/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate fixtures with deliberately invalid shapes */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURES, loadFixture } from '../src/contracts/fixtures/index.js';
import {
  ClassifyRequestSchema,
  ClassifyRequestStrictSchema,
  ClassifyResponseSchema,
  ClassifyResponseStrictSchema,
  HealthSchema,
  HealthStrictSchema,
  MULTILABEL_LANGUAGES,
  MULTILABEL_STANCES,
  TaxonomySchema,
  TaxonomyStrictSchema,
  type ClassifyResponse,
} from '../src/contracts/model/multilabelV1.js';
import {
  ThreeClassResponseSchema,
  ThreeClassResponseStrictSchema,
} from '../src/contracts/model/threeClassV0.js';
import { LanguageSchema, StanceSchema } from '../src/contracts/api/classification.js';

const clone = <T>(v: T): T => structuredClone(v);
const completedBatch = () => loadFixture<ClassifyResponse>(FIXTURES.completed);
const item0 = (b: any) => b.results[0];

describe('fixtures parse', () => {
  it.each([FIXTURES.categories, FIXTURES.completed, FIXTURES.partial, FIXTURES.irrelevant])(
    '%s (runtime + strict)',
    (f) => {
      const data = loadFixture(f);
      expect(ClassifyResponseSchema.safeParse(data).success).toBe(true);
      expect(ClassifyResponseStrictSchema.safeParse(data).success).toBe(true);
    },
  );

  it('request, health x3, taxonomy', () => {
    expect(ClassifyRequestStrictSchema.safeParse(loadFixture(FIXTURES.request)).success).toBe(true);
    for (const f of [FIXTURES.healthReady, FIXTURES.healthWarming, FIXTURES.healthDegraded]) {
      expect(HealthStrictSchema.safeParse(loadFixture(f)).success).toBe(true);
    }
    expect(TaxonomyStrictSchema.safeParse(loadFixture(FIXTURES.taxonomy)).success).toBe(true);
  });

  it('threeclass fixture parses and carries the ASSUMED marker', () => {
    expect(ThreeClassResponseStrictSchema.safeParse(loadFixture(FIXTURES.threeClass)).success).toBe(true);
    expect(
      readFileSync(new URL(`../src/contracts/fixtures/${FIXTURES.threeClass}`, import.meta.url), 'utf8'),
    ).toContain('ASSUMED');
    expect(FIXTURES.threeClass).toContain('ASSUMED');
  });

  it('every json fixture in the folder is covered by FIXTURES', () => {
    const files = readdirSync(new URL('../src/contracts/fixtures/', import.meta.url)).filter((f) =>
      f.endsWith('.json'),
    );
    expect(files.sort()).toEqual(Object.values(FIXTURES).sort());
  });

  it('covers all 12 categories as top category and all 7 languages', () => {
    const batch = loadFixture<ClassifyResponse>(FIXTURES.categories);
    const taxonomy = TaxonomySchema.parse(loadFixture(FIXTURES.taxonomy));
    const tops = new Set<string>();
    const langs = new Set<string>();
    for (const r of batch.results) {
      if (r.status === 'completed') {
        tops.add(r.categories[0]!.label);
        langs.add(r.language.primary);
        // every category present in each item
        expect(r.categories).toHaveLength(taxonomy.categories.length);
      }
    }
    expect([...tops].sort()).toEqual(taxonomy.categories.map((c) => c.id).sort());
    expect([...langs].sort()).toEqual([...MULTILABEL_LANGUAGES].sort());
    expect(taxonomy.categories).toHaveLength(12);
  });

  it('partial fixture has exactly one failed item that carries only item_id/status/error', () => {
    const b = loadFixture<ClassifyResponse>(FIXTURES.partial);
    const failed = b.results.filter((r) => r.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(Object.keys(failed[0]!).sort()).toEqual(['error', 'item_id', 'status']);
  });
});

describe('enum drift between model contract and internal API', () => {
  it('stance and language ids match', () => {
    expect([...StanceSchema.options]).toEqual([...MULTILABEL_STANCES]);
    expect([...LanguageSchema.options]).toEqual([...MULTILABEL_LANGUAGES]);
  });
});

describe('multilabel-v1 strictness', () => {
  it('"complete" instead of "completed" fails', () => {
    const b = completedBatch();
    (b as { status: string }).status = 'complete';
    expect(ClassifyResponseSchema.safeParse(b).success).toBe(false);
    const c = completedBatch();
    (item0(c) as { status: string }).status = 'complete';
    expect(ClassifyResponseSchema.safeParse(c).success).toBe(false);
  });

  it('a missing key fails', () => {
    const b = completedBatch();
    delete item0(b).truncated;
    expect(ClassifyResponseSchema.safeParse(b).success).toBe(false);
  });

  it('an extra key is stripped at runtime but fails strict', () => {
    const b = completedBatch();
    item0(b).surprise = 1;
    const runtime = ClassifyResponseSchema.safeParse(b);
    expect(runtime.success).toBe(true);
    if (runtime.success) expect(item0(runtime.data)).not.toHaveProperty('surprise');
    expect(ClassifyResponseStrictSchema.safeParse(b).success).toBe(false);
  });

  it('strict variants of other schemas reject extra keys too', () => {
    expect(HealthStrictSchema.safeParse({ ...loadFixture<object>(FIXTURES.healthReady), x: 1 }).success).toBe(
      false,
    );
    expect(HealthSchema.safeParse({ ...loadFixture<object>(FIXTURES.healthReady), x: 1 }).success).toBe(true);
    expect(
      ThreeClassResponseSchema.safeParse({ ...loadFixture<object>(FIXTURES.threeClass), x: 1 }).success,
    ).toBe(true);
    expect(
      ThreeClassResponseStrictSchema.safeParse({ ...loadFixture<object>(FIXTURES.threeClass), x: 1 }).success,
    ).toBe(false);
  });

  it('unknown enum values fail (stance, language, severity)', () => {
    for (const mutate of [
      (b: any) => (item0(b).stance.label = 'agrees'),
      (b: any) => (item0(b).language.primary = 'sw'),
      (b: any) => (item0(b).severity.level = 5),
    ]) {
      const b = completedBatch();
      mutate(b);
      expect(ClassifyResponseSchema.safeParse(b).success).toBe(false);
    }
  });

  it('unknown category labels are NOT a schema failure (validated against the taxonomy at runtime)', () => {
    const b = completedBatch();
    item0(b).categories[0].label = 'brand_new_category';
    expect(ClassifyResponseSchema.safeParse(b).success).toBe(true);
  });
});

describe('multilabel-v1 invariants (passing and failing)', () => {
  it('categories sorted descending', () => {
    expect(ClassifyResponseSchema.safeParse(completedBatch()).success).toBe(true);
    const b = completedBatch();
    item0(b).categories.reverse();
    expect(ClassifyResponseSchema.safeParse(b).success).toBe(false);
  });

  it('categories unique', () => {
    const b = completedBatch();
    item0(b).categories[1].label = item0(b).categories[0].label;
    expect(ClassifyResponseSchema.safeParse(b).success).toBe(false);
  });

  it('scores and confidences within [0,1]', () => {
    const a = completedBatch();
    item0(a).categories[0].score = 1.2;
    expect(ClassifyResponseSchema.safeParse(a).success).toBe(false);
    const b = completedBatch();
    item0(b).language.confidence = -0.1;
    expect(ClassifyResponseSchema.safeParse(b).success).toBe(false);
    const c = completedBatch();
    item0(c).severity.confidence = 2;
    expect(ClassifyResponseSchema.safeParse(c).success).toBe(false);
  });

  it('distribution length 5', () => {
    const b = completedBatch();
    item0(b).severity.distribution = [0.5, 0.5];
    expect(ClassifyResponseSchema.safeParse(b).success).toBe(false);
  });

  it('distribution sums to ~1 (±0.01)', () => {
    const ok = completedBatch();
    item0(ok).severity.distribution = [0.02, 0.03, 0.06, 0.15, 0.74];
    expect(ClassifyResponseSchema.safeParse(ok).success).toBe(true);
    const within = clone(ok);
    item0(within).severity.distribution = [0.02, 0.03, 0.06, 0.15, 0.745];
    expect(ClassifyResponseSchema.safeParse(within).success).toBe(true);
    const bad = clone(ok);
    item0(bad).severity.distribution = [0.1, 0.1, 0.1, 0.1, 0.1];
    expect(ClassifyResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('is_ebola_related=false requires null stance and severity', () => {
    expect(ClassifyResponseSchema.safeParse(loadFixture(FIXTURES.irrelevant)).success).toBe(true);
    for (const field of ['stance', 'severity'] as const) {
      const b = completedBatch();
      item0(b).relevance.is_ebola_related = false;
      const ok = clone(b);
      item0(ok).stance = null;
      item0(ok).severity = null;
      expect(ClassifyResponseSchema.safeParse(ok).success).toBe(true);
      item0(ok)[field] =
        field === 'stance' ? { label: 'endorses', confidence: 0.5 } : item0(completedBatch()).severity;
      expect(ClassifyResponseSchema.safeParse(ok).success).toBe(false);
    }
  });

  it('failed items may only carry item_id, status, error (extra fields stripped; missing error fails)', () => {
    const b = loadFixture<ClassifyResponse>(FIXTURES.partial);
    const failed = clone(b);
    delete (failed.results[1] as { error?: unknown }).error;
    expect(ClassifyResponseSchema.safeParse(failed).success).toBe(false);
    const withExtra = clone(b);
    (withExtra.results[1] as Record<string, unknown>).language = { primary: 'en' };
    expect(ClassifyResponseStrictSchema.safeParse(withExtra).success).toBe(false);
  });

  it('completed item missing completed-only fields fails (discriminated on status)', () => {
    const b = completedBatch();
    delete item0(b).language;
    expect(ClassifyResponseSchema.safeParse(b).success).toBe(false);
  });

  it('batch status: completed = all completed', () => {
    const partial = loadFixture<ClassifyResponse>(FIXTURES.partial);
    partial.status = 'completed';
    expect(ClassifyResponseSchema.safeParse(partial).success).toBe(false);
  });

  it('batch status: partial = >=1 failed and >=1 completed', () => {
    expect(ClassifyResponseSchema.safeParse(loadFixture(FIXTURES.partial)).success).toBe(true);
    const b = completedBatch();
    b.status = 'partial';
    expect(ClassifyResponseSchema.safeParse(b).success).toBe(false);
  });

  it('batch status: failed = all failed', () => {
    const allFailed = loadFixture<ClassifyResponse>(FIXTURES.partial);
    allFailed.results = [allFailed.results[1]!];
    allFailed.status = 'failed';
    expect(ClassifyResponseSchema.safeParse(allFailed).success).toBe(true);
    const partial = loadFixture<ClassifyResponse>(FIXTURES.partial);
    partial.status = 'failed';
    expect(ClassifyResponseSchema.safeParse(partial).success).toBe(false);
  });

  it('request enforces 1..32 items', () => {
    const req = loadFixture<{ items: unknown[] }>(FIXTURES.request);
    expect(ClassifyRequestSchema.safeParse(req).success).toBe(true);
    const big = { ...req, items: Array.from({ length: 33 }, () => req.items[0]) };
    expect(ClassifyRequestSchema.safeParse(big).success).toBe(false);
  });
});

describe('threeclass-v0 (ASSUMED shape)', () => {
  it('rejects unknown label and out-of-range probabilities', () => {
    const a = loadFixture<any>(FIXTURES.threeClass);
    a.results[0].label = 'maybe';
    expect(ThreeClassResponseSchema.safeParse(a).success).toBe(false);
    const b = loadFixture<any>(FIXTURES.threeClass);
    b.results[0].probabilities.factual = 1.5;
    expect(ThreeClassResponseSchema.safeParse(b).success).toBe(false);
  });
});
