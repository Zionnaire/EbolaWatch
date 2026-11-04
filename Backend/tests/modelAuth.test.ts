/**
 * What the model developer confirmed: X-ML-API-Key auth, FastAPI {"detail": "..."} errors, a 2,000-character text
 * limit (still being decided, so configurable), and mock detection by model_version (v0.0.0-mock vs v1.0.0).
 */
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { pickThreeClass } from '../src/classifier/fixtureResponder.js';
import { HttpClassifier } from '../src/classifier/httpClassifier.js';
import { HttpHealthSource } from '../src/classifier/httpHealthSource.js';
import { buildClassifierStack } from '../src/classifier/index.js';
import {
  extractErrorDetail,
  modelHeaders,
  truncateText,
  MODEL_API_KEY_HEADER,
} from '../src/classifier/modelHttp.js';
import { classifierProvenance, matchesMockMarker } from '../src/classifier/provenance.js';
import {
  FixtureTaxonomySource,
  HttpTaxonomySource,
  MemoryTaxonomyRepo,
  TaxonomyService,
} from '../src/classifier/taxonomy.js';
import type { ClassifyInput } from '../src/classifier/types.js';
import { waitForModelHealth } from '../src/classifier/waitForModel.js';
import { createMockModelApp } from '../src/mock-model/app.js';
import { startModelServer, type RunningModel } from './helpers/modelServer.js';

const BASE = 'http://model.test';
const KEY = 'secret-ml-key-123';
const server = setupServer();
beforeAll(() =>
  server.listen({
    // anything aimed at the real local servers started in this file passes through; everything else must be mocked
    onUnhandledRequest: (req, print) => {
      if (new URL(req.url).hostname === '127.0.0.1') return;
      print.error();
    },
  }),
);
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const models: RunningModel[] = [];
afterEach(async () => {
  await Promise.all(models.splice(0).map((m) => m.close()));
});

const inputs = (n: number, text = 'synthetic text'): ClassifyInput[] =>
  Array.from({ length: n }, (_, i) => ({ itemId: `item-${i}`, text, platform: 'bluesky' }));

const threeClassTaxonomy = () =>
  new TaxonomyService(new FixtureTaxonomySource('threeclass-v0'), new MemoryTaxonomyRepo());

function threeClassClient(opts: Partial<ConstructorParameters<typeof HttpClassifier>[0]> = {}, hooks = {}) {
  const sleeps: number[] = [];
  const client = new HttpClassifier(
    {
      baseUrl: BASE,
      contract: 'threeclass-v0',
      timeoutMs: 2000,
      warmupMaxWaitMs: 1000,
      maxRetries: 1,
      baseDelayMs: 1,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...opts,
    },
    threeClassTaxonomy(),
    hooks,
  );
  return { client, sleeps };
}

const validThreeClass = (body: { request_id: string; items: Array<{ item_id: string }> }) => ({
  request_id: body.request_id,
  status: 'completed',
  model: {
    name: 'mock-legacy-3class',
    version: 'v0.0.0-mock',
    taxonomy_version: null,
    base_model: null,
    trained_at: null,
  },
  results: body.items.map((i) => pickThreeClass(i.item_id)),
});

describe('modelHeaders / extractErrorDetail / truncateText', () => {
  it('sends the API key in X-ML-API-Key, and nothing when there is no key', () => {
    expect(MODEL_API_KEY_HEADER).toBe('X-ML-API-Key');
    expect(modelHeaders(KEY)).toEqual({ 'X-ML-API-Key': KEY });
    expect(modelHeaders(KEY, { 'content-type': 'application/json' })).toEqual({
      'content-type': 'application/json',
      'X-ML-API-Key': KEY,
    });
    expect(modelHeaders(null)).toEqual({});
    expect(modelHeaders(undefined, { a: 'b' })).toEqual({ a: 'b' });
    expect(modelHeaders('')).toEqual({});
  });

  it('reads the FastAPI error body: {"detail": "message"}', () => {
    expect(extractErrorDetail({ detail: 'Not authenticated' })).toBe('Not authenticated');
    expect(extractErrorDetail('{"detail":"Invalid API key"}')).toBe('Invalid API key');
  });

  it('also understands the pydantic validation list FastAPI uses for 422', () => {
    const body = {
      detail: [
        { loc: ['body', 'items', 0, 'text'], msg: 'field required', type: 'missing' },
        { loc: ['body', 'request_id'], msg: 'bad id', type: 'x' },
      ],
    };
    expect(extractErrorDetail(body)).toBe('items.0.text: field required; request_id: bad id');
    expect(extractErrorDetail({ detail: [{ msg: 'just a message' }] })).toBe('just a message');
    expect(extractErrorDetail({ detail: { code: 7 } })).toBe('{"code":7}');
  });

  it('returns null for anything without a detail, and never throws', () => {
    for (const v of [
      null,
      undefined,
      42,
      '',
      'plain text',
      '<html>',
      '{"error":"x"}',
      {},
      { detail: '' },
      { detail: '   ' },
      [],
    ]) {
      expect(extractErrorDetail(v)).toBeNull();
    }
  });

  it('clips very long details', () => {
    expect(extractErrorDetail({ detail: 'x'.repeat(5000) })!.length).toBe(500);
  });

  it('truncateText cuts at the limit, never splits an emoji, and leaves short text alone', () => {
    expect(truncateText('hello', 10)).toBe('hello');
    expect(truncateText('hello', 5)).toBe('hello');
    expect(truncateText('hello world', 5)).toBe('hello');
    const text = 'ab😀cd'; // the emoji is two UTF-16 units at index 2-3
    expect(truncateText(text, 3)).toBe('ab'); // would have cut the emoji in half
    expect(truncateText(text, 4)).toBe('ab😀');
  });
});

describe('config: MODEL_API_KEY and MODEL_MAX_TEXT_CHARS', () => {
  const env = {
    FRONTEND_URL: 'http://localhost:5173',
    MONGODB_URI: 'mongodb://x',
    INGEST_API_KEY: 'x'.repeat(16),
    AUTHOR_HASH_SECRET: 'y'.repeat(16),
    JWT_SECRET: 'z'.repeat(32),
  };
  it('the key is optional; blank means none; surrounding whitespace is trimmed', () => {
    expect(loadConfig(env).MODEL_API_KEY).toBeUndefined();
    expect(loadConfig({ ...env, MODEL_API_KEY: '' }).MODEL_API_KEY).toBeUndefined();
    expect(loadConfig({ ...env, MODEL_API_KEY: '  ' }).MODEL_API_KEY).toBeUndefined();
    expect(loadConfig({ ...env, MODEL_API_KEY: ' abc ' }).MODEL_API_KEY).toBe('abc');
  });
  it('the text cap defaults to the documented 2,000 and has a sane floor', () => {
    expect(loadConfig(env).MODEL_MAX_TEXT_CHARS).toBe(2000);
    expect(loadConfig({ ...env, MODEL_MAX_TEXT_CHARS: '1500' }).MODEL_MAX_TEXT_CHARS).toBe(1500);
    expect(() => loadConfig({ ...env, MODEL_MAX_TEXT_CHARS: '10' })).toThrow(/MODEL_MAX_TEXT_CHARS/);
  });
});

describe('the key is sent to every model endpoint', () => {
  it('classify, health and taxonomy all carry X-ML-API-Key; without a key the header is absent', async () => {
    const seen: Record<string, string | null> = {};
    server.use(
      http.post(`${BASE}/v1/classify`, async ({ request }) => {
        seen.classify = request.headers.get('x-ml-api-key');
        return HttpResponse.json(validThreeClass((await request.json()) as never));
      }),
      http.get(`${BASE}/v1/health`, ({ request }) => {
        seen.health = request.headers.get('x-ml-api-key');
        return HttpResponse.json({
          status: 'ready',
          model_version: 'v1.0.0',
          taxonomy_version: 'x',
          retry_after_seconds: null,
        });
      }),
      http.get(`${BASE}/v1/taxonomy`, ({ request }) => {
        seen.taxonomy = request.headers.get('x-ml-api-key');
        return HttpResponse.json(null, { status: 500 });
      }),
    );

    expect((await threeClassClient({ apiKey: KEY }).client.classify(inputs(1)))[0]!.outcome).toBe(
      'classified',
    );
    await new HttpHealthSource(BASE, 1000, undefined, KEY).fetchHealth();
    await new HttpTaxonomySource(BASE, 1000, undefined, KEY).fetchTaxonomy().catch(() => undefined);
    await waitForModelHealth({ baseUrl: BASE, timeoutMs: 100, apiKey: KEY });
    expect(seen).toEqual({ classify: KEY, health: KEY, taxonomy: KEY });

    await threeClassClient().client.classify(inputs(1));
    await new HttpHealthSource(BASE, 1000).fetchHealth();
    expect(seen.classify).toBeNull();
    expect(seen.health).toBeNull();
  });

  it('buildClassifierStack wires the key and the cap from config into every piece', async () => {
    const seen: Array<{ path: string; key: string | null; textLen?: number }> = [];
    server.use(
      http.get(`${BASE}/v1/taxonomy`, ({ request }) => {
        seen.push({ path: 'taxonomy', key: request.headers.get('x-ml-api-key') });
        return HttpResponse.json(null, { status: 404 });
      }),
      http.get(`${BASE}/v1/health`, ({ request }) => {
        seen.push({ path: 'health', key: request.headers.get('x-ml-api-key') });
        return HttpResponse.json({
          status: 'ready',
          model_version: 'v1.0.0',
          taxonomy_version: 'n/a',
          retry_after_seconds: null,
        });
      }),
      http.post(`${BASE}/v1/classify`, async ({ request }) => {
        const body = (await request.json()) as {
          request_id: string;
          items: Array<{ item_id: string; text: string }>;
        };
        seen.push({
          path: 'classify',
          key: request.headers.get('x-ml-api-key'),
          textLen: body.items[0]!.text.length,
        });
        return HttpResponse.json(validThreeClass(body));
      }),
    );
    const stack = buildClassifierStack(
      {
        MODEL_MODE: 'live',
        MODEL_CONTRACT: 'threeclass-v0',
        MODEL_BASE_URL: BASE,
        MODEL_TIMEOUT_MS: 2000,
        MODEL_WARMUP_MAX_WAIT_MS: 1000,
        MODEL_API_KEY: KEY,
        MODEL_MAX_TEXT_CHARS: 300,
      },
      new MemoryTaxonomyRepo(),
      undefined,
    );
    await stack.poller.poll();
    await stack.client.classify(inputs(1, 'z'.repeat(1000)));
    expect(seen).toEqual([
      { path: 'health', key: KEY },
      { path: 'classify', key: KEY, textLen: 300 },
    ]);
  });
});

describe('a rejected key (401 / 403) is our configuration bug', () => {
  it.each([401, 403])(
    '%i: no retry, a critical alert, status error, items fail as unauthorized, and the key never leaks',
    async (status) => {
      let calls = 0;
      server.use(
        http.post(`${BASE}/v1/classify`, () => {
          calls++;
          return HttpResponse.json({ detail: 'Invalid API key' }, { status });
        }),
      );
      const hooks = { onModelStatus: vi.fn(), onAlert: vi.fn() };
      const { client, sleeps } = threeClassClient({ apiKey: KEY, maxRetries: 3 }, hooks);
      const results = await client.classify(inputs(3));

      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
      for (const r of results) {
        expect(r).toMatchObject({ outcome: 'error', reason: 'unauthorized', code: String(status) });
        if (r.outcome === 'error') {
          expect(r.message).toContain('Invalid API key'); // what the service said
          expect(r.message).not.toContain(KEY);
        }
      }
      expect(hooks.onModelStatus).toHaveBeenCalledWith({
        status: 'error',
        retryAvailableAt: null,
        detail: 'model rejected our API key',
      });
      expect(hooks.onAlert).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'critical', code: 'model_auth_failed' }),
      );
      expect(JSON.stringify(hooks.onAlert.mock.calls)).not.toContain(KEY);
    },
  );

  it("health and taxonomy explain the refusal with the model's own message", async () => {
    server.use(
      http.get(`${BASE}/v1/health`, () =>
        HttpResponse.json({ detail: 'Not authenticated' }, { status: 401 }),
      ),
      http.get(`${BASE}/v1/taxonomy`, () =>
        HttpResponse.json({ detail: 'Not authenticated' }, { status: 401 }),
      ),
    );
    await expect(new HttpHealthSource(BASE, 1000).fetchHealth()).rejects.toThrow(
      'GET /v1/health returned HTTP 401: Not authenticated',
    );
    await expect(new HttpTaxonomySource(BASE, 1000).fetchTaxonomy()).rejects.toThrow(
      'GET /v1/taxonomy failed: HTTP 401: Not authenticated',
    );
    expect((await waitForModelHealth({ baseUrl: BASE, timeoutMs: 10, intervalMs: 5 })).reachable).toBe(false);
  });
});

describe('FastAPI error bodies are used in our messages', () => {
  it('422 with a validation list: the field and reason appear in the item error', async () => {
    server.use(
      http.post(`${BASE}/v1/classify`, () =>
        HttpResponse.json(
          {
            detail: [
              { loc: ['body', 'items', 0, 'text'], msg: 'field required', type: 'value_error.missing' },
            ],
          },
          { status: 422 },
        ),
      ),
    );
    const r = (await threeClassClient().client.classify(inputs(1)))[0]!;
    expect(r).toMatchObject({ outcome: 'error', reason: 'bad_request', code: '422' });
    expect(r.outcome === 'error' && r.message).toBe(
      'Model rejected the request (HTTP 422): items.0.text: field required',
    );
  });

  it('400 with a plain detail string, and a non-JSON body (clipped raw text) are both handled', async () => {
    server.use(
      http.post(`${BASE}/v1/classify`, () =>
        HttpResponse.json({ detail: 'batch too large' }, { status: 400 }),
      ),
    );
    const a = (await threeClassClient().client.classify(inputs(1)))[0]!;
    expect(a.outcome === 'error' && a.message).toBe('Model rejected the request (HTTP 400): batch too large');

    server.use(
      http.post(`${BASE}/v1/classify`, () => new HttpResponse('Bad Gateway from proxy', { status: 404 })),
    );
    const b = (await threeClassClient().client.classify(inputs(1)))[0]!;
    expect(b.outcome === 'error' && b.message).toBe(
      'Model rejected the request (HTTP 404): Bad Gateway from proxy',
    );
  });

  it('the mock model now speaks the same dialect', async () => {
    const { app } = createMockModelApp({ apiKey: KEY });
    const auth = { 'x-ml-api-key': KEY };
    const bad = await request(app).post('/v1/classify').set(auth).send({ items: [] });
    expect(bad.status).toBe(400);
    expect(typeof bad.body.detail).toBe('string');
    expect(bad.body.detail).toContain('Invalid request');
    expect(bad.body.error).toBeUndefined();

    const mismatch = await request(app)
      .post('/v1/classify')
      .set(auth)
      .send({
        request_id: 'r',
        taxonomy_version: 'ebola-tax-9',
        items: [{ item_id: 'a', text: 't', platform: 'x', language_hint: null, context_text: null }],
      });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.detail).toContain('taxonomy_version mismatch');

    await request(app).post('/__control').send({ warmupSeconds: 5 });
    const warming = await request(app).post('/v1/classify').set(auth).send({});
    expect(warming.status).toBe(503);
    expect(warming.body).toEqual({ detail: 'Model is warming up' });
  });
});

describe('the mock model enforces the key, like the real service', () => {
  async function secured() {
    const m = await startModelServer({ apiKey: KEY });
    models.push(m);
    return m;
  }

  it('rejects a missing or wrong key on every /v1 endpoint with a 401 and a FastAPI body; accepts the right one', async () => {
    const m = await secured();
    for (const [method, path] of [
      ['GET', '/v1/health'],
      ['GET', '/v1/taxonomy'],
      ['POST', '/v1/classify'],
    ] as const) {
      for (const headers of [{}, { 'X-ML-API-Key': 'wrong' }] as Array<Record<string, string>>) {
        const res = await fetch(`${m.url}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          body: method === 'POST' ? '{}' : undefined,
        });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(await res.json()).toEqual({ detail: 'Invalid or missing API key' });
      }
    }
    expect((await fetch(`${m.url}/v1/health`, { headers: { 'X-ML-API-Key': KEY } })).status).toBe(200);
    // the control endpoint is not part of the model and stays open
    expect((await fetch(`${m.url}/__control`)).status).toBe(200);
  });

  it('end to end: the right key classifies, a missing key is reported as unauthorized (and tells the operator)', async () => {
    const m = await secured();
    const taxonomy = new TaxonomyService(
      new HttpTaxonomySource(m.url, 2000, undefined, KEY),
      new MemoryTaxonomyRepo(),
    );
    await taxonomy.resync();
    expect(taxonomy.version()).toBe('ebola-tax-1.0');

    const make = (apiKey: string | null, hooks = {}) =>
      new HttpClassifier(
        { baseUrl: m.url, contract: 'multilabel-v1', timeoutMs: 2000, warmupMaxWaitMs: 1000, apiKey },
        taxonomy,
        hooks,
      );

    expect((await make(KEY).classify(inputs(3))).every((r) => r.outcome === 'classified')).toBe(true);

    const before = m.count('/v1/classify');
    const hooks = { onAlert: vi.fn(), onModelStatus: vi.fn() };
    const refused = await make(null, hooks).classify(inputs(3));
    expect(refused.every((r) => r.outcome === 'error' && r.reason === 'unauthorized')).toBe(true);
    expect(m.count('/v1/classify') - before).toBe(1); // one attempt, no retry storm
    expect(hooks.onAlert).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_auth_failed' }));
  });
});

describe('the text limit is a setting', () => {
  it('long texts are cut to MODEL_MAX_TEXT_CHARS before they are sent, and only those results are marked truncated', async () => {
    const sentLengths: number[] = [];
    server.use(
      http.post(`${BASE}/v1/classify`, async ({ request }) => {
        const body = (await request.json()) as {
          request_id: string;
          items: Array<{ item_id: string; text: string }>;
        };
        sentLengths.push(...body.items.map((i) => i.text.length));
        return HttpResponse.json(validThreeClass(body));
      }),
    );
    const { client } = threeClassClient({ maxTextChars: 100 });
    const results = await client.classify([
      { itemId: 'short', text: 'x'.repeat(100), platform: 'x' }, // exactly at the limit: not cut
      { itemId: 'long', text: 'y'.repeat(101), platform: 'x' },
      { itemId: 'huge', text: 'z'.repeat(5000), platform: 'x' },
    ]);
    expect(sentLengths).toEqual([100, 100, 100]);
    const truncated = Object.fromEntries(
      results.map((r) => [r.itemId, r.outcome === 'classified' && r.classification.truncated]),
    );
    expect(truncated).toEqual({ short: false, long: true, huge: true });
  });

  it('defaults to the documented 2,000 characters', async () => {
    let sent = 0;
    server.use(
      http.post(`${BASE}/v1/classify`, async ({ request }) => {
        const body = (await request.json()) as {
          request_id: string;
          items: Array<{ item_id: string; text: string }>;
        };
        sent = body.items[0]!.text.length;
        return HttpResponse.json(validThreeClass(body));
      }),
    );
    await threeClassClient().client.classify(inputs(1, 'q'.repeat(2500)));
    expect(sent).toBe(2000);
  });

  it('an item that fails keeps its error (nothing is marked truncated on a failure)', async () => {
    server.use(
      http.post(`${BASE}/v1/classify`, () => HttpResponse.json({ detail: 'nope' }, { status: 400 })),
    );
    const r = (await threeClassClient({ maxTextChars: 50 }).client.classify(inputs(1, 'w'.repeat(500))))[0]!;
    expect(r.outcome).toBe('error');
  });
});

describe('the mock is recognised by model_version (v0.0.0-mock vs v1.0.0)', () => {
  it('matches the marker in the version, whatever the model is called', () => {
    expect(matchesMockMarker({ name: 'threeclass', version: 'v0.0.0-mock' }, 'mock')).toBe(true);
    expect(matchesMockMarker({ name: 'threeclass', version: 'v1.0.0' }, 'mock')).toBe(false);
    expect(classifierProvenance('http', { name: 'anything', version: 'v0.0.0-mock' }, 'mock')).toBe(
      'mock-server',
    );
    expect(classifierProvenance('http', { name: 'anything', version: 'v1.0.0' }, 'mock')).toBe('live');
  });
});
