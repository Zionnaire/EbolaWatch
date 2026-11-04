import { Types } from 'mongoose';
import type { ClassifierClient, ClassifyInput, ClassifyResult } from '../classifier/types.js';
import { findUnknownLabels } from '../classifier/unknownLabels.js';
import type { TaxonomyService } from '../classifier/taxonomy.js';
import type { Classification, DataSource, OperatingMode, RecomputeResult } from '../contracts/api/index.js';
import { ClassificationModel, type ClassificationDoc } from '../models/Classification.js';
import { DecisionModel, type DecisionDoc } from '../models/Decision.js';
import { PostModel, type PostDoc, type Triage } from '../models/Post.js';
import { decide, type DecisionResult } from '../services/decisionEngine.js';
import { toClassification, toPostDto } from '../services/postDto.js';
import type { RulesService } from '../services/rules.js';
import { classifierIsMock } from '../services/runScope.js';
import type { Broadcaster } from '../sockets/index.js';
import { textHash } from '../utils/hashing.js';
import { logger } from '../utils/logger.js';
import type { EnqueueResult, WorkQueue } from './queue.js';

export interface PipelineDeps {
  classifier: ClassifierClient;
  rules: RulesService;
  taxonomy: Pick<TaxonomyService, 'knownCategoryIds' | 'getVersion'>;
  getMode: () => OperatingMode;
  classifierProvenance: () => DataSource['classifier'];
  broadcaster: Pick<Broadcaster, 'emitPost'>;
  overdueHours: number;
  now?: () => Date;
  /** Delays before a `pending` post is tried again. Overridable in tests. */
  retryDelaysMs?: { warming: number; taxonomy: number };
  maxPendingAttempts?: number;
}

const DUPLICATE_KEY = 11000;

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === DUPLICATE_KEY;

/** Categories at or above the threshold recorded in the decision snapshot (what the queue filters on). */
export function overThreshold(
  c: Classification,
  d: Pick<DecisionResult, 'isMisinformation' | 'rulesSnapshot'>,
): string[] {
  if (c.contract === 'threeclass-v0') return d.isMisinformation ? ['misinformation'] : [];
  const thresholds = (d.rulesSnapshot.thresholds ?? {}) as Record<string, number>;
  return c.categories.filter((x) => x.score >= (thresholds[x.label] ?? Infinity)).map((x) => x.label);
}

export function buildTriage(c: Classification, d: DecisionResult): Triage {
  return {
    queue: d.queue,
    finalSeverity: d.finalSeverity,
    priorityScore: d.priorityScore,
    urgent: d.urgent,
    isMisinformation: d.isMisinformation,
    categories: overThreshold(c, d),
    topCategory:
      c.contract === 'threeclass-v0' ? (c.threeClass?.label ?? null) : (c.categories[0]?.label ?? null),
    language: c.language,
    stance: c.stance,
  };
}

/** classify -> decide -> upsert -> emit. The DB is the source of truth; this class is restart-safe. */
export class PipelineService {
  private queue: WorkQueue | null = null;
  /** Posts that came back `pending`: kept out of sweeps until their retry fires. */
  private readonly cooling = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly deps: PipelineDeps) {}

  attachQueue(queue: WorkQueue): void {
    this.queue = queue;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Queue handler. Never throws for per-post problems: each post ends in a defined state. */
  async processBatch(ids: string[]): Promise<void> {
    const oids = ids.map((id) => new Types.ObjectId(id));
    await PostModel.updateMany(
      { _id: { $in: oids }, pipelineStatus: 'pending' },
      { $set: { pipelineStatus: 'classifying' } },
    );
    const posts = (await PostModel.find({
      _id: { $in: oids },
      pipelineStatus: 'classifying',
    }).lean()) as unknown as PostDoc[];
    if (posts.length === 0) return;

    const inputs: ClassifyInput[] = posts.map((p) => ({
      itemId: String(p._id),
      text: p.text,
      platform: p.platform,
      languageHint: p.languageHint ?? null,
    }));

    let results: ClassifyResult[];
    try {
      results = await this.deps.classifier.classify(inputs);
    } catch (err) {
      logger.error({ err }, 'classifier threw unexpectedly');
      results = inputs.map((i) => ({
        itemId: i.itemId,
        outcome: 'error' as const,
        reason: 'unavailable' as const,
        message: 'Classifier failed unexpectedly',
      }));
    }

    const byId = new Map(posts.map((p) => [String(p._id), p]));
    const pending: Array<{ id: string; reason: 'warming' | 'taxonomy_mismatch' | 'taxonomy_unavailable' }> =
      [];

    // Every claimed post must end in a defined state, even if a classifier forgets to answer for it.
    const answered = new Set(results.map((r) => r.itemId));
    const unanswered = posts.filter((p) => !answered.has(String(p._id)));
    if (unanswered.length > 0) {
      logger.error({ count: unanswered.length }, 'classifier returned no result for some posts');
      await PostModel.updateMany(
        { _id: { $in: unanswered.map((p) => p._id) } },
        {
          $set: {
            pipelineStatus: 'classification_error',
            errorDetail: 'missing_result: the classifier returned no result for this post',
          },
        },
      );
    }

    for (const r of results) {
      const post = byId.get(r.itemId);
      if (!post) continue;
      try {
        if (r.outcome === 'classified') {
          await this.applyClassified(post, r);
        } else if (r.outcome === 'pending') {
          await PostModel.updateOne(
            { _id: post._id },
            { $set: { pipelineStatus: 'pending', errorDetail: null } },
          );
          pending.push({ id: r.itemId, reason: r.reason });
        } else {
          await PostModel.updateOne(
            { _id: post._id },
            {
              $set: {
                pipelineStatus: 'classification_error',
                errorDetail: `${r.reason}${r.code ? ` (${r.code})` : ''}: ${r.message}`,
              },
            },
          );
        }
      } catch (err) {
        logger.error({ err, postId: r.itemId }, 'failed to persist classification result');
        await PostModel.updateOne(
          { _id: post._id },
          {
            $set: {
              pipelineStatus: 'classification_error',
              errorDetail: 'persist_failed: could not store the result',
            },
          },
        ).catch(() => undefined);
      }
    }
    for (const p of pending) this.scheduleRetry(p.id, p.reason);
  }

  private async applyClassified(
    post: PostDoc,
    r: Extract<ClassifyResult, { outcome: 'classified' }>,
  ): Promise<void> {
    const c = r.classification;
    const mock = classifierIsMock(this.deps.classifierProvenance());
    const classification = await this.upsertClassification(post, r, mock);
    const { decision } = await this.decideAndStore(post, classification, c, r.unknownLabels);

    const updated = (await PostModel.findById(post._id).lean()) as unknown as PostDoc;
    // only the organizations that may see this post receive it (review state is not shown in a live event)
    this.deps.broadcaster.emitPost(
      toPostDto(updated, c, decision, { now: this.now(), overdueHours: this.deps.overdueHours }),
      {
        visibility: updated.visibility ?? 'global',
        organizationId: updated.organizationId ? String(updated.organizationId) : null,
        state: updated.state ?? null,
      },
    );
  }

  /** Idempotent: a retry of the same (post, modelVersion, taxonomyVersion, textHash) returns the existing row. */
  private async upsertClassification(
    post: PostDoc,
    r: Extract<ClassifyResult, { outcome: 'classified' }>,
    isMock: boolean,
  ): Promise<ClassificationDoc> {
    const c = r.classification;
    const key = {
      postId: post._id,
      modelVersion: c.modelVersion,
      taxonomyVersion: c.taxonomyVersion,
      textHash: textHash(post.text),
    };
    const insert = {
      contract: c.contract,
      modelName: c.modelName,
      isMock,
      output: r.raw,
      normalized: c,
      isRelevant: c.isRelevant,
      stance: c.stance,
      topCategory: c.categories[0]?.label ?? null,
      severityLevel: c.severity?.level ?? null,
      language: c.language,
      createdAt: this.now(),
    };
    try {
      return (await ClassificationModel.findOneAndUpdate(
        key,
        { $setOnInsert: insert },
        { upsert: true, returnDocument: 'after' },
      ).lean()) as unknown as ClassificationDoc;
    } catch (err) {
      // two concurrent upserts of the same key: the loser reads the winner's row
      if (!isDuplicateKey(err)) throw err;
      return (await ClassificationModel.findOne(key).lean()) as unknown as ClassificationDoc;
    }
  }

  /** Computes a decision for the given classification under the current mode and stores it (append-only). */
  private async decideAndStore(
    post: PostDoc,
    classification: ClassificationDoc,
    c: Classification,
    unknownLabels: string[],
  ): Promise<{ decision: DecisionDoc; created: boolean }> {
    const mode = this.deps.getMode();
    const known = this.deps.taxonomy.knownCategoryIds();
    const rules = await this.deps.rules.getFor(c.contract, c.taxonomyVersion, known ? [...known] : undefined);
    const result = decide(
      { classification: c, text: post.text, engagement: post.engagement ?? null, unknownLabels },
      rules,
      mode,
    );

    if (result.rulelessCategories.length > 0) {
      logger.warn(
        { postId: String(post._id), categories: result.rulelessCategories },
        'categories without a rule used the default threshold and floor 0',
      );
    }
    if (result.needsReview) {
      logger.warn(
        { postId: String(post._id), unknownLabels },
        'unknown category label: flagged needs_review',
      );
    }

    // recompute is idempotent: the same classification under the same rules + mode yields the same row
    const inputHash = textHash(JSON.stringify([mode, result.rulesSnapshot]));
    const key = { classificationId: classification._id, inputHash };
    let created = false;
    try {
      const res = await DecisionModel.updateOne(
        key,
        {
          $setOnInsert: {
            postId: post._id,
            mode,
            isMisinformation: result.isMisinformation,
            finalSeverity: result.finalSeverity,
            reasons: result.reasons,
            priorityScore: result.priorityScore,
            urgent: result.urgent,
            queue: result.queue,
            needsReview: result.needsReview,
            rulesSnapshot: result.rulesSnapshot,
            isMock: classification.isMock,
            createdAt: this.now(),
          },
        },
        { upsert: true },
      );
      created = res.upsertedCount > 0;
    } catch (err) {
      // two concurrent upserts of the same key: the loser reads the winner's row
      if (!isDuplicateKey(err)) throw err;
    }
    const decision = (await DecisionModel.findOne(key).lean()) as unknown as DecisionDoc;

    await PostModel.updateOne(
      { _id: post._id },
      {
        $set: {
          latestClassificationId: classification._id,
          latestDecisionId: decision._id,
          triage: buildTriage(c, result),
          pipelineStatus: result.needsReview ? 'needs_review' : 'classified',
          errorDetail: null,
          // mock data = synthetic origin, or classified by a mock classifier. Recomputed from the classification
          // that is now in force, so a provisional stamp made before the model identified itself is corrected.
          isMock: (post.originMock ?? post.isMock) || classification.isMock,
        },
      },
    );
    return { decision, created };
  }

  private scheduleRetry(id: string, reason: 'warming' | 'taxonomy_mismatch' | 'taxonomy_unavailable'): void {
    const delays = this.deps.retryDelaysMs ?? { warming: 15_000, taxonomy: 60_000 };
    const max = this.deps.maxPendingAttempts ?? 20;
    const n = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, n);
    this.cooling.add(id);
    if (n > max) {
      logger.warn(
        { postId: id, reason },
        'giving up automatic retries for now: post stays pending until the next boot',
      );
      return;
    }
    const delay = reason === 'warming' ? delays.warming : delays.taxonomy;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.cooling.delete(id);
      this.requeue(id);
    }, delay);
    timer.unref();
    this.timers.add(timer);
  }

  private requeue(id: string): EnqueueResult {
    return this.queue?.enqueue(id) ?? 'full';
  }

  /** Pulls `pending` posts that are not waiting on a retry into the in-memory queue. */
  async sweep(): Promise<number> {
    if (!this.queue) return 0;
    const room = this.queue.capacityLeft();
    if (room <= 0) return 0;
    const docs = await PostModel.find({
      pipelineStatus: 'pending',
      _id: { $nin: [...this.cooling].map((id) => new Types.ObjectId(id)) },
    })
      .sort({ ingestedAt: 1 })
      .limit(room)
      .select('_id')
      .lean();
    let n = 0;
    for (const d of docs) if (this.requeue(String(d._id)) === 'queued') n++;
    return n;
  }

  /** Called on boot: the DB is the source of truth, so the in-memory queue is rebuilt from it. */
  async rebuildQueue(): Promise<number> {
    await PostModel.updateMany({ pipelineStatus: 'classifying' }, { $set: { pipelineStatus: 'pending' } });
    return this.sweep();
  }

  /**
   * Explicit only: re-runs the decision for each post's latest classification under the current mode and rules.
   * Appends new Decision rows (old ones stay); `changed` counts rows written, `unchanged` those already present.
   */
  async recomputeDecisions(scopeIsMock: boolean): Promise<RecomputeResult> {
    const mode = this.deps.getMode();
    let examined = 0;
    let changed = 0;
    const cursor = PostModel.find({ isMock: scopeIsMock, latestClassificationId: { $ne: null } })
      .lean()
      .cursor();
    for await (const raw of cursor) {
      const post = raw as unknown as PostDoc;
      const doc = (await ClassificationModel.findById(
        post.latestClassificationId,
      ).lean()) as unknown as ClassificationDoc | null;
      if (!doc) continue;
      const c = toClassification(doc.normalized, `classification ${String(doc._id)}`);
      if (!c) continue;
      let unknownLabels: string[] = [];
      if (c.taxonomyVersion) {
        const tax = await this.deps.taxonomy.getVersion(c.taxonomyVersion);
        if (tax) unknownLabels = findUnknownLabels(c, new Set(tax.categories.map((x) => x.id)));
      }
      const { created } = await this.decideAndStore(post, doc, c, unknownLabels);
      examined++;
      if (created) changed++;
    }
    return { mode, examined, changed, unchanged: examined - changed };
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
