import type { GeoDto, GeoState } from '../../contracts/api/index.js';
import { canonicalState, NIGERIA_STATES } from '../../data/nigeriaStates.js';
import { round } from './stats.js';
import { toCsv } from './csv.js';

export interface GeoConfig {
  /** Week-on-week growth above this fraction is a surge: 0.5 means more than +50%. */
  surgeThreshold: number;
  /** A surge needs at least this many flagged posts this week, so 1 -> 2 is not an "alert". */
  minCount: number;
}

export const DEFAULT_GEO_CONFIG: GeoConfig = { surgeThreshold: 0.5, minCount: 3 };

export type Period = 'cur' | 'prev';

/** One aggregation row: posts sharing state, LGA, period, platform, language and flagged-ness. */
export interface GeoRow {
  state: string | null;
  lga: string | null;
  period: Period;
  platform: string;
  language: string;
  flagged: boolean;
  count: number;
}

/** Flagged posts counted once per category they were flagged for. */
export interface GeoCategoryRow {
  state: string | null;
  lga: string | null;
  period: Period;
  category: string;
  count: number;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Highest count first; ties broken alphabetically so the output is deterministic. */
function ranked(entries: Map<string, number>): Array<{ id: string; count: number }> {
  return [...entries.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function tally<T>(rows: T[], key: (r: T) => string, weight: (r: T) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + weight(r));
  return m;
}

/**
 * Surge rule: flagged posts this week vs the previous week.
 *   - needs at least `minCount` flagged posts this week;
 *   - then it is a surge if last week had none (new activity), or growth is strictly above the threshold
 *     (exactly +50% is not a surge).
 */
export function isSurge(flagged: number, previousFlagged: number, cfg: GeoConfig): boolean {
  if (flagged < cfg.minCount) return false;
  if (previousFlagged === 0) return true;
  return flagged - previousFlagged > previousFlagged * cfg.surgeThreshold;
}

export function areaStats(rows: GeoRow[], catRows: GeoCategoryRow[], cfg: GeoConfig) {
  const cur = rows.filter((r) => r.period === 'cur');
  const flaggedCur = cur.filter((r) => r.flagged);
  const flagged = sum(flaggedCur.map((r) => r.count));
  const previousFlagged = sum(rows.filter((r) => r.period === 'prev' && r.flagged).map((r) => r.count));
  const platforms = ranked(
    tally(
      flaggedCur,
      (r) => r.platform,
      (r) => r.count,
    ),
  );
  const languages = ranked(
    tally(
      flaggedCur,
      (r) => r.language,
      (r) => r.count,
    ),
  );
  const categories = ranked(
    tally(
      catRows.filter((r) => r.period === 'cur'),
      (r) => r.category,
      (r) => r.count,
    ),
  );
  return {
    total: sum(cur.map((r) => r.count)),
    flagged,
    previousFlagged,
    changePct: previousFlagged > 0 ? round(((flagged - previousFlagged) / previousFlagged) * 100, 1) : null,
    newActivity: previousFlagged === 0 && flagged > 0,
    surge: isSurge(flagged, previousFlagged, cfg),
    dominantPlatform: platforms[0]?.id ?? null,
    dominantLanguage: languages[0]?.id ?? null,
    topCategories: categories.slice(0, 3),
  };
}

/** Groups rows by a key, dropping rows whose key is null. */
function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

export function rollupGeo(
  rows: GeoRow[],
  catRows: GeoCategoryRow[],
  cfg: GeoConfig = DEFAULT_GEO_CONFIG,
): Pick<GeoDto, 'states' | 'unlocated' | 'totals'> {
  const stateOf = (r: { state: string | null }) => canonicalState(r.state);
  const byState = groupBy(rows, stateOf);
  const catByState = groupBy(catRows, stateOf);

  const states: GeoState[] = NIGERIA_STATES.map((state) => {
    const sRows = byState.get(state) ?? [];
    const sCats = catByState.get(state) ?? [];
    const lgaRows = groupBy(sRows, (r) => r.lga);
    const lgaCats = groupBy(sCats, (r) => r.lga);
    const lgas = [...lgaRows.keys()]
      .map((lga) => ({ lga, ...areaStats(lgaRows.get(lga) ?? [], lgaCats.get(lga) ?? [], cfg) }))
      .sort((a, b) => b.flagged - a.flagged || b.total - a.total || a.lga.localeCompare(b.lga));
    return { state, density: 0, ...areaStats(sRows, sCats, cfg), lgas };
  });

  const maxFlagged = Math.max(0, ...states.map((s) => s.flagged));
  for (const s of states) s.density = maxFlagged === 0 ? 0 : round(s.flagged / maxFlagged, 4);

  const unlocatedRows = rows.filter((r) => r.period === 'cur' && stateOf(r) === null);
  const curRows = rows.filter((r) => r.period === 'cur');
  return {
    states,
    unlocated: {
      total: sum(unlocatedRows.map((r) => r.count)),
      flagged: sum(unlocatedRows.filter((r) => r.flagged).map((r) => r.count)),
    },
    totals: {
      total: sum(curRows.map((r) => r.count)),
      flagged: sum(curRows.filter((r) => r.flagged).map((r) => r.count)),
    },
  };
}

/** One row per state, followed by one row per LGA of that state (LGA column filled). */
export function geoToCsv(geo: Pick<GeoDto, 'states'>): string {
  const headers = [
    'state',
    'lga',
    'posts',
    'flagged',
    'previous_week_flagged',
    'change_pct',
    'new_activity',
    'surge',
    'dominant_platform',
    'dominant_language',
    'top_categories',
  ];
  const line = (state: string, lga: string, a: ReturnType<typeof areaStats>) => [
    state,
    lga,
    a.total,
    a.flagged,
    a.previousFlagged,
    a.changePct,
    a.newActivity,
    a.surge,
    a.dominantPlatform,
    a.dominantLanguage,
    a.topCategories.map((c) => `${c.id}:${c.count}`).join(' | '),
  ];
  const rows = geo.states.flatMap((s) => [
    line(s.state, '', s),
    ...s.lgas.map((l) => line(s.state, l.lga, l)),
  ]);
  return toCsv(headers, rows);
}
