import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureTaxonomySource, MemoryTaxonomyRepo, TaxonomyService } from '../src/classifier/taxonomy.js';
import type { ClassifierClient, ClassifyInput, ClassifyResult } from '../src/classifier/types.js';
import {
  PostDtoSchema,
  type Classification,
  type DataSource,
  type OperatingMode,
} from '../src/contracts/api/index.js';
import { ClassificationModel } from '../src/models/Classification.js';
import { DecisionModel } from '../src/models/Decision.js';
import { PostModel } from '../src/models/Post.js';
import { PipelineService, type PipelineDeps } from '../src/pipeline/pipeline.js';
import type { WorkQueue } from '../src/pipeline/queue.js';
import { MemoryRulesRepo, RulesService } from '../src/services/rules.js';
import { clearCollections, DATA_COLLECTIONS, useMongo } from './helpers/mongo.js';
import { recordingBroadcaster } from './helpers/app.js';
import { seedPost } from './helpers/seed.js';

useMongo();

const baseClassification = (over: Partial<Classification> = {}): Classification => ({
  contract: 'multilabel-v1',
  modelName: 'mock-ebola-clf',
  modelVersion: '0.0.0-mock',
  taxonomyVersion: 'ebola-tax-1.0',
  isRelevant: true,
  relevanceConfidence: 0.95,
  language: 'en',
  stance: 'endorses',
  categories: [{ label: 'fake_cure_prevention', score: 0.88 }],
  severity: { level: 3, confidence: 0.7, distribution: [0.02, 0.03, 0.1, 0.6, 0.25] },
  threeClass: null,
  truncated: false,
  latencyMs: 120,
  ...over,
});

const classified = (
  itemId: string,
  c: Classification = baseClassification(),
  unknownLabels: string[] = [],
): ClassifyResult => ({
  itemId,
  outcome: 'classified',
  classification: c,
  raw: { item_id: itemId, status: 'completed', note: 'full validated model output' },
  model: { name: c.modelName, version: c.modelVersion, taxonomyVersion: c.taxonomyVersion },
  unknownLabels,
});

class Scripted implements ClassifierClient {
  readonly kind = 'inprocess' as const;
  readonly contract = 'multilabel-v1' as const;
  calls: ClassifyInput[][] = [];
  constructor(public script: (i: ClassifyInput) => ClassifyResult) {}
  classify(inputs: ClassifyInput[]): Promise<ClassifyResult[]> {
    this.calls.push(inputs);
    return Promise.resolve(inputs.map(this.script));
  }
}

async function makeService(
  classifier: ClassifierClient,
  over: Partial<PipelineDeps> & { mode?: { current: OperatingMode } } = {},
) {
  const taxonomy = new TaxonomyService(new FixtureTaxonomySource('multilabel-v1'), new MemoryTaxonomyRepo());
  await taxonomy.resync();
  const rec = recordingBroadcaster();
  const mode = over.mode ?? { current: 'dormant' as OperatingMode };
  const queue = { enqueue: vi.fn(() => 'queued' as const), capacityLeft: vi.fn(() => 100) };
  const service = new PipelineService({
    classifier,
    rules: new RulesService(new MemoryRulesRepo()),
    taxonomy,
    getMode: () => mode.current,
    classifierProvenance: () => 'mock-inprocess' as DataSource['classifier'],
    broadcaster: rec.broadcaster,
    overdueHours: 48,
    retryDelaysMs: { warming: 25, taxonomy: 25 },
    ...over,
  });
  service.attachQueue(queue as unknown as WorkQueue);
  return { service, rec, queue, mode };
}

const idOf = (p: { _id: unknown }) => String(p._id);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => clearCollections(DATA_COLLECTIONS));

describe('PipelineService: classified path', () => {
  it('stores classification + decision, links them to the post, and emits post:classified', async () => {
    const { post } = await seedPost({ classified: false });
    const clf = new Scripted((i) => classified(i.itemId));
    const { service, rec } = await makeService(clf);

    await service.processBatch([idOf(post)]);

    const stored = (await PostModel.findById(post._id).lean())!;
    expect(stored.pipelineStatus).toBe('classified');
    expect(stored.latestClassificationId).not.toBeNull();
    expect(stored.latestDecisionId).not.toBeNull();
    expect(stored.triage).toMatchObject({
      queue: 'review',
      finalSeverity: 3,
      urgent: false,
      topCategory: 'fake_cure_prevention',
      categories: ['fake_cure_prevention'],
      language: 'en',
      stance: 'endorses',
    });

    const cls = (await ClassificationModel.find({ postId: post._id }).lean())!;
    expect(cls).toHaveLength(1);
    expect(cls[0]).toMatchObject({
      contract: 'multilabel-v1',
      modelVersion: '0.0.0-mock',
      taxonomyVersion: 'ebola-tax-1.0',
      isMock: true,
      isRelevant: true,
      stance: 'endorses',
      topCategory: 'fake_cure_prevention',
      severityLevel: 3,
    });
    expect((cls[0]!.output as { note: string }).note).toBe('full validated model output'); // whole validated output kept as Mixed

    const dec = await DecisionModel.find({ postId: post._id }).lean();
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({
      isMisinformation: true,
      finalSeverity: 3,
      queue: 'review',
      mode: 'dormant',
    });
    expect(dec[0]!.rulesSnapshot).toMatchObject({
      mode: 'dormant',
      thresholds: { fake_cure_prevention: 0.5 },
      floors: { fake_cure_prevention: 3 },
    });

    const events = rec.ofType('post:classified');
    expect(events).toHaveLength(1);
    expect(PostDtoSchema.safeParse(events[0]!.payload).success).toBe(true);
  });

  it('is idempotent: re-processing the same (post, model, taxonomy, text) adds no rows', async () => {
    const { post } = await seedPost({ classified: false });
    const { service } = await makeService(new Scripted((i) => classified(i.itemId)));
    await service.processBatch([idOf(post)]);
    await PostModel.updateOne({ _id: post._id }, { $set: { pipelineStatus: 'pending' } });
    await service.processBatch([idOf(post)]);
    expect(await ClassificationModel.countDocuments({ postId: post._id })).toBe(1);
    expect(await DecisionModel.countDocuments({ postId: post._id })).toBe(1);
  });

  it('a new model version appends a second classification and keeps the first (history)', async () => {
    const { post } = await seedPost({ classified: false });
    let version = '1.0.0';
    const { service } = await makeService(
      new Scripted((i) => classified(i.itemId, baseClassification({ modelVersion: version }))),
    );
    await service.processBatch([idOf(post)]);
    version = '1.1.0';
    await PostModel.updateOne({ _id: post._id }, { $set: { pipelineStatus: 'pending' } });
    await service.processBatch([idOf(post)]);
    const all = await ClassificationModel.find({ postId: post._id }).sort({ createdAt: 1 }).lean();
    expect(all.map((c) => c.modelVersion)).toEqual(['1.0.0', '1.1.0']);
    const stored = (await PostModel.findById(post._id).lean())!;
    expect(String(stored.latestClassificationId)).toBe(String(all[1]!._id));
  });

  it('the unique indexes reject duplicate classification and decision keys', async () => {
    const { classification, decision } = await seedPost();
    await expect(
      ClassificationModel.create({
        postId: classification!.postId,
        contract: 'multilabel-v1',
        modelName: 'm',
        modelVersion: classification!.modelVersion,
        taxonomyVersion: classification!.taxonomyVersion,
        textHash: classification!.textHash,
        isMock: true,
        normalized: {},
      }),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      DecisionModel.create({
        postId: decision!.postId,
        classificationId: decision!.classificationId,
        inputHash: decision!.inputHash,
        mode: 'dormant',
        isMisinformation: false,
        queue: 'none',
        rulesSnapshot: {},
        isMock: true,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('only claims posts that are pending; others are left alone', async () => {
    const { post } = await seedPost({ pipelineStatus: 'classification_error', classified: false });
    const clf = new Scripted((i) => classified(i.itemId));
    const { service } = await makeService(clf);
    await service.processBatch([idOf(post)]);
    expect(clf.calls).toHaveLength(0);
    expect((await PostModel.findById(post._id).lean())!.pipelineStatus).toBe('classification_error');
  });

  it('sends only scrubbed text, platform and hint to the classifier (never ids or author data)', async () => {
    const { post } = await seedPost({
      classified: false,
      text: 'scrubbed [handle] text',
      platform: 'youtube',
    });
    const clf = new Scripted((i) => classified(i.itemId));
    const { service } = await makeService(clf);
    await service.processBatch([idOf(post)]);
    expect(clf.calls[0]![0]).toEqual({
      itemId: idOf(post),
      text: 'scrubbed [handle] text',
      platform: 'youtube',
      languageHint: null,
    });
  });
});

describe('PipelineService: unknown labels, pending, errors', () => {
  it('an unknown category label flags the post needs_review (and the decision), without crashing', async () => {
    const { post } = await seedPost({ classified: false });
    const c = baseClassification({
      categories: [
        { label: 'brand_new', score: 0.95 },
        { label: 'fake_cure_prevention', score: 0.1 },
      ],
    });
    const { service, rec } = await makeService(new Scripted((i) => classified(i.itemId, c, ['brand_new'])));
    await service.processBatch([idOf(post)]);
    expect((await PostModel.findById(post._id).lean())!.pipelineStatus).toBe('needs_review');
    const dec = (await DecisionModel.findOne({ postId: post._id }).lean())!;
    expect(dec.needsReview).toBe(true);
    expect(dec.reasons.join(' ')).toContain('Unknown category label');
    expect(rec.ofType('post:classified')).toHaveLength(1);
  });

  it('pending (warming): the post stays pending, is not swept while cooling, and is re-enqueued later', async () => {
    const { post } = await seedPost({ classified: false });
    const clf = new Scripted((i) => ({ itemId: i.itemId, outcome: 'pending', reason: 'warming' }));
    const { service, queue } = await makeService(clf);
    await service.processBatch([idOf(post)]);
    const stored = (await PostModel.findById(post._id).lean())!;
    expect(stored.pipelineStatus).toBe('pending');
    expect(stored.errorDetail).toBeNull();
    expect(await ClassificationModel.countDocuments({ postId: post._id })).toBe(0);

    // cooling: the sweeper must not hammer a warming model
    expect(await service.sweep()).toBe(0);
    expect(queue.enqueue).not.toHaveBeenCalled();

    await wait(60);
    expect(queue.enqueue).toHaveBeenCalledWith(idOf(post));
    expect(await service.sweep()).toBe(1); // no longer cooling
    service.stop();
  });

  it('gives up automatic retries after maxPendingAttempts (stays pending, never errors)', async () => {
    const { post } = await seedPost({ classified: false });
    const clf = new Scripted((i) => ({ itemId: i.itemId, outcome: 'pending', reason: 'taxonomy_mismatch' }));
    const { service, queue } = await makeService(clf, { maxPendingAttempts: 1 });
    await service.processBatch([idOf(post)]); // attempt 1 -> scheduled
    await PostModel.updateOne({ _id: post._id }, { $set: { pipelineStatus: 'pending' } });
    await wait(60);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    await service.processBatch([idOf(post)]); // attempt 2 > max -> no timer
    await wait(60);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect((await PostModel.findById(post._id).lean())!.pipelineStatus).toBe('pending');
    service.stop();
  });

  it('error outcome: post becomes classification_error with a readable detail; nothing is classified or emitted', async () => {
    const { post } = await seedPost({ classified: false });
    const clf = new Scripted((i) => ({
      itemId: i.itemId,
      outcome: 'error',
      reason: 'invalid_response',
      message: 'Model response did not match the contract',
    }));
    const { service, rec } = await makeService(clf);
    await service.processBatch([idOf(post)]);
    const stored = (await PostModel.findById(post._id).lean())!;
    expect(stored.pipelineStatus).toBe('classification_error');
    expect(stored.errorDetail).toContain('invalid_response');
    expect(stored.errorDetail).toContain('did not match');
    expect(rec.ofType('post:classified')).toHaveLength(0);
  });

  it('item_failed keeps the error code in the detail', async () => {
    const { post } = await seedPost({ classified: false });
    const clf = new Scripted((i) => ({
      itemId: i.itemId,
      outcome: 'error',
      reason: 'item_failed',
      code: 'empty_text',
      message: 'Text was empty',
    }));
    const { service } = await makeService(clf);
    await service.processBatch([idOf(post)]);
    expect((await PostModel.findById(post._id).lean())!.errorDetail).toContain('empty_text');
  });

  it('a mixed batch: every post ends in its own defined state', async () => {
    const [a, b, c] = await Promise.all([
      seedPost({ classified: false }),
      seedPost({ classified: false }),
      seedPost({ classified: false }),
    ]);
    const ids = [idOf(a.post), idOf(b.post), idOf(c.post)];
    const clf = new Scripted((i) =>
      i.itemId === ids[0]
        ? classified(i.itemId)
        : i.itemId === ids[1]
          ? { itemId: i.itemId, outcome: 'pending', reason: 'warming' }
          : { itemId: i.itemId, outcome: 'error', reason: 'unavailable', message: 'down' },
    );
    const { service } = await makeService(clf);
    await service.processBatch(ids);
    const statuses = await Promise.all(
      ids.map(async (id) => (await PostModel.findById(id).lean())!.pipelineStatus),
    );
    expect(statuses).toEqual(['classified', 'pending', 'classification_error']);
    service.stop();
  });

  it('a classifier that throws turns every post into classification_error (never lost)', async () => {
    const { post } = await seedPost({ classified: false });
    const clf: ClassifierClient = {
      kind: 'http',
      contract: 'multilabel-v1',
      classify: () => Promise.reject(new Error('kaboom')),
    };
    const { service } = await makeService(clf);
    await service.processBatch([idOf(post)]);
    expect((await PostModel.findById(post._id).lean())!.pipelineStatus).toBe('classification_error');
  });

  it('a result for a post that was not in the batch is ignored, and a post without any result becomes classification_error', async () => {
    const { post } = await seedPost({ classified: false });
    const clf: ClassifierClient = {
      kind: 'inprocess',
      contract: 'multilabel-v1',
      classify: () => Promise.resolve([classified(new mongoose.Types.ObjectId().toHexString())]),
    };
    const { service } = await makeService(clf);
    await service.processBatch([idOf(post)]);
    const stored = (await PostModel.findById(post._id).lean())!;
    expect(stored.pipelineStatus).toBe('classification_error');
    expect(stored.errorDetail).toContain('missing_result');
  });
});

describe('PipelineService: mock scoping', () => {
  it('a provisional mock stamp made before the model identified itself is corrected when a live model classifies the post', async () => {
    // stamped mock at ingest (we did not know yet), but the post is real by origin
    const { post } = await seedPost({ classified: false, isMock: true });
    await PostModel.updateOne({ _id: post._id }, { $set: { originMock: false } });
    const { service } = await makeService(new Scripted((i) => classified(i.itemId)), {
      classifierProvenance: () => 'live',
    });
    await service.processBatch([idOf(post)]);
    expect((await PostModel.findById(post._id).lean())!.isMock).toBe(false);
  });

  it('a synthetic post stays mock even when a live model classifies it', async () => {
    const { post } = await seedPost({ classified: false, isMock: true });
    await PostModel.updateOne({ _id: post._id }, { $set: { originMock: true } });
    const { service } = await makeService(new Scripted((i) => classified(i.itemId)), {
      classifierProvenance: () => 'live',
    });
    await service.processBatch([idOf(post)]);
    expect((await PostModel.findById(post._id).lean())!.isMock).toBe(true);
  });

  it('recompute never flips the flag: a real post classified by a mock model stays mock', async () => {
    const { post } = await seedPost({ classified: false, isMock: false });
    await PostModel.updateOne({ _id: post._id }, { $set: { originMock: false } });
    const mode = { current: 'dormant' as OperatingMode };
    const { service } = await makeService(new Scripted((i) => classified(i.itemId)), {
      classifierProvenance: () => 'mock-server',
      mode,
    });
    await service.processBatch([idOf(post)]);
    expect((await PostModel.findById(post._id).lean())!.isMock).toBe(true);
    mode.current = 'surge';
    await service.recomputeDecisions(true);
    expect((await PostModel.findById(post._id).lean())!.isMock).toBe(true);
  });

  it('a post touched by a mock classifier becomes mock data, and the classification is stamped mock', async () => {
    const { post } = await seedPost({ classified: false, isMock: false });
    const { service } = await makeService(new Scripted((i) => classified(i.itemId)), {
      classifierProvenance: () => 'mock-server',
    });
    await service.processBatch([idOf(post)]);
    expect((await PostModel.findById(post._id).lean())!.isMock).toBe(true);
    expect((await ClassificationModel.findOne({ postId: post._id }).lean())!.isMock).toBe(true);
    expect((await DecisionModel.findOne({ postId: post._id }).lean())!.isMock).toBe(true);
  });

  it('a live classifier keeps real data real', async () => {
    const { post } = await seedPost({ classified: false, isMock: false });
    const { service } = await makeService(new Scripted((i) => classified(i.itemId)), {
      classifierProvenance: () => 'live',
    });
    await service.processBatch([idOf(post)]);
    expect((await PostModel.findById(post._id).lean())!.isMock).toBe(false);
    expect((await ClassificationModel.findOne({ postId: post._id }).lean())!.isMock).toBe(false);
  });
});

describe('PipelineService: modes, recompute, restart safety', () => {
  const borderline = baseClassification({ categories: [{ label: 'fake_cure_prevention', score: 0.45 }] });

  it('the mode in force is recorded on each decision (dormant 0.5 vs surge 0.4)', async () => {
    const { post } = await seedPost({ classified: false });
    const mode = { current: 'surge' as OperatingMode };
    const { service } = await makeService(new Scripted((i) => classified(i.itemId, borderline)), { mode });
    await service.processBatch([idOf(post)]);
    const dec = (await DecisionModel.findOne({ postId: post._id }).lean())!;
    expect(dec).toMatchObject({ mode: 'surge', isMisinformation: true, queue: 'review' });
    expect(dec.rulesSnapshot).toMatchObject({ mode: 'surge', thresholds: { fake_cure_prevention: 0.4 } });
  });

  it('changing the mode never rewrites old decisions; recompute appends new ones explicitly and idempotently', async () => {
    const { post } = await seedPost({ classified: false });
    const mode = { current: 'dormant' as OperatingMode };
    const { service } = await makeService(new Scripted((i) => classified(i.itemId, borderline)), { mode });
    await service.processBatch([idOf(post)]);
    const before = (await DecisionModel.findOne({ postId: post._id }).lean())!;
    expect(before).toMatchObject({ isMisinformation: false, queue: 'none' });
    expect((await PostModel.findById(post._id).lean())!.triage).toMatchObject({ queue: 'none' });

    // mode change alone: nothing is rewritten
    mode.current = 'surge';
    expect(await DecisionModel.countDocuments({ postId: post._id })).toBe(1);
    expect((await PostModel.findById(post._id).lean())!.triage).toMatchObject({ queue: 'none' });

    // explicit recompute appends a new decision and repoints the post
    const first = await service.recomputeDecisions(true);
    expect(first).toEqual({ mode: 'surge', examined: 1, changed: 1, unchanged: 0 });
    expect(await DecisionModel.countDocuments({ postId: post._id })).toBe(2);
    expect(await DecisionModel.findById(before._id).lean()).toMatchObject({
      isMisinformation: false,
      mode: 'dormant',
    }); // old row untouched
    const after = (await PostModel.findById(post._id).lean())!;
    expect(after.triage).toMatchObject({ queue: 'review', isMisinformation: true });
    expect(String(after.latestDecisionId)).not.toBe(String(before._id));

    // idempotent
    expect(await service.recomputeDecisions(true)).toMatchObject({ examined: 1, changed: 0, unchanged: 1 });
    expect(await DecisionModel.countDocuments({ postId: post._id })).toBe(2);

    // back to dormant: reuses the original row, no new one
    mode.current = 'dormant';
    expect(await service.recomputeDecisions(true)).toMatchObject({ changed: 0, unchanged: 1 });
    expect(String((await PostModel.findById(post._id).lean())!.latestDecisionId)).toBe(String(before._id));
  });

  it('recompute is scoped to the current run and skips unclassified posts', async () => {
    await seedPost({ classified: false });
    await seedPost({ isMock: false });
    const { service } = await makeService(new Scripted((i) => classified(i.itemId)));
    expect(await service.recomputeDecisions(true)).toMatchObject({ examined: 0 });
    expect(await service.recomputeDecisions(false)).toMatchObject({ examined: 1 });
  });

  it('boot rebuild resets classifying -> pending and enqueues pending posts, but not classified ones', async () => {
    const stuck = await seedPost({ classified: false, pipelineStatus: 'classifying' });
    const pending = await seedPost({ classified: false });
    const done = await seedPost();
    const { service, queue } = await makeService(new Scripted((i) => classified(i.itemId)));
    const n = await service.rebuildQueue();
    expect(n).toBe(2);
    expect((await PostModel.findById(stuck.post._id).lean())!.pipelineStatus).toBe('pending');
    const enqueued = queue.enqueue.mock.calls.map((c) => (c as unknown[])[0]).sort();
    expect(enqueued).toEqual([idOf(stuck.post), idOf(pending.post)].sort());
    expect(enqueued).not.toContain(idOf(done.post));
  });

  it('sweep respects the free capacity of the queue, oldest first', async () => {
    const old = await seedPost({ classified: false, ingestedAt: new Date('2026-01-01') });
    await seedPost({ classified: false, ingestedAt: new Date('2026-06-01') });
    await seedPost({ classified: false, ingestedAt: new Date('2026-09-01') });
    const { service, queue } = await makeService(new Scripted((i) => classified(i.itemId)));
    queue.capacityLeft.mockReturnValue(1);
    expect(await service.sweep()).toBe(1);
    expect(queue.enqueue).toHaveBeenCalledWith(idOf(old.post));
    queue.enqueue.mockClear();
    queue.capacityLeft.mockReturnValue(0);
    expect(await service.sweep()).toBe(0);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe('PipelineService: three-class contract', () => {
  it('decides from the bands and stores the 3-class output in the neutral shape', async () => {
    const { post } = await seedPost({ classified: false });
    const tc: Classification = {
      contract: 'threeclass-v0',
      modelName: 'mock-legacy-3class',
      modelVersion: '0.0.0-mock',
      taxonomyVersion: null,
      isRelevant: true,
      relevanceConfidence: 0.95,
      language: 'en',
      stance: null,
      categories: [],
      severity: null,
      threeClass: {
        label: 'misinformation',
        probabilities: { misinformation: 0.93, factual: 0.05, irrelevant: 0.02 },
        entropy: 0.3,
      },
      truncated: false,
      latencyMs: 90,
    };
    const { service } = await makeService(new Scripted((i) => classified(i.itemId, tc)));
    await service.processBatch([idOf(post)]);
    const stored = (await PostModel.findById(post._id).lean())!;
    expect(stored.triage).toMatchObject({
      queue: 'review',
      finalSeverity: 3,
      urgent: true,
      categories: ['misinformation'],
      topCategory: 'misinformation',
    });
    expect((await DecisionModel.findOne({ postId: post._id }).lean())!.rulesSnapshot).toMatchObject({
      contract: 'threeclass-v0',
      taxonomyVersion: 'threeclass-v0',
    });
  });
});
