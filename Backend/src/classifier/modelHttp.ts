/** Small HTTP helpers shared by everything that talks to the model service. */

/** The model service authenticates with this header (confirmed by the model developer). */
export const MODEL_API_KEY_HEADER = 'X-ML-API-Key';

/** Headers for a request to the model: the API key when one is configured. Never logged. */
export function modelHeaders(
  apiKey: string | null | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  return apiKey ? { ...extra, [MODEL_API_KEY_HEADER]: apiKey } : { ...extra };
}

const MAX_DETAIL_CHARS = 500;

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(describe).join('; ');
  if (value && typeof value === 'object') {
    const o = value as { loc?: unknown; msg?: unknown };
    // FastAPI / pydantic validation errors: { loc: ["body", "items", 0, "text"], msg: "...", type: "..." }
    if (typeof o.msg === 'string') {
      const where = Array.isArray(o.loc) ? o.loc.filter((p) => p !== 'body').join('.') : '';
      return where ? `${where}: ${o.msg}` : o.msg;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Extracts the human message from a FastAPI error body, `{"detail": "message"}`. Real FastAPI sometimes sends a
 * list of validation errors as `detail`, so that is understood too. Returns null when there is no `detail`.
 */
export function extractErrorDetail(body: unknown): string | null {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || !('detail' in value)) return null;
  const text = describe((value as { detail: unknown }).detail).trim();
  return text ? text.slice(0, MAX_DETAIL_CHARS) : null;
}

/** Reads an error response and returns its `detail` (or a clipped copy of the raw body). Never throws. */
export async function readErrorDetail(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  return extractErrorDetail(raw) ?? raw.trim().slice(0, MAX_DETAIL_CHARS);
}

/** Cuts text to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? max - 1 : max; // do not end on half an emoji
  return text.slice(0, cut);
}
