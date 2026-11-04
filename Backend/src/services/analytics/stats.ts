/** null when the denominator is 0: "not enough data" is different from 0%. */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
}

export interface PrecisionRecallF1 extends Confusion {
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

/** F1 = 2TP / (2TP + FP + FN), which is 0 (not undefined) when there are positives but no hits. */
export function precisionRecallF1({ tp, fp, fn }: Confusion): PrecisionRecallF1 {
  return {
    tp,
    fp,
    fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    f1: ratio(2 * tp, 2 * tp + fp + fn),
  };
}

/** Nearest-rank percentile of an ascending-sorted array (p in 0..100). null for an empty array. */
export function percentile(sortedAscending: number[], p: number): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * n));
  return sortedAscending[Math.min(n, rank) - 1] ?? null;
}

export function latencyPercentiles(values: number[]): {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
} {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/** Equal-width bins over [min, max]. The top edge belongs to the last bin; values outside are clamped in. */
export function histogram(
  values: number[],
  binCount = 10,
  min = 0,
  max = 1,
): Array<{ from: number; to: number; count: number }> {
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: round(min + i * width),
    to: round(min + (i + 1) * width),
    count: 0,
  }));
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((v - min) / width)));
    bins[idx]!.count++;
  }
  return bins;
}

export const round = (n: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
