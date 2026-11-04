import type { Classification } from '../contracts/api/index.js';

/**
 * Category labels are data. Labels absent from the synced taxonomy are reported (caller logs and
 * flags the post `needs_review`); they never crash anything. Without a synced taxonomy nothing can be judged.
 */
export function findUnknownLabels(c: Classification, known: ReadonlySet<string> | null): string[] {
  if (!known) return [];
  return c.categories.map((x) => x.label).filter((l) => !known.has(l));
}
