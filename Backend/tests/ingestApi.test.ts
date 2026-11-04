import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostDtoSchema,
  PostListDtoSchema,
  RulesConfigSchema,
  SystemStatusSchema,
  ConnectorDtoSchema,
  IngestResponseSchema,
} from '../src/contracts/api/index.js';
import { ClassificationModel } from '../src/models/Classification.js';
import { DecisionModel } from '../src/models/Decision.js';
import { PostModel } from '../src/models/Post.js';
import { hashAuthor, textHash } from '../src/utils/hashing.js';
import { HASH_SECRET, INGEST_KEY, startApp } from './helpers/app.js';
import { clearCollections, DATA_COLLECTIONS, useMongo } from './helpers/mongo.js';
import { seedPost } from './helpers/seed.js';

useMongo();

type Started = Awaited<ReturnType<typeof startApp>>;
let ctx: Started;

beforeAll(async () => {
  ctx = await startApp();
}, 120_000);
afterAll(async () => ctx.application.stop());
beforeEach(() => clearCollections(DATA_COLLECTIONS));

const post = (n: number, over: Record<string, unknown> = {}) => ({
  platform: 'bluesky',
  sourceId: `src-${n}`,
  authorHandle: `@person_${n}`,
  text: `Synthetic post number ${n} about Ebola`,
  language: 'en',
  postedAt: '2026-10-27T10:00:00.000Z',
  state: 'Lagos',
  lga: 'Ikeja',
  engagement: { likes: 3, reposts: 1, replies: 0 },
  ...over,
});

const ingest = (posts: unknown[], key: string | null = INGEST_KEY) => {
  const r = request(ctx.application.app).post('/api/ingest');
  if (key !== null) r.set('X-Api-Key', key);
  return r.send({ posts });
};

describe('POST /api/ingest: access and validation', () => {
  it('requires the API key', async () => {
    expect((await ingest([post(1)], null)).status).toBe(401);
    expect((await ingest([post(1)], 'wrong-key')).status).toBe(401);
    expect(await PostModel.countDocuments()).toBe(0);
  });

  it('accepts valid posts with 202 and a schema-valid summary', async () => {
    const res = await ingest([post(1), post(2)]);
    expect(res.status).toBe(202);
    expect(IngestResponseSchema.parse(res.body)).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
  });

  it('rejects an empty body, an empty list and an oversized batch with 400', async () => {
    expect(
      (await request(ctx.application.app).post('/api/ingest').set('X-Api-Key', INGEST_KEY).send({})).status,
    ).toBe(400);
    expect((await ingest([])).status).toBe(400);
    const big = await ingest(Array.from({ length: 101 }, (_, i) => post(i)));
    expect(big.status).toBe(400);
    expect(big.body.error.code).toBe('validation_error');
  });

  it('a bad post does not reject the batch: valid ones are accepted, bad ones reported by index', async () => {
    const res = await ingest([
      post(1),
      post(2, { text: '   ' }),
      42,
      post(3, { postedAt: 'yesterday' }),
      post(4, { platform: '' }),
    ]);
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected.map((r: { index: number }) => r.index)).toEqual([1, 2, 3, 4]);
    expect(res.body.rejected[0].reason).toContain('text');
  });

  it('duplicates (same platform + sourceId, case-insensitive platform) are ignored', async () => {
    expect((await ingest([post(1)])).body).toMatchObject({ accepted: 1, duplicates: 0 });
    const again = await ingest([post(1), post(1, { platform: 'Bluesky' }), post(2)]);
    expect(again.body).toMatchObject({ accepted: 1, duplicates: 2 });
    await ctx.application.queue.idle();
    expect(await PostModel.countDocuments()).toBe(2);
  });

  it('a duplicate inside the same batch is counted once', async () => {
    const res = await ingest([post(7), post(7)]);
    expect(res.body.accepted + res.body.duplicates).toBe(2);
    await ctx.application.queue.idle();
    expect(await PostModel.countDocuments({ sourceId: 'src-7' })).toBe(1);
  });
});

describe('POST /api/ingest: privacy', () => {
  const raw = {
    handle: '@ayo_k',
    email: 'ayo.k@mail-example.com',
    phone: '0803 123 4567',
    url: 'https://example.com/private/page?id=77',
  };
  const text = `${raw.handle} says drink salt water. mail ${raw.email} or call ${raw.phone}, see ${raw.url} and bit.ly/xyz789`;

  it('scrubs PII before storage and hashes the author with an HMAC; raw values appear nowhere in the DB', async () => {
    await ingest([post(1, { text, authorHandle: '@Ayo_K_Real' })]);
    await ctx.application.queue.idle();

    const stored = (await PostModel.findOne({ sourceId: 'src-1' }).lean())!;
    expect(stored.text).toBe(
      '[handle] says drink salt water. mail [email] or call [phone], see [url] and [url]',
    );
    expect(stored.authorHash).toBe(hashAuthor(HASH_SECRET, 'bluesky', 'ayo_k_real'));
    expect(stored.authorHash).not.toBe(textHash('bluesky:ayo_k_real'));

    // nothing raw in any collection
    const db = mongoose.connection.db!;
    const dump = JSON.stringify(
      await Promise.all(
        (await db.listCollections().toArray()).map(async (c) => db.collection(c.name).find().toArray()),
      ),
    );
    for (const needle of [
      'ayo_k',
      'Ayo_K_Real',
      'mail-example.com',
      '0803 123 4567',
      'example.com/private',
      'bit.ly',
    ]) {
      expect(dump.toLowerCase()).not.toContain(needle.toLowerCase());
    }
  });

  it('the API never returns raw text or an author field', async () => {
    await ingest([post(1, { text })]);
    await ctx.application.queue.idle();
    const res = await ctx.api().get('/api/posts');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ayo_k');
    expect(body).not.toContain('authorHash');
    expect(body).not.toContain('authorHandle');
  });

  it('a post without an author is fine (null hash); location is coarse and canonicalised', async () => {
    await ingest([
      post(1, { authorHandle: null, state: 'lagos' }),
      post(2, { state: 'abuja', lga: null }),
      post(3, { state: 'Atlantis' }),
      post(4, { state: null, lga: null }),
    ]);
    await ctx.application.queue.idle();
    const states = Object.fromEntries(
      (await PostModel.find().lean()).map((p) => [p.sourceId, [p.state, p.authorHash]]),
    );
    expect(states['src-1']).toEqual(['Lagos', null]);
    expect(states['src-2']![0]).toBe('FCT');
    expect(states['src-3']![0]).toBe('Atlantis'); // unrecognised: kept, never guessed
    expect(states['src-4']![0]).toBeNull();
  });
});

describe('ingest -> scrub -> classify -> decide -> DB -> socket (mock classifier)', () => {
  it('processes every post to a defined end state, stamps isMock, and emits post:classified per post', async () => {
    const before = ctx.ofType('post:classified').length;
    const res = await ingest(Array.from({ length: 12 }, (_, i) => post(i)));
    expect(res.body.accepted).toBe(12);
    await ctx.application.queue.idle();

    const posts = await PostModel.find().lean();
    expect(posts).toHaveLength(12);
    for (const p of posts) {
      expect(['classified', 'needs_review']).toContain(p.pipelineStatus);
      expect(p.isMock).toBe(true); // mock classifier => mock data
      expect(p.latestClassificationId).not.toBeNull();
      expect(p.latestDecisionId).not.toBeNull();
    }
    expect(await ClassificationModel.countDocuments({ isMock: true })).toBe(12);
    expect(await DecisionModel.countDocuments({ isMock: true })).toBe(12);
    expect(ctx.ofType('post:classified').length - before).toBe(12);
  });

  it('GET /api/posts then returns schema-valid DTOs with classification and decision attached', async () => {
    await ingest(Array.from({ length: 6 }, (_, i) => post(i)));
    await ctx.application.queue.idle();
    const res = await ctx.api().get('/api/posts?pageSize=100');
    expect(res.status).toBe(200);
    const list = PostListDtoSchema.parse(res.body);
    expect(list.total).toBe(6);
    for (const p of list.items) {
      expect(p.classification?.contract).toBe('multilabel-v1');
      expect(p.classification?.modelName).toBe('mock-ebola-clf');
      expect(p.decision).not.toBeNull();
    }
    // sorted by priority, highest first
    const scores = list.items.map((p) => p.decision?.priorityScore ?? 0);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('works with the queue capped far below the burst: overflow stays pending in the DB and is swept up', async () => {
    const capped = await startApp({ QUEUE_CAP: '2' });
    try {
      const res = await request(capped.application.app)
        .post('/api/ingest')
        .set('X-Api-Key', INGEST_KEY)
        .send({ posts: Array.from({ length: 9 }, (_, i) => post(100 + i)) });
      expect(res.body.accepted).toBe(9);
      await capped.application.queue.idle();
      const statuses = (await PostModel.find({ sourceId: /^src-10|^src-10/ }).lean()).map(
        (p) => p.pipelineStatus,
      );
      expect(statuses).toHaveLength(9);
      expect(statuses.every((s) => s === 'classified' || s === 'needs_review')).toBe(true);
    } finally {
      await capped.application.stop();
    }
  });

  it('restart safety: pending and stuck-classifying posts in the DB are re-enqueued on boot', async () => {
    const stuck = await seedPost({ classified: false, pipelineStatus: 'classifying' });
    const pending = await seedPost({ classified: false });
    const done = await seedPost();
    const n = await ctx.application.pipeline.rebuildQueue();
    expect(n).toBe(2);
    await ctx.application.queue.idle();
    for (const p of [stuck.post, pending.post]) {
      expect(['classified', 'needs_review']).toContain(
        (await PostModel.findById(p._id).lean())!.pipelineStatus,
      );
    }
    expect(await ClassificationModel.countDocuments({ postId: done.post._id })).toBe(1); // untouched
  });
});

describe('scoping, system status, connectors, rules, taxonomy', () => {
  it('queries are scoped to the current run: real (non-mock) data is invisible while the run is mock', async () => {
    const { post: real } = await seedPost({ isMock: false });
    await seedPost({ isMock: true });
    const list = await ctx.api().get('/api/posts');
    expect(list.body.total).toBe(1);
    expect(list.body.items.map((p: { id: string }) => p.id)).not.toContain(String(real._id));
    expect((await ctx.api().get(`/api/posts/${real._id}`)).status).toBe(404);
  });

  it('GET /api/system/status reflects the wiring: mock classifier, push ingestion, mock generator and dispatcher', async () => {
    const res = await ctx.api().get('/api/system/status');
    const s = SystemStatusSchema.parse(res.body);
    expect(s).toMatchObject({
      modelMode: 'mock',
      modelContract: 'multilabel-v1',
      dataSource: { ingestion: 'push', classifier: 'mock-inprocess', generator: 'mock', dispatcher: 'mock' },
      modelStatus: 'ready',
      operatingMode: 'dormant',
      taxonomyVersion: 'ebola-tax-1.0',
    });
  });

  it('GET /api/connectors lists real statuses from the DB: stubs are not_integrated, feeds follow INGESTION_MODE', async () => {
    const res = await ctx.api().get('/api/connectors');
    const list = res.body.map((c: unknown) => ConnectorDtoSchema.parse(c));
    const by = Object.fromEntries(list.map((c: { id: string; status: string }) => [c.id, c.status]));
    expect(by).toEqual({
      bluesky: 'not_integrated',
      instagram: 'not_integrated',
      'push-api': 'live',
      mock: 'paused',
      twitter: 'not_integrated',
      youtube: 'not_integrated',
    });
    expect(list.find((c: { id: string }) => c.id === 'bluesky').detail).toContain('Not connected yet');
  });

  it('GET /api/rules returns the seeded section 9 rules', async () => {
    const res = await ctx.api().get('/api/rules');
    expect(res.status).toBe(200);
    const rules = res.body.map((r: unknown) => RulesConfigSchema.parse(r));
    const v1 = rules.find((r: { taxonomyVersion: string }) => r.taxonomyVersion === 'ebola-tax-1.0');
    expect(v1.defaultThresholds).toEqual({ dormant: 0.5, surge: 0.4 });
    expect(Object.keys(v1.categories)).toHaveLength(12);
  });

  it('GET /api/taxonomy serves the synced taxonomy', async () => {
    const res = await ctx.api().get('/api/taxonomy');
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(12);
  });

  it('a single post DTO round-trips through its schema', async () => {
    await ingest([post(1)]);
    await ctx.application.queue.idle();
    const list = await ctx.api().get('/api/posts');
    expect(PostDtoSchema.safeParse(list.body.items[0]).success).toBe(true);
  });
});
