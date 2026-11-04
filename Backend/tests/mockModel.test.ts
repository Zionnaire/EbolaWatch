import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FIXTURES, loadFixture } from '../src/contracts/fixtures/index.js';
import {
  ClassifyResponseSchema,
  ClassifyResponseStrictSchema,
  HealthStrictSchema,
  TaxonomyStrictSchema,
} from '../src/contracts/model/multilabelV1.js';
import { ThreeClassResponseStrictSchema } from '../src/contracts/model/threeClassV0.js';
import { createMockModelApp, MOCK_MODEL_NAME, MOCK_MODEL_VERSION } from '../src/mock-model/app.js';

const TAX = 'ebola-tax-1.0';
const item = (id: string, text = 'synthetic text') => ({
  item_id: id,
  text,
  platform: 'bluesky',
  language_hint: null,
  context_text: null,
});
const body = (items: ReturnType<typeof item>[], taxonomy_version = TAX) => ({
  request_id: 'req-1',
  taxonomy_version,
  items,
});

describe('mock model: multilabel-v1', () => {
  it('identifies itself as a mock', async () => {
    const { app } = createMockModelApp();
    const res = await request(app)
      .post('/v1/classify')
      .send(body([item('a')]));
    expect(res.status).toBe(200);
    expect(res.body.model.name).toBe(MOCK_MODEL_NAME);
    expect(res.body.model.version).toBe(MOCK_MODEL_VERSION);
  });

  it('health and taxonomy conform to the strict contract', async () => {
    const { app } = createMockModelApp();
    const health = await request(app).get('/v1/health');
    expect(health.body.status).toBe('ready');
    expect(HealthStrictSchema.safeParse(health.body).success).toBe(true);
    const tax = await request(app).get('/v1/taxonomy');
    expect(TaxonomyStrictSchema.safeParse(tax.body).success).toBe(true);
    expect(tax.body).toEqual(loadFixture(FIXTURES.taxonomy));
  });

  it('classify output passes the strict schema and echoes ids/request_id', async () => {
    const { app } = createMockModelApp();
    const ids = Array.from({ length: 32 }, (_, i) => `item-${i}`);
    const res = await request(app)
      .post('/v1/classify')
      .send(body(ids.map((i) => item(i))));
    expect(res.status).toBe(200);
    expect(ClassifyResponseStrictSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.request_id).toBe('req-1');
    expect(res.body.results.map((r: { item_id: string }) => r.item_id)).toEqual(ids);
  });

  it('is deterministic by item_id', async () => {
    const { app } = createMockModelApp();
    const a = await request(app)
      .post('/v1/classify')
      .send(body([item('same'), item('other')]));
    const b = await request(app)
      .post('/v1/classify')
      .send(body([item('other'), item('same')]));
    expect(a.body.results[0]).toEqual(b.body.results[1]);
    expect(a.body.results[1]).toEqual(b.body.results[0]);
  });

  it('rejects more than 32 items with 400', async () => {
    const { app } = createMockModelApp();
    const items = Array.from({ length: 33 }, (_, i) => item(`i${i}`));
    const res = await request(app).post('/v1/classify').send(body(items));
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON and invalid bodies with 400', async () => {
    const { app } = createMockModelApp();
    expect((await request(app).post('/v1/classify').send({ nope: true })).status).toBe(400);
    const bad = await request(app).post('/v1/classify').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
  });

  it('truncates long text and sets truncated', async () => {
    const { app } = createMockModelApp();
    const res = await request(app)
      .post('/v1/classify')
      .send(body([item('long', 'x'.repeat(2001)), item('short')]));
    expect(res.body.results[0].truncated).toBe(true);
    // the short item keeps whatever the fixture says (never forced true by length)
    expect(ClassifyResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('per-item failure does not fail the batch: empty text -> failed item, batch partial', async () => {
    const { app } = createMockModelApp();
    const res = await request(app)
      .post('/v1/classify')
      .send(body([item('ok'), item('empty', '   ')]));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('partial');
    expect(res.body.results[1]).toEqual({
      item_id: 'empty',
      status: 'failed',
      error: { code: 'empty_text', message: 'Text was empty after normalisation' },
    });
    expect(ClassifyResponseStrictSchema.safeParse(res.body).success).toBe(true);
  });

  it('failure rate 1 fails every item (batch status failed, HTTP 200)', async () => {
    const { app } = createMockModelApp({ failureRate: 1 });
    const res = await request(app)
      .post('/v1/classify')
      .send(body([item('a'), item('b')]));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(ClassifyResponseStrictSchema.safeParse(res.body).success).toBe(true);
  });

  it('taxonomy version mismatch -> 409 (request-driven and control-driven)', async () => {
    const { app } = createMockModelApp();
    expect(
      (
        await request(app)
          .post('/v1/classify')
          .send(body([item('a')], 'ebola-tax-9.9'))
      ).status,
    ).toBe(409);
    await request(app).post('/__control').send({ taxonomyMismatch: true });
    expect(
      (
        await request(app)
          .post('/v1/classify')
          .send(body([item('a')]))
      ).status,
    ).toBe(409);
  });

  it('warm-up: health warming, classify 503 + Retry-After, then ready (injected clock)', async () => {
    let t = 1_000_000;
    const { app } = createMockModelApp({ warmupSeconds: 20, now: () => t });
    const health = await request(app).get('/v1/health');
    expect(health.body).toMatchObject({ status: 'warming', retry_after_seconds: 20 });
    const res = await request(app)
      .post('/v1/classify')
      .send(body([item('a')]));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('20');
    t += 21_000;
    expect((await request(app).get('/v1/health')).body.status).toBe('ready');
    expect(
      (
        await request(app)
          .post('/v1/classify')
          .send(body([item('a')]))
      ).status,
    ).toBe(200);
  });

  it('malformed mode produces a response the runtime schema rejects', async () => {
    const { app } = createMockModelApp();
    await request(app).post('/__control').send({ malformed: true });
    const res = await request(app)
      .post('/v1/classify')
      .send(body([item('a')]));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('complete');
    expect(ClassifyResponseSchema.safeParse(res.body).success).toBe(false);
  });

  it('added latency delays the response', async () => {
    const { app } = createMockModelApp();
    await request(app).post('/__control').send({ latencyMs: 80 });
    const start = Date.now();
    await request(app)
      .post('/v1/classify')
      .send(body([item('a')]));
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
  });

  it('control: validates input, warmupSeconds starts a warm-up, reset restores defaults', async () => {
    const { app } = createMockModelApp();
    expect((await request(app).post('/__control').send({ failureRate: 5 })).status).toBe(400);
    await request(app).post('/__control').send({ warmupSeconds: 30, failureRate: 0.5 });
    expect((await request(app).get('/v1/health')).body.status).toBe('warming');
    await request(app).post('/__control').send({ reset: true });
    expect((await request(app).get('/v1/health')).body.status).toBe('ready');
    expect((await request(app).get('/__control')).body.failureRate).toBe(0);
  });
});

describe('mock model: threeclass-v0 mode (ASSUMED shape)', () => {
  it('serves 3-class results, no taxonomy, identifies as a mock', async () => {
    const { app } = createMockModelApp({ contract: 'threeclass-v0' });
    const res = await request(app)
      .post('/v1/classify')
      .send({ request_id: 'r', items: [item('a'), item('b'), item('c')] });
    expect(res.status).toBe(200);
    expect(ThreeClassResponseStrictSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.model.version).toBe(MOCK_MODEL_VERSION);
    expect(res.body.results[0]).toHaveProperty('probabilities');
    expect((await request(app).get('/v1/taxonomy')).status).toBe(404);
  });

  it('can be switched at runtime via /__control', async () => {
    const { app } = createMockModelApp();
    await request(app).post('/__control').send({ contract: 'threeclass-v0' });
    const res = await request(app)
      .post('/v1/classify')
      .send({ request_id: 'r', items: [item('a')] });
    expect(ThreeClassResponseStrictSchema.safeParse(res.body).success).toBe(true);
  });
});
