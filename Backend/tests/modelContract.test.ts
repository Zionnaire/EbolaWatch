/**
 * Contract tests: the real HttpClassifier against the real mock-model HTTP server, in every simulation mode
 * and for both contracts. Warm-ups run on a virtual clock (the classifier's sleep advances the server's time),
 * so nothing here waits for real seconds except the timeout test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hash32 } from '../src/classifier/fixtureResponder.js';
import { HttpClassifier, type HttpClassifierOptions } from '../src/classifier/httpClassifier.js';
import { HttpHealthSource } from '../src/classifier/httpHealthSource.js';
import { InProcessMockClassifier } from '../src/classifier/inProcessMock.js';
import { ModelStatusPoller, ModelStatusStore } from '../src/classifier/modelStatus.js';
import { classifierProvenance } from '../src/classifier/provenance.js';
import {
  FixtureTaxonomySource,
  HttpTaxonomySource,
  MemoryTaxonomyRepo,
  TaxonomyService,
} from '../src/classifier/taxonomy.js';
import type { ClassifyInput, ClassifyResult, ModelIdentity } from '../src/classifier/types.js';
import { waitForModelHealth } from '../src/classifier/waitForModel.js';
import { ClassificationSchema, type Contract } from '../src/contracts/api/index.js';
import type { MockModelOptions } from '../src/mock-model/app.js';
import { startModelServer, type RunningModel } from './helpers/modelServer.js';

const servers: RunningModel[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const inputs = (n: number, prefix = 'item-'): ClassifyInput[] =>
  Array.from({ length: n }, (_, i) => ({
    itemId: `${prefix}${i}`,
    text: 'synthetic text',
    platform: 'bluesky',
  }));

interface SetupOptions {
  server?: MockModelOptions;
  contract?: Contract;
  client?: Partial<HttpClassifierOptions>;
  /** Use fixtures for the taxonomy even for multilabel (when the server cannot serve /v1/taxonomy). */
  fixtureTaxonomy?: boolean;
}

async function setup(o: SetupOptions = {}) {
  const srv = await startModelServer(o.server);
  servers.push(srv);
  const contract = o.contract ?? 'multilabel-v1';
  const source =
    contract === 'multilabel-v1' && !o.fixtureTaxonomy
      ? new HttpTaxonomySource(srv.url, 2000)
      : new FixtureTaxonomySource(contract);
  const taxonomy = new TaxonomyService(source, new MemoryTaxonomyRepo());
  await taxonomy.resync();
  const sleeps: number[] = [];
  const hooks = { onModelStatus: vi.fn(), onAlert: vi.fn(), onModelIdentity: vi.fn() };
  const client = new HttpClassifier(
    {
      baseUrl: srv.url,
      contract,
      timeoutMs: 2000,
      warmupMaxWaitMs: 120_000,
      maxRetries: 2,
      itemRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
      // time is virtual: sleeping advances the server's clock
      sleep: (ms) => {
        sleeps.push(ms);
        srv.advance(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      now: () => srv.clock.now,
      ...o.client,
    },
    taxonomy,
    hooks,
  );
  return { srv, client, taxonomy, sleeps, hooks };
}

const classified = (r: ClassifyResult[]) => r.filter((x) => x.outcome === 'classified');
const identityOf = (hooks: { onModelIdentity: ReturnType<typeof vi.fn> }) =>
  hooks.onModelIdentity.mock.calls[0]![0] as ModelIdentity;

describe('multilabel-v1 over real HTTP: normal operation', () => {
  it('classifies a batch; the model identifies itself as a mock, so provenance is mock-server', async () => {
    const { client, srv, hooks } = await setup();
    const results = await client.classify(inputs(5));
    expect(results.map((r) => r.outcome)).toEqual(Array(5).fill('classified'));
    expect(srv.count('/v1/classify')).toBe(1);
    const identity = identityOf(hooks);
    expect(identity).toEqual({
      name: 'mock-ebola-clf',
      version: '0.0.0-mock',
      taxonomyVersion: 'ebola-tax-1.0',
    });
    for (const r of results) {
      if (r.outcome !== 'classified') throw new Error('expected classified');
      expect(ClassificationSchema.safeParse(r.classification).success).toBe(true);
      expect(r.unknownLabels).toEqual([]);
    }
    expect(classifierProvenance('http', identity, 'mock')).toBe('mock-server');
    // the marker is what decides it: a model that does not match the marker is reported as live
    expect(classifierProvenance('http', identity, 'staging')).toBe('live');
  });

  it('pins the taxonomy version it synced from the model', async () => {
    const { taxonomy } = await setup();
    expect(taxonomy.version()).toBe('ebola-tax-1.0');
    expect(taxonomy.knownCategoryIds()?.size).toBe(12);
  });

  it('chunks 70 items into 3 requests and returns every result in input order', async () => {
    const { client, srv } = await setup();
    const results = await client.classify(inputs(70));
    expect(srv.count('/v1/classify')).toBe(3);
    expect(results.map((r) => r.itemId)).toEqual(inputs(70).map((i) => i.itemId));
    expect(classified(results)).toHaveLength(70);
  });

  it('is deterministic: the same ids give the same classifications on every call', async () => {
    const { client } = await setup();
    const strip = (rs: ClassifyResult[]) =>
      rs.map((r) => (r.outcome === 'classified' ? r.classification : r));
    expect(strip(await client.classify(inputs(10)))).toEqual(strip(await client.classify(inputs(10))));
  });

  it('long text is truncated by the model and reported, not rejected', async () => {
    const { client } = await setup();
    const r = (await client.classify([{ itemId: 'long', text: 'x'.repeat(3000), platform: 'x' }]))[0]!;
    if (r.outcome !== 'classified') throw new Error('expected classified');
    expect(r.classification.truncated).toBe(true);
  });

  it('empty text is a terminal per-item error: others are classified, and there is no retry', async () => {
    const { client, srv, sleeps } = await setup();
    const results = await client.classify([
      { itemId: 'ok', text: 'fine', platform: 'x' },
      { itemId: 'empty', text: '   ', platform: 'x' },
    ]);
    expect(results[0]!.outcome).toBe('classified');
    expect(results[1]).toMatchObject({ outcome: 'error', reason: 'item_failed', code: 'empty_text' });
    expect(srv.count('/v1/classify')).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe('simulation mode: per-item failures', () => {
  it('failure rate 1: every item fails with `internal`; only the failed items are retried (limited), none are dropped', async () => {
    const { client, srv } = await setup({ server: { failureRate: 1 } });
    const results = await client.classify(inputs(4));
    expect(results).toHaveLength(4);
    for (const r of results)
      expect(r).toMatchObject({ outcome: 'error', reason: 'item_failed', code: 'internal' });
    expect(srv.count('/v1/classify')).toBe(3); // initial + 2 item retries
  });

  it('a partial failure rate: failing items error out after the retries, the rest are classified', async () => {
    const { client, srv } = await setup({ server: { failureRate: 0.5 } });
    const ids = inputs(24).map((i) => i.itemId);
    const failing = new Set(ids.filter((id) => hash32(`fail:${id}`) / 2 ** 32 < 0.5));
    expect(failing.size).toBeGreaterThan(0);
    expect(failing.size).toBeLessThan(ids.length);

    const results = await client.classify(inputs(24));
    expect(results).toHaveLength(24);
    for (const r of results) {
      if (failing.has(r.itemId))
        expect(r).toMatchObject({ outcome: 'error', reason: 'item_failed', code: 'internal' });
      else expect(r.outcome).toBe('classified');
    }
    expect(srv.count('/v1/classify')).toBe(3);
  });

  it('the failure rate can be changed at runtime through /__control', async () => {
    const { client, srv } = await setup();
    await srv.control({ failureRate: 1 });
    expect((await client.classify(inputs(2)))[0]!.outcome).toBe('error');
    await srv.control({ failureRate: 0 });
    expect((await client.classify(inputs(2)))[0]!.outcome).toBe('classified');
  });
});

describe('simulation mode: latency', () => {
  it('a response slower than the timeout is aborted and retried, then reported unavailable; recovery works', async () => {
    const { client, srv, hooks } = await setup({
      server: { latencyMs: 400 },
      client: { timeoutMs: 60, maxRetries: 1 },
    });
    const results = await client.classify(inputs(2));
    expect(results.every((r) => r.outcome === 'error' && r.reason === 'unavailable')).toBe(true);
    expect(srv.count('/v1/classify')).toBe(2); // 1 + maxRetries
    expect(hooks.onModelStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));

    await srv.control({ latencyMs: 0 });
    expect((await client.classify(inputs(2))).every((r) => r.outcome === 'classified')).toBe(true);
  });

  it('latency under the timeout is simply slow, not an error', async () => {
    const { client } = await setup({ server: { latencyMs: 60 }, client: { timeoutMs: 1500 } });
    const start = Date.now();
    expect((await client.classify(inputs(1)))[0]!.outcome).toBe('classified');
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });
});

describe('simulation mode: warm-up (503 + Retry-After)', () => {
  it('waits out Retry-After, announces warming with an absolute retryAvailableAt, then classifies', async () => {
    const { client, srv, sleeps, hooks } = await setup({ server: { warmupSeconds: 20 } });
    const t0 = srv.clock.now;
    const results = await client.classify(inputs(3));
    expect(sleeps).toEqual([20_000]);
    expect(results.every((r) => r.outcome === 'classified')).toBe(true);
    expect(srv.count('/v1/classify')).toBe(2); // one 503, one success
    expect(hooks.onModelStatus.mock.calls[0]![0]).toEqual({
      status: 'warming',
      retryAvailableAt: new Date(t0 + 20_000).toISOString(),
    });
    expect(hooks.onModelStatus).toHaveBeenLastCalledWith({ status: 'ready', retryAvailableAt: null });
  });

  it('a model that stays cold longer than the maximum wait leaves the items pending (not errors), and works once warm', async () => {
    const { client, srv, sleeps } = await setup({
      server: { warmupSeconds: 30 },
      client: { warmupMaxWaitMs: 10_000 },
    });
    const cold = await client.classify(inputs(2));
    expect(cold).toEqual([
      { itemId: 'item-0', outcome: 'pending', reason: 'warming' },
      { itemId: 'item-1', outcome: 'pending', reason: 'warming' },
    ]);
    expect(sleeps).toEqual([]);
    srv.advance(31_000);
    expect((await client.classify(inputs(2))).every((r) => r.outcome === 'classified')).toBe(true);
  });

  it('can be started at runtime through /__control and ends by itself', async () => {
    const { client, srv } = await setup();
    await srv.control({ warmupSeconds: 5 });
    const results = await client.classify(inputs(1));
    expect(results[0]!.outcome).toBe('classified');
    expect(srv.count('/v1/classify')).toBe(2);
  });
});

describe('simulation mode: taxonomy mismatch (409)', () => {
  it('forced 409: stops, re-syncs once, raises a critical alert, does not retry; items stay pending', async () => {
    const { client, srv, hooks, sleeps } = await setup();
    await srv.control({ taxonomyMismatch: true });
    const taxonomyCalls = srv.count('/v1/taxonomy');
    const results = await client.classify(inputs(3));
    expect(results.every((r) => r.outcome === 'pending' && r.reason === 'taxonomy_mismatch')).toBe(true);
    expect(srv.count('/v1/classify')).toBe(1);
    expect(srv.count('/v1/taxonomy')).toBe(taxonomyCalls + 1);
    expect(hooks.onAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'critical', code: 'taxonomy_mismatch' }),
    );
    expect(sleeps).toEqual([]);
  });

  it('a genuinely stale taxonomy_version is rejected by the model, healed by the re-sync, and the next call succeeds', async () => {
    const srv = await startModelServer();
    servers.push(srv);
    const real = new HttpTaxonomySource(srv.url, 2000);
    let calls = 0;
    const stale = { ...(await real.fetchTaxonomy()), taxonomyVersion: 'ebola-tax-0.9' };
    const taxonomy = new TaxonomyService(
      { fetchTaxonomy: () => (calls++ === 0 ? Promise.resolve(stale) : real.fetchTaxonomy()) },
      new MemoryTaxonomyRepo(),
    );
    await taxonomy.resync();
    expect(taxonomy.version()).toBe('ebola-tax-0.9');

    const hooks = { onAlert: vi.fn() };
    const client = new HttpClassifier(
      { baseUrl: srv.url, contract: 'multilabel-v1', timeoutMs: 2000, warmupMaxWaitMs: 1000 },
      taxonomy,
      hooks,
    );
    const first = await client.classify(inputs(2));
    expect(first.every((r) => r.outcome === 'pending' && r.reason === 'taxonomy_mismatch')).toBe(true);
    expect(taxonomy.version()).toBe('ebola-tax-1.0'); // re-synced from the model
    expect(hooks.onAlert).toHaveBeenCalledTimes(1);

    const second = await client.classify(inputs(2));
    expect(second.every((r) => r.outcome === 'classified')).toBe(true);
  });
});

describe('simulation mode: malformed response', () => {
  it('"complete" instead of "completed": items fail as invalid_response, status goes to error, no retry; recovers when fixed', async () => {
    const { client, srv, hooks, sleeps } = await setup();
    await srv.control({ malformed: true });
    const results = await client.classify(inputs(3));
    expect(results).toHaveLength(3);
    for (const r of results) expect(r).toMatchObject({ outcome: 'error', reason: 'invalid_response' });
    expect(srv.count('/v1/classify')).toBe(1);
    expect(sleeps).toEqual([]);
    expect(hooks.onModelStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', detail: 'invalid response schema' }),
    );

    await srv.control({ malformed: false });
    expect((await client.classify(inputs(3))).every((r) => r.outcome === 'classified')).toBe(true);
    expect(hooks.onModelStatus).toHaveBeenLastCalledWith({ status: 'ready', retryAvailableAt: null });
  });
});

describe('contract mismatch between our config and the server', () => {
  it('a three-class client talking to a multilabel server sends a request the server rejects: 400, our bug, no retry', async () => {
    const { client, srv, sleeps } = await setup({ contract: 'threeclass-v0' });
    const results = await client.classify(inputs(2));
    for (const r of results)
      expect(r).toMatchObject({ outcome: 'error', reason: 'bad_request', code: '400' });
    expect(srv.count('/v1/classify')).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('a multilabel client talking to a three-class server gets a response it cannot parse: invalid_response (drift is loud)', async () => {
    const { client } = await setup({
      server: { contract: 'threeclass-v0' },
      contract: 'multilabel-v1',
      fixtureTaxonomy: true,
    });
    const results = await client.classify(inputs(2));
    for (const r of results) expect(r).toMatchObject({ outcome: 'error', reason: 'invalid_response' });
  });
});

describe('threeclass-v0 over real HTTP (ASSUMED shape)', () => {
  it('classifies into the neutral shape with three-class output; the model is identified as a mock', async () => {
    const { client, hooks } = await setup({
      server: { contract: 'threeclass-v0' },
      contract: 'threeclass-v0',
    });
    const results = await client.classify(inputs(12));
    expect(classified(results)).toHaveLength(12);
    for (const r of results) {
      if (r.outcome !== 'classified') throw new Error('expected classified');
      expect(ClassificationSchema.safeParse(r.classification).success).toBe(true);
      expect(r.classification).toMatchObject({
        contract: 'threeclass-v0',
        taxonomyVersion: null,
        stance: null,
        categories: [],
        severity: null,
      });
      expect(r.classification.threeClass).not.toBeNull();
    }
    expect(identityOf(hooks).name).toBe('mock-legacy-3class');
    expect(classifierProvenance('http', identityOf(hooks), 'mock')).toBe('mock-server');
  });

  it('can be switched on at runtime through /__control', async () => {
    const srv = await startModelServer();
    servers.push(srv);
    await srv.control({ contract: 'threeclass-v0' });
    const taxonomy = new TaxonomyService(
      new FixtureTaxonomySource('threeclass-v0'),
      new MemoryTaxonomyRepo(),
    );
    await taxonomy.resync();
    const client = new HttpClassifier(
      { baseUrl: srv.url, contract: 'threeclass-v0', timeoutMs: 2000, warmupMaxWaitMs: 1000 },
      taxonomy,
    );
    expect((await client.classify(inputs(3))).every((r) => r.outcome === 'classified')).toBe(true);
  });

  it('the model has no taxonomy endpoint in this mode (404), and nothing depends on it', async () => {
    const { srv } = await setup({ server: { contract: 'threeclass-v0' }, contract: 'threeclass-v0' });
    expect((await fetch(`${srv.url}/v1/taxonomy`)).status).toBe(404);
  });

  it('shares the failure handling: empty text terminal, malformed response invalid, warm-up honoured', async () => {
    const { client, srv, sleeps } = await setup({
      server: { contract: 'threeclass-v0' },
      contract: 'threeclass-v0',
    });
    const mixed = await client.classify([
      { itemId: 'ok', text: 'fine', platform: 'x' },
      { itemId: 'empty', text: '', platform: 'x' },
    ]);
    expect(mixed[0]!.outcome).toBe('classified');
    expect(mixed[1]).toMatchObject({ outcome: 'error', reason: 'item_failed', code: 'empty_text' });

    await srv.control({ malformed: true });
    expect((await client.classify(inputs(1)))[0]).toMatchObject({
      outcome: 'error',
      reason: 'invalid_response',
    });
    await srv.control({ malformed: false, warmupSeconds: 15 });
    expect((await client.classify(inputs(1)))[0]!.outcome).toBe('classified');
    expect(sleeps).toEqual([15_000]);
  });
});

describe('parity: the in-process mock and the mock server agree', () => {
  it.each(['multilabel-v1', 'threeclass-v0'] as const)(
    '%s: identical classifications for the same items',
    async (contract) => {
      const { client, taxonomy } = await setup({ server: { contract }, contract });
      const inProcess = new InProcessMockClassifier(contract, taxonomy);
      const items = [...inputs(40), { itemId: 'empty', text: '  ', platform: 'x' }];
      const viaHttp = await client.classify(items);
      const direct = await inProcess.classify(items);

      expect(viaHttp).toHaveLength(direct.length);
      viaHttp.forEach((h, i) => {
        const d = direct[i]!;
        expect(h.outcome).toBe(d.outcome);
        if (h.outcome === 'classified' && d.outcome === 'classified') {
          expect(h.classification).toEqual(d.classification);
          expect(h.model).toEqual(d.model);
        } else if (h.outcome === 'error' && d.outcome === 'error') {
          expect({ reason: h.reason, code: h.code }).toEqual({ reason: d.reason, code: d.code });
        }
      });
    },
  );
});

describe('health, status polling and waiting for the model', () => {
  it('HttpHealthSource reads ready, then warming with a countdown, then ready again', async () => {
    const { srv } = await setup();
    const source = new HttpHealthSource(srv.url, 2000);
    expect(await source.fetchHealth()).toMatchObject({
      status: 'ready',
      model_version: '0.0.0-mock',
      taxonomy_version: 'ebola-tax-1.0',
      retry_after_seconds: null,
    });
    await srv.control({ warmupSeconds: 20 });
    expect(await source.fetchHealth()).toMatchObject({ status: 'warming', retry_after_seconds: 20 });
    srv.advance(12_000);
    expect((await source.fetchHealth()).retry_after_seconds).toBe(8);
    srv.advance(9_000);
    expect(await source.fetchHealth()).toMatchObject({ status: 'ready', retry_after_seconds: null });
  });

  it('the status poller turns that into model:status changes with an absolute retryAvailableAt, and an outage into `error`', async () => {
    const { srv, taxonomy } = await setup();
    const store = new ModelStatusStore();
    const changes: string[] = [];
    store.on('change', (s: { status: string }) => changes.push(s.status));
    const poller = new ModelStatusPoller(new HttpHealthSource(srv.url, 500), store, taxonomy, {
      intervalMs: 1000,
      syncsTaxonomy: true,
      now: () => srv.clock.now,
    });

    await poller.poll();
    expect(store.get()).toMatchObject({
      status: 'ready',
      modelVersion: '0.0.0-mock',
      taxonomyVersion: 'ebola-tax-1.0',
      retryAvailableAt: null,
    });

    await srv.control({ warmupSeconds: 20 });
    const t = srv.clock.now;
    await poller.poll();
    expect(store.get()).toMatchObject({
      status: 'warming',
      retryAvailableAt: new Date(t + 20_000).toISOString(),
    });

    srv.advance(25_000);
    await poller.poll();
    expect(store.get()).toMatchObject({ status: 'ready', retryAvailableAt: null });

    await srv.close();
    servers.length = 0;
    await poller.poll();
    expect(store.get().status).toBe('error');
    expect(changes).toEqual(['ready', 'warming', 'ready', 'error']);
  });

  it('waitForModelHealth returns at once when the model is up, and counts a warming model as up', async () => {
    const { srv } = await setup();
    expect(await waitForModelHealth({ baseUrl: srv.url, timeoutMs: 1000 })).toMatchObject({
      reachable: true,
      status: 'ready',
      attempts: 1,
    });
    await srv.control({ warmupSeconds: 30 });
    expect(await waitForModelHealth({ baseUrl: srv.url, timeoutMs: 1000 })).toMatchObject({
      reachable: true,
      status: 'warming',
      attempts: 1,
    });
  });

  it('waitForModelHealth keeps trying while the model is starting, then succeeds (no startup race)', async () => {
    const { srv } = await setup();
    let calls = 0;
    const flaky: typeof fetch = (input, init) =>
      calls++ < 3 ? Promise.reject(new TypeError('fetch failed')) : fetch(input, init);
    let t = 0;
    const waits: number[] = [];
    const result = await waitForModelHealth({
      baseUrl: srv.url,
      timeoutMs: 60_000,
      intervalMs: 1000,
      fetchImpl: flaky,
      now: () => t,
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
      onWait: (w) => waits.push(w.attempt),
    });
    expect(result).toMatchObject({ reachable: true, status: 'ready', attempts: 4, waitedMs: 3000 });
    expect(waits).toEqual([1, 2, 3]);
  });

  it('waitForModelHealth gives up after the timeout without throwing (the backend then starts anyway)', async () => {
    let t = 0;
    const result = await waitForModelHealth({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 5000,
      intervalMs: 1000,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
      now: () => t,
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({ reachable: false, status: null });
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.waitedMs).toBeLessThanOrEqual(5000);
  });

  it('a non-model server on that port (invalid health body) is not mistaken for the model', async () => {
    const result = await waitForModelHealth({
      baseUrl: 'http://model.test',
      timeoutMs: 20,
      intervalMs: 10,
      fetchImpl: () => Promise.resolve(new Response('<html>hello</html>', { status: 200 })),
    });
    expect(result.reachable).toBe(false);
  });
});
