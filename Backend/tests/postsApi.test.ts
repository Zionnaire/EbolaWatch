import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostDetailDtoSchema, PostListDtoSchema, RecomputeResultSchema } from '../src/contracts/api/index.js';
import { AnalystReviewModel } from './helpers/anyTenant.js';
import { ClassificationModel } from '../src/models/Classification.js';
import { DecisionModel } from '../src/models/Decision.js';
import { MongoSystemStateRepo } from '../src/services/systemState.js';
import { PostModel } from '../src/models/Post.js';
import { INGEST_KEY, startApp } from './helpers/app.js';
import { clearCollections, DATA_COLLECTIONS, useMongo } from './helpers/mongo.js';
import { seedPost, setSeedOrg } from './helpers/seed.js';

useMongo();

type Started = Awaited<ReturnType<typeof startApp>>;
let ctx: Started;
const api = () => ctx.api();

beforeAll(async () => {
  ctx = await startApp();
  setSeedOrg(ctx.org._id); // seeded `reviewStatus` belongs to the default organization
}, 120_000);
afterAll(async () => ctx.application.stop());
beforeEach(async () => {
  await clearCollections(DATA_COLLECTIONS);
  await new MongoSystemStateRepo().save('dormant', null);
  await ctx.application.state.init();
});

const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

describe('GET /api/posts: sorting, paging, validation', () => {
  it('sorts by priority (highest first), then newest; unclassified posts come last', async () => {
    const low = await seedPost({ priorityScore: 10 });
    const high = await seedPost({ priorityScore: 90 });
    const mid = await seedPost({ priorityScore: 50 });
    const unclassified = await seedPost({ classified: false });
    const res = await api().get('/api/posts');
    expect(ids(res.body)).toEqual([
      String(high.post._id),
      String(mid.post._id),
      String(low.post._id),
      String(unclassified.post._id),
    ]);
    const parsed = PostListDtoSchema.parse(res.body);
    expect(parsed.items[3]!.classification).toBeNull();
    expect(parsed.items[3]!.decision).toBeNull();
  });

  it('paginates with a stable total', async () => {
    for (let i = 0; i < 7; i++) await seedPost({ priorityScore: 100 - i });
    const p1 = await api().get('/api/posts?pageSize=3&page=1');
    const p2 = await api().get('/api/posts?pageSize=3&page=2');
    const p3 = await api().get('/api/posts?pageSize=3&page=3');
    expect([p1.body.items.length, p2.body.items.length, p3.body.items.length]).toEqual([3, 3, 1]);
    expect(p1.body.total).toBe(7);
    expect(new Set([...ids(p1.body), ...ids(p2.body), ...ids(p3.body)]).size).toBe(7);
    expect((await api().get('/api/posts?pageSize=3&page=9')).body.items).toEqual([]);
  });

  it('validates the query: bad values are 400 with a validation_error', async () => {
    for (const q of [
      'severity=9',
      'severity=x',
      'pageSize=500',
      'page=0',
      'queue=bogus',
      'overdue=maybe',
      'pipelineStatus=nope',
    ]) {
      const res = await api().get(`/api/posts?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
  });
});

describe('GET /api/posts: filters', () => {
  beforeEach(async () => {
    await seedPost({
      queue: 'review',
      finalSeverity: 4,
      priorityScore: 95,
      urgent: true,
      categories: ['incitement_against_response', 'fake_cure_prevention'],
      language: 'pcm',
      platform: 'bluesky',
      state: 'Lagos',
    });
    await seedPost({
      queue: 'review',
      finalSeverity: 3,
      priorityScore: 70,
      categories: ['fake_cure_prevention'],
      language: 'en',
      platform: 'x',
      state: 'Rivers',
    });
    await seedPost({
      queue: 'information_gap',
      finalSeverity: null,
      priorityScore: 5,
      categories: [],
      language: 'ha',
      platform: 'youtube',
      state: 'Kano',
      stance: 'questions',
    });
    await seedPost({
      queue: 'none',
      finalSeverity: null,
      priorityScore: 0,
      categories: [],
      language: 'en',
      platform: 'bluesky',
      state: 'Lagos',
      reviewStatus: 'confirmed',
    });
  });
  const count = async (q: string) => (await api().get(`/api/posts?${q}`)).body.total as number;

  it('by queue', async () => {
    expect(await count('queue=review')).toBe(2);
    expect(await count('queue=information_gap')).toBe(1);
    expect(await count('queue=none')).toBe(1);
  });
  it('by final severity', async () => {
    expect(await count('severity=4')).toBe(1);
    expect(await count('severity=3')).toBe(1);
    expect(await count('severity=0')).toBe(0);
  });
  it('by category: matches any over-threshold category', async () => {
    expect(await count('category=fake_cure_prevention')).toBe(2);
    expect(await count('category=incitement_against_response')).toBe(1);
    expect(await count('category=nope')).toBe(0);
  });
  it('by language, platform, state (state is case-insensitive via canonical names)', async () => {
    expect(await count('language=en')).toBe(2);
    expect(await count('language=pcm')).toBe(1);
    expect(await count('platform=bluesky')).toBe(2);
    expect(await count('platform=Bluesky')).toBe(2);
    expect(await count('state=Lagos')).toBe(2);
    expect(await count('state=lagos')).toBe(2);
    expect(await count('state=Kano')).toBe(1);
  });
  it('by review status and combined filters', async () => {
    expect(await count('reviewStatus=confirmed')).toBe(1);
    expect(await count('reviewStatus=unreviewed')).toBe(3);
    expect(await count('queue=review&language=en')).toBe(1);
    expect(await count('queue=review&language=en&state=Lagos')).toBe(0);
  });
  it('by pipeline status', async () => {
    await seedPost({ classified: false, pipelineStatus: 'classification_error' });
    expect(await count('pipelineStatus=classification_error')).toBe(1);
    expect(await count('pipelineStatus=classified')).toBe(4);
  });
});

describe('overdue', () => {
  const HOURS = 3_600_000;
  it('is a computed flag: unreviewed + in a queue + older than OVERDUE_HOURS', async () => {
    const old = await seedPost({ queue: 'review', ingestedAt: new Date(Date.now() - 49 * HOURS) });
    const fresh = await seedPost({ queue: 'review', ingestedAt: new Date(Date.now() - 47 * HOURS) });
    const reviewed = await seedPost({
      queue: 'review',
      ingestedAt: new Date(Date.now() - 100 * HOURS),
      reviewStatus: 'confirmed',
    });
    const noQueue = await seedPost({ queue: 'none', ingestedAt: new Date(Date.now() - 100 * HOURS) });
    const gap = await seedPost({ queue: 'information_gap', ingestedAt: new Date(Date.now() - 100 * HOURS) });

    const all = (await api().get('/api/posts?pageSize=100')).body.items as { id: string; overdue: boolean }[];
    const flag = (p: { post: { _id: unknown } }) => all.find((x) => x.id === String(p.post._id))!.overdue;
    expect([flag(old), flag(fresh), flag(reviewed), flag(noQueue), flag(gap)]).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);

    expect(ids((await api().get('/api/posts?overdue=true')).body).sort()).toEqual(
      [String(old.post._id), String(gap.post._id)].sort(),
    );
    const notOverdue = ids((await api().get('/api/posts?overdue=false&pageSize=100')).body);
    expect(notOverdue).toHaveLength(3);
    expect(notOverdue).not.toContain(String(old.post._id));
  });
});

describe('GET /api/posts/:id', () => {
  it('returns post + classification history (newest first, across model versions) + reviews', async () => {
    const { post, classification } = await seedPost({ priorityScore: 60 });
    // an older classification from a previous model version
    const older = await ClassificationModel.create({
      postId: post._id,
      contract: 'multilabel-v1',
      modelName: 'ebola-clf',
      modelVersion: '0.9.0',
      taxonomyVersion: 'ebola-tax-1.0',
      textHash: 'older-hash',
      isMock: true,
      normalized: { ...(classification!.normalized as object), modelVersion: '0.9.0' },
      createdAt: new Date(Date.now() - 86_400_000),
    });
    const res = await api().get(`/api/posts/${post._id}`);
    expect(res.status).toBe(200);
    const detail = PostDetailDtoSchema.parse(res.body);
    expect(detail.history.map((h) => h.classification.modelVersion)).toEqual(['0.0.0-mock', '0.9.0']);
    expect(detail.history[0]!.classificationId).toBe(String(classification!._id));
    expect(detail.history[1]!.classificationId).toBe(String(older._id));
    expect(detail.history[0]!.decision).not.toBeNull();
    expect(detail.history[1]!.decision).toBeNull();
    expect(detail.post.classification?.modelVersion).toBe('0.0.0-mock');
    expect(detail.post.decision?.reasons).toEqual(['seeded']);
    expect(detail.reviews).toEqual([]);
  });

  it('shows the decision currently in force, not merely the newest row', async () => {
    const { post, classification, decision } = await seedPost({ priorityScore: 60 });
    await DecisionModel.create({
      postId: post._id,
      classificationId: classification!._id,
      mode: 'surge',
      inputHash: 'newer',
      isMisinformation: false,
      queue: 'none',
      reasons: ['newer but not in force'],
      rulesSnapshot: {},
      isMock: true,
      createdAt: new Date(Date.now() + 1000),
    });
    const body = (await api().get(`/api/posts/${post._id}`)).body;
    expect(body.post.decision.reasons).toEqual(['seeded']);
    expect(String(body.history[0].decision.reasons)).toBe('seeded');
    void decision;
  });

  it('404 for unknown id, 400 for malformed id', async () => {
    expect((await api().get(`/api/posts/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    const bad = await api().get('/api/posts/not-an-id');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_id');
  });
});

describe('POST /api/posts/:id/review', () => {
  const review = (id: unknown, body: unknown) =>
    api()
      .post(`/api/posts/${id}/review`)
      .send(body as object);

  it('confirm / reject: 201, post.reviewStatus follows, reviewer comes from the auth stub', async () => {
    const { post } = await seedPost();
    const res = await review(post._id, { decision: 'confirmed', note: 'clear fake cure claim' });
    expect(res.status).toBe(201);
    const detail = PostDetailDtoSchema.parse(res.body);
    expect(detail.post.reviewStatus).toBe('confirmed');
    expect(detail.reviews).toHaveLength(1);
    expect(detail.reviews[0]).toMatchObject({
      reviewer: ctx.userId,
      decision: 'confirmed',
      note: 'clear fake cure claim',
      correction: null,
      taxonomyVersion: 'ebola-tax-1.0',
    });

    const res2 = await review(post._id, { decision: 'rejected' });
    expect(res2.body.post.reviewStatus).toBe('rejected');
    expect(res2.body.reviews.map((r: { decision: string }) => r.decision)).toEqual(['rejected', 'confirmed']);
  });

  it("correct: labels are validated against the classification's own taxonomy and stored with its version", async () => {
    const { post } = await seedPost();
    const res = await review(post._id, {
      decision: 'corrected',
      correction: { labels: ['burial_resistance', 'stigma_discrimination'], stance: 'refutes' },
    });
    expect(res.status).toBe(201);
    expect(res.body.post.reviewStatus).toBe('corrected');
    expect(res.body.reviews[0]).toMatchObject({
      decision: 'corrected',
      correction: { labels: ['burial_resistance', 'stigma_discrimination'], stance: 'refutes' },
      taxonomyVersion: 'ebola-tax-1.0',
    });
  });

  it('rejects unknown labels, a missing correction, and a correction on confirm/reject', async () => {
    const { post } = await seedPost();
    const unknown = await review(post._id, {
      decision: 'corrected',
      correction: { labels: ['not_a_category'] },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('invalid_label');
    expect((await review(post._id, { decision: 'corrected' })).status).toBe(400);
    expect((await review(post._id, { decision: 'corrected', correction: { labels: [] } })).status).toBe(400);
    const extra = await review(post._id, {
      decision: 'confirmed',
      correction: { labels: ['burial_resistance'] },
    });
    expect(extra.status).toBe(400);
    expect((await review(post._id, { decision: 'maybe' })).status).toBe(400);
    expect(await AnalystReviewModel.countDocuments()).toBe(0); // nothing half-written
    expect((await PostModel.findById(post._id).lean())!.reviewStatus).toBe('unreviewed');
  });

  it("3-class: a correction must be exactly one of the model's own labels", async () => {
    const { post } = await seedPost({ contract: 'threeclass-v0' });
    expect(
      (await review(post._id, { decision: 'corrected', correction: { labels: ['factual'] } })).status,
    ).toBe(201);
    expect(
      (await review(post._id, { decision: 'corrected', correction: { labels: ['bogus'] } })).status,
    ).toBe(400);
    expect(
      (await review(post._id, { decision: 'corrected', correction: { labels: ['factual', 'irrelevant'] } }))
        .status,
    ).toBe(400);
    const stored = (await AnalystReviewModel.findOne().lean())!;
    expect(stored.taxonomyVersion).toBe('threeclass-v0');
  });

  it('409 for an unclassified post, 404 for unknown, 400 for malformed id', async () => {
    const { post } = await seedPost({ classified: false });
    const res = await review(post._id, { decision: 'confirmed' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_classified');
    expect((await review(new mongoose.Types.ObjectId(), { decision: 'confirmed' })).status).toBe(404);
    expect((await review('nope', { decision: 'confirmed' })).status).toBe(400);
  });

  it('a post outside the current run (real data during a mock run) cannot be reviewed: 404 and nothing is written', async () => {
    const { post } = await seedPost({ isMock: false });
    expect((await review(post._id, { decision: 'confirmed' })).status).toBe(404);
    expect(await AnalystReviewModel.countDocuments()).toBe(0);
    expect((await PostModel.findById(post._id).lean())!.reviewStatus).toBe('unreviewed');
  });

  it('reviews are append-only: updates and deletes are refused at the model level', async () => {
    const { post } = await seedPost();
    await review(post._id, { decision: 'confirmed' });
    await expect(AnalystReviewModel.updateOne({}, { $set: { decision: 'rejected' } })).rejects.toThrow(
      /append-only/,
    );
    await expect(AnalystReviewModel.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(AnalystReviewModel.findOneAndUpdate({}, { $set: { note: 'x' } })).rejects.toThrow(
      /append-only/,
    );
    expect(await AnalystReviewModel.countDocuments()).toBe(1);
  });

  it('a reviewed post leaves the unreviewed queue filter', async () => {
    const { post } = await seedPost({ queue: 'review' });
    expect((await api().get('/api/posts?queue=review&reviewStatus=unreviewed')).body.total).toBe(1);
    await review(post._id, { decision: 'confirmed' });
    expect((await api().get('/api/posts?queue=review&reviewStatus=unreviewed')).body.total).toBe(0);
  });
});

describe('every route needs a session (ingest has its own key)', () => {
  it('requests without a session are refused with 401, reads included; ingest is unaffected', async () => {
    const { post } = await seedPost();
    const anon = ctx.anon();
    expect((await anon.get('/api/posts')).status).toBe(401);
    expect((await anon.get(`/api/posts/${post._id}`)).status).toBe(401);
    expect((await anon.post(`/api/posts/${post._id}/review`).send({ decision: 'confirmed' })).status).toBe(
      401,
    );
    expect((await anon.post('/api/admin/mode').send({ mode: 'surge' })).status).toBe(401);
    expect((await anon.post('/api/admin/recompute-decisions').send({})).status).toBe(401);
    expect((await anon.get('/api/connectors')).status).toBe(401);
    expect((await anon.get('/api/rules')).status).toBe(401);
    const ing = await anon
      .post('/api/ingest')
      .set('X-Api-Key', INGEST_KEY)
      .send({
        posts: [{ platform: 'x', sourceId: 'p1', text: 'hello', postedAt: '2026-10-27T10:00:00Z' }],
      });
    expect(ing.status).toBe(202);
    expect(await AnalystReviewModel.countDocuments()).toBe(0);
  });
});

describe('admin: operating mode and recompute', () => {
  const ingestSome = async (n: number) => {
    await api()
      .post('/api/ingest')
      .set('X-Api-Key', INGEST_KEY)
      .send({
        posts: Array.from({ length: n }, (_, i) => ({
          platform: 'bluesky',
          sourceId: `m-${Date.now()}-${i}`,
          text: `post ${i}`,
          postedAt: '2026-10-27T10:00:00Z',
        })),
      });
    await ctx.application.queue.idle();
  };

  it('POST /api/admin/mode validates, persists, announces, and does NOT rewrite existing decisions', async () => {
    await ingestSome(5);
    const decisionsBefore = await DecisionModel.find().lean();
    const events = ctx.ofType('system:update').length;

    const bad = await api().post('/api/admin/mode').send({ mode: 'panic' });
    expect(bad.status).toBe(400);

    const res = await api().post('/api/admin/mode').send({ mode: 'surge' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'surge', previous: 'dormant' });
    expect((await api().get('/api/system/status')).body.operatingMode).toBe('surge');
    expect(await new MongoSystemStateRepo().load()).toBe('surge'); // persisted, not just in memory
    expect(ctx.ofType('system:update').length).toBe(events + 1);
    expect((ctx.ofType('system:update').at(-1)!.payload as { reason: string }).reason).toBe(
      'operating_mode_changed',
    );

    // old decisions are byte-for-byte the same
    expect(await DecisionModel.find().lean()).toEqual(decisionsBefore);
  });

  it('POST /api/admin/recompute-decisions appends decisions under the new mode, idempotently', async () => {
    await ingestSome(6);
    await api().post('/api/admin/mode').send({ mode: 'surge' });
    const first = await api().post('/api/admin/recompute-decisions').send({});
    expect(first.status).toBe(200);
    const r1 = RecomputeResultSchema.parse(first.body);
    expect(r1).toMatchObject({ mode: 'surge', examined: 6, changed: 6, unchanged: 0 });
    expect(await DecisionModel.countDocuments({ mode: 'surge' })).toBe(6);
    expect(await DecisionModel.countDocuments({ mode: 'dormant' })).toBe(6); // history kept

    const second = RecomputeResultSchema.parse(
      (await api().post('/api/admin/recompute-decisions').send({})).body,
    );
    expect(second).toMatchObject({ examined: 6, changed: 0, unchanged: 6 });
    expect((ctx.ofType('system:update').at(-1)!.payload as { reason: string }).reason).toBe(
      'decisions_recomputed',
    );
  });

  it('every decision records the mode actually used', async () => {
    await ingestSome(3);
    for (const d of await DecisionModel.find().lean()) {
      expect(d.mode).toBe('dormant');
      expect((d.rulesSnapshot as { mode: string }).mode).toBe('dormant');
    }
  });
});
