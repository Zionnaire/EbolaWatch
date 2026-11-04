import { describe, expect, it } from 'vitest';
import {
  ClassificationSchema,
  RulesConfigSchema,
  type Classification,
  type RulesConfig,
} from '../src/contracts/api/index.js';
import { decide, priorityScore, type DecisionInput } from '../src/services/decisionEngine.js';
import {
  DEFAULT_CATEGORY_FLOORS,
  MemoryRulesRepo,
  RulesService,
  defaultRules,
  rulesKey,
} from '../src/services/rules.js';

const rules = (over: Partial<RulesConfig> = {}): RulesConfig => ({
  ...defaultRules('multilabel-v1', 'ebola-tax-1.0'),
  ...over,
});

const ml = (over: Partial<Classification> = {}): Classification =>
  ClassificationSchema.parse({
    contract: 'multilabel-v1',
    modelName: 'm',
    modelVersion: '1',
    taxonomyVersion: 'ebola-tax-1.0',
    isRelevant: true,
    relevanceConfidence: 0.95,
    language: 'en',
    stance: 'endorses',
    categories: [{ label: 'fake_cure_prevention', score: 0.88 }],
    severity: { level: 1, confidence: 0.7, distribution: [0.1, 0.5, 0.2, 0.1, 0.1] },
    threeClass: null,
    truncated: false,
    latencyMs: 100,
    ...over,
  });

const input = (c: Classification, over: Partial<DecisionInput> = {}): DecisionInput => ({
  classification: c,
  text: 'drink salt water to be safe',
  engagement: null,
  unknownLabels: [],
  ...over,
});

const tc = (
  label: 'misinformation' | 'factual' | 'irrelevant',
  misinformation: number,
  over: Partial<Classification> = {},
): Classification =>
  ClassificationSchema.parse({
    contract: 'threeclass-v0',
    modelName: 'legacy',
    modelVersion: '0.9',
    taxonomyVersion: null,
    isRelevant: label !== 'irrelevant',
    relevanceConfidence: 0.9,
    language: 'en',
    stance: null,
    categories: [],
    severity: null,
    threeClass: {
      label,
      probabilities: {
        misinformation,
        factual: (1 - misinformation) / 2,
        irrelevant: (1 - misinformation) / 2,
      },
      entropy: 0.4,
    },
    truncated: false,
    latencyMs: 80,
    ...over,
  });

const tcRules = () => defaultRules('threeclass-v0', null);

describe('multilabel-v1 decisions', () => {
  it('not relevant => not misinformation, null severity, queue none', () => {
    const d = decide(input(ml({ isRelevant: false, stance: null, severity: null })), rules(), 'dormant');
    expect(d).toMatchObject({
      isMisinformation: false,
      finalSeverity: null,
      queue: 'none',
      urgent: false,
      priorityScore: 0,
    });
  });

  it('endorsing + category over threshold => misinformation in the review queue', () => {
    const d = decide(input(ml()), rules(), 'dormant');
    expect(d).toMatchObject({ isMisinformation: true, queue: 'review' });
    expect(d.reasons.join(' ')).toContain('fake_cure_prevention');
  });

  it('finalSeverity = max(model severity, category floors, keyword severity)', () => {
    // model 1, floor(fake_cure_prevention)=3 -> 3
    expect(decide(input(ml()), rules(), 'dormant').finalSeverity).toBe(3);
    // model 4 beats floor 3
    const high = ml({ severity: { level: 4, confidence: 0.7, distribution: [0, 0, 0, 0.1, 0.9] } });
    expect(decide(input(high), rules(), 'dormant').finalSeverity).toBe(4);
    // keyword severity wins when highest
    const kw = rules({ keywordRules: [{ id: 'burn', pattern: 'salt water', flags: 'iu', severity: 4 }] });
    const d = decide(input(ml()), kw, 'dormant');
    expect(d.finalSeverity).toBe(4);
    expect(d.reasons.join(' ')).toContain('Keyword rule "burn"');
    expect(d.rulesSnapshot.keywordMatches).toEqual(['burn']);
  });

  it('multiple over-threshold categories: the highest floor counts, under-threshold floors do not', () => {
    const c = ml({
      categories: [
        { label: 'incitement_against_response', score: 0.7 },
        { label: 'fake_cure_prevention', score: 0.6 },
        { label: 'other_ebola_misinfo', score: 0.1 },
      ],
      severity: { level: 0, confidence: 0.7, distribution: [0.9, 0.1, 0, 0, 0] },
    });
    expect(decide(input(c), rules(), 'dormant').finalSeverity).toBe(4);
    const below = ml({
      categories: [
        { label: 'fake_cure_prevention', score: 0.6 },
        { label: 'incitement_against_response', score: 0.3 }, // under threshold: its floor 4 must NOT apply
      ],
      severity: { level: 0, confidence: 0.7, distribution: [0.9, 0.1, 0, 0, 0] },
    });
    expect(decide(input(below), rules(), 'dormant').finalSeverity).toBe(3);
  });

  it('nothing over threshold => not misinformation, queue none, stored', () => {
    const c = ml({ categories: [{ label: 'fake_cure_prevention', score: 0.49 }] });
    const d = decide(input(c), rules(), 'dormant');
    expect(d).toMatchObject({ isMisinformation: false, finalSeverity: null, queue: 'none' });
    expect(d.reasons.join(' ')).toContain('No category reached its threshold');
  });

  it('threshold boundary is inclusive (>=)', () => {
    const at = ml({ categories: [{ label: 'fake_cure_prevention', score: 0.5 }] });
    expect(decide(input(at), rules(), 'dormant').isMisinformation).toBe(true);
  });

  it('dormant vs surge: 0.45 is below the dormant threshold (0.5) but over the surge one (0.4)', () => {
    const c = ml({ categories: [{ label: 'fake_cure_prevention', score: 0.45 }] });
    expect(decide(input(c), rules(), 'dormant').isMisinformation).toBe(false);
    const surge = decide(input(c), rules(), 'surge');
    expect(surge.isMisinformation).toBe(true);
    expect(surge.rulesSnapshot).toMatchObject({ mode: 'surge', thresholds: { fake_cure_prevention: 0.4 } });
  });

  it('per-category threshold overrides the default', () => {
    const r = rules({
      categories: {
        ...rules().categories,
        fake_cure_prevention: { floor: 3, thresholds: { dormant: 0.9, surge: 0.8 } },
      },
    });
    expect(decide(input(ml()), r, 'dormant').isMisinformation).toBe(false); // 0.88 < 0.9
    expect(decide(input(ml()), r, 'surge').isMisinformation).toBe(true);
  });

  it('only an endorsing stance can be misinformation', () => {
    for (const stance of ['refutes', 'neutral_report'] as const) {
      const d = decide(input(ml({ stance })), rules(), 'dormant');
      expect(d).toMatchObject({ isMisinformation: false, queue: 'none' });
    }
    expect(decide(input(ml({ stance: null })), rules(), 'dormant').queue).toBe('none');
  });

  it('relevant + stance questions => information_gap queue, not misinformation', () => {
    const d = decide(input(ml({ stance: 'questions' })), rules(), 'dormant');
    expect(d).toMatchObject({
      isMisinformation: false,
      finalSeverity: null,
      queue: 'information_gap',
      priorityScore: 5,
    });
  });

  it('urgent when final severity reaches urgentSeverityMin', () => {
    const c = ml({ categories: [{ label: 'incitement_against_response', score: 0.9 }] });
    expect(decide(input(c), rules(), 'dormant')).toMatchObject({ finalSeverity: 4, urgent: true });
    expect(decide(input(ml()), rules(), 'dormant').urgent).toBe(false);
  });

  it('a category with no rule uses the default threshold and floor 0, and is reported', () => {
    const c = ml({
      categories: [{ label: 'new_but_known_category', score: 0.6 }],
      severity: { level: 1, confidence: 1, distribution: [0, 1, 0, 0, 0] },
    });
    const d = decide(input(c), rules(), 'dormant');
    expect(d).toMatchObject({
      isMisinformation: true,
      finalSeverity: 1,
      rulelessCategories: ['new_but_known_category'],
    });
    expect(d.needsReview).toBe(false);
  });

  it('an unknown label (absent from the taxonomy) flags needs_review but never crashes', () => {
    const c = ml({
      categories: [
        { label: 'brand_new', score: 0.9 },
        { label: 'fake_cure_prevention', score: 0.1 },
      ],
    });
    const d = decide(input(c, { unknownLabels: ['brand_new'] }), rules(), 'dormant');
    expect(d.needsReview).toBe(true);
    expect(d.reasons.join(' ')).toContain('Unknown category label');
    // still decided: unknown label uses default threshold and floor 0
    expect(d.isMisinformation).toBe(true);
    // and for an irrelevant post too
    const irr = decide(
      input(ml({ isRelevant: false, stance: null, severity: null }), { unknownLabels: ['x'] }),
      rules(),
      'dormant',
    );
    expect(irr.needsReview).toBe(true);
  });

  it('missing model severity counts as 0', () => {
    const c = ml({ severity: null, categories: [{ label: 'other_ebola_misinfo', score: 0.7 }] });
    expect(decide(input(c), rules(), 'dormant').finalSeverity).toBe(1);
  });

  it('snapshots the thresholds, floors, keyword rules, bands and mode actually used', () => {
    const d = decide(input(ml()), rules(), 'surge');
    expect(d.rulesSnapshot).toMatchObject({
      mode: 'surge',
      contract: 'multilabel-v1',
      taxonomyVersion: 'ebola-tax-1.0',
      thresholds: { fake_cure_prevention: 0.4 },
      floors: { fake_cure_prevention: 3 },
      keywordRules: [],
      confidenceBands: { urgent: 0.9, standard: 0.75 },
    });
  });

  it('is pure: same input, same output, input not mutated', () => {
    const i = input(ml());
    const r = rules(); // one instance: updatedAt is part of the snapshot
    const before = JSON.stringify([i, r]);
    expect(decide(i, r, 'dormant')).toEqual(decide(i, r, 'dormant'));
    expect(JSON.stringify([i, r])).toBe(before);
  });
});

describe('priorityScore (placeholder)', () => {
  it('is 0 without a severity, grows with severity, urgency and engagement; null engagement is fine', () => {
    expect(priorityScore(null, false, null)).toBe(0);
    expect(priorityScore(2, false, null)).toBe(40);
    expect(priorityScore(2, true, null)).toBe(65);
    expect(priorityScore(2, false, { likes: 100, reposts: 50, replies: 10 })).toBeGreaterThan(40);
    expect(priorityScore(2, false, { likes: null, reposts: undefined })).toBe(40);
    expect(priorityScore(4, true, { likes: 1e9 })).toBeLessThanOrEqual(80 + 25 + 25);
  });

  it('engagement raises the decision priority but never changes severity', () => {
    const quiet = decide(input(ml(), { engagement: null }), rules(), 'dormant');
    const loud = decide(
      input(ml(), { engagement: { likes: 5000, reposts: 800, replies: 300 } }),
      rules(),
      'dormant',
    );
    expect(loud.finalSeverity).toBe(quiet.finalSeverity);
    expect(loud.priorityScore).toBeGreaterThan(quiet.priorityScore);
  });
});

describe('threeclass-v0 decisions (ASSUMED shape)', () => {
  it.each([
    [0.74, false, null, false],
    [0.75, true, 2, false],
    [0.89, true, 2, false],
    [0.9, true, 3, true],
    [0.99, true, 3, true],
  ])('misinformation at %s => misinformation=%s severity=%s urgent=%s', (p, isMis, sev, urgent) => {
    const d = decide(input(tc('misinformation', p)), tcRules(), 'dormant');
    expect(d.isMisinformation).toBe(isMis);
    expect(d.finalSeverity).toBe(sev);
    expect(d.urgent).toBe(urgent);
    expect(d.queue).toBe(isMis ? 'review' : 'none');
  });

  it('below the standard band is stored, not queued, and says so', () => {
    const d = decide(input(tc('misinformation', 0.6)), tcRules(), 'dormant');
    expect(d).toMatchObject({ queue: 'none', isMisinformation: false });
    expect(d.reasons.join(' ')).toContain('stored, not queued');
  });

  it('factual and irrelevant are never queued; there is no information_gap queue', () => {
    expect(decide(input(tc('factual', 0.05)), tcRules(), 'dormant')).toMatchObject({
      queue: 'none',
      isMisinformation: false,
    });
    expect(decide(input(tc('irrelevant', 0.02)), tcRules(), 'dormant')).toMatchObject({
      queue: 'none',
      finalSeverity: null,
    });
    // questions stance cannot exist for 3-class; even if present it is ignored
    expect(decide(input(tc('factual', 0.05, { stance: 'questions' })), tcRules(), 'dormant').queue).toBe(
      'none',
    );
  });

  it('bands and severity map are data: changing the config changes the outcome', () => {
    const custom = RulesConfigSchema.parse({
      ...tcRules(),
      confidenceBands: { urgent: 0.8, standard: 0.5 },
      threeClassSeverity: { urgent: 4, standard: 1 },
    });
    expect(decide(input(tc('misinformation', 0.6)), custom, 'dormant')).toMatchObject({
      finalSeverity: 1,
      urgent: false,
    });
    expect(decide(input(tc('misinformation', 0.8)), custom, 'dormant')).toMatchObject({
      finalSeverity: 4,
      urgent: true,
    });
  });

  it('mode does not affect the 3-class decision, but is recorded in the snapshot', () => {
    const a = decide(input(tc('misinformation', 0.8)), tcRules(), 'dormant');
    const b = decide(input(tc('misinformation', 0.8)), tcRules(), 'surge');
    expect(a.finalSeverity).toBe(b.finalSeverity);
    expect(b.rulesSnapshot.mode).toBe('surge');
  });

  it('missing threeClass output on a 3-class classification is queue none', () => {
    expect(decide(input(tc('misinformation', 0.9, { threeClass: null })), tcRules(), 'dormant').queue).toBe(
      'none',
    );
  });
});

describe('rules config and service', () => {
  it('default rules match section 9 and validate', () => {
    const r = defaultRules('multilabel-v1', 'ebola-tax-1.0');
    expect(RulesConfigSchema.safeParse(r).success).toBe(true);
    expect(r.defaultThresholds).toEqual({ dormant: 0.5, surge: 0.4 });
    expect(Object.keys(r.categories)).toHaveLength(12);
    expect(r.categories.fake_cure_prevention?.floor).toBe(3);
    expect(r.categories.incitement_against_response?.floor).toBe(4);
    expect(r.categories.other_ebola_misinfo?.floor).toBe(1);
    expect(r.keywordRules).toEqual([]);
    expect(r.confidenceBands).toEqual({ urgent: 0.9, standard: 0.75 });
    expect(DEFAULT_CATEGORY_FLOORS).toMatchObject({
      response_distrust: 3,
      burial_resistance: 3,
      fake_official_notice: 3,
    });
  });

  it('validation rejects an urgent band below the standard band and invalid regexes', () => {
    const base = defaultRules('multilabel-v1', 'v');
    expect(
      RulesConfigSchema.safeParse({ ...base, confidenceBands: { urgent: 0.5, standard: 0.9 } }).success,
    ).toBe(false);
    expect(
      RulesConfigSchema.safeParse({
        ...base,
        keywordRules: [{ id: 'bad', pattern: '(', flags: 'iu', severity: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rules are keyed by taxonomy version; 3-class uses its contract name', () => {
    expect(rulesKey('multilabel-v1', 'ebola-tax-2.0')).toBe('ebola-tax-2.0');
    expect(rulesKey('threeclass-v0', null)).toBe('threeclass-v0');
  });

  it('the service seeds on first use, then serves the stored (editable) copy', async () => {
    const repo = new MemoryRulesRepo();
    const svc = new RulesService(repo);
    const first = await svc.getFor('multilabel-v1', 'ebola-tax-1.0');
    expect(first.categories.fake_cure_prevention?.floor).toBe(3);
    await repo.save({ ...first, defaultThresholds: { dormant: 0.6, surge: 0.5 } });
    expect((await svc.getFor('multilabel-v1', 'ebola-tax-1.0')).defaultThresholds.dormant).toBe(0.6);
    expect(await svc.list()).toHaveLength(1);
  });

  it('a new taxonomy version seeds rules for the categories we know; the rest are ruleless', async () => {
    const svc = new RulesService(new MemoryRulesRepo());
    const r = await svc.getFor('multilabel-v1', 'ebola-tax-2.0', [
      'fake_cure_prevention',
      'shiny_new_category',
    ]);
    expect(r.taxonomyVersion).toBe('ebola-tax-2.0');
    expect(Object.keys(r.categories)).toEqual(['fake_cure_prevention']);
  });
});
