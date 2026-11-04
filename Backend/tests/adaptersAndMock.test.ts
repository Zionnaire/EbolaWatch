import { describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../src/classifier/adapters/index.js';
import { multilabelV1Adapter } from '../src/classifier/adapters/multilabelV1.js';
import { threeClassV0Adapter } from '../src/classifier/adapters/threeClassV0.js';
import { MOCK_MODEL_NAME, MOCK_MODEL_VERSION } from '../src/classifier/fixtureResponder.js';
import { InProcessMockClassifier } from '../src/classifier/inProcessMock.js';
import { classifierProvenance, matchesMockMarker } from '../src/classifier/provenance.js';
import { findUnknownLabels } from '../src/classifier/unknownLabels.js';
import { ClassificationSchema } from '../src/contracts/api/index.js';
import { FIXTURES, loadFixture } from '../src/contracts/fixtures/index.js';

describe('multilabel-v1 adapter', () => {
  it('maps completed items into valid neutral Classifications and keeps raw output', () => {
    const parsed = multilabelV1Adapter.parseResponse(loadFixture(FIXTURES.completed));
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.model).toEqual({ name: 'ebola-clf', version: '1.0.0', taxonomyVersion: 'ebola-tax-1.0' });
    const endorse = parsed.items[0]!;
    if (endorse.status !== 'completed') throw new Error('expected completed');
    expect(ClassificationSchema.safeParse(endorse.classification).success).toBe(true);
    expect(endorse.classification).toMatchObject({
      contract: 'multilabel-v1',
      isRelevant: true,
      stance: 'endorses',
      language: 'pcm',
      threeClass: null,
      severity: { level: 4 },
    });
    expect(endorse.raw).toHaveProperty('language.code_switched', true); // full output retained
  });

  it('maps irrelevant items (null stance / severity) and failed items', () => {
    const irr = multilabelV1Adapter.parseResponse(loadFixture(FIXTURES.irrelevant));
    if (!irr.ok) throw new Error('expected ok');
    const item = irr.items[0]!;
    if (item.status !== 'completed') throw new Error('expected completed');
    expect(item.classification).toMatchObject({ isRelevant: false, stance: null, severity: null });
    expect(irr.items[1]).toMatchObject({
      status: 'completed',
      classification: { truncated: true, language: 'und' },
    });

    const partial = multilabelV1Adapter.parseResponse(loadFixture(FIXTURES.partial));
    if (!partial.ok) throw new Error('expected ok');
    expect(partial.items[1]).toEqual({
      itemId: 'syn_empty',
      status: 'failed',
      code: 'empty_text',
      message: 'Text was empty after normalisation',
    });
  });

  it('returns ok:false with zod issues for invalid payloads', () => {
    const bad = { ...loadFixture<object>(FIXTURES.completed), status: 'complete' };
    const r = multilabelV1Adapter.parseResponse(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
    expect(multilabelV1Adapter.parseResponse(undefined).ok).toBe(false);
  });

  it('builds a request with absent values as null, never omitted', () => {
    const req = multilabelV1Adapter.buildRequest('rid', 'ebola-tax-1.0', [
      { itemId: 'a', text: 't', platform: 'x' },
    ]) as {
      items: Record<string, unknown>[];
    };
    expect(req.items[0]).toEqual({
      item_id: 'a',
      text: 't',
      platform: 'x',
      language_hint: null,
      context_text: null,
    });
  });
});

describe('threeclass-v0 adapter (ASSUMED)', () => {
  it('maps label to relevance and keeps probabilities/entropy', () => {
    const parsed = threeClassV0Adapter.parseResponse(loadFixture(FIXTURES.threeClass));
    if (!parsed.ok) throw new Error('expected ok');
    const [mis, factual, irr, failed] = parsed.items;
    expect(mis).toMatchObject({
      status: 'completed',
      classification: {
        contract: 'threeclass-v0',
        isRelevant: true,
        stance: null,
        categories: [],
        severity: null,
        taxonomyVersion: null,
        threeClass: { label: 'misinformation', entropy: 0.31 },
      },
    });
    expect(factual).toMatchObject({ classification: { isRelevant: true, language: 'pcm' } });
    expect(irr).toMatchObject({ classification: { isRelevant: false, language: null } });
    expect(failed).toMatchObject({ status: 'failed', code: 'empty_text' });
    for (const i of [mis, factual, irr]) {
      if (i!.status === 'completed')
        expect(ClassificationSchema.safeParse(i!.classification).success).toBe(true);
    }
  });

  it('sends no taxonomy_version', () => {
    expect(threeClassV0Adapter.buildRequest('r', 'ignored', [])).not.toHaveProperty('taxonomy_version');
    expect(adapterFor('threeclass-v0')).toBe(threeClassV0Adapter);
    expect(adapterFor('multilabel-v1')).toBe(multilabelV1Adapter);
  });
});

describe('unknown category labels', () => {
  const c = ClassificationSchema.parse({
    contract: 'multilabel-v1',
    modelName: 'm',
    modelVersion: '1',
    taxonomyVersion: 't',
    isRelevant: true,
    relevanceConfidence: 1,
    language: 'en',
    stance: 'endorses',
    categories: [
      { label: 'a', score: 0.9 },
      { label: 'zzz', score: 0.1 },
    ],
    severity: null,
    threeClass: null,
    truncated: false,
    latencyMs: 1,
  });
  it('reports labels absent from the taxonomy, and nothing when no taxonomy is known', () => {
    expect(findUnknownLabels(c, new Set(['a']))).toEqual(['zzz']);
    expect(findUnknownLabels(c, new Set(['a', 'zzz']))).toEqual([]);
    expect(findUnknownLabels(c, null)).toEqual([]);
  });
});

describe('InProcessMockClassifier', () => {
  const taxonomy = { version: () => 'ebola-tax-1.0', knownCategoryIds: () => null };
  const input = (id: string, text = 'synthetic') => ({ itemId: id, text, platform: 'bluesky' });

  it('is deterministic, offline and goes through the real adapter', async () => {
    const hooks = { onModelIdentity: vi.fn() };
    const c = new InProcessMockClassifier('multilabel-v1', taxonomy, hooks);
    const a = await c.classify([input('x'), input('y')]);
    const b = await c.classify([input('y'), input('x')]);
    expect(a[0]).toEqual(b[1]);
    expect(a[0]).toMatchObject({
      outcome: 'classified',
      model: { name: MOCK_MODEL_NAME, version: MOCK_MODEL_VERSION },
    });
    expect(hooks.onModelIdentity).toHaveBeenCalledWith(expect.objectContaining({ name: MOCK_MODEL_NAME }));
  });

  it('empty text is a terminal item failure; the rest of the batch is classified', async () => {
    const c = new InProcessMockClassifier('multilabel-v1', taxonomy);
    const r = await c.classify([input('ok'), input('empty', '   ')]);
    expect(r[0]!.outcome).toBe('classified');
    expect(r[1]).toMatchObject({ outcome: 'error', reason: 'item_failed', code: 'empty_text' });
  });

  it('every item fails -> still one result per item', async () => {
    const r = await new InProcessMockClassifier('multilabel-v1', taxonomy).classify([input('e', '')]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: 'error' });
  });

  it('supports the threeclass-v0 contract', async () => {
    const c = new InProcessMockClassifier('threeclass-v0', {
      version: () => null,
      knownCategoryIds: () => null,
    });
    const r = (await c.classify([input('x')]))[0]!;
    if (r.outcome !== 'classified') throw new Error('expected classified');
    expect(r.classification.contract).toBe('threeclass-v0');
    expect(r.classification.threeClass).not.toBeNull();
    expect(r.model.name).toContain('mock');
  });

  it('flags unknown labels against a taxonomy that lacks them', async () => {
    const c = new InProcessMockClassifier('multilabel-v1', {
      version: () => 'ebola-tax-1.0',
      knownCategoryIds: () => new Set(['x']),
    });
    const r = (await c.classify([input('x')]))[0]!;
    if (r.outcome !== 'classified') throw new Error('expected classified');
    expect(r.unknownLabels.length).toBeGreaterThan(0);
  });
});

describe('provenance', () => {
  it('matches the mock marker in name or version, case-insensitively', () => {
    expect(matchesMockMarker({ name: 'mock-ebola-clf', version: '1.0.0' }, 'mock')).toBe(true);
    expect(matchesMockMarker({ name: 'ebola-clf', version: '0.0.0-MOCK' }, 'mock')).toBe(true);
    expect(matchesMockMarker({ name: 'ebola-clf', version: '1.0.0' }, 'mock')).toBe(false);
  });

  it('in-process is always mock-inprocess; http trusts the model identity, not our flags', () => {
    expect(classifierProvenance('inprocess', null, 'mock')).toBe('mock-inprocess');
    expect(classifierProvenance('http', { name: 'mock-ebola-clf', version: '0.0.0-mock' }, 'mock')).toBe(
      'mock-server',
    );
    expect(classifierProvenance('http', { name: 'ebola-clf', version: '1.0.0' }, 'mock')).toBe('live');
  });

  it('cannot claim live before the model has identified itself', () => {
    expect(classifierProvenance('http', null, 'mock')).toBe('mock-server');
  });
});
