/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies captured from msw are untyped */
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickMultilabel, pickThreeClass } from '../src/classifier/fixtureResponder.js';
import {
  HttpClassifier,
  parseRetryAfterSeconds,
  type HttpClassifierOptions,
} from '../src/classifier/httpClassifier.js';
import type {
  ClassifierHooks,
  ClassifyInput,
  ClassifyResult,
  TaxonomyView,
} from '../src/classifier/types.js';

const BASE = 'http://model.test';
const URL_CLASSIFY = `${BASE}/v1/classify`;
const NOW = 1_700_000_000_000;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const inputs = (n: number, prefix = 'i'): ClassifyInput[] =>
  Array.from({ length: n }, (_, i) => ({
    itemId: `${prefix}${i}`,
    text: 'synthetic text',
    platform: 'bluesky',
  }));

const MODEL = {
  name: 'ebola-clf',
  version: '1.0.0',
  taxonomy_version: 'ebola-tax-1.0',
  base_model: null,
  trained_at: null,
};

function okBody(req: any, patch?: (results: any[]) => any[]) {
  const results = req.items.map((it: any) => pickMultilabel(it.item_id));
  return {
    request_id: req.request_id,
    status: 'completed',
    model: MODEL,
    results: patch ? patch(results) : results,
  };
}

const failedItem = (id: string, code: string) => ({
  item_id: id,
  status: 'failed',
  error: { code, message: `${code} happened` },
});

interface Harness {
  client: HttpClassifier;
  sleeps: number[];
  hooks: Required<{ [K in keyof ClassifierHooks]: ReturnType<typeof vi.fn> }>;
  taxonomy: TaxonomyView & { resync: ReturnType<typeof vi.fn> };
}

function harness(
  opts: Partial<HttpClassifierOptions> = {},
  taxonomyOverrides: Partial<TaxonomyView> = {},
): Harness {
  const sleeps: number[] = [];
  const hooks = { onModelStatus: vi.fn(), onAlert: vi.fn(), onModelIdentity: vi.fn() };
  const taxonomy = {
    version: () => 'ebola-tax-1.0',
    knownCategoryIds: () => null,
    resync: vi.fn().mockResolvedValue(undefined),
    ...taxonomyOverrides,
  } as Harness['taxonomy'];
  const client = new HttpClassifier(
    {
      baseUrl: BASE,
      contract: 'multilabel-v1',
      timeoutMs: 2000,
      warmupMaxWaitMs: 120_000,
      maxRetries: 3,
      itemRetries: 2,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5, // jitter factor 0.75
      now: () => NOW,
      ...opts,
    },
    taxonomy,
    hooks,
  );
  return { client, sleeps, hooks, taxonomy };
}

const outcomes = (r: ClassifyResult[]) => r.map((x) => x.outcome);

describe('HttpClassifier: 200 valid', () => {
  it('classifies, pins taxonomy_version, reports identity and ready', async () => {
    let seen: any;
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) => {
        seen = await request.json();
        return HttpResponse.json(okBody(seen));
      }),
    );
    const h = harness();
    const results = await h.client.classify(inputs(3));
    expect(outcomes(results)).toEqual(['classified', 'classified', 'classified']);
    expect(seen.taxonomy_version).toBe('ebola-tax-1.0');
    expect(seen.items[0]).toMatchObject({
      item_id: 'i0',
      platform: 'bluesky',
      language_hint: null,
      context_text: null,
    });
    const first = results[0]!;
    if (first.outcome !== 'classified') throw new Error('expected classified');
    expect(first.classification.contract).toBe('multilabel-v1');
    expect(first.model.name).toBe('ebola-clf');
    expect(h.hooks.onModelIdentity).toHaveBeenCalledWith(expect.objectContaining({ name: 'ebola-clf' }));
    expect(h.hooks.onModelStatus).toHaveBeenCalledWith({ status: 'ready', retryAvailableAt: null });
  });

  it('chunks 70 items into requests of 32 / 32 / 6 and keeps input order', async () => {
    const sizes: number[] = [];
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) => {
        const body: any = await request.json();
        sizes.push(body.items.length);
        return HttpResponse.json(okBody(body));
      }),
    );
    const results = await harness().client.classify(inputs(70));
    expect(sizes).toEqual([32, 32, 6]);
    expect(results.map((r) => r.itemId)).toEqual(inputs(70).map((i) => i.itemId));
  });

  it('flags category labels that are not in the synced taxonomy (never crashes)', async () => {
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) =>
        HttpResponse.json(
          okBody(await request.json(), (res) => {
            res[0].categories = [
              { label: 'brand_new_category', score: 0.9 },
              ...res[0].categories.slice(0, 1).map((c: any) => ({ ...c, score: 0.1 })),
            ];
            return res;
          }),
        ),
      ),
    );
    const known = new Set(['fake_cure_prevention', 'other_ebola_misinfo', 'transmission_misinfo']);
    const [r] = await harness({}, { knownCategoryIds: () => known }).client.classify(inputs(1));
    if (r!.outcome !== 'classified') throw new Error('expected classified');
    expect(r!.unknownLabels).toContain('brand_new_category');
  });

  it('maps a response that omits an item to missing_result without dropping the rest', async () => {
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) =>
        HttpResponse.json(okBody(await request.json(), (res) => res.slice(0, 1))),
      ),
    );
    const results = await harness().client.classify(inputs(2));
    expect(results[0]!.outcome).toBe('classified');
    expect(results[1]).toMatchObject({ outcome: 'error', reason: 'missing_result' });
  });
});

describe('HttpClassifier: 200 invalid schema', () => {
  it('"complete" instead of "completed": no retry, items -> error, none dropped, status error', async () => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) => {
        calls++;
        return HttpResponse.json({ ...okBody(await request.json()), status: 'complete' });
      }),
    );
    const h = harness();
    const results = await h.client.classify(inputs(3));
    expect(calls).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(results).toHaveLength(3);
    for (const r of results) expect(r).toMatchObject({ outcome: 'error', reason: 'invalid_response' });
    expect(h.hooks.onModelStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('a 200 with a non-JSON body is treated the same way', async () => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, () => {
        calls++;
        return new HttpResponse('<html>oops</html>', { status: 200 });
      }),
    );
    const results = await harness().client.classify(inputs(2));
    expect(calls).toBe(1);
    expect(outcomes(results)).toEqual(['error', 'error']);
  });
});

describe('HttpClassifier: 503 warming', () => {
  const warmingThenOk = (retryAfter: string | null, warmCalls = 1) => {
    let n = 0;
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) => {
        if (n++ < warmCalls) {
          return new HttpResponse(null, {
            status: 503,
            headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
          });
        }
        return HttpResponse.json(okBody(await request.json()));
      }),
    );
    return () => n;
  };

  it('honours Retry-After, emits warming with an absolute retryAvailableAt, then succeeds', async () => {
    const calls = warmingThenOk('3');
    const h = harness();
    const results = await h.client.classify(inputs(2));
    expect(h.sleeps).toEqual([3000]);
    expect(calls()).toBe(2);
    expect(outcomes(results)).toEqual(['classified', 'classified']);
    expect(h.hooks.onModelStatus).toHaveBeenCalledWith({
      status: 'warming',
      retryAvailableAt: new Date(NOW + 3000).toISOString(),
    });
  });

  it('clamps Retry-After to 1..60 seconds', async () => {
    warmingThenOk('0');
    const low = harness();
    await low.client.classify(inputs(1));
    expect(low.sleeps).toEqual([1000]);

    server.resetHandlers();
    warmingThenOk('500');
    const high = harness();
    await high.client.classify(inputs(1));
    expect(high.sleeps).toEqual([60_000]);
  });

  it('uses the default backoff when Retry-After is absent', async () => {
    warmingThenOk(null);
    const h = harness();
    await h.client.classify(inputs(1));
    expect(h.sleeps).toEqual([375]); // 500 * 2^0 * 0.75
  });

  it('gives up after MODEL_WARMUP_MAX_WAIT_MS: items stay pending, status emitted', async () => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, () => {
        calls++;
        return new HttpResponse(null, { status: 503, headers: { 'Retry-After': '6' } });
      }),
    );
    const h = harness({ warmupMaxWaitMs: 10_000 });
    const results = await h.client.classify(inputs(2));
    // wait 6s (ok, total 6s), second 503 would push to 12s > 10s -> pending
    expect(h.sleeps).toEqual([6000]);
    expect(calls).toBe(2);
    expect(results).toEqual([
      { itemId: 'i0', outcome: 'pending', reason: 'warming' },
      { itemId: 'i1', outcome: 'pending', reason: 'warming' },
    ]);
    expect(h.hooks.onModelStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'warming' }));
  });

  it('a single long Retry-After beyond the max wait does not sleep at all', async () => {
    warmingThenOk('30', 5);
    const h = harness({ warmupMaxWaitMs: 10_000 });
    const results = await h.client.classify(inputs(1));
    expect(h.sleeps).toEqual([]);
    expect(results[0]).toMatchObject({ outcome: 'pending', reason: 'warming' });
  });
});

describe('HttpClassifier: 409 taxonomy mismatch', () => {
  it('stops, re-syncs once, raises an alert, does not retry; items stay pending', async () => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, () => {
        calls++;
        return HttpResponse.json({ error: { code: 'taxonomy_mismatch' } }, { status: 409 });
      }),
    );
    const h = harness();
    const results = await h.client.classify(inputs(2));
    expect(calls).toBe(1);
    expect(h.taxonomy.resync).toHaveBeenCalledTimes(1);
    expect(h.hooks.onAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'critical', code: 'taxonomy_mismatch' }),
    );
    expect(h.sleeps).toEqual([]);
    expect(results.every((r) => r.outcome === 'pending' && r.reason === 'taxonomy_mismatch')).toBe(true);
  });

  it('still alerts when the re-sync itself fails', async () => {
    server.use(http.post(URL_CLASSIFY, () => new HttpResponse(null, { status: 409 })));
    const h = harness();
    h.taxonomy.resync.mockRejectedValue(new Error('down'));
    const results = await h.client.classify(inputs(1));
    expect(h.hooks.onAlert).toHaveBeenCalled();
    expect(results[0]).toMatchObject({ outcome: 'pending' });
  });
});

describe('HttpClassifier: 400 / 422 (our bug)', () => {
  it.each([400, 422])('%i: logged, no retry, items -> error bad_request', async (status) => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, () => {
        calls++;
        return HttpResponse.json({ detail: 'bad' }, { status });
      }),
    );
    const h = harness();
    const results = await h.client.classify(inputs(2));
    expect(calls).toBe(1);
    expect(h.sleeps).toEqual([]);
    for (const r of results)
      expect(r).toMatchObject({ outcome: 'error', reason: 'bad_request', code: String(status) });
  });
});

describe('HttpClassifier: 429 / 5xx / network / timeout', () => {
  it('500: exponential backoff with jitter, max N retries, then error unavailable', async () => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const h = harness({ maxRetries: 3 });
    const results = await h.client.classify(inputs(2));
    expect(calls).toBe(4);
    expect(h.sleeps).toEqual([375, 750, 1500]);
    for (const r of results)
      expect(r).toMatchObject({ outcome: 'error', reason: 'unavailable', code: '500' });
    expect(h.hooks.onModelStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('backoff is capped at maxDelayMs and jittered by the random source', async () => {
    server.use(http.post(URL_CLASSIFY, () => new HttpResponse(null, { status: 502 })));
    const h = harness({ maxRetries: 4, baseDelayMs: 4000, maxDelayMs: 5000, random: () => 1 });
    await h.client.classify(inputs(1));
    expect(h.sleeps).toEqual([4000, 5000, 5000, 5000]);
  });

  it('recovers when a later attempt succeeds', async () => {
    let n = 0;
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) =>
        n++ < 2 ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(okBody(await request.json())),
      ),
    );
    const h = harness();
    const results = await h.client.classify(inputs(1));
    expect(outcomes(results)).toEqual(['classified']);
    expect(h.sleeps).toEqual([375, 750]);
  });

  it('429 honours Retry-After when it exceeds the backoff', async () => {
    let n = 0;
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) =>
        n++ < 1
          ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '5' } })
          : HttpResponse.json(okBody(await request.json())),
      ),
    );
    const h = harness();
    await h.client.classify(inputs(1));
    expect(h.sleeps).toEqual([5000]);
  });

  it('network errors are retried then reported as unavailable', async () => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    const h = harness({ maxRetries: 2 });
    const results = await h.client.classify(inputs(2));
    expect(calls).toBe(3);
    expect(h.sleeps).toEqual([375, 750]);
    for (const r of results) expect(r).toMatchObject({ outcome: 'error', reason: 'unavailable' });
  });

  it('per-request timeout aborts the call and is retried', async () => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, async () => {
        calls++;
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    const h = harness({ maxRetries: 1, timeoutMs: 40 });
    const results = await h.client.classify(inputs(1));
    expect(calls).toBe(2);
    expect(results[0]).toMatchObject({ outcome: 'error', reason: 'unavailable' });
  });
});

describe('HttpClassifier: per-item failures', () => {
  it('internal: only the failed items are re-sent; others are kept', async () => {
    const bodies: any[] = [];
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) => {
        const body: any = await request.json();
        bodies.push(body.items.map((i: any) => i.item_id));
        const first = bodies.length === 1;
        return HttpResponse.json({
          ...okBody(body, (res) =>
            res.map((r) => (first && r.item_id === 'i1' ? failedItem('i1', 'internal') : r)),
          ),
          status: first ? 'partial' : 'completed',
        });
      }),
    );
    const h = harness();
    const results = await h.client.classify(inputs(3));
    expect(bodies).toEqual([['i0', 'i1', 'i2'], ['i1']]);
    expect(outcomes(results)).toEqual(['classified', 'classified', 'classified']);
    expect(h.sleeps).toHaveLength(1);
  });

  it('internal: gives up after the limited retries; the rest of the batch still succeeds', async () => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) => {
        calls++;
        const body: any = await request.json();
        const results = body.items.map((it: any) =>
          it.item_id === 'i1' ? failedItem('i1', 'internal') : pickMultilabel(it.item_id),
        );
        const failed = results.filter((r: any) => r.status === 'failed').length;
        return HttpResponse.json({
          request_id: body.request_id,
          status: failed === results.length ? 'failed' : 'partial',
          model: MODEL,
          results,
        });
      }),
    );
    const results = await harness({ itemRetries: 2 }).client.classify(inputs(3));
    expect(calls).toBe(3); // initial + 2 item retries
    expect(results[0]!.outcome).toBe('classified');
    expect(results[1]).toMatchObject({ outcome: 'error', reason: 'item_failed', code: 'internal' });
    expect(results[2]!.outcome).toBe('classified');
  });

  it.each(['empty_text', 'text_too_long', 'unsupported_input'])('%s is terminal: no retry', async (code) => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) => {
        calls++;
        const body: any = await request.json();
        return HttpResponse.json({
          ...okBody(body, (res) => [failedItem('i0', code), ...res.slice(1)]),
          status: 'partial',
        });
      }),
    );
    const h = harness();
    const results = await h.client.classify(inputs(2));
    expect(calls).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(results[0]).toMatchObject({ outcome: 'error', reason: 'item_failed', code });
    expect(results[1]!.outcome).toBe('classified');
  });
});

describe('HttpClassifier: taxonomy not available yet', () => {
  it('syncs first; if it still has no version, items stay pending and the model is not called', async () => {
    let calls = 0;
    server.use(
      http.post(URL_CLASSIFY, () => {
        calls++;
        return HttpResponse.json({});
      }),
    );
    const h = harness({}, { version: () => null });
    h.taxonomy.resync.mockRejectedValue(new Error('model warming'));
    const results = await h.client.classify(inputs(2));
    expect(calls).toBe(0);
    expect(results.every((r) => r.outcome === 'pending' && r.reason === 'taxonomy_unavailable')).toBe(true);
  });
});

describe('HttpClassifier: threeclass-v0 (ASSUMED)', () => {
  it('sends no taxonomy_version and maps results via the 3-class adapter', async () => {
    let seen: any;
    server.use(
      http.post(URL_CLASSIFY, async ({ request }) => {
        seen = await request.json();
        return HttpResponse.json({
          request_id: seen.request_id,
          status: 'completed',
          model: {
            name: 'legacy-3class',
            version: '0.9.0',
            taxonomy_version: null,
            base_model: null,
            trained_at: null,
          },
          results: seen.items.map((i: any) => pickThreeClass(i.item_id)),
        });
      }),
    );
    const h = harness({ contract: 'threeclass-v0' }, { version: () => null });
    const results = await h.client.classify(inputs(2));
    expect(seen).not.toHaveProperty('taxonomy_version');
    expect(h.taxonomy.resync).not.toHaveBeenCalled();
    const r = results[0]!;
    if (r.outcome !== 'classified') throw new Error('expected classified');
    expect(r.classification.contract).toBe('threeclass-v0');
    expect(r.classification.threeClass).not.toBeNull();
  });
});

describe('parseRetryAfterSeconds', () => {
  it('parses seconds, HTTP dates and garbage', () => {
    expect(parseRetryAfterSeconds('7', NOW)).toBe(7);
    expect(parseRetryAfterSeconds(null, NOW)).toBeNull();
    expect(parseRetryAfterSeconds('soon', NOW)).toBeNull();
    expect(parseRetryAfterSeconds(new Date(NOW + 9000).toUTCString(), NOW)).toBeCloseTo(9, 0);
  });
});

beforeEach(() => vi.clearAllMocks());
