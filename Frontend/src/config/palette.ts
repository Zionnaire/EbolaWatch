/**
 * Categorical colours for charts. Warm, earthy and distinguishable from each other (and from the severity scale,
 * which only ever appears with its glyph). Series beyond the palette wrap around and are told apart by the legend.
 */
export const CATEGORY_COLORS = [
  '#25665d',
  '#bf4f36',
  '#c98a1b',
  '#6f9a63',
  '#3c6d93',
  '#8a5a83',
  '#c9806d',
  '#5f5a8f',
];
export const NOT_FLAGGED_COLOR = '#d8ccb2';
export const UNCLASSIFIED_COLOR = '#ece3d0';

export const colorAt = (i: number) => CATEGORY_COLORS[i % CATEGORY_COLORS.length] ?? '#25665d';
