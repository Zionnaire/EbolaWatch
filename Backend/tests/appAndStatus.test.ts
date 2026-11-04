import type { RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { ApiRouteDeps } from '../src/routes/api.js';
import type { AuthRouteDeps, TenancyRouteDeps } from '../src/routes/tenancy.js';
import { ModelStatusStore } from '../src/classifier/modelStatus.js';
import { FixtureTaxonomySource, MemoryTaxonomyRepo, TaxonomyService } from '../src/classifier/taxonomy.js';
import type { ModelIdentity } from '../src/classifier/types.js';
import {
  AlertEventSchema,
  SocketEventSchemas,
  SystemStatusSchema,
  TaxonomyDtoSchema,
  mockStages,
} from '../src/contracts/api/index.js';
import { buildSystemStatus } from '../src/services/systemStatus.js';
import { emitAlert, wireModelStatus, type Broadcaster } from '../src/sockets/index.js';

const FRONTEND = 'http://localhost:5173';
type Cfg = Parameters<typeof buildSystemStatus>[0]['config'];
const baseConfig: Cfg = {
  MODEL_MODE: 'mock',
  MODEL_CONTRACT: 'multilabel-v1',
  INGESTION_MODE: 'mock',
  MODEL_MOCK_MARKER: 'mock',
};

async function setup(
  over: {
    kind?: 'inprocess' | 'http';
    identity?: ModelIdentity | null;
    config?: Partial<Cfg>;
  } = {},
) {
  const store = new ModelStatusStore();
  const taxonomy = new TaxonomyService(new FixtureTaxonomySource('multilabel-v1'), new MemoryTaxonomyRepo());
  const identity = { current: over.identity ?? null };
  const getStatus = () =>
    buildSystemStatus({
      config: { ...baseConfig, ...over.config },
      store,
      classifier: { kind: over.kind ?? 'inprocess' },
      identity,
      operatingMode: () => 'dormant',
    });
  const passthrough: RequestHandler = (_req, _res, next) => next();
  // only the public system routes are exercised here; the other routers are inert stand-ins
  const api = { authenticate: passthrough, ingestKey: passthrough } as unknown as ApiRouteDeps;
  const auth = { authenticate: passthrough, authLimiter: passthrough } as unknown as AuthRouteDeps;
  const tenancy = { authenticate: passthrough } as unknown as TenancyRouteDeps;
  const app = createApp({ FRONTEND_URL: FRONTEND }, { system: { getStatus, taxonomy }, auth, tenancy, api });
  return { app, store, taxonomy, getStatus, identity };
}

describe('GET /api/system/status', () => {
  it('returns a schema-valid status with provenance for every stage', async () => {
    const { app, store } = await setup();
    store.update({
      status: 'warming',
      modelVersion: '0.0.0-mock',
      retryAvailableAt: '2026-10-27T12:00:20.000Z',
    });
    const res = await request(app).get('/api/system/status');
    expect(res.status).toBe(200);
    expect(SystemStatusSchema.parse(res.body)).toMatchObject({
      modelMode: 'mock',
      modelContract: 'multilabel-v1',
      dataSource: { ingestion: 'mock', classifier: 'mock-inprocess', generator: 'mock', dispatcher: 'mock' },
      modelStatus: 'warming',
      operatingMode: 'dormant',
      retryAvailableAt: '2026-10-27T12:00:20.000Z',
    });
  });

  it('the config flag reaches the client: MODEL_MODE / INGESTION_MODE / contract are echoed', async () => {
    const { getStatus } = await setup({
      config: { MODEL_MODE: 'live', MODEL_CONTRACT: 'threeclass-v0', INGESTION_MODE: 'push' },
    });
    expect(getStatus()).toMatchObject({
      modelMode: 'live',
      modelContract: 'threeclass-v0',
      dataSource: { ingestion: 'push' },
    });
  });

  it('cannot lie: a mock server reached in live mode is reported as mock-server', async () => {
    const mock = await setup({
      kind: 'http',
      config: { MODEL_MODE: 'live' },
      identity: { name: 'mock-ebola-clf', version: '0.0.0-mock', taxonomyVersion: 'ebola-tax-1.0' },
    });
    expect(mock.getStatus().dataSource.classifier).toBe('mock-server');
    expect(mockStages(mock.getStatus().dataSource)).toContain('classifier');

    const live = await setup({
      kind: 'http',
      config: { MODEL_MODE: 'live' },
      identity: { name: 'ebola-clf', version: '1.0.0', taxonomyVersion: 'ebola-tax-1.0' },
    });
    expect(live.getStatus().dataSource.classifier).toBe('live');
  });

  it('the generator and dispatcher are reported as mock until they are real', async () => {
    const { getStatus } = await setup();
    expect(getStatus().dataSource.generator).toBe('mock');
    expect(getStatus().dataSource.dispatcher).toBe('mock');
  });
});

describe('GET /api/taxonomy', () => {
  it('503 before the first sync, then serves the current taxonomy', async () => {
    const { app, taxonomy } = await setup();
    expect((await request(app).get('/api/taxonomy')).status).toBe(503);
    await taxonomy.resync();
    const res = await request(app).get('/api/taxonomy');
    expect(res.status).toBe(200);
    expect(TaxonomyDtoSchema.parse(res.body).categories).toHaveLength(12);
  });

  it('?version= resolves the taxonomy a classification was made with; unknown -> 404', async () => {
    const { app, taxonomy } = await setup();
    await taxonomy.resync();
    expect((await request(app).get('/api/taxonomy?version=ebola-tax-1.0')).status).toBe(200);
    const missing = await request(app).get('/api/taxonomy?version=nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('taxonomy_not_found');
  });
});

describe('app hardening', () => {
  it('unknown routes return a JSON 404', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('CORS is locked to FRONTEND_URL and never reflects other origins', async () => {
    const { app } = await setup();
    const ok = await request(app).get('/api/health').set('Origin', FRONTEND);
    expect(ok.headers['access-control-allow-origin']).toBe(FRONTEND);
    const evil = await request(app).get('/api/health').set('Origin', 'http://evil.example');
    // A fixed origin is always answered with FRONTEND_URL: the browser blocks the mismatch. Never * and never the caller's origin.
    expect(evil.headers['access-control-allow-origin']).toBe(FRONTEND);
  });

  it('sets helmet headers and hides x-powered-by', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('malformed JSON is a 400, not a 500', async () => {
    const { app } = await setup();
    const res = await request(app).post('/api/health').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
  });
});

describe('socket wiring', () => {
  const fake = () => {
    const emit = vi.fn();
    return { b: { emit } as unknown as Broadcaster, emit };
  };

  it('emits model:status on store change with an absolute retryAvailableAt, schema-valid', () => {
    const { b, emit } = fake();
    const store = new ModelStatusStore();
    wireModelStatus(store, b);
    store.update({ status: 'warming', modelVersion: '1', retryAvailableAt: '2026-10-27T12:00:20.000Z' });
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0]!;
    expect(event).toBe('model:status');
    expect(SocketEventSchemas['model:status'].safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({ modelStatus: 'warming', retryAvailableAt: '2026-10-27T12:00:20.000Z' });
  });

  it('does not emit when nothing changed', () => {
    const { b, emit } = fake();
    const store = new ModelStatusStore();
    wireModelStatus(store, b);
    store.update({ status: 'ready', modelVersion: '1' });
    store.update({ status: 'ready', modelVersion: '1' });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emitAlert produces a schema-valid alert event', () => {
    const { b, emit } = fake();
    emitAlert(b, { level: 'critical', code: 'taxonomy_mismatch', message: 'm' });
    const [event, payload] = emit.mock.calls[0]!;
    expect(event).toBe('alert');
    expect(AlertEventSchema.safeParse(payload).success).toBe(true);
  });
});
