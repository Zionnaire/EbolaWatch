import { randomUUID } from 'node:crypto';
import type { Contract } from '../contracts/api/index.js';
import { logger } from '../utils/logger.js';
import { adapterFor } from './adapters/index.js';
import type { AdaptedItem, ContractAdapter } from './adapters/index.js';
import { modelHeaders, readErrorDetail, truncateText } from './modelHttp.js';
import { findUnknownLabels } from './unknownLabels.js';
import type {
  ClassifierClient,
  ClassifierHooks,
  ClassifyInput,
  ClassifyResult,
  ModelIdentity,
  TaxonomyView,
} from './types.js';

export interface HttpClassifierOptions {
  baseUrl: string;
  contract: Contract;
  timeoutMs: number;
  warmupMaxWaitMs: number;
  /** Sent as the X-ML-API-Key header. */
  apiKey?: string | null;
  /** Texts longer than this are cut before they are sent, and the result is marked `truncated`. */
  maxTextChars?: number;
  /** Max retries for 429 / 5xx / network / timeout. */
  maxRetries?: number;
  /** Max extra attempts for per-item `internal` errors. */
  itemRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const RETRY_AFTER_MIN_S = 1;
const RETRY_AFTER_MAX_S = 60;
/** Per-item errors that will never succeed on retry. */
const TERMINAL_ITEM_CODES = new Set(['empty_text', 'text_too_long', 'unsupported_input']);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function parseRetryAfterSeconds(header: string | null, now: number): number | null {
  if (!header) return null;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber)) return asNumber;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, (date - now) / 1000);
}

/** Calls the external model over HTTP and implements the failure table. Never drops items. */
export class HttpClassifier implements ClassifierClient {
  readonly kind = 'http' as const;
  readonly contract: Contract;
  private readonly adapter: ContractAdapter;
  private readonly o: Required<
    Omit<HttpClassifierOptions, 'contract' | 'baseUrl' | 'timeoutMs' | 'warmupMaxWaitMs'>
  > &
    Pick<HttpClassifierOptions, 'baseUrl' | 'timeoutMs' | 'warmupMaxWaitMs'>;

  constructor(
    options: HttpClassifierOptions,
    private readonly taxonomy: TaxonomyView,
    private readonly hooks: ClassifierHooks = {},
  ) {
    this.contract = options.contract;
    this.adapter = adapterFor(options.contract);
    this.o = {
      maxRetries: 3,
      itemRetries: 2,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      sleep: defaultSleep,
      random: Math.random,
      now: Date.now,
      fetchImpl: (input, init) => fetch(input, init),
      ...options,
      // an explicit `undefined` in options must not erase these defaults
      apiKey: options.apiKey ?? null,
      maxTextChars: options.maxTextChars ?? 2000,
    };
  }

  async classify(inputs: ClassifyInput[]): Promise<ClassifyResult[]> {
    // The model's text limit is a setting, not a surprise: we cut long texts ourselves so we always know it happened.
    const cut = new Set<string>();
    const toSend = inputs.map((i) => {
      const text = truncateText(i.text, this.o.maxTextChars);
      if (text.length < i.text.length) cut.add(i.itemId);
      return text === i.text ? i : { ...i, text };
    });

    const out: ClassifyResult[] = [];
    for (let i = 0; i < toSend.length; i += this.adapter.maxBatch) {
      out.push(...(await this.classifyChunk(toSend.slice(i, i + this.adapter.maxBatch), 0)));
    }
    if (cut.size === 0) return out;
    return out.map((r) =>
      r.outcome === 'classified' && cut.has(r.itemId)
        ? { ...r, classification: { ...r.classification, truncated: true } }
        : r,
    );
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** attempt);
    return Math.round(exp * (0.5 + this.o.random() * 0.5));
  }

  private all(inputs: ClassifyInput[], make: (itemId: string) => ClassifyResult): ClassifyResult[] {
    return inputs.map((i) => make(i.itemId));
  }

  private async classifyChunk(inputs: ClassifyInput[], itemAttempt: number): Promise<ClassifyResult[]> {
    // Taxonomy-pinned contracts need a synced taxonomy before the first call.
    if (this.adapter.sendsTaxonomyVersion && !this.taxonomy.version()) {
      await this.taxonomy
        .resync()
        .catch((err) => logger.warn({ err }, 'taxonomy sync failed before classify'));
      if (!this.taxonomy.version()) {
        return this.all(inputs, (itemId) => ({ itemId, outcome: 'pending', reason: 'taxonomy_unavailable' }));
      }
    }

    let attempt = 0;
    let warmedMs = 0;

    for (;;) {
      const requestId = randomUUID();
      const request = this.adapter.buildRequest(requestId, this.taxonomy.version(), inputs);

      let res: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
        try {
          res = await this.o.fetchImpl(`${this.o.baseUrl}/v1/classify`, {
            method: 'POST',
            headers: modelHeaders(this.o.apiKey, { 'content-type': 'application/json' }),
            body: JSON.stringify(request),
            signal: controller.signal,
          });
          // Read the body inside the timeout window.
          return await this.handle(res, inputs, itemAttempt, attempt, warmedMs, async (retry) => {
            if (retry.kind === 'warming') {
              warmedMs += retry.waitMs;
              await this.o.sleep(retry.waitMs);
            } else {
              attempt += 1;
              await this.o.sleep(retry.waitMs);
            }
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (err instanceof RetrySignal) continue;
        // network error or timeout
        logger.warn({ err: String(err), attempt }, 'model request failed');
        if (attempt >= this.o.maxRetries) {
          this.hooks.onModelStatus?.({
            status: 'error',
            retryAvailableAt: null,
            detail: 'model unreachable',
          });
          return this.all(inputs, (itemId) => ({
            itemId,
            outcome: 'error',
            reason: 'unavailable',
            message: `Model unreachable after ${attempt + 1} attempts`,
          }));
        }
        await this.o.sleep(this.backoff(attempt));
        attempt += 1;
      }
    }
  }

  /** Handles one HTTP response. Throws RetrySignal (after sleeping) to ask the caller to loop. */
  private async handle(
    res: Response,
    inputs: ClassifyInput[],
    itemAttempt: number,
    attempt: number,
    warmedMs: number,
    scheduleRetry: (r: { kind: 'warming' | 'transient'; waitMs: number }) => Promise<void>,
  ): Promise<ClassifyResult[]> {
    const status = res.status;

    if (status === 200) return this.handleOk(res, inputs, itemAttempt);

    if (status === 503) {
      const raw = parseRetryAfterSeconds(res.headers.get('retry-after'), this.o.now());
      const waitMs =
        raw === null
          ? this.backoff(attempt)
          : Math.min(RETRY_AFTER_MAX_S, Math.max(RETRY_AFTER_MIN_S, raw)) * 1000;
      const retryAvailableAt = new Date(this.o.now() + waitMs).toISOString();
      this.hooks.onModelStatus?.({ status: 'warming', retryAvailableAt });
      if (warmedMs + waitMs > this.o.warmupMaxWaitMs) {
        return this.all(inputs, (itemId) => ({ itemId, outcome: 'pending', reason: 'warming' }));
      }
      await scheduleRetry({ kind: 'warming', waitMs });
      throw new RetrySignal();
    }

    if (status === 409) {
      logger.error({ taxonomyVersion: this.taxonomy.version() }, 'model rejected taxonomy_version (409)');
      await this.taxonomy.resync().catch((err) => logger.warn({ err }, 'taxonomy re-sync after 409 failed'));
      this.hooks.onAlert?.({
        level: 'critical',
        code: 'taxonomy_mismatch',
        message:
          'The model rejected our taxonomy version. Taxonomy was re-synced; classification paused for these items.',
      });
      return this.all(inputs, (itemId) => ({ itemId, outcome: 'pending', reason: 'taxonomy_mismatch' }));
    }

    if (status === 401 || status === 403) {
      // Our configuration is wrong (key missing, wrong or revoked). Retrying cannot help and would hammer the model.
      const detail = await readErrorDetail(res);
      logger.error({ status, detail }, 'model rejected our API key: check MODEL_API_KEY');
      this.hooks.onModelStatus?.({
        status: 'error',
        retryAvailableAt: null,
        detail: 'model rejected our API key',
      });
      this.hooks.onAlert?.({
        level: 'critical',
        code: 'model_auth_failed',
        message: `The model service rejected our API key (HTTP ${status}). Classification is stopped until MODEL_API_KEY is fixed.`,
      });
      return this.all(inputs, (itemId) => ({
        itemId,
        outcome: 'error',
        reason: 'unauthorized',
        code: String(status),
        message: `The model rejected our API key (HTTP ${status})${detail ? `: ${detail}` : ''}`,
      }));
    }

    if (status === 400 || status === 422 || (status >= 400 && status < 500 && status !== 429)) {
      // Our bug: log and do not retry. FastAPI explains itself in {"detail": "..."}.
      const detail = await readErrorDetail(res);
      logger.error({ status, detail }, 'model rejected our request: this is a bug on our side');
      return this.all(inputs, (itemId) => ({
        itemId,
        outcome: 'error',
        reason: 'bad_request',
        code: String(status),
        message: `Model rejected the request (HTTP ${status})${detail ? `: ${detail}` : ''}`,
      }));
    }

    // 429 / 5xx: backoff with jitter, up to maxRetries
    if (attempt >= this.o.maxRetries) {
      this.hooks.onModelStatus?.({ status: 'error', retryAvailableAt: null, detail: `HTTP ${status}` });
      return this.all(inputs, (itemId) => ({
        itemId,
        outcome: 'error',
        reason: 'unavailable',
        code: String(status),
        message: `Model unavailable (HTTP ${status}) after ${attempt + 1} attempts`,
      }));
    }
    let waitMs = this.backoff(attempt);
    if (status === 429) {
      const ra = parseRetryAfterSeconds(res.headers.get('retry-after'), this.o.now());
      if (ra !== null) waitMs = Math.max(waitMs, Math.min(RETRY_AFTER_MAX_S, ra) * 1000);
    }
    await scheduleRetry({ kind: 'transient', waitMs });
    throw new RetrySignal();
  }

  private async handleOk(
    res: Response,
    inputs: ClassifyInput[],
    itemAttempt: number,
  ): Promise<ClassifyResult[]> {
    let json: unknown;
    let rawText = '';
    try {
      rawText = await res.text();
      json = JSON.parse(rawText);
    } catch {
      json = undefined;
    }
    const parsed = this.adapter.parseResponse(json);
    if (!parsed.ok) {
      // Schema drift: keep the evidence, surface it, do not retry, never drop the items.
      logger.error(
        { raw: rawText.slice(0, 20_000), issues: parsed.issues },
        'model response failed schema validation',
      );
      this.hooks.onModelStatus?.({
        status: 'error',
        retryAvailableAt: null,
        detail: 'invalid response schema',
      });
      return this.all(inputs, (itemId) => ({
        itemId,
        outcome: 'error',
        reason: 'invalid_response',
        message: 'Model response did not match the contract',
      }));
    }

    this.hooks.onModelIdentity?.(parsed.model);
    this.hooks.onModelStatus?.({ status: 'ready', retryAvailableAt: null });

    const known = this.taxonomy.knownCategoryIds();
    const byId = new Map<string, AdaptedItem>(parsed.items.map((i) => [i.itemId, i]));
    const results = new Map<string, ClassifyResult>();
    const retryable: ClassifyInput[] = [];

    for (const input of inputs) {
      const item = byId.get(input.itemId);
      if (!item) {
        results.set(input.itemId, {
          itemId: input.itemId,
          outcome: 'error',
          reason: 'missing_result',
          message: 'Model response had no result for this item',
        });
      } else if (item.status === 'completed') {
        results.set(input.itemId, this.classified(item, parsed.model, known));
      } else if (!TERMINAL_ITEM_CODES.has(item.code) && itemAttempt < this.o.itemRetries) {
        retryable.push(input);
      } else {
        results.set(input.itemId, {
          itemId: input.itemId,
          outcome: 'error',
          reason: 'item_failed',
          code: item.code,
          message: item.message,
        });
      }
    }

    if (retryable.length > 0) {
      await this.o.sleep(this.backoff(itemAttempt));
      for (const r of await this.classifyChunk(retryable, itemAttempt + 1)) results.set(r.itemId, r);
    }
    return inputs.map((i) => results.get(i.itemId)!);
  }

  private classified(
    item: Extract<AdaptedItem, { status: 'completed' }>,
    model: ModelIdentity,
    known: ReadonlySet<string> | null,
  ): ClassifyResult {
    const unknownLabels = findUnknownLabels(item.classification, known);
    if (unknownLabels.length > 0) {
      logger.warn(
        { itemId: item.itemId, unknownLabels },
        'model returned category labels absent from the taxonomy',
      );
    }
    return {
      itemId: item.itemId,
      outcome: 'classified',
      classification: item.classification,
      raw: item.raw,
      model,
      unknownLabels,
    };
  }
}

/** Internal control-flow signal: the retry has been scheduled (and slept); loop again. */
class RetrySignal extends Error {}
