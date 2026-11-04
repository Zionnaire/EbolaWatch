/**
 * End to end, with nothing mocked inside the application: an in-memory MongoDB, the real Express app, a real
 * Socket.io server (spoken to over a real WebSocket), and, where relevant, the real mock-model HTTP server.
 *   mock connector -> scrub PII -> classify -> decide -> DB -> socket event
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostDtoSchema, SystemStatusSchema } from '../src/contracts/api/index.js';
import { ClassificationModel } from '../src/models/Classification.js';
import { ConnectorModel } from '../src/models/Connector.js';
import { DecisionModel } from '../src/models/Decision.js';
import { PostModel } from '../src/models/Post.js';
import { INGEST_KEY } from './helpers/app.js';
import { clearCollections, DATA_COLLECTIONS, useMongo } from './helpers/mongo.js';
import { startModelServer, type RunningModel } from './helpers/modelServer.js';
import { connectSocket, waitUntil, type RawSocket } from './helpers/rawSocket.js';
import { startServer, type RunningServer } from './helpers/server.js';

useMongo();

const servers: RunningServer[] = [];
const models: RunningModel[] = [];
const sockets: RawSocket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(models.splice(0).map((m) => m.close()));
});
beforeEach(() => clearCollections([...DATA_COLLECTIONS, 'connectors']));

async function boot(env: Record<string, string> = {}, options: Parameters<typeof startServer>[1] = {}) {
  const s = await startServer(env, options);
  servers.push(s);
  return s;
}
async function model(opts: Parameters<typeof startModelServer>[0] = {}) {
  const m = await startModelServer({ realClock: true, ...opts });
  models.push(m);
  return m;
}
async function socketTo(s: RunningServer) {
  const sock = await connectSocket(s.port, s.user.token);
  sockets.push(sock);
  return sock;
}

const ingestBody = (n: number, tag = 'e2e') => ({
  posts: Array.from({ length: n }, (_, i) => ({
    platform: 'bluesky',
    sourceId: `${tag}-${i}-${Date.now()}`,
    authorHandle: `@person_${i}`,
    text: `@person_${i} says drink salt water, call 0803 123 4567 or see https://example.com/x${i}`,
    postedAt: new Date().toISOString(),
    state: 'Lagos',
  })),
});
const postIngest = (s: RunningServer, body: unknown) =>
  request(s.url)
    .post('/api/ingest')
    .set('X-Api-Key', INGEST_KEY)
    .send(body as object);

const classifiedCount = () =>
  PostModel.countDocuments({ pipelineStatus: { $in: ['classified', 'needs_review'] } });

describe('mock connector -> scrub -> classify -> decide -> DB -> socket event', () => {
  it('flows through every stage, over HTTP and a real Socket.io connection', async () => {
    // mock ingestion + in-process mock classifier (the default development setup); the feed's own timer is parked
    const s = await boot({ INGESTION_MODE: 'mock' }, { mockIntervalMs: 3_600_000, mockBatchSize: 3 });
    // the feed emits one batch at boot; let it finish completely so that from here on only our tick is in flight
    await waitUntil(async () => (await classifiedCount()) === 3, { what: 'the boot batch classified' });
    await s.application.queue.idle();
    const before = await PostModel.countDocuments();

    const sock = await socketTo(s);
    const tick = await s.application.mock.tick();
    expect(tick).toMatchObject({ accepted: 3, duplicates: 0 });
    await sock.waitFor(() => sock.ofType('post:classified').length >= 3);
    await s.application.queue.idle();

    // --- socket events: exactly the three new posts, schema-valid, scrubbed, with classification and decision
    const events = sock.ofType('post:classified');
    expect(events).toHaveLength(3);
    const ids = new Set<string>();
    for (const e of events) {
      const dto = PostDtoSchema.parse(e);
      ids.add(dto.id);
      expect(dto.isMock).toBe(true);
      expect(dto.platform).toMatch(/^(bluesky|x|youtube|instagram)$/);
      expect(dto.classification).toMatchObject({ contract: 'multilabel-v1', modelName: 'mock-ebola-clf' });
      expect(dto.decision).not.toBeNull();
      expect(['classified', 'needs_review']).toContain(dto.pipelineStatus);
    }
    expect(ids.size).toBe(3);

    // --- database: every post went through scrub -> classify -> decide
    const posts = await PostModel.find().lean();
    expect(posts).toHaveLength(before + 3);
    for (const p of posts) {
      expect(['classified', 'needs_review']).toContain(p.pipelineStatus);
      expect(p.originMock).toBe(true);
      expect(p.isMock).toBe(true);
      expect(p.authorHash).toMatch(/^[0-9a-f]{64}$/);
      expect(p.latestClassificationId).not.toBeNull();
      expect(p.latestDecisionId).not.toBeNull();
    }
    expect(await ClassificationModel.countDocuments()).toBe(posts.length);
    expect(await DecisionModel.countDocuments()).toBe(posts.length);
    for (const id of ids) expect(posts.map((p) => String(p._id))).toContain(id);

    // --- privacy: nothing raw anywhere (DB or wire)
    const db = mongoose.connection.db!;
    const dump = JSON.stringify(
      await Promise.all(
        (await db.listCollections().toArray()).map((c) => db.collection(c.name).find().toArray()),
      ),
    );
    const wire = JSON.stringify(events);
    for (const raw of [
      '@synthetic_user',
      '0803 000 0000',
      '0805 000 0000',
      'https://example.com/secret',
      'fake-example.com',
      'bit.ly/closed',
    ]) {
      expect(dump).not.toContain(raw);
      expect(wire).not.toContain(raw);
    }

    // --- the REST view agrees with the socket view
    const list = await s.api().get('/api/posts?pageSize=100');
    expect(list.body.total).toBe(posts.length);

    // --- connector status is data written by the run
    await waitUntil(async () => (await ConnectorModel.findOne({ key: 'mock' }).lean())?.lastRunAt != null, {
      what: 'connector lastRunAt',
    });
    expect(await ConnectorModel.findOne({ key: 'mock' }).lean()).toMatchObject({ status: 'live' });

    // --- provenance reaches the client and says mock for every stage
    const status = SystemStatusSchema.parse((await s.api().get('/api/system/status')).body);
    expect(status.dataSource).toEqual({
      ingestion: 'mock',
      classifier: 'mock-inprocess',
      generator: 'mock',
      dispatcher: 'mock',
    });

    // --- analytics see the same data
    const breakdown = (await s.api().get('/api/analytics/breakdown')).body;
    expect(breakdown.total).toBe(posts.length);
  });

  it('the feed feeds itself on a timer, and stops cleanly', async () => {
    const s = await boot({ INGESTION_MODE: 'mock' }, { mockIntervalMs: 60, mockBatchSize: 2 });
    await waitUntil(async () => (await classifiedCount()) >= 6, { what: '6 classified posts' });
    expect(await ConnectorModel.findOne({ key: 'mock' }).lean()).toMatchObject({ status: 'live' });

    s.application.mock.stop();
    await s.application.queue.idle();
    const settled = await PostModel.countDocuments();
    await new Promise((r) => setTimeout(r, 250));
    expect(await PostModel.countDocuments()).toBe(settled); // no more arrivals after stop
    expect(await PostModel.countDocuments({ pipelineStatus: 'pending' })).toBe(0);
  });

  it('operator actions are broadcast: changing the mode and recomputing both emit system:update', async () => {
    const s = await boot({ INGESTION_MODE: 'push' });
    const sock = await socketTo(s);
    await postIngest(s, ingestBody(2));
    await s.application.queue.idle();

    expect((await s.api().post('/api/admin/mode').send({ mode: 'surge' })).status).toBe(200);
    await sock.waitFor(() => sock.ofType('system:update').length >= 1);
    expect(sock.ofType('system:update')[0]).toMatchObject({
      reason: 'operating_mode_changed',
      status: { operatingMode: 'surge' },
    });

    await s.api().post('/api/admin/recompute-decisions').send({});
    await sock.waitFor(() => sock.ofType('system:update').length >= 2);
    expect(sock.ofType('system:update')[1]).toMatchObject({ reason: 'decisions_recomputed' });
  });
});

describe('live mode against the real mock-model service', () => {
  it('a cold model: posts wait (pending, never errors), the countdown is visible, then everything classifies and status turns ready', async () => {
    const m = await model({ warmupSeconds: 3 });
    const s = await boot({ MODEL_MODE: 'live', MODEL_BASE_URL: m.url, INGESTION_MODE: 'push' });
    const sock = await socketTo(s);

    // at boot the poller already saw the model warming, with an absolute time to retry at
    const cold = SystemStatusSchema.parse((await s.api().get('/api/system/status')).body);
    expect(cold.modelStatus).toBe('warming');
    expect(Date.parse(cold.retryAvailableAt!)).toBeGreaterThan(Date.now());
    expect(cold.dataSource.classifier).toBe('mock-server'); // the model identifies itself as a mock

    const res = await postIngest(s, ingestBody(4));
    expect(res.body.accepted).toBe(4);

    // while it warms the posts are pending or in flight, never an error
    await new Promise((r) => setTimeout(r, 300));
    expect(await PostModel.countDocuments({ pipelineStatus: 'classification_error' })).toBe(0);
    expect(await classifiedCount()).toBe(0);

    await waitUntil(async () => (await classifiedCount()) === 4, {
      timeoutMs: 20_000,
      what: '4 classified posts after warm-up',
    });
    expect(m.count('/v1/classify')).toBeGreaterThanOrEqual(2); // one 503, then success

    const posts = await PostModel.find().lean();
    for (const p of posts) {
      expect(p.isMock).toBe(true); // a mock model's output is mock data
      expect(p.text).not.toMatch(/@person|0803|example\.com/);
    }
    expect(
      await ClassificationModel.countDocuments({
        modelName: 'mock-ebola-clf',
        modelVersion: '0.0.0-mock',
        isMock: true,
      }),
    ).toBe(4);

    await sock.waitFor(() => sock.ofType('post:classified').length >= 4);
    await sock.waitFor(() =>
      sock.ofType('model:status').some((e) => (e as { modelStatus: string }).modelStatus === 'ready'),
    );
    const ready = SystemStatusSchema.parse((await s.api().get('/api/system/status')).body);
    expect(ready).toMatchObject({ modelStatus: 'ready', modelVersion: '0.0.0-mock', retryAvailableAt: null });
  });

  it('what the model says about itself decides provenance: a model that does not match MODEL_MOCK_MARKER is live, and its data is real', async () => {
    const m = await model();
    const s = await boot({
      MODEL_MODE: 'live',
      MODEL_BASE_URL: m.url,
      INGESTION_MODE: 'push',
      MODEL_MOCK_MARKER: 'staging',
    });

    const status = SystemStatusSchema.parse((await s.api().get('/api/system/status')).body);
    expect(status.dataSource.classifier).toBe('live');

    await postIngest(s, ingestBody(3));
    // stamped real at ingest (the model was already known not to be a mock) ...
    expect(await PostModel.countDocuments({ isMock: false })).toBe(3);
    await s.application.queue.idle();
    await waitUntil(async () => (await classifiedCount()) === 3, { what: '3 classified posts' });

    // ... and still real after classification; visible through the API, which is scoped to the real run
    expect(await PostModel.countDocuments({ isMock: false, originMock: false })).toBe(3);
    expect(await ClassificationModel.countDocuments({ isMock: false })).toBe(3);
    const list = await s.api().get('/api/posts?pageSize=100');
    expect(list.body.total).toBe(3);
    expect(list.body.items.every((p: { isMock: boolean }) => p.isMock === false)).toBe(true);
  });

  it('restart safety: posts left pending by a cold model are picked up by the next boot, once, without duplicates', async () => {
    const m = await model({ warmupSeconds: 60 });
    const env = {
      MODEL_MODE: 'live',
      MODEL_BASE_URL: m.url,
      INGESTION_MODE: 'push',
      MODEL_WARMUP_MAX_WAIT_MS: '1000',
    };

    const first = await boot(env);
    await postIngest(first, ingestBody(3, 'restart'));
    await waitUntil(async () => (await PostModel.countDocuments({ pipelineStatus: 'pending' })) === 3, {
      what: '3 pending posts',
    });
    expect(await classifiedCount()).toBe(0);
    expect(await PostModel.countDocuments({ pipelineStatus: 'classification_error' })).toBe(0);
    await first.close();
    servers.length = 0;

    await m.control({ warmupSeconds: 0 }); // the model is warm by the time the backend comes back
    const second = await boot(env);
    await waitUntil(async () => (await classifiedCount()) === 3, {
      what: 'the pending posts classified after restart',
    });
    await second.application.queue.idle();
    expect(await ClassificationModel.countDocuments()).toBe(3);
    expect(await DecisionModel.countDocuments()).toBe(3);
  });

  it('a malformed model response is surfaced, not hidden: items become classification_error and the status says error', async () => {
    const m = await model();
    await m.control({ malformed: true });
    const s = await boot({ MODEL_MODE: 'live', MODEL_BASE_URL: m.url, INGESTION_MODE: 'push' });
    await postIngest(s, ingestBody(2));
    await waitUntil(
      async () => (await PostModel.countDocuments({ pipelineStatus: 'classification_error' })) === 2,
      { what: '2 classification errors' },
    );
    expect(await PostModel.findOne().lean()).toMatchObject({
      errorDetail: expect.stringContaining('invalid_response'),
    });
    expect((await s.api().get('/api/system/status')).body.modelStatus).toBe('error');
    expect(await ClassificationModel.countDocuments()).toBe(0); // nothing half-stored
  });

  it('works with the three-class contract end to end', async () => {
    const m = await model({ contract: 'threeclass-v0' });
    const s = await boot({
      MODEL_MODE: 'live',
      MODEL_BASE_URL: m.url,
      MODEL_CONTRACT: 'threeclass-v0',
      INGESTION_MODE: 'push',
    });
    await postIngest(s, ingestBody(6));
    await waitUntil(async () => (await classifiedCount()) === 6, { what: '6 classified posts' });
    const status = (await s.api().get('/api/system/status')).body;
    expect(status).toMatchObject({ modelContract: 'threeclass-v0', taxonomyVersion: 'threeclass-v0' });
    const posts = (await s.api().get('/api/posts?pageSize=100')).body.items;
    for (const p of posts) {
      expect(p.classification).toMatchObject({
        contract: 'threeclass-v0',
        modelName: 'mock-legacy-3class',
        stance: null,
      });
      expect(p.classification.threeClass).not.toBeNull();
    }
    // the taxonomy endpoint exposes the three labels so the UI can resolve every name
    const taxonomy = (await s.api().get('/api/taxonomy')).body;
    expect(taxonomy.categories.map((c: { id: string }) => c.id)).toEqual([
      'misinformation',
      'factual',
      'irrelevant',
    ]);
  });
});

describe('Socket.io', () => {
  it('uses the same origin lock as the REST API: only FRONTEND_URL is answered, never * and never an arbitrary origin', async () => {
    const s = await boot();
    const handshake = (origin: string) =>
      fetch(`${s.url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: origin } });
    const ok = await handshake('http://localhost:5173');
    expect(ok.status).toBe(200);
    // answered by Socket.io itself (an engine.io open packet), not by the Express app: regression for the
    // double-handling bug when Socket.io attached before the app was the request listener
    expect(await ok.clone().text()).toMatch(/^0\{/);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const evil = await handshake('http://evil.example');
    expect(evil.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(evil.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('a client connects over WebSocket and receives typed events', async () => {
    const s = await boot();
    const sock = await socketTo(s);
    await postIngest(s, ingestBody(1));
    await sock.waitFor(() => sock.ofType('post:classified').length >= 1);
    expect(PostDtoSchema.safeParse(sock.ofType('post:classified')[0]).success).toBe(true);
  });
});

describe('shutdown', () => {
  it('stops cleanly: nothing keeps running, and the port is released', async () => {
    const s = await boot({ INGESTION_MODE: 'mock' }, { mockIntervalMs: 50, mockBatchSize: 1 });
    await waitUntil(async () => (await PostModel.countDocuments()) >= 2, { what: 'some posts' });
    await s.close();
    servers.length = 0;
    await expect(fetch(`${s.url}/api/health`)).rejects.toThrow();
    const count = await PostModel.countDocuments();
    await new Promise((r) => setTimeout(r, 200));
    expect(await PostModel.countDocuments()).toBe(count); // the feed is really stopped
  });
});
