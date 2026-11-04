import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildClassifierStack } from '../src/classifier/index.js';
import { HttpHealthSource } from '../src/classifier/httpHealthSource.js';
import { ModelStatusPoller, ModelStatusStore, type HealthSource } from '../src/classifier/modelStatus.js';
import {
  FixtureTaxonomySource,
  HttpTaxonomySource,
  MemoryTaxonomyRepo,
  TaxonomyService,
  threeClassTaxonomy,
  toTaxonomyDto,
  type TaxonomySource,
} from '../src/classifier/taxonomy.js';
import { TaxonomyDtoSchema } from '../src/contracts/api/index.js';
import { FIXTURES, loadFixture } from '../src/contracts/fixtures/index.js';
import { TaxonomySchema, type ModelHealth } from '../src/contracts/model/multilabelV1.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const dto = toTaxonomyDto(TaxonomySchema.parse(loadFixture(FIXTURES.taxonomy)));
const v2 = { ...dto, taxonomyVersion: 'ebola-tax-2.0' };

describe('taxonomy mapping', () => {
  it('maps the model taxonomy to a camelCase DTO that passes the API schema', () => {
    expect(TaxonomyDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto.categories).toHaveLength(12);
    expect(dto.categories[0]).toMatchObject({
      id: 'fake_cure_prevention',
      displayName: 'Fake cure or prevention',
    });
    expect(dto.severityLevels).toEqual([0, 1, 2, 3, 4]);
  });

  it('exposes the 3-class labels through the same shape', () => {
    const t = threeClassTaxonomy();
    expect(TaxonomyDtoSchema.safeParse(t).success).toBe(true);
    expect(t.categories.map((c) => c.id)).toEqual(['misinformation', 'factual', 'irrelevant']);
  });
});

describe('TaxonomyService', () => {
  const source = (versions: (typeof dto)[]): TaxonomySource & { calls: number } => {
    let i = 0;
    return {
      calls: 0,
      fetchTaxonomy() {
        this.calls++;
        return Promise.resolve(versions[Math.min(i++, versions.length - 1)]!);
      },
    };
  };

  it('init serves the stored copy first, then syncs', async () => {
    const repo = new MemoryTaxonomyRepo();
    await repo.save(v2);
    const s = new TaxonomyService(source([dto]), repo);
    await s.init();
    expect(s.version()).toBe('ebola-tax-1.0');
    expect(await s.getVersion('ebola-tax-2.0')).toEqual(v2); // older version still resolvable
    expect(s.knownCategoryIds()).toContain('burial_resistance');
  });

  it('keeps the stored copy when the initial sync fails (e.g. model warming)', async () => {
    const repo = new MemoryTaxonomyRepo();
    await repo.save(dto);
    const s = new TaxonomyService({ fetchTaxonomy: () => Promise.reject(new Error('503')) }, repo);
    await expect(s.init()).resolves.toBeUndefined();
    expect(s.version()).toBe('ebola-tax-1.0');
  });

  it('emits change only when the version changes, and shares one in-flight sync', async () => {
    const src = source([dto, dto, v2]);
    const s = new TaxonomyService(src, new MemoryTaxonomyRepo());
    const onChange = vi.fn();
    s.on('change', onChange);
    await s.resync();
    await s.resync(); // same version
    expect(onChange).toHaveBeenCalledTimes(1);
    await Promise.all([s.resync(), s.resync(), s.resync()]);
    expect(src.calls).toBe(3); // 2 sequential + 1 shared
    expect(s.version()).toBe('ebola-tax-2.0');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('has no known ids before the first sync; getVersion of an unknown version is null', async () => {
    const s = new TaxonomyService(source([dto]), new MemoryTaxonomyRepo());
    expect(s.knownCategoryIds()).toBeNull();
    expect(s.version()).toBeNull();
    expect(await s.getVersion('nope')).toBeNull();
  });

  it('fixture sources: multilabel taxonomy fixture, and the synthetic 3-class one', async () => {
    expect((await new FixtureTaxonomySource('multilabel-v1').fetchTaxonomy()).taxonomyVersion).toBe(
      'ebola-tax-1.0',
    );
    expect((await new FixtureTaxonomySource('threeclass-v0').fetchTaxonomy()).taxonomyVersion).toBe(
      'threeclass-v0',
    );
  });
});

describe('HttpTaxonomySource', () => {
  const URL_TAX = 'http://model.test/v1/taxonomy';
  it('fetches and validates', async () => {
    server.use(http.get(URL_TAX, () => HttpResponse.json(loadFixture(FIXTURES.taxonomy))));
    expect(await new HttpTaxonomySource('http://model.test', 1000).fetchTaxonomy()).toEqual(dto);
  });
  it('rejects an invalid body and non-2xx statuses', async () => {
    server.use(http.get(URL_TAX, () => HttpResponse.json({ taxonomy_version: 1 })));
    await expect(new HttpTaxonomySource('http://model.test', 1000).fetchTaxonomy()).rejects.toThrow(
      /validation/,
    );
    server.use(http.get(URL_TAX, () => new HttpResponse(null, { status: 503 })));
    await expect(new HttpTaxonomySource('http://model.test', 1000).fetchTaxonomy()).rejects.toThrow(/503/);
  });
});

describe('HttpHealthSource', () => {
  it('parses a 503 warming body and rejects garbage', async () => {
    const warming = loadFixture<{ status: string }>(FIXTURES.healthWarming);
    server.use(http.get('http://model.test/v1/health', () => HttpResponse.json(warming, { status: 503 })));
    expect(await new HttpHealthSource('http://model.test', 1000).fetchHealth()).toMatchObject({
      status: 'warming',
      retry_after_seconds: 20,
    });
    server.use(http.get('http://model.test/v1/health', () => new HttpResponse('nope', { status: 200 })));
    await expect(new HttpHealthSource('http://model.test', 1000).fetchHealth()).rejects.toThrow(
      /invalid body/,
    );
  });
});

describe('ModelStatusStore', () => {
  it('emits only on meaningful change', () => {
    const s = new ModelStatusStore();
    const onChange = vi.fn();
    s.on('change', onChange);
    s.update({ status: 'ready', modelVersion: '1' });
    s.update({ status: 'ready', modelVersion: '1' });
    s.update({ status: 'ready', modelVersion: '1', detail: 'just a note' });
    expect(onChange).toHaveBeenCalledTimes(1);
    s.update({ status: 'degraded' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps retryAvailableAt stable under small drift, re-emits on a large one, clears when not warming', () => {
    const s = new ModelStatusStore();
    const onChange = vi.fn();
    s.update({ status: 'warming', retryAvailableAt: '2026-10-27T12:00:20.000Z' });
    s.on('change', onChange);
    s.update({ status: 'warming', retryAvailableAt: '2026-10-27T12:00:22.000Z' });
    expect(onChange).not.toHaveBeenCalled();
    expect(s.get().retryAvailableAt).toBe('2026-10-27T12:00:20.000Z');
    s.update({ status: 'warming', retryAvailableAt: '2026-10-27T12:01:20.000Z' });
    expect(onChange).toHaveBeenCalledTimes(1);
    s.update({ status: 'ready' });
    expect(s.get().retryAvailableAt).toBeNull();
  });

  it('markClassifySuccess clears error/warming but never overrides degraded', () => {
    const s = new ModelStatusStore();
    s.update({ status: 'error' });
    s.markClassifySuccess();
    expect(s.get().status).toBe('ready');
    s.update({ status: 'degraded' });
    s.markClassifySuccess();
    expect(s.get().status).toBe('degraded');
  });
});

describe('ModelStatusPoller', () => {
  const NOW = 1_700_000_000_000;
  const health = (over: Partial<ModelHealth>): ModelHealth => ({
    status: 'ready',
    model_version: '1.0.0',
    taxonomy_version: 'ebola-tax-1.0',
    retry_after_seconds: null,
    ...over,
  });
  async function setup(h: ModelHealth | Error, syncsTaxonomy = true) {
    const source: HealthSource = {
      fetchHealth: () => (h instanceof Error ? Promise.reject(h) : Promise.resolve(h)),
    };
    const store = new ModelStatusStore();
    const taxonomy = new TaxonomyService(
      new FixtureTaxonomySource('multilabel-v1'),
      new MemoryTaxonomyRepo(),
    );
    await taxonomy.resync();
    const resync = vi.spyOn(taxonomy, 'resync');
    const poller = new ModelStatusPoller(source, store, taxonomy, {
      intervalMs: 1000,
      syncsTaxonomy,
      now: () => NOW,
    });
    return { poller, store, resync };
  }

  it('ready', async () => {
    const { poller, store } = await setup(health({}));
    await poller.poll();
    expect(store.get()).toMatchObject({
      status: 'ready',
      modelVersion: '1.0.0',
      taxonomyVersion: 'ebola-tax-1.0',
      retryAvailableAt: null,
    });
  });

  it('warming carries an absolute retryAvailableAt derived from retry_after_seconds', async () => {
    const { poller, store } = await setup(health({ status: 'warming', retry_after_seconds: 20 }));
    await poller.poll();
    expect(store.get()).toMatchObject({
      status: 'warming',
      retryAvailableAt: new Date(NOW + 20_000).toISOString(),
    });
  });

  it('degraded', async () => {
    const { poller, store } = await setup(health({ status: 'degraded' }));
    await poller.poll();
    expect(store.get().status).toBe('degraded');
  });

  it('an unreachable model becomes error (not a crash)', async () => {
    const { poller, store } = await setup(new Error('ECONNREFUSED'));
    await poller.poll();
    expect(store.get().status).toBe('error');
  });

  it('a new taxonomy_version triggers a re-sync; same version or warming does not', async () => {
    const same = await setup(health({}));
    await same.poller.poll();
    expect(same.resync).not.toHaveBeenCalled();

    const changed = await setup(health({ taxonomy_version: 'ebola-tax-2.0' }));
    await changed.poller.poll();
    expect(changed.resync).toHaveBeenCalledTimes(1);

    const warming = await setup(
      health({ status: 'warming', taxonomy_version: 'ebola-tax-2.0', retry_after_seconds: 5 }),
    );
    await warming.poller.poll();
    expect(warming.resync).not.toHaveBeenCalled();
  });

  it('contracts without a taxonomy never re-sync', async () => {
    const { poller, resync } = await setup(health({ taxonomy_version: 'n/a' }), false);
    await poller.poll();
    expect(resync).not.toHaveBeenCalled();
  });
});

describe('buildClassifierStack', () => {
  const base = {
    MODEL_CONTRACT: 'multilabel-v1' as const,
    MODEL_BASE_URL: 'http://model.test',
    MODEL_TIMEOUT_MS: 1000,
    MODEL_WARMUP_MAX_WAIT_MS: 1000,
  };

  it('mock mode: in-process client, taxonomy from fixtures, status ready, no network', async () => {
    const stack = buildClassifierStack({ ...base, MODEL_MODE: 'mock' }, new MemoryTaxonomyRepo(), undefined);
    expect(stack.client.kind).toBe('inprocess');
    await stack.taxonomy.init();
    await stack.poller.poll();
    expect(stack.taxonomy.version()).toBe('ebola-tax-1.0');
    expect(stack.store.get()).toMatchObject({ status: 'ready', modelVersion: '0.0.0-mock' });
  });

  it('mock mode with the 3-class contract exposes the 3-class taxonomy', async () => {
    const stack = buildClassifierStack(
      { ...base, MODEL_MODE: 'mock', MODEL_CONTRACT: 'threeclass-v0' },
      new MemoryTaxonomyRepo(),
      undefined,
    );
    await stack.taxonomy.init();
    expect(stack.taxonomy.version()).toBe('threeclass-v0');
  });

  it('live mode: http client, taxonomy and health over the wire', async () => {
    server.use(
      http.get('http://model.test/v1/taxonomy', () => HttpResponse.json(loadFixture(FIXTURES.taxonomy))),
      http.get('http://model.test/v1/health', () => HttpResponse.json(loadFixture(FIXTURES.healthReady))),
    );
    const stack = buildClassifierStack({ ...base, MODEL_MODE: 'live' }, new MemoryTaxonomyRepo(), undefined);
    expect(stack.client.kind).toBe('http');
    await stack.taxonomy.init();
    await stack.poller.poll();
    expect(stack.taxonomy.version()).toBe('ebola-tax-1.0');
    expect(stack.store.get().status).toBe('ready');
  });

  it('live mode: hooks feed identity (provenance) and status from classify calls', async () => {
    server.use(
      http.get('http://model.test/v1/taxonomy', () => HttpResponse.json(loadFixture(FIXTURES.taxonomy))),
      http.post(
        'http://model.test/v1/classify',
        () => new HttpResponse(null, { status: 503, headers: { 'Retry-After': '30' } }),
      ),
    );
    const onAlert = vi.fn();
    const stack = buildClassifierStack(
      { ...base, MODEL_MODE: 'live', MODEL_WARMUP_MAX_WAIT_MS: 1000 },
      new MemoryTaxonomyRepo(),
      onAlert,
    );
    await stack.taxonomy.init();
    const [r] = await stack.client.classify([{ itemId: 'a', text: 'hi', platform: 'x' }]);
    expect(r).toMatchObject({ outcome: 'pending', reason: 'warming' });
    expect(stack.store.get().status).toBe('warming');
    expect(stack.store.get().retryAvailableAt).not.toBeNull();
  });
});
