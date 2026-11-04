import { HttpHealthSource } from './httpHealthSource.js';
import type { ModelHealth } from '../contracts/model/multilabelV1.js';

export interface WaitForModelOptions {
  baseUrl: string;
  /** Give up waiting after this long (the caller decides what that means). */
  timeoutMs: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  /** Sent as the X-ML-API-Key header. */
  apiKey?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWait?: (info: { attempt: number; waitedMs: number; error: string }) => void;
}

export interface WaitForModelResult {
  /** True once /v1/health answered with a valid body, whatever the status (warming counts: it is up). */
  reachable: boolean;
  status: ModelHealth['status'] | null;
  attempts: number;
  waitedMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Waits until the model service answers on /v1/health. Used at startup in live mode so that starting the
 * model and the backend together (root `pnpm dev`) does not race. A cold model that answers `warming` counts
 * as reachable: warming is a normal state the classifier already handles. Never throws.
 */
export async function waitForModelHealth(o: WaitForModelOptions): Promise<WaitForModelResult> {
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;
  const intervalMs = o.intervalMs ?? 1000;
  const source = new HttpHealthSource(o.baseUrl, o.requestTimeoutMs ?? 3000, o.fetchImpl, o.apiKey ?? null);
  const started = now();
  let attempts = 0;

  for (;;) {
    attempts++;
    try {
      const health = await source.fetchHealth();
      return { reachable: true, status: health.status, attempts, waitedMs: now() - started };
    } catch (err) {
      const waitedMs = now() - started;
      o.onWait?.({ attempt: attempts, waitedMs, error: err instanceof Error ? err.message : String(err) });
      if (waitedMs + intervalMs > o.timeoutMs) return { reachable: false, status: null, attempts, waitedMs };
      await sleep(intervalMs);
    }
  }
}
