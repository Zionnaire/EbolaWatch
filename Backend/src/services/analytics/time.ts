/** Calendar days are Nigerian days (WAT, UTC+1, no daylight saving). */
export const WAT_OFFSET_MINUTES = 60;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Midnight WAT at the start of the day containing `d`, as an absolute instant. */
export function startOfDay(d: Date): Date {
  const shifted = new Date(d.getTime() + WAT_OFFSET_MINUTES * MINUTE);
  const midnightShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnightShifted - WAT_OFFSET_MINUTES * MINUTE);
}

/** YYYY-MM-DD of `d` in WAT. */
export function dayKey(d: Date): string {
  return new Date(d.getTime() + WAT_OFFSET_MINUTES * MINUTE).toISOString().slice(0, 10);
}

/** The last `n` calendar days ending with today, oldest first, and the instant the first one starts. */
export function lastDays(now: Date, n: number): { days: string[]; start: Date } {
  const today = startOfDay(now);
  const start = new Date(today.getTime() - (n - 1) * DAY);
  const days = Array.from({ length: n }, (_, i) =>
    dayKey(new Date(start.getTime() + i * DAY + 12 * 60 * MINUTE)),
  );
  return { days, start };
}

/** Rolling windows: `current` is the last 7 x 24h, `previous` the 7 x 24h before it. */
export function weekWindows(now: Date): { currentStart: Date; previousStart: Date; end: Date } {
  const end = now;
  const currentStart = new Date(now.getTime() - 7 * DAY);
  const previousStart = new Date(now.getTime() - 14 * DAY);
  return { currentStart, previousStart, end };
}

export const daysAgo = (now: Date, n: number): Date => new Date(now.getTime() - n * DAY);
