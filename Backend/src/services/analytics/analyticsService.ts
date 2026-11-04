import type { QueryFilter } from 'mongoose';
import {
  resolveScope,
  unreviewedFilter,
  visiblePostsFilter,
  type Scope,
  type ScopeLike,
} from '../../auth/scope.js';
import {
  ANALYTICS_TIMEZONE,
  type BreakdownDto,
  type Classification,
  type ClusterDto,
  type ClustersDto,
  type GeoDto,
  type ModelHealthDto,
  type SummaryDto,
  type TimeseriesDto,
} from '../../contracts/api/index.js';
import { AnalystReviewModel, type AnalystReviewDoc } from '../../models/AnalystReview.js';
import { ClassificationModel, type ClassificationDoc } from '../../models/Classification.js';
import { DecisionModel, type DecisionDoc } from '../../models/Decision.js';
import { DispatchModel } from '../../models/Dispatch.js';
import { PostModel, type PostDoc } from '../../models/Post.js';
import { CROSS_TENANT } from '../../models/tenantGuard.js';
import { overThreshold } from '../../pipeline/pipeline.js';
import { toClassification } from '../postDto.js';
import {
  DEFAULT_GEO_CONFIG,
  rollupGeo,
  type GeoCategoryRow,
  type GeoConfig,
  type GeoRow,
} from './geoRollup.js';
import { histogram, latencyPercentiles, precisionRecallF1, ratio, round } from './stats.js';
import { daysAgo, lastDays, startOfDay, weekWindows } from './time.js';
import { clusterTexts } from './clustering.js';
import { NoRefiner, type NarrativeRefiner } from './narrativeRefiner.js';

export interface AnalyticsDeps {
  /** QUEUE_CAP: the review queue is compared to it for the cap warning. */
  queueCap: number;
  overdueHours: number;
  geo?: GeoConfig;
  now?: () => Date;
  /** Merges and names narratives with AI. Without it, narratives are grouped by wording only. */
  refiner?: NarrativeRefiner;
  /** How long a narrative result is reused (ms). 0 = never; the cache is per tenant visibility. */
  clusterCacheMs?: number;
}

/** The warning starts at this share of the cap. */
export const CAP_WARNING_SHARE = 0.8;
/** Safety bounds so one request cannot read an unbounded number of rows into memory. */
const MAX_ROWS = 100_000;
/** Narratives are computed from the newest flagged posts of the last two weeks, at most this many. */
const CLUSTER_MAX_POSTS = 4000;
/** A narrative needs at least this many posts this week; one-offs are only counted. */
const MIN_CLUSTER_SIZE = 2;

export const REVIEW_CAVEAT =
  'Precision, recall and F1 are computed only from analyst reviews, so they describe the reviewed sample, not ' +
  'the model in general. Reviewers mostly see posts the model flagged, which makes recall optimistic. ' +
  'Treat small samples with caution.';

const CONFIDENCE_BASIS = 'top category score (multilabel) or highest class probability (three-class)';

const langOf = '$triage.language';
const languageExpr = { $ifNull: [langOf, { $ifNull: ['$languageHint', 'unknown'] }] };
const isFlagged = { $eq: ['$triage.isMisinformation', true] };

const byRateThenKey = <T extends { reviewed: number; key: string }>(a: T, b: T) =>
  b.reviewed - a.reviewed || a.key.localeCompare(b.key);

/** Read-only analytics. Every query is scoped to the current run's `isMock` so mock and real data never mix. */
export class AnalyticsService {
  private readonly clusterCache = new Map<string, { at: number; dto: ClustersDto }>();

  constructor(private readonly deps: AnalyticsDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  // ---------------------------------------------------------------- summary

  /**
   * Posts this tenant may see in this run: the base of every post query here. Posts are global, so the numbers
   * are facts about what the tenant can see; review-related numbers are the tenant's own.
   */
  private postFilter(scope: Scope, ...extra: object[]): QueryFilter<PostDoc> {
    return { $and: [{ isMock: scope.isMock }, visiblePostsFilter(scope.tenant), ...extra] };
  }

  async summary(scopeLike: ScopeLike): Promise<SummaryDto> {
    const scope = resolveScope(scopeLike);
    const now = this.now();
    const today = startOfDay(now);
    // an organization's own settings win, else the platform defaults
    const overdueHours = scope.tenant.settings?.overdueHours ?? this.deps.overdueHours;
    const cap = scope.tenant.settings?.queueCap ?? this.deps.queueCap;
    const overdueCutoff = new Date(now.getTime() - overdueHours * 3_600_000);
    const unreviewed = unreviewedFilter(scope.tenant);
    const dispatchFilter = {
      isMock: scope.isMock,
      status: 'sent',
      createdAt: { $gte: today },
      ...(scope.tenant.organizationId ? { organizationId: scope.tenant.organizationId } : {}),
    };

    const [postsToday, flagged7d, review, informationGap, overdue, dispatchedToday, pipelineRows] =
      await Promise.all([
        PostModel.countDocuments(this.postFilter(scope, { postedAt: { $gte: today } })),
        PostModel.countDocuments(
          this.postFilter(scope, { 'triage.isMisinformation': true, postedAt: { $gte: daysAgo(now, 7) } }),
        ),
        PostModel.countDocuments(this.postFilter(scope, { 'triage.queue': 'review' }, unreviewed)),
        PostModel.countDocuments(this.postFilter(scope, { 'triage.queue': 'information_gap' }, unreviewed)),
        PostModel.countDocuments(
          this.postFilter(
            scope,
            unreviewed,
            { 'triage.queue': { $in: ['review', 'information_gap'] } },
            { ingestedAt: { $lt: overdueCutoff } },
          ),
        ),
        DispatchModel.countDocuments(dispatchFilter).setOptions(
          scope.tenant.platformWide ? CROSS_TENANT : {},
        ),
        PostModel.aggregate<{ _id: string; n: number }>([
          { $match: this.postFilter(scope) },
          { $group: { _id: '$pipelineStatus', n: { $sum: 1 } } },
        ]),
      ]);

    const status = Object.fromEntries(pipelineRows.map((r) => [r._id, r.n])) as Record<string, number>;
    return {
      generatedAt: now.toISOString(),
      timezone: ANALYTICS_TIMEZONE,
      postsToday,
      flagged7d,
      queue: {
        review,
        informationGap,
        overdue,
        cap,
        warning: review >= cap ? 'full' : review >= cap * CAP_WARNING_SHARE ? 'approaching' : 'none',
      },
      dispatchedToday,
      pipeline: {
        pending: status.pending ?? 0,
        classifying: status.classifying ?? 0,
        needsReview: status.needs_review ?? 0,
        classificationError: status.classification_error ?? 0,
      },
    };
  }

  // ------------------------------------------------------------- timeseries

  /** Last 7 Nigerian calendar days, stacked by label: a flagged post counts under its top category. */
  async timeseries(scopeLike: ScopeLike): Promise<TimeseriesDto> {
    const scope = resolveScope(scopeLike);
    const { days, start } = lastDays(this.now(), 7);
    const rows = await PostModel.aggregate<{ _id: { day: string; key: string; kind: string }; n: number }>([
      { $match: this.postFilter(scope, { postedAt: { $gte: start } }) },
      {
        $project: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$postedAt', timezone: ANALYTICS_TIMEZONE } },
          label: {
            $cond: [
              { $eq: [{ $type: '$triage' }, 'object'] },
              {
                $cond: [
                  isFlagged,
                  {
                    key: {
                      $ifNull: [
                        { $arrayElemAt: ['$triage.categories', 0] },
                        { $ifNull: ['$triage.topCategory', 'unknown'] },
                      ],
                    },
                    kind: 'category',
                  },
                  { key: 'not_flagged', kind: 'not_flagged' },
                ],
              },
              { key: 'unclassified', kind: 'unclassified' },
            ],
          },
        },
      },
      { $group: { _id: { day: '$day', key: '$label.key', kind: '$label.kind' }, n: { $sum: 1 } } },
    ]);

    const index = new Map(days.map((d, i) => [d, i]));
    const series = new Map<
      string,
      { key: string; kind: 'category' | 'not_flagged' | 'unclassified'; counts: number[] }
    >();
    const totals = days.map(() => 0);
    for (const r of rows) {
      const i = index.get(r._id.day);
      if (i === undefined) continue; // outside the 7 local days (timezone edge)
      const id = `${r._id.kind}:${r._id.key}`;
      const s = series.get(id) ?? {
        key: r._id.key,
        kind: r._id.kind as 'category',
        counts: days.map(() => 0),
      };
      s.counts[i]! += r.n;
      totals[i]! += r.n;
      series.set(id, s);
    }
    // Categories first (largest first), then the two non-category buckets, so stacks read consistently.
    const order = { category: 0, not_flagged: 1, unclassified: 2 } as const;
    const sorted = [...series.values()].sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        b.counts.reduce((x, y) => x + y, 0) - a.counts.reduce((x, y) => x + y, 0) ||
        a.key.localeCompare(b.key),
    );
    return { timezone: ANALYTICS_TIMEZONE, days, series: sorted, totals };
  }

  // -------------------------------------------------------------- breakdown

  async breakdown(days: number, scopeLike: ScopeLike): Promise<BreakdownDto> {
    const scope = resolveScope(scopeLike);
    const since = daysAgo(this.now(), days);
    const group = (field: unknown) => [
      { $match: this.postFilter(scope, { postedAt: { $gte: since } }) },
      { $group: { _id: field, total: { $sum: 1 }, flagged: { $sum: { $cond: [isFlagged, 1, 0] } } } },
    ];
    const [platform, language] = await Promise.all([
      PostModel.aggregate<{ _id: string; total: number; flagged: number }>(group('$platform')),
      PostModel.aggregate<{ _id: string; total: number; flagged: number }>(group(languageExpr)),
    ]);
    const rows = (xs: Array<{ _id: string; total: number; flagged: number }>) =>
      xs
        .map((x) => ({ key: String(x._id), total: x.total, flagged: x.flagged }))
        .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    const total = platform.reduce((a, b) => a + b.total, 0);
    return { windowDays: days, total, platform: rows(platform), language: rows(language) };
  }

  // --------------------------------------------------------------- clusters

  /**
   * Narratives: flagged posts grouped by the claim they make. Posts from this week and last week are grouped
   * together by wording (see clustering.ts), so each group has a count for both weeks; an optional AI step merges
   * paraphrases across languages and names the groups (see narrativeRefiner.ts). One-off posts are counted, not listed.
   */
  async clusters(scopeLike: ScopeLike): Promise<ClustersDto> {
    const scope = resolveScope(scopeLike);
    const cacheMs = this.deps.clusterCacheMs ?? 0;
    const cacheKey = JSON.stringify([
      scope.isMock,
      String(scope.tenant.organizationId),
      scope.tenant.platformWide,
      scope.tenant.scopeStates,
    ]);
    const hit = this.clusterCache.get(cacheKey);
    if (cacheMs > 0 && hit && this.now().getTime() - hit.at < cacheMs) return hit.dto;

    const now = this.now();
    const { currentStart, previousStart } = weekWindows(now);
    const docs = (await PostModel.find(
      this.postFilter(scope, { 'triage.isMisinformation': true, postedAt: { $gte: previousStart } }),
      {
        text: 1,
        platform: 1,
        state: 1,
        postedAt: 1,
        languageHint: 1,
        'triage.categories': 1,
        'triage.topCategory': 1,
        'triage.priorityScore': 1,
        'triage.urgent': 1,
        'triage.language': 1,
      },
    )
      .sort({ postedAt: -1 })
      .limit(CLUSTER_MAX_POSTS)
      .lean()) as unknown as PostDoc[];

    const tri = (p: PostDoc) =>
      (p.triage ?? {}) as Partial<{
        categories: string[];
        topCategory: string | null;
        priorityScore: number;
        urgent: boolean;
        language: string | null;
      }>;
    const isCurrent = (p: PostDoc) => p.postedAt >= currentStart;

    const clustering = clusterTexts(
      docs.map((p) => ({ id: String(p._id), text: p.text, at: p.postedAt.getTime() })),
    );
    const refiner = this.deps.refiner ?? new NoRefiner();

    interface Sub {
      id: string;
      cur: PostDoc[];
      prev: number;
      keyStems: string[];
      sample: PostDoc;
    }
    const subs: Sub[] = [];
    for (const c of clustering.clusters) {
      const members = c.members.map((i) => docs[i]!);
      const cur = members.filter(isCurrent);
      if (cur.length === 0) continue;
      const central = docs[c.centralMember]!;
      const sample = isCurrent(central)
        ? central
        : cur.reduce((a, b) => ((tri(b).priorityScore ?? 0) > (tri(a).priorityScore ?? 0) ? b : a));
      subs.push({ id: c.id, cur, prev: members.length - cur.length, keyStems: c.keyStems, sample });
    }

    // ask the AI step about what it has not seen (in the background); use what it already knows
    refiner.request(
      subs.map((s) => ({
        key: s.id,
        count: s.cur.length,
        samples: [
          ...new Set([s.sample, ...s.cur].map((p) => p.text.replace(/\s+/g, ' ').slice(0, 220))),
        ].slice(0, 3),
      })),
    );

    interface Group {
      subs: Sub[];
      title: string | null;
      summary: string | null;
    }
    const groups = new Map<string, Group>();
    for (const s of subs) {
      const r = refiner.lookup(s.id);
      const key = r?.narrativeKey ?? s.id;
      const g = groups.get(key) ?? { subs: [], title: null, summary: null };
      g.subs.push(s);
      if (r?.title) {
        g.title = r.title;
        g.summary = r.summary;
      }
      groups.set(key, g);
    }

    const totalCurrent = subs.reduce((a, s) => a + s.cur.length, 0);
    const top = (m: Map<string, number>, n: number) =>
      [...m.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .slice(0, n);
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

    let unclustered = 0;
    let anyAi = false;
    const clusters: ClusterDto[] = [];
    for (const [id, g] of groups) {
      const cur = g.subs.flatMap((s) => s.cur);
      if (cur.length < MIN_CLUSTER_SIZE) {
        unclustered += cur.length;
        continue;
      }
      const previousCount = g.subs.reduce((a, s) => a + s.prev, 0);
      const platforms = new Map<string, number>();
      const languages = new Map<string, number>();
      const states = new Map<string, number>();
      const categories = new Map<string, number>();
      let urgentCount = 0;
      let first = cur[0]!.postedAt;
      let last = cur[0]!.postedAt;
      for (const p of cur) {
        const t = tri(p);
        bump(platforms, p.platform);
        bump(languages, t.language ?? p.languageHint ?? 'unknown');
        if (p.state) bump(states, p.state);
        const cat = t.categories?.[0] ?? t.topCategory;
        if (cat) bump(categories, cat);
        if (t.urgent) urgentCount++;
        if (p.postedAt < first) first = p.postedAt;
        if (p.postedAt > last) last = p.postedAt;
      }
      const lead = g.subs.reduce((a, b) => (b.cur.length > a.cur.length ? b : a));
      const sample = g.subs
        .map((s) => s.sample)
        .reduce((a, b) => ((tri(b).priorityScore ?? 0) > (tri(a).priorityScore ?? 0) ? b : a));
      const terms = [
        ...new Set(g.subs.flatMap((s) => s.keyStems.slice(0, 4)).map((s) => clustering.surface(s))),
      ].slice(0, 5);
      const keywordTitle = terms.slice(0, 3).join(' · ');
      const ai = g.title !== null;
      anyAi ||= ai;

      const count = cur.length;
      const changePct = previousCount > 0 ? round(((count - previousCount) / previousCount) * 100, 1) : null;
      const trend: ClusterDto['trend'] =
        previousCount === 0
          ? 'new'
          : count - previousCount >= 2 && count >= previousCount * 1.25
            ? 'rising'
            : count <= previousCount * 0.75
              ? 'falling'
              : 'steady';

      clusters.push({
        id,
        title:
          g.title ??
          (keywordTitle ? keywordTitle.charAt(0).toUpperCase() + keywordTitle.slice(1) : 'Similar posts'),
        summary: g.summary,
        labelSource: ai ? 'ai' : 'keywords',
        keyTerms: terms,
        category: top(categories, 1)[0]?.key ?? null,
        count,
        share: totalCurrent > 0 ? round(count / totalCurrent, 4) : 0,
        previousCount,
        changePct,
        trend,
        urgentCount,
        platforms: top(platforms, 4),
        languages: top(languages, 4),
        topStates: top(states, 3),
        samplePostId: String((g.subs.length > 1 ? sample : lead.sample)._id),
        sampleText: (g.subs.length > 1 ? sample : lead.sample).text.slice(0, 280),
        firstSeen: first.toISOString(),
        lastSeen: last.toISOString(),
      });
    }
    clusters.sort((a, b) => b.count - a.count || b.urgentCount - a.urgentCount || a.id.localeCompare(b.id));

    const ai = anyAi && refiner.model !== null;
    const dto: ClustersDto = {
      windowDays: 7,
      method: {
        grouping: 'text-similarity',
        refinement: ai ? 'ai' : 'none',
        model: ai ? refiner.model : null,
      },
      note: ai
        ? 'Grouped by what posts say. An AI model merged the same claim written in different words or languages and wrote the titles, so check them against the sample posts.'
        : 'Grouped by similar wording. The same claim written in different languages or very different words may appear as separate groups.',
      unclustered,
      clusters,
    };
    if (cacheMs > 0) this.clusterCache.set(cacheKey, { at: now.getTime(), dto });
    return dto;
  }

  // -------------------------------------------------------------------- geo

  async geo(scopeLike: ScopeLike): Promise<GeoDto> {
    const scope = resolveScope(scopeLike);
    const now = this.now();
    const { currentStart, previousStart } = weekWindows(now);
    const match = this.postFilter(scope, { postedAt: { $gte: previousStart, $lte: now } });
    const period = { $cond: [{ $gte: ['$postedAt', currentStart] }, 'cur', 'prev'] };

    const [fine, cats] = await Promise.all([
      PostModel.aggregate<{ _id: Omit<GeoRow, 'count'>; n: number }>([
        { $match: match },
        {
          $group: {
            _id: {
              state: '$state',
              lga: '$lga',
              period,
              platform: '$platform',
              language: languageExpr,
              flagged: isFlagged,
            },
            n: { $sum: 1 },
          },
        },
      ]),
      PostModel.aggregate<{ _id: Omit<GeoCategoryRow, 'count'>; n: number }>([
        { $match: { $and: [match, { 'triage.isMisinformation': true }] } },
        { $unwind: '$triage.categories' },
        {
          $group: {
            _id: { state: '$state', lga: '$lga', period, category: '$triage.categories' },
            n: { $sum: 1 },
          },
        },
      ]),
    ]);

    const cfg = this.deps.geo ?? DEFAULT_GEO_CONFIG;
    const rolled = rollupGeo(
      fine.map((r) => ({ ...r._id, count: r.n })),
      cats.map((r) => ({ ...r._id, count: r.n })),
      cfg,
    );
    return {
      generatedAt: now.toISOString(),
      windowDays: 7,
      surgeThresholdPct: cfg.surgeThreshold * 100,
      minCount: cfg.minCount,
      ...rolled,
    };
  }

  // ----------------------------------------------------------- model health

  async modelHealth(days: number, scopeLike: ScopeLike): Promise<ModelHealthDto> {
    const scope = resolveScope(scopeLike);
    const scopeIsMock = scope.isMock;
    const now = this.now();
    const since = daysAgo(now, days);

    const classifications = await ClassificationModel.aggregate<{
      modelName: string;
      modelVersion: string;
      latency: number | null;
      score: number | null;
    }>([
      { $match: { isMock: scopeIsMock, createdAt: { $gte: since } } },
      { $limit: MAX_ROWS },
      {
        $project: {
          _id: 0,
          modelName: 1,
          modelVersion: 1,
          latency: '$normalized.latencyMs',
          score: {
            $cond: [
              { $eq: ['$contract', 'threeclass-v0'] },
              {
                $max: [
                  '$normalized.threeClass.probabilities.misinformation',
                  '$normalized.threeClass.probabilities.factual',
                  '$normalized.threeClass.probabilities.irrelevant',
                ],
              },
              { $arrayElemAt: ['$normalized.categories.score', 0] },
            ],
          },
        },
      },
    ]);

    const models = new Map<string, { modelName: string; modelVersion: string; classifications: number }>();
    for (const c of classifications) {
      const k = `${c.modelName}\u0000${c.modelVersion}`;
      const m = models.get(k) ?? { modelName: c.modelName, modelVersion: c.modelVersion, classifications: 0 };
      m.classifications++;
      models.set(k, m);
    }

    // the model's own numbers (latency, confidence) are platform-level; the review-derived ones are the caller's
    const review = await this.reviewMetrics(since, scope);

    return {
      generatedAt: now.toISOString(),
      windowDays: days,
      reviewDerived: review.reviewDerived,
      overrideRate: review.overrideRate,
      languageAgreement: review.languageAgreement,
      confidence: {
        basis: CONFIDENCE_BASIS,
        n: classifications.filter((c) => typeof c.score === 'number').length,
        bins: histogram(
          classifications.map((c) => c.score).filter((s): s is number => typeof s === 'number'),
        ),
      },
      latency: {
        unit: 'ms',
        ...latencyPercentiles(
          classifications.map((c) => c.latency).filter((l): l is number => typeof l === 'number'),
        ),
      },
      models: [...models.values()].sort(
        (a, b) => b.classifications - a.classifications || a.modelVersion.localeCompare(b.modelVersion),
      ),
    };
  }

  /**
   * Everything derived from analyst reviews. Each post counts once, by its latest review. For each review:
   *   P = the categories the model flagged (empty when it did not flag the post);
   *   A = the categories the analyst says apply:
   *     confirmed -> A = P (they agree);  rejected -> A = {} (not misinformation);
   *     corrected -> A = the labels they entered.
   * A review of a post the model did NOT flag, which the analyst rejects, is a missed positive (a false negative
   * for the binary measure) with no label to attribute it to.
   */
  private async reviewMetrics(since: Date, scope: Scope) {
    // an organization is measured on its own reviews; the platform operator sees all of them
    const orgFilter = scope.tenant.organizationId ? { organizationId: scope.tenant.organizationId } : {};
    const aggregate = AnalystReviewModel.aggregate<AnalystReviewDoc>([
      { $match: { ...orgFilter, isMock: scope.isMock, createdAt: { $gte: since } } },
      { $sort: { createdAt: -1, _id: -1 } },
      // each organization's latest review of each post (the platform operator sees every organization's)
      { $group: { _id: { post: '$postId', org: '$organizationId' }, doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $limit: MAX_ROWS },
    ]);
    const latest = await (scope.tenant.platformWide ? aggregate.option(CROSS_TENANT) : aggregate);

    const classIds = latest.map((r) => r.classificationId);
    const postIds = latest.map((r) => r.postId);
    const [classes, decisions, posts] = await Promise.all([
      classIds.length
        ? (ClassificationModel.find({ _id: { $in: classIds } }).lean() as unknown as Promise<
            ClassificationDoc[]
          >)
        : [],
      classIds.length
        ? (DecisionModel.find({ classificationId: { $in: classIds } })
            .sort({ createdAt: -1, _id: -1 })
            .lean() as unknown as Promise<DecisionDoc[]>)
        : [],
      postIds.length
        ? (PostModel.find({ _id: { $in: postIds } }, { platform: 1 }).lean() as unknown as Promise<PostDoc[]>)
        : [],
    ]);
    const classById = new Map(classes.map((c) => [String(c._id), c]));
    const platformById = new Map(posts.map((p) => [String(p._id), p.platform]));
    const decisionByClass = new Map<string, DecisionDoc>();
    for (const d of decisions)
      if (!decisionByClass.has(String(d.classificationId)))
        decisionByClass.set(String(d.classificationId), d);

    const bin = { tp: 0, fp: 0, fn: 0, tn: 0 };
    const perClass = new Map<
      string,
      { tp: number; fp: number; fn: number; predicted: number; support: number }
    >();
    const klass = (id: string) =>
      perClass.get(id) ?? perClass.set(id, { tp: 0, fp: 0, fn: 0, predicted: 0, support: 0 }).get(id)!;
    const overall = { reviewed: 0, overridden: 0 };
    const agg = (
      m: Map<string, { reviewed: number; overridden: number }>,
      key: string,
      overridden: boolean,
    ) => {
      const row = m.get(key) ?? { reviewed: 0, overridden: 0 };
      row.reviewed++;
      if (overridden) row.overridden++;
      m.set(key, row);
    };
    const byClass = new Map<string, { reviewed: number; overridden: number }>();
    const byPlatform = new Map<string, { reviewed: number; overridden: number }>();
    const byLanguage = new Map<string, { reviewed: number; overridden: number }>();

    let used = 0;
    for (const r of latest) {
      const cls = classById.get(String(r.classificationId));
      const dec = decisionByClass.get(String(r.classificationId));
      const c: Classification | null = cls
        ? toClassification(cls.normalized, `classification ${String(cls._id)}`)
        : null;
      if (!cls || !dec || !c) continue; // cannot judge a review whose classification or decision is gone
      used++;

      const modelFlagged = dec.isMisinformation;
      const P = modelFlagged ? overThreshold(c, dec) : [];
      let A: string[];
      let actualPositive: boolean;
      if (r.decision === 'confirmed') {
        A = P;
        actualPositive = modelFlagged;
      } else if (r.decision === 'rejected') {
        A = [];
        actualPositive = !modelFlagged; // rejecting "not flagged" = it was misinformation after all
      } else {
        const labels = r.correction?.labels ?? [];
        A = c.contract === 'threeclass-v0' ? labels.filter((l) => l === 'misinformation') : labels;
        actualPositive = A.length > 0;
      }

      if (modelFlagged && actualPositive) bin.tp++;
      else if (modelFlagged) bin.fp++;
      else if (actualPositive) bin.fn++;
      else bin.tn++;

      for (const id of new Set([...P, ...A])) {
        const k = klass(id);
        const p = P.includes(id);
        const a = A.includes(id);
        if (p) k.predicted++;
        if (a) k.support++;
        if (p && a) k.tp++;
        else if (p) k.fp++;
        else k.fn++;
      }

      const overridden = r.decision !== 'confirmed';
      overall.reviewed++;
      if (overridden) overall.overridden++;
      agg(byClass, P[0] ?? 'not_flagged', overridden);
      agg(byPlatform, platformById.get(String(r.postId)) ?? 'unknown', overridden);
      agg(byLanguage, c.language ?? 'unknown', overridden);
    }

    const rows = (m: Map<string, { reviewed: number; overridden: number }>) =>
      [...m.entries()]
        .map(([key, v]) => ({
          key,
          reviewed: v.reviewed,
          overridden: v.overridden,
          rate: ratio(v.overridden, v.reviewed),
        }))
        .sort(byRateThenKey);

    return {
      reviewDerived: {
        caveat: REVIEW_CAVEAT,
        sampleSize: used,
        overall: { ...precisionRecallF1(bin), tn: bin.tn },
        perClass: [...perClass.entries()]
          .map(([id, k]) => ({ id, predicted: k.predicted, support: k.support, ...precisionRecallF1(k) }))
          .sort((a, b) => b.predicted + b.support - (a.predicted + a.support) || a.id.localeCompare(b.id)),
      },
      overrideRate: {
        overall: { ...overall, rate: ratio(overall.overridden, overall.reviewed) },
        byClass: rows(byClass),
        byPlatform: rows(byPlatform),
      },
      languageAgreement: rows(byLanguage).map((r) => ({
        language: r.key,
        reviewed: r.reviewed,
        agreed: r.reviewed - r.overridden,
        rate: ratio(r.reviewed - r.overridden, r.reviewed),
      })),
    };
  }
}
