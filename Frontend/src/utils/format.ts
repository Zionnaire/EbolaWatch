/** "fake_cure_prevention" -> "Fake cure prevention". The fallback when a name is not in the taxonomy. */
export function prettify(id: string): string {
  const s = id.replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : id;
}

const LAGOS = 'Africa/Lagos';

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: LAGOS,
  }).format(new Date(iso));
}

/** `day` is a YYYY-MM-DD calendar day (already a Lagos day, from the API). */
export function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-NG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${day}T12:00:00Z`));
}

/** "4 min ago", "3 h ago", "2 d ago". Falls back to a date after a week. */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d <= 7) return `${d} d ago`;
  return formatDateTime(iso);
}

export const percent = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`;

export const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact' }).format(n);

export function secondsUntil(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000));
}

/** plural(3, 'post') -> "3 posts" */
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
