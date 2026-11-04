import type { ZodType } from 'zod';
import { API_URL } from '@/env';

/** Anything the API (or the network) did wrong, in one shape the UI can show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: Array<{ path: Array<string | number>; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level problems from a 400, keyed by the first path segment. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const i of this.issues ?? []) {
      const key = String(i.path[0] ?? '_');
      out[key] ??= i.message;
    }
    return out;
  }
}

interface Options<T> {
  schema?: ZodType<T>;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

let onUnauthorized: () => void = () => undefined;
/** The session provider registers here so a dead session anywhere signs the user out once. */
export function registerUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

const NO_REFRESH = [
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/claim',
  '/api/auth/invite',
];

function url(path: string, query?: Options<unknown>['query']): string {
  const u = new URL(`${API_URL}${path}`, globalThis.location?.origin ?? 'http://localhost');
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return API_URL ? u.toString() : `${u.pathname}${u.search}`;
}

let refreshing: Promise<boolean> | null = null;
/** One refresh at a time: parallel queries that all hit an expired token share it. */
function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(url('/api/auth/refresh'), { method: 'POST', credentials: 'include' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; issues?: ApiError['issues'] } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* not JSON */
  }
  return new ApiError(
    res.status,
    body.error?.code ?? `http_${res.status}`,
    body.error?.message ?? `The server answered ${res.status}`,
    body.error?.issues,
  );
}

async function send(method: string, path: string, o: Options<unknown>, retried = false): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url(path, o.query), {
      method,
      credentials: 'include',
      signal: o.signal,
      headers: o.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 401 && !retried && !NO_REFRESH.some((p) => path.startsWith(p))) {
    if (await refreshSession()) return send(method, path, o, true);
    onUnauthorized();
  }
  if (!res.ok) throw await toError(res);
  return res;
}

export async function api<T>(method: string, path: string, o: Options<T> = {}): Promise<T> {
  const res = await send(method, path, o);
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json();
  if (!o.schema) return json as T;
  const parsed = o.schema.safeParse(json);
  if (!parsed.success) {
    // A drifted contract is a bug, not a user error: say so loudly in development, plainly in production.
    console.error(`Contract mismatch on ${method} ${path}`, parsed.error.issues);
    throw new ApiError(
      502,
      'contract_mismatch',
      'The server sent data this version of the app does not understand.',
    );
  }
  return parsed.data;
}

export const get = <T>(path: string, schema: ZodType<T>, query?: Options<T>['query'], signal?: AbortSignal) =>
  api<T>('GET', path, { schema, query, signal });
export const post = <T>(path: string, schema: ZodType<T>, body?: unknown) =>
  api<T>('POST', path, { schema, body: body ?? {} });
export const patch = <T>(path: string, schema: ZodType<T>, body?: unknown) =>
  api<T>('PATCH', path, { schema, body: body ?? {} });
export const del = (path: string) => api<void>('DELETE', path);

/** Downloads a file the API generates (the geo CSV) through the browser's save dialog. */
export async function download(path: string, query?: Options<unknown>['query']): Promise<void> {
  const res = await send('GET', path, { query });
  const name =
    /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.csv';
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}
