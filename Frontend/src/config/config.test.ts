import { describe, expect, it } from 'vitest';
import { GRID_COLS, GRID_ROWS, STATE_TILES } from './stateGrid';
import { SEVERITY, SEVERITY_LEVELS } from './severity';
import { MODEL_STATUS } from './status';

describe('config tables', () => {
  it('every severity level has a distinct glyph and a text label (never colour alone)', () => {
    const glyphs = SEVERITY_LEVELS.map((l) => SEVERITY[l].glyph);
    expect(new Set(glyphs).size).toBe(SEVERITY_LEVELS.length);
    for (const l of SEVERITY_LEVELS) expect(SEVERITY[l].label.length).toBeGreaterThan(0);
  });

  it('the cartogram has the 36 states and the FCT, each on its own tile inside the grid', () => {
    const tiles = Object.values(STATE_TILES);
    expect(tiles).toHaveLength(37);
    expect(new Set(tiles.map((t) => `${t.col},${t.row}`)).size).toBe(37);
    expect(new Set(tiles.map((t) => t.abbr)).size).toBe(37);
    for (const t of tiles) {
      expect(t.col).toBeGreaterThanOrEqual(0);
      expect(t.col).toBeLessThan(GRID_COLS);
      expect(t.row).toBeLessThan(GRID_ROWS);
    }
  });

  it('a warming model is a neutral state, never an error tone', () => {
    expect(MODEL_STATUS.warming.tone).toBe('wait');
    expect(MODEL_STATUS.error.tone).toBe('bad');
  });
});
