import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BreakdownDtoSchema,
  ClustersDtoSchema,
  GeoDtoSchema,
  ModelHealthDtoSchema,
  SummaryDtoSchema,
  TimeseriesDtoSchema,
} from '../src/contracts/api/index.js';
import { AnalystReviewModel, DispatchModel } from './helpers/anyTenant.js';
import { REVIEW_CAVEAT, AnalyticsService } from '../src/services/analytics/analyticsService.js';
import { startApp } from './helpers/app.js';
import { clearCollections, DATA_COLLECTIONS, useMongo } from './helpers/mongo.js';
import { seedPost, setSeedOrg, type SeedSpec } from './helpers/seed.js';

useMongo();

/** 13:00 in Lagos. "Today" in Lagos began at 2026-10-26T23:00:00Z. */
const ORG = new mongoose.Types.ObjectId();
const NOW = new Date('2026-10-27T12:00:00Z');
const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const service = (over: Partial<ConstructorParameters<typeof AnalyticsService>[0]> = {}) =>
  new AnalyticsService({ queueCap: 500, overdueHours: 48, now: () => NOW, ...over });

/** Seeds with an explicit ingestion time so nothing depends on the real clock. */
const seed = (o: SeedSpec = {}) =>
  seedPost({ ingestedAt: new Date(NOW.getTime() - HOUR), postedAt: NOW, ...o });

beforeAll(async () => undefined);
beforeEach(async () => {
  await clearCollections(DATA_COLLECTIONS);
  setSeedOrg(ORG);
});

describe('summary', () => {
  async function seedDay() {
    const T = at('2026-10-27T05:00:00Z'); // today in Lagos
    await seed({ postedAt: T, queue: 'review' }); // a: flagged, unreviewed
    await seed({ postedAt: T, queue: 'review', ingestedAt: new Date(NOW.getTime() - 72 * HOUR) }); // b: overdue
    await seed({ postedAt: T, queue: 'none' }); // c
    await seed({ postedAt: T, classified: false, pipelineStatus: 'pending' }); // d
    await seed({ postedAt: T, queue: 'information_gap', stance: 'questions' }); // e
    await seed({ postedAt: T, queue: 'review', reviewStatus: 'confirmed' }); // f: already reviewed
    await seed({ postedAt: at('2026-10-26T22:00:00Z'), queue: 'review' }); // g: yesterday (23:00 in Lagos)
    await seed({ postedAt: at('2026-10-19T12:00:00Z'), queue: 'review' }); // h: 8 days ago
    await seed({ postedAt: T, queue: 'review', isMock: false }); // i: real data, other run
    await seed({ postedAt: T, classified: false, pipelineStatus: 'classification_error' });
    await seed({ postedAt: T, classified: false, pipelineStatus: 'classifying' });
    await seed({ postedAt: T, classified: false, pipelineStatus: 'needs_review' });
  }

  it('counts posts today (Lagos day), flagged in the last 7 days, queue sizes, overdue and pipeline states', async () => {
    await seedDay();
    // "already reviewed" is per organization, so this one reads as the org that reviewed post f
    const orgScope = {
      isMock: true,
      tenant: {
        organizationId: ORG,
        platformWide: false,
        scopeStates: [],
        orgType: 'state' as const,
        settings: null,
      },
    };
    const s = SummaryDtoSchema.parse(await service().summary(orgScope));
    expect(s.timezone).toBe('Africa/Lagos');
    expect(s.generatedAt).toBe(NOW.toISOString());
    // a b c d e f + three pipeline-state posts today; yesterday, 8 days ago and the real post do not count
    expect(s.postsToday).toBe(9);
    expect(s.flagged7d).toBe(4); // a b f g (h is 8 days old; e and c are not misinformation)
    expect(s.queue).toMatchObject({ review: 4, informationGap: 1, overdue: 1, cap: 500, warning: 'none' }); // a b g h; f is reviewed
    expect(s.pipeline).toEqual({ pending: 1, classifying: 1, needsReview: 1, classificationError: 1 });
  });

  it('a post one minute either side of Lagos midnight lands on the right day', async () => {
    await seed({ postedAt: at('2026-10-26T22:59:00Z') }); // 23:59 on the 26th
    await seed({ postedAt: at('2026-10-26T23:01:00Z') }); // 00:01 on the 27th
    expect((await service().summary(true)).postsToday).toBe(1);
  });

  it('the cap warning starts at 80% of QUEUE_CAP and is "full" at or above it', async () => {
    for (let i = 0; i < 4; i++) await seed({ queue: 'review' });
    expect((await service({ queueCap: 10 }).summary(true)).queue.warning).toBe('none');
    expect((await service({ queueCap: 5 }).summary(true)).queue.warning).toBe('approaching'); // 4 >= 4
    expect((await service({ queueCap: 4 }).summary(true)).queue.warning).toBe('full');
    expect((await service({ queueCap: 3 }).summary(true)).queue.warning).toBe('full');
  });

  it('dispatched today counts only sent items, today (Lagos), in this run', async () => {
    const base = {
      narrativeId: new mongoose.Types.ObjectId(),
      platform: 'x',
      text: 't',
      textHash: 'h',
      approvedBy: 'a',
      approvalReviewId: new mongoose.Types.ObjectId(),
      dispatchedBy: 'd',
      organizationId: ORG,
      dispatcher: { name: 'mock-dispatcher', mode: 'mock' },
      isMock: true,
    };
    const mk = (o: Record<string, unknown>) =>
      DispatchModel.create({ ...base, narrativeId: new mongoose.Types.ObjectId(), ...o });
    await mk({ status: 'sent', createdAt: at('2026-10-27T06:00:00Z') });
    await mk({ status: 'sent', createdAt: at('2026-10-26T12:00:00Z') }); // yesterday
    await mk({ status: 'failed', createdAt: at('2026-10-27T06:00:00Z') }); // failed
    await mk({ status: 'sent', createdAt: at('2026-10-27T06:00:00Z'), isMock: false }); // other run
    expect((await service().summary(true)).dispatchedToday).toBe(1);
  });

  it('an empty database gives zeros, not errors', async () => {
    const s = await service().summary(true);
    expect(s).toMatchObject({ postsToday: 0, flagged7d: 0, dispatchedToday: 0 });
    expect(s.queue).toMatchObject({ review: 0, overdue: 0, warning: 'none' });
  });
});

describe('timeseries', () => {
  it('7 Lagos days, stacked by label; edge-of-day posts land on the right day', async () => {
    await seed({ postedAt: at('2026-10-27T05:00:00Z'), categories: ['fake_cure_prevention'] });
    await seed({ postedAt: at('2026-10-27T06:00:00Z'), categories: ['fake_cure_prevention'] });
    await seed({ postedAt: at('2026-10-27T07:00:00Z'), categories: ['burial_resistance'] });
    await seed({ postedAt: at('2026-10-27T08:00:00Z'), queue: 'none', categories: [] }); // classified, not flagged
    await seed({ postedAt: at('2026-10-27T09:00:00Z'), classified: false }); // unclassified
    await seed({ postedAt: at('2026-10-26T22:30:00Z'), categories: ['fake_cure_prevention'] }); // 23:30 on the 26th
    await seed({ postedAt: at('2026-10-26T23:30:00Z'), categories: ['burial_resistance'] }); // 00:30 on the 27th
    await seed({ postedAt: at('2026-10-21T07:00:00Z'), categories: ['outbreak_denial'] }); // oldest day
    await seed({ postedAt: at('2026-10-20T22:30:00Z'), categories: ['outbreak_denial'] }); // 23:30 on the 20th: outside
    await seed({ postedAt: at('2026-10-27T05:00:00Z'), isMock: false }); // other run

    const t = TimeseriesDtoSchema.parse(await service().timeseries(true));
    expect(t.days).toEqual([
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
    expect(t.series).toEqual([
      { key: 'fake_cure_prevention', kind: 'category', counts: [0, 0, 0, 0, 0, 1, 2] },
      { key: 'burial_resistance', kind: 'category', counts: [0, 0, 0, 0, 0, 0, 2] },
      { key: 'outbreak_denial', kind: 'category', counts: [1, 0, 0, 0, 0, 0, 0] },
      { key: 'not_flagged', kind: 'not_flagged', counts: [0, 0, 0, 0, 0, 0, 1] },
      { key: 'unclassified', kind: 'unclassified', counts: [0, 0, 0, 0, 0, 0, 1] },
    ]);
    expect(t.totals).toEqual([1, 0, 0, 0, 0, 1, 6]);
    // the stack always adds up
    for (let i = 0; i < 7; i++) expect(t.series.reduce((a, s) => a + s.counts[i]!, 0)).toBe(t.totals[i]);
  });

  it('a flagged post counts under its first (top) category only', async () => {
    await seed({ postedAt: NOW, categories: ['burial_resistance', 'fake_cure_prevention'] });
    const t = await service().timeseries(true);
    expect(t.series.map((s) => s.key)).toEqual(['burial_resistance']);
  });

  it('three-class posts stack under the "misinformation" label', async () => {
    await seed({ postedAt: NOW, contract: 'threeclass-v0', categories: ['misinformation'] });
    const t = await service().timeseries(true);
    expect(t.series).toEqual([{ key: 'misinformation', kind: 'category', counts: [0, 0, 0, 0, 0, 0, 1] }]);
  });

  it('no data: seven zero days and no series', async () => {
    const t = await service().timeseries(true);
    expect(t.series).toEqual([]);
    expect(t.totals).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('breakdown', () => {
  it('counts posts and flagged posts per platform and language within the window, busiest first', async () => {
    await seed({ platform: 'x', language: 'en', queue: 'review' });
    await seed({ platform: 'x', language: 'en', queue: 'none' });
    await seed({ platform: 'x', language: 'pcm', queue: 'review' });
    await seed({ platform: 'bluesky', language: 'en', queue: 'none' });
    await seed({ platform: 'youtube', classified: false }); // no language at all
    await seed({ platform: 'x', postedAt: new Date(NOW.getTime() - 8 * DAY) }); // outside 7 days
    await seed({ platform: 'x', isMock: false }); // other run

    const b = BreakdownDtoSchema.parse(await service().breakdown(7, true));
    expect(b.windowDays).toBe(7);
    expect(b.total).toBe(5);
    expect(b.platform).toEqual([
      { key: 'x', total: 3, flagged: 2 },
      { key: 'bluesky', total: 1, flagged: 0 },
      { key: 'youtube', total: 1, flagged: 0 },
    ]);
    expect(b.language).toEqual([
      { key: 'en', total: 2 + 1, flagged: 1 },
      { key: 'pcm', total: 1, flagged: 1 },
      { key: 'unknown', total: 1, flagged: 0 },
    ]);
  });

  it('the window is configurable', async () => {
    await seed({ postedAt: new Date(NOW.getTime() - 20 * DAY) });
    expect((await service().breakdown(7, true)).total).toBe(0);
    expect((await service().breakdown(30, true)).total).toBe(1);
  });
});

describe('geo', () => {
  const week = (days: number) => new Date(NOW.getTime() - days * DAY);

  it('week-on-week change, surge flag, density, dominant fields and LGA table per state', async () => {
    // Lagos this week: 6 flagged (4 Ikeja x/en, 2 Surulere bluesky/pcm); last week: 3 -> +100% => surge
    for (let i = 0; i < 4; i++)
      await seed({
        state: 'Lagos',
        lga: 'Ikeja',
        platform: 'x',
        language: 'en',
        categories: ['fake_cure_prevention'],
      });
    for (let i = 0; i < 2; i++)
      await seed({
        state: 'Lagos',
        lga: 'Surulere',
        platform: 'bluesky',
        language: 'pcm',
        categories: ['burial_resistance'],
      });
    for (let i = 0; i < 3; i++)
      await seed({ state: 'Lagos', lga: 'Ikeja', postedAt: week(10), categories: ['fake_cure_prevention'] });
    await seed({ state: 'Lagos', lga: 'Ikeja', queue: 'none', categories: [] }); // not flagged: in `total` only
    // Rivers: exactly +50% (4 -> 6) is not a surge
    for (let i = 0; i < 6; i++) await seed({ state: 'Rivers', platform: 'x', language: 'en' });
    for (let i = 0; i < 4; i++) await seed({ state: 'Rivers', postedAt: week(9) });
    // Kano: nothing last week, 3 now => new activity at volume => surge
    for (let i = 0; i < 3; i++) await seed({ state: 'Kano', platform: 'youtube', language: 'ha' });
    // Oyo: 2 flagged, below the minimum volume
    for (let i = 0; i < 2; i++) await seed({ state: 'Oyo' });
    // no state / unrecognised state / other run / too old
    await seed({ state: null });
    await seed({ state: 'Atlantis', queue: 'none', categories: [] });
    await seed({ state: 'Lagos', isMock: false });
    await seed({ state: 'Lagos', postedAt: week(15) });

    const g = GeoDtoSchema.parse(await service().geo(true));
    expect(g).toMatchObject({ windowDays: 7, surgeThresholdPct: 50, minCount: 3 });
    expect(g.states).toHaveLength(37);
    const st = (n: string) => g.states.find((s) => s.state === n)!;

    expect(st('Lagos')).toMatchObject({
      total: 7,
      flagged: 6,
      previousFlagged: 3,
      changePct: 100,
      newActivity: false,
      surge: true,
      density: 1,
      dominantPlatform: 'x',
      dominantLanguage: 'en',
    });
    expect(st('Lagos').topCategories).toEqual([
      { id: 'fake_cure_prevention', count: 4 },
      { id: 'burial_resistance', count: 2 },
    ]);
    expect(st('Lagos').lgas.map((l) => [l.lga, l.flagged, l.previousFlagged, l.surge])).toEqual([
      ['Ikeja', 4, 3, false], // +33%
      ['Surulere', 2, 0, false], // new but below the minimum volume
    ]);
    expect(st('Rivers')).toMatchObject({ flagged: 6, previousFlagged: 4, changePct: 50, surge: false });
    expect(st('Kano')).toMatchObject({
      flagged: 3,
      previousFlagged: 0,
      changePct: null,
      newActivity: true,
      surge: true,
      dominantPlatform: 'youtube',
      dominantLanguage: 'ha',
    });
    expect(st('Oyo')).toMatchObject({ flagged: 2, surge: false });
    expect(st('Kano').density).toBe(0.5);
    expect(st('Zamfara')).toMatchObject({ total: 0, flagged: 0, density: 0, lgas: [] });

    expect(g.unlocated).toEqual({ total: 2, flagged: 1 });
    expect(g.totals).toEqual({ total: 7 + 6 + 3 + 2 + 2, flagged: 6 + 6 + 3 + 2 + 1 });
  });

  it('is scoped to the current run', async () => {
    await seed({ state: 'Lagos', isMock: false });
    expect((await service().geo(true)).totals).toEqual({ total: 0, flagged: 0 });
    expect((await service().geo(false)).totals).toEqual({ total: 1, flagged: 1 });
  });

  it('the surge rule is configurable', async () => {
    for (let i = 0; i < 5; i++) await seed({ state: 'Lagos' });
    for (let i = 0; i < 4; i++) await seed({ state: 'Lagos', postedAt: week(9) });
    const strict = await service({ geo: { surgeThreshold: 0.5, minCount: 3 } }).geo(true);
    const sensitive = await service({ geo: { surgeThreshold: 0.1, minCount: 3 } }).geo(true);
    expect(strict.states.find((s) => s.state === 'Lagos')!.surge).toBe(false); // +25%
    expect(sensitive.states.find((s) => s.state === 'Lagos')!.surge).toBe(true);
    expect(sensitive.surgeThresholdPct).toBe(10);
  });
});

describe('model health', () => {
  type Spec = SeedSpec & {
    review?: Array<{
      decision: 'confirmed' | 'rejected' | 'corrected';
      labels?: string[];
      daysAgo?: number;
      isMock?: boolean;
    }>;
  };

  /** Seeds a post and (optionally) analyst reviews for it. Reviews are inserted oldest first. */
  async function reviewed(spec: Spec) {
    const { review = [], ...rest } = spec;
    const s = await seed(rest);
    for (const r of review) {
      await AnalystReviewModel.create({
        postId: s.post._id,
        classificationId: s.classification!._id,
        reviewer: 'analyst-1',
        organizationId: ORG,
        decision: r.decision,
        correction: r.decision === 'corrected' ? { labels: r.labels ?? [] } : null,
        taxonomyVersion: 'ebola-tax-1.0',
        isMock: r.isMock ?? true,
        createdAt: new Date(NOW.getTime() - (r.daysAgo ?? 1) * DAY),
      });
    }
    return s;
  }

  async function seedScenario() {
    const f = ['fake_cure_prevention'];
    await reviewed({ categories: f, platform: 'x', language: 'en', review: [{ decision: 'confirmed' }] }); // 1 TP
    await reviewed({ categories: f, platform: 'x', language: 'en', review: [{ decision: 'confirmed' }] }); // 2 TP
    await reviewed({ categories: f, platform: 'x', language: 'pcm', review: [{ decision: 'rejected' }] }); // 3 FP
    await reviewed({
      categories: ['burial_resistance'],
      platform: 'bluesky',
      language: 'pcm',
      review: [{ decision: 'corrected', labels: ['outbreak_denial'] }],
    }); // 4
    await reviewed({
      queue: 'none',
      categories: [],
      platform: 'bluesky',
      language: 'ha',
      review: [{ decision: 'rejected' }],
    }); // 5 FN
    await reviewed({
      queue: 'none',
      categories: [],
      platform: 'youtube',
      language: 'ha',
      review: [{ decision: 'confirmed' }],
    }); // 6 TN
    await reviewed({
      categories: f,
      platform: 'youtube',
      language: 'en',
      review: [
        { decision: 'rejected', daysAgo: 3 },
        { decision: 'confirmed', daysAgo: 1 },
      ],
    }); // 7: latest review wins
    await seed({ categories: f }); // never reviewed: not in the sample
  }

  it('precision / recall / F1 come only from the latest analyst review per post, with the sample size and caveat', async () => {
    await seedScenario();
    const h = ModelHealthDtoSchema.parse(await service().modelHealth(30, true));
    const r = h.reviewDerived;
    expect(r.sampleSize).toBe(7);
    expect(r.caveat).toBe(REVIEW_CAVEAT);
    expect(r.caveat).toContain('only from analyst reviews');
    // flagged+agreed: posts 1 2 4 7 = TP; flagged+disagreed: 3 = FP; unflagged but analyst says misinformation: 5 = FN; 6 = TN
    expect(r.overall).toEqual({ tp: 4, fp: 1, fn: 1, tn: 1, precision: 0.8, recall: 0.8, f1: 0.8 });

    const cls = Object.fromEntries(r.perClass.map((c) => [c.id, c]));
    expect(cls.fake_cure_prevention).toMatchObject({
      tp: 3,
      fp: 1,
      fn: 0,
      predicted: 4,
      support: 3,
      precision: 0.75,
      recall: 1,
    });
    expect(cls.fake_cure_prevention!.f1).toBeCloseTo(6 / 7, 10);
    expect(cls.burial_resistance).toMatchObject({
      tp: 0,
      fp: 1,
      fn: 0,
      predicted: 1,
      support: 0,
      precision: 0,
      recall: null,
      f1: 0,
    });
    expect(cls.outbreak_denial).toMatchObject({
      tp: 0,
      fp: 0,
      fn: 1,
      predicted: 0,
      support: 1,
      precision: null,
      recall: 0,
      f1: 0,
    });
  });

  it('override rate (rejected or corrected) by class and by platform; language agreement', async () => {
    await seedScenario();
    const h = await service().modelHealth(30, true);
    expect(h.overrideRate.overall).toEqual({ reviewed: 7, overridden: 3, rate: 3 / 7 });
    expect(h.overrideRate.byClass).toEqual([
      { key: 'fake_cure_prevention', reviewed: 4, overridden: 1, rate: 0.25 },
      { key: 'not_flagged', reviewed: 2, overridden: 1, rate: 0.5 },
      { key: 'burial_resistance', reviewed: 1, overridden: 1, rate: 1 },
    ]);
    expect(h.overrideRate.byPlatform).toEqual([
      { key: 'x', reviewed: 3, overridden: 1, rate: 1 / 3 },
      { key: 'bluesky', reviewed: 2, overridden: 2, rate: 1 },
      { key: 'youtube', reviewed: 2, overridden: 0, rate: 0 },
    ]);
    expect(h.languageAgreement).toEqual([
      { language: 'en', reviewed: 3, agreed: 3, rate: 1 },
      { language: 'ha', reviewed: 2, agreed: 1, rate: 0.5 },
      { language: 'pcm', reviewed: 2, agreed: 0, rate: 0 },
    ]);
  });

  it('no reviews: nothing is invented (null metrics, empty tables) but the caveat is still there', async () => {
    await seed({});
    const h = await service().modelHealth(30, true);
    expect(h.reviewDerived.sampleSize).toBe(0);
    expect(h.reviewDerived.overall).toEqual({
      tp: 0,
      fp: 0,
      fn: 0,
      tn: 0,
      precision: null,
      recall: null,
      f1: null,
    });
    expect(h.reviewDerived.perClass).toEqual([]);
    expect(h.overrideRate.overall).toEqual({ reviewed: 0, overridden: 0, rate: null });
    expect(h.languageAgreement).toEqual([]);
    expect(h.reviewDerived.caveat).toBe(REVIEW_CAVEAT);
  });

  it('reviews outside the window or the run are excluded', async () => {
    await reviewed({ review: [{ decision: 'confirmed', daysAgo: 40 }] });
    await reviewed({ review: [{ decision: 'confirmed', isMock: false }] });
    await reviewed({ review: [{ decision: 'confirmed', daysAgo: 2 }] });
    expect((await service().modelHealth(30, true)).reviewDerived.sampleSize).toBe(1);
    expect((await service().modelHealth(60, true)).reviewDerived.sampleSize).toBe(2);
  });

  it('three-class reviews: a correction to "factual" means the model was wrong', async () => {
    const mk = (decision: 'confirmed' | 'rejected' | 'corrected', labels?: string[]) =>
      reviewed({ contract: 'threeclass-v0', categories: ['misinformation'], review: [{ decision, labels }] });
    await mk('confirmed');
    await mk('corrected', ['misinformation']);
    await mk('corrected', ['factual']);
    await mk('rejected');
    const r = (await service().modelHealth(30, true)).reviewDerived;
    expect(r.overall).toMatchObject({ tp: 2, fp: 2, fn: 0, precision: 0.5, recall: 1 });
    expect(r.perClass).toHaveLength(1);
    expect(r.perClass[0]).toMatchObject({ id: 'misinformation', tp: 2, fp: 2 });
  });

  it('latency percentiles (nearest-rank) and the confidence histogram come from classifications in the window', async () => {
    for (let i = 1; i <= 10; i++) await seed({ latencyMs: i * 100, score: i === 10 ? 1 : i / 10 - 0.05 });
    await seed({ latencyMs: 99_999, createdAt: new Date(NOW.getTime() - 40 * DAY) }); // outside the window
    await seed({ latencyMs: 99_999, isMock: false }); // other run
    const h = await service().modelHealth(30, true);
    expect(h.latency).toEqual({ unit: 'ms', n: 10, p50: 500, p95: 1000, p99: 1000 });
    expect(h.confidence.n).toBe(10);
    expect(h.confidence.basis).toContain('top category score');
    expect(h.confidence.bins).toHaveLength(10);
    // scores 0.05, 0.15 ... 0.85, then 0.95 -> 1.0: one per bin, the last bin also holds the 1.0
    expect(h.confidence.bins.map((b) => b.count)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('lists the model versions seen, with counts', async () => {
    await seed({ modelVersion: '1.0.0' });
    await seed({ modelVersion: '1.0.0' });
    await seed({ modelVersion: '1.1.0' });
    expect((await service().modelHealth(30, true)).models).toEqual([
      { modelName: 'mock-ebola-clf', modelVersion: '1.0.0', classifications: 2 },
      { modelName: 'mock-ebola-clf', modelVersion: '1.1.0', classifications: 1 },
    ]);
  });
});

describe('HTTP routes', () => {
  type Started = Awaited<ReturnType<typeof startApp>>;
  let ctx: Started;
  const api = () => ctx.api();
  const nowish = () => new Date(Date.now() - 2 * HOUR);

  beforeAll(async () => {
    ctx = await startApp();
  }, 120_000);
  afterAll(async () => ctx.application.stop());

  it('every endpoint answers with a schema-valid body', async () => {
    await seedPost({ postedAt: nowish(), state: 'Lagos', lga: 'Ikeja' });
    expect(SummaryDtoSchema.safeParse((await api().get('/api/analytics/summary')).body).success).toBe(true);
    expect(TimeseriesDtoSchema.safeParse((await api().get('/api/analytics/timeseries')).body).success).toBe(
      true,
    );
    expect(BreakdownDtoSchema.safeParse((await api().get('/api/analytics/breakdown')).body).success).toBe(
      true,
    );
    expect(ClustersDtoSchema.safeParse((await api().get('/api/analytics/clusters')).body).success).toBe(true);
    expect(GeoDtoSchema.safeParse((await api().get('/api/analytics/geo')).body).success).toBe(true);
    expect(
      ModelHealthDtoSchema.safeParse((await api().get('/api/analytics/model-health')).body).success,
    ).toBe(true);
  });

  it('days is validated (1..365) with sensible defaults', async () => {
    for (const path of ['breakdown', 'model-health']) {
      for (const days of ['0', '366', 'abc', '-1']) {
        expect((await api().get(`/api/analytics/${path}?days=${days}`)).status, `${path}?days=${days}`).toBe(
          400,
        );
      }
    }
    expect((await api().get('/api/analytics/breakdown')).body.windowDays).toBe(7);
    expect((await api().get('/api/analytics/model-health')).body.windowDays).toBe(30);
    expect((await api().get('/api/analytics/breakdown?days=90')).body.windowDays).toBe(90);
  });

  it('geo CSV: spreadsheet content type, dated filename, header row, one row per state and LGA', async () => {
    for (let i = 0; i < 3; i++) await seedPost({ postedAt: nowish(), state: 'Kano', lga: 'Fagge' });
    const res = await api().get('/api/analytics/geo?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="geo-surge-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'state,lga,posts,flagged,previous_week_flagged,change_pct,new_activity,surge,dominant_platform,dominant_language,top_categories',
    );
    expect(lines).toContain('Kano,,3,3,0,,true,true,bluesky,en,fake_cure_prevention:3');
    expect(lines).toContain('Kano,Fagge,3,3,0,,true,true,bluesky,en,fake_cure_prevention:3');
    expect((await api().get('/api/analytics/geo?format=xml')).status).toBe(400);
  });

  it('geo CSV neutralises formula injection coming from stored data', async () => {
    await seedPost({ postedAt: nowish(), state: 'Lagos', lga: '=HYPERLINK("http://evil.example")' });
    const csv = (await api().get('/api/analytics/geo?format=csv')).text;
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('analytics are read-only and open; mock and real data stay separate', async () => {
    await seedPost({ postedAt: nowish(), state: 'Lagos', isMock: false });
    const geo = (await api().get('/api/analytics/geo')).body;
    expect(geo.states.find((s: { state: string }) => s.state === 'Lagos').total).toBe(0);
    expect((await api().post('/api/analytics/summary').send({})).status).toBe(404);
  });

  it('model-health always carries the review-derived caveat', async () => {
    const h = (await api().get('/api/analytics/model-health')).body;
    expect(h.reviewDerived.caveat).toContain('only from analyst reviews');
    expect(h.reviewDerived.sampleSize).toBeTypeOf('number');
  });
});
