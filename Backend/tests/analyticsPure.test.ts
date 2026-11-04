import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/services/analytics/csv.js';
import {
  areaStats,
  DEFAULT_GEO_CONFIG,
  geoToCsv,
  isSurge,
  rollupGeo,
  type GeoCategoryRow,
  type GeoRow,
} from '../src/services/analytics/geoRollup.js';
import {
  histogram,
  latencyPercentiles,
  percentile,
  precisionRecallF1,
  ratio,
} from '../src/services/analytics/stats.js';
import { dayKey, lastDays, startOfDay, weekWindows } from '../src/services/analytics/time.js';

describe('Lagos calendar days', () => {
  it('a day starts at 23:00 UTC the evening before (WAT = UTC+1)', () => {
    // 2026-10-27 22:30 UTC is already 23:30 on the 27th in Lagos; 23:30 UTC is 00:30 on the 28th
    expect(startOfDay(new Date('2026-10-27T22:30:00Z')).toISOString()).toBe('2026-10-26T23:00:00.000Z');
    expect(startOfDay(new Date('2026-10-27T23:30:00Z')).toISOString()).toBe('2026-10-27T23:00:00.000Z');
    expect(dayKey(new Date('2026-10-27T22:59:59Z'))).toBe('2026-10-27');
    expect(dayKey(new Date('2026-10-27T23:00:00Z'))).toBe('2026-10-28');
  });

  it('lastDays gives n consecutive days ending today, oldest first, with the right start', () => {
    const { days, start } = lastDays(new Date('2026-10-27T12:00:00Z'), 7);
    expect(days).toEqual([
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
    expect(start.toISOString()).toBe('2026-10-20T23:00:00.000Z');
  });

  it('works across a month and year boundary', () => {
    expect(lastDays(new Date('2027-01-02T10:00:00Z'), 4).days).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('week windows are rolling 7 x 24h', () => {
    const now = new Date('2026-10-27T12:00:00Z');
    const w = weekWindows(now);
    expect(w.currentStart.toISOString()).toBe('2026-10-20T12:00:00.000Z');
    expect(w.previousStart.toISOString()).toBe('2026-10-13T12:00:00.000Z');
  });
});

describe('statistics', () => {
  it('ratio is null, not 0, when there is nothing to divide by', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(0, 5)).toBe(0);
    expect(ratio(1, 4)).toBe(0.25);
  });

  it('precision / recall / F1', () => {
    expect(precisionRecallF1({ tp: 8, fp: 2, fn: 4 })).toEqual({
      tp: 8,
      fp: 2,
      fn: 4,
      precision: 0.8,
      recall: 8 / 12,
      f1: 16 / 22,
    });
  });

  it('undefined metrics are null; F1 is 0 (not null) when there are positives but no hits', () => {
    expect(precisionRecallF1({ tp: 0, fp: 0, fn: 0 })).toMatchObject({
      precision: null,
      recall: null,
      f1: null,
    });
    expect(precisionRecallF1({ tp: 0, fp: 3, fn: 0 })).toMatchObject({ precision: 0, recall: null, f1: 0 });
    expect(precisionRecallF1({ tp: 0, fp: 0, fn: 2 })).toMatchObject({ precision: null, recall: 0, f1: 0 });
    expect(precisionRecallF1({ tp: 5, fp: 0, fn: 0 })).toMatchObject({ precision: 1, recall: 1, f1: 1 });
  });

  it('nearest-rank percentiles', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 99)).toBe(99);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 75)).toBe(30);
  });

  it('latencyPercentiles sorts, ignores junk, and handles empty input', () => {
    expect(latencyPercentiles([300, 100, 200, Number.NaN, 400])).toEqual({
      n: 4,
      p50: 200,
      p95: 400,
      p99: 400,
    });
    expect(latencyPercentiles([])).toEqual({ n: 0, p50: null, p95: null, p99: null });
  });

  it('histogram: 10 bins over 0..1, top edge in the last bin, clamping, junk ignored', () => {
    const bins = histogram([0, 0.05, 0.1, 0.55, 0.99, 1, 1, -0.2, 1.4, Number.NaN]);
    expect(bins).toHaveLength(10);
    expect(bins[0]).toEqual({ from: 0, to: 0.1, count: 3 }); // 0, 0.05 and the clamped -0.2
    expect(bins[1]!.count).toBe(1); // 0.1
    expect(bins[5]!.count).toBe(1); // 0.55
    expect(bins[9]!.count).toBe(4); // 0.99, 1, 1, and the clamped 1.4
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(9);
    expect(bins[9]!.to).toBe(1);
  });
});

describe('surge rule (> +50% week on week)', () => {
  const cfg = DEFAULT_GEO_CONFIG;
  it('exactly +50% is not a surge; just above is', () => {
    expect(isSurge(6, 4, cfg)).toBe(false); // +50%
    expect(isSurge(7, 4, cfg)).toBe(true); // +75%
    expect(isSurge(9, 6, cfg)).toBe(false); // +50%
    expect(isSurge(10, 6, cfg)).toBe(true); // +66%
  });
  it('shrinking or flat is never a surge', () => {
    expect(isSurge(10, 10, cfg)).toBe(false);
    expect(isSurge(5, 10, cfg)).toBe(false);
  });
  it('needs a minimum volume so 1 -> 2 is not an alert', () => {
    expect(isSurge(2, 1, cfg)).toBe(false);
    expect(isSurge(2, 0, cfg)).toBe(false);
    expect(isSurge(3, 0, cfg)).toBe(true); // new activity at volume
    expect(isSurge(3, 1, cfg)).toBe(true); // +200% at volume
    expect(isSurge(3, 2, cfg)).toBe(false); // +50%
  });
  it('the threshold and the minimum are configurable', () => {
    expect(isSurge(5, 4, { surgeThreshold: 0.1, minCount: 1 })).toBe(true);
    expect(isSurge(5, 4, { surgeThreshold: 0.5, minCount: 1 })).toBe(false);
  });
});

describe('geo rollup', () => {
  const row = (o: Partial<GeoRow> & Pick<GeoRow, 'state' | 'count'>): GeoRow => ({
    lga: null,
    period: 'cur',
    platform: 'x',
    language: 'en',
    flagged: true,
    ...o,
  });
  const cat = (
    o: Partial<GeoCategoryRow> & Pick<GeoCategoryRow, 'state' | 'category' | 'count'>,
  ): GeoCategoryRow => ({
    lga: null,
    period: 'cur',
    ...o,
  });

  const rows: GeoRow[] = [
    row({ state: 'Lagos', lga: 'Ikeja', count: 6, platform: 'x', language: 'en' }),
    row({ state: 'Lagos', lga: 'Ikeja', count: 2, platform: 'bluesky', language: 'pcm' }),
    row({ state: 'Lagos', lga: 'Surulere', count: 1, platform: 'x', language: 'en' }),
    row({ state: 'Lagos', lga: 'Ikeja', count: 5, flagged: false }),
    row({ state: 'Lagos', lga: 'Ikeja', count: 4, period: 'prev' }),
    row({ state: 'Rivers', count: 2 }),
    row({ state: 'Rivers', count: 2, period: 'prev' }),
    row({ state: 'Kano', count: 3 }), // new activity: nothing last week
    row({ state: 'lagos', lga: null, count: 1 }), // loosely written state still counts for Lagos
    row({ state: null, count: 4 }),
    row({ state: 'Atlantis', count: 2, flagged: false }),
  ];
  const cats: GeoCategoryRow[] = [
    cat({ state: 'Lagos', lga: 'Ikeja', category: 'fake_cure_prevention', count: 7 }),
    cat({ state: 'Lagos', lga: 'Ikeja', category: 'burial_resistance', count: 3 }),
    cat({ state: 'Lagos', lga: 'Surulere', category: 'burial_resistance', count: 1 }),
    cat({ state: 'Lagos', lga: 'Ikeja', category: 'outbreak_denial', count: 9, period: 'prev' }), // not this week
  ];
  const geo = rollupGeo(rows, cats);
  const state = (name: string) => geo.states.find((s) => s.state === name)!;

  it('lists every state and the FCT, in a stable order, including empty ones', () => {
    expect(geo.states).toHaveLength(37);
    expect(geo.states.map((s) => s.state)).toContain('FCT');
    expect(state('Zamfara')).toMatchObject({
      total: 0,
      flagged: 0,
      density: 0,
      surge: false,
      dominantPlatform: null,
      lgas: [],
    });
  });

  it('counts this week, last week, change and surge per state', () => {
    // Lagos: flagged 6+2+1+1 = 10 (the loose "lagos" row too), previous 4 -> +150%
    expect(state('Lagos')).toMatchObject({
      total: 15,
      flagged: 10,
      previousFlagged: 4,
      changePct: 150,
      newActivity: false,
      surge: true,
    });
    // Rivers: 2 vs 2 -> flat, and below the minimum anyway
    expect(state('Rivers')).toMatchObject({ flagged: 2, previousFlagged: 2, changePct: 0, surge: false });
    // Kano: 3 vs 0 -> new activity at volume
    expect(state('Kano')).toMatchObject({
      flagged: 3,
      previousFlagged: 0,
      changePct: null,
      newActivity: true,
      surge: true,
    });
  });

  it('density is relative to the busiest state', () => {
    expect(state('Lagos').density).toBe(1);
    expect(state('Kano').density).toBe(0.3);
    expect(state('Rivers').density).toBe(0.2);
  });

  it("dominant platform / language / top categories come from this week's flagged posts", () => {
    expect(state('Lagos')).toMatchObject({ dominantPlatform: 'x', dominantLanguage: 'en' });
    expect(state('Lagos').topCategories).toEqual([
      { id: 'fake_cure_prevention', count: 7 },
      { id: 'burial_resistance', count: 4 },
    ]); // last week's outbreak_denial is excluded
  });

  it('has an LGA table per state, busiest first, with the same stats', () => {
    const lagos = state('Lagos');
    expect(lagos.lgas.map((l) => l.lga)).toEqual(['Ikeja', 'Surulere']);
    expect(lagos.lgas[0]).toMatchObject({
      lga: 'Ikeja',
      flagged: 8,
      previousFlagged: 4,
      changePct: 100,
      surge: true,
      dominantPlatform: 'x',
      dominantLanguage: 'en',
    });
    expect(lagos.lgas[0]!.topCategories[0]).toEqual({ id: 'fake_cure_prevention', count: 7 });
    expect(lagos.lgas[1]).toMatchObject({ lga: 'Surulere', flagged: 1, surge: false });
  });

  it('posts without a (recognised) state go to unlocated, and totals include everything', () => {
    expect(geo.unlocated).toEqual({ total: 6, flagged: 4 });
    expect(geo.totals).toEqual({ total: 15 + 2 + 3 + 6, flagged: 10 + 2 + 3 + 4 });
  });

  it('ties are broken alphabetically so output is deterministic', () => {
    const tie = rollupGeo(
      [
        row({ state: 'Kano', count: 2, platform: 'youtube' }),
        row({ state: 'Kano', count: 2, platform: 'bluesky' }),
      ],
      [cat({ state: 'Kano', category: 'b', count: 1 }), cat({ state: 'Kano', category: 'a', count: 1 })],
    );
    const kano = tie.states.find((s) => s.state === 'Kano')!;
    expect(kano.dominantPlatform).toBe('bluesky');
    expect(kano.topCategories.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('empty input is fine', () => {
    const empty = rollupGeo([], []);
    expect(empty.totals).toEqual({ total: 0, flagged: 0 });
    expect(empty.states.every((s) => s.density === 0)).toBe(true);
  });

  it('areaStats on nothing', () => {
    expect(areaStats([], [], DEFAULT_GEO_CONFIG)).toMatchObject({
      total: 0,
      flagged: 0,
      changePct: null,
      newActivity: false,
      surge: false,
      topCategories: [],
    });
  });
});

describe('CSV export', () => {
  it('quotes commas, quotes and newlines; uses CRLF; blanks nulls', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x,y', 'he said "hi"'],
          ['line\nbreak', null],
        ],
      ),
    ).toBe('a,b\r\n"x,y","he said ""hi"""\r\n"line\nbreak",\r\n');
  });
  it('neutralises spreadsheet formula injection in text but leaves numbers alone', () => {
    const out = toCsv(['v'], [['=HYPERLINK("http://evil")'], ['+1'], ['-2'], ['@SUM(A1)'], [-5], ['ok']]);
    expect(out).toContain("'=HYPERLINK");
    expect(out).toContain("'+1");
    expect(out).toContain("'-2");
    expect(out).toContain("'@SUM(A1)");
    expect(out).toContain('\r\n-5\r\n'); // a real negative number is not touched
    expect(out).toContain('\r\nok\r\n');
  });
  it('geoToCsv: a state row followed by its LGA rows, with the surge flag', () => {
    const rows: GeoRow[] = [
      { state: 'Lagos', lga: 'Ikeja', period: 'cur', platform: 'x', language: 'en', flagged: true, count: 5 },
      {
        state: 'Lagos',
        lga: 'Ikeja',
        period: 'prev',
        platform: 'x',
        language: 'en',
        flagged: true,
        count: 1,
      },
    ];
    const csv = geoToCsv(
      rollupGeo(rows, [
        { state: 'Lagos', lga: 'Ikeja', period: 'cur', category: 'fake_cure_prevention', count: 5 },
      ]),
    );
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'state,lga,posts,flagged,previous_week_flagged,change_pct,new_activity,surge,dominant_platform,dominant_language,top_categories',
    );
    const lagos = lines.indexOf('Lagos,,5,5,1,400,false,true,x,en,fake_cure_prevention:5');
    expect(lagos).toBeGreaterThan(0);
    expect(lines[lagos + 1]).toBe('Lagos,Ikeja,5,5,1,400,false,true,x,en,fake_cure_prevention:5');
    expect(lines).toHaveLength(1 + 37 + 1); // header + states + one LGA row
  });
});
