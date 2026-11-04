/**
 * Mock model server implementing the external model contract from fixtures.
 * Production code must never import from here (enforced by ESLint).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  MOCK_MODEL_NAME,
  MOCK_MODEL_VERSION,
  MOCK_THREECLASS_NAME,
  hash32,
  pickMultilabel,
  pickThreeClass,
} from '../classifier/fixtureResponder.js';
import { FIXTURES, loadFixture } from '../contracts/fixtures/index.js';
import { safeEqual } from '../utils/hashing.js';
import {
  ClassifyRequestSchema,
  MULTILABEL_MAX_TEXT_CHARS,
  type ModelTaxonomy,
} from '../contracts/model/multilabelV1.js';

export { MOCK_MODEL_NAME, MOCK_MODEL_VERSION, MOCK_THREECLASS_NAME, hash32 };

export interface MockControlState {
  contract: 'multilabel-v1' | 'threeclass-v0';
  /** Epoch ms until which the model reports `warming`; null = ready. */
  warmupUntil: number | null;
  latencyMs: number;
  /** 0..1, deterministic per item_id. Failed items use error code `internal`. */
  failureRate: number;
  /** Respond 409 to every classify call. */
  taxonomyMismatch: boolean;
  /** Return a response that violates the contract ("complete" instead of "completed"). */
  malformed: boolean;
}

export const ControlPatchSchema = z.object({
  reset: z.boolean().optional(),
  contract: z.enum(['multilabel-v1', 'threeclass-v0']).optional(),
  warmupSeconds: z.number().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
  failureRate: z.number().min(0).max(1).optional(),
  taxonomyMismatch: z.boolean().optional(),
  malformed: z.boolean().optional(),
});

export interface MockModelOptions {
  contract?: MockControlState['contract'];
  warmupSeconds?: number;
  latencyMs?: number;
  failureRate?: number;
  /**
   * When set, every /v1/* request must carry this value in the X-ML-API-Key header, as the real service requires
   * (401 with a FastAPI-style body otherwise). /__control is never protected: it is not part of the model.
   */
  apiKey?: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** FastAPI-style error body: `{ "detail": "message" }`. */
const detail = (message: string) => ({ detail: message });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const issuesToText = (issues: Array<{ path: PropertyKey[]; message: string }>) =>
  issues.map((i) => `${i.path.map(String).join('.') || '(body)'}: ${i.message}`).join('; ');

export function createMockModelApp(opts: MockModelOptions = {}) {
  const now = opts.now ?? Date.now;
  const taxonomy = loadFixture<ModelTaxonomy>(FIXTURES.taxonomy);
  const taxonomyVersion = taxonomy.taxonomy_version;

  const initial = (): MockControlState => ({
    contract: opts.contract ?? 'multilabel-v1',
    warmupUntil: opts.warmupSeconds ? now() + opts.warmupSeconds * 1000 : null,
    latencyMs: opts.latencyMs ?? 0,
    failureRate: opts.failureRate ?? 0,
    taxonomyMismatch: false,
    malformed: false,
  });
  const control = initial();

  const secondsUntilReady = () =>
    control.warmupUntil !== null && now() < control.warmupUntil
      ? Math.max(1, Math.ceil((control.warmupUntil - now()) / 1000))
      : null;

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // --- authentication: the same header and failure body as the real service ---
  app.use('/v1', (req, res, next) => {
    if (!opts.apiKey) return next();
    const provided = req.header('x-ml-api-key');
    if (!provided || !safeEqual(provided, opts.apiKey)) {
      return res.status(401).json(detail('Invalid or missing API key'));
    }
    return next();
  });

  // --- control (not part of the model contract) ---
  app.get('/__control', (_req, res) => res.json(control));
  app.post('/__control', (req, res) => {
    const patch = ControlPatchSchema.safeParse(req.body);
    if (!patch.success) return res.status(400).json(detail(issuesToText(patch.error.issues)));
    const { reset, warmupSeconds, ...rest } = patch.data;
    if (reset) Object.assign(control, initial(), { warmupUntil: null });
    Object.assign(control, rest);
    if (warmupSeconds !== undefined)
      control.warmupUntil = warmupSeconds > 0 ? now() + warmupSeconds * 1000 : null;
    return res.json(control);
  });

  // --- model contract ---
  app.get('/v1/health', (_req, res) => {
    const wait = secondsUntilReady();
    const isThree = control.contract === 'threeclass-v0';
    res.json({
      status: wait !== null ? 'warming' : 'ready',
      model_version: MOCK_MODEL_VERSION,
      taxonomy_version: isThree ? 'n/a' : taxonomyVersion,
      retry_after_seconds: wait,
    });
  });

  app.get('/v1/taxonomy', (_req, res) => {
    if (control.contract === 'threeclass-v0') {
      return res.status(404).json(detail('threeclass-v0 has no taxonomy'));
    }
    return res.json(taxonomy);
  });

  const isThree = () => control.contract === 'threeclass-v0';
  // In 3-class mode taxonomy_version is not part of the (assumed) request.
  const requestSchema = () =>
    isThree() ? ClassifyRequestSchema.partial({ taxonomy_version: true }) : ClassifyRequestSchema;

  app.post('/v1/classify', async (req, res) => {
    const wait = secondsUntilReady();
    if (wait !== null) {
      res.set('Retry-After', String(wait));
      return res.status(503).json(detail('Model is warming up'));
    }
    const parsed = requestSchema().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(detail(`Invalid request: ${issuesToText(parsed.error.issues)}`));
    }
    const request = parsed.data;
    if (
      control.taxonomyMismatch ||
      (!isThree() && request.taxonomy_version !== undefined && request.taxonomy_version !== taxonomyVersion)
    ) {
      return res.status(409).json(detail(`taxonomy_version mismatch: server taxonomy is ${taxonomyVersion}`));
    }
    if (control.latencyMs > 0) await sleep(control.latencyMs);

    const results = request.items.map((it) => {
      const failure = (code: 'empty_text' | 'internal', message: string) => ({
        item_id: it.item_id,
        status: 'failed' as const,
        error: { code, message },
      });
      if (it.text.trim().length === 0) return failure('empty_text', 'Text was empty after normalisation');
      if (hash32(`fail:${it.item_id}`) / 2 ** 32 < control.failureRate)
        return failure('internal', 'Simulated internal error');
      const truncated = it.text.length > MULTILABEL_MAX_TEXT_CHARS;
      if (isThree()) {
        return pickThreeClass(it.item_id, { languageHint: it.language_hint, text: it.text });
      }
      const pick = pickMultilabel(it.item_id, { languageHint: it.language_hint, text: it.text });
      return { ...pick, truncated: pick.truncated || truncated };
    });

    const failed = results.filter((r) => r.status === 'failed').length;
    const status = failed === 0 ? 'completed' : failed === results.length ? 'failed' : 'partial';
    const model = isThree()
      ? {
          name: MOCK_THREECLASS_NAME,
          version: MOCK_MODEL_VERSION,
          taxonomy_version: null,
          base_model: null,
          trained_at: null,
        }
      : {
          name: MOCK_MODEL_NAME,
          version: MOCK_MODEL_VERSION,
          taxonomy_version: taxonomyVersion,
          base_model: 'mock',
          trained_at: null,
        };

    return res.json({
      request_id: request.request_id,
      // Malformed mode reproduces a real drift bug: "complete" instead of "completed".
      status: control.malformed ? 'complete' : status,
      model,
      results,
    });
  });

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json(detail(status === 500 ? 'Internal server error' : err.message));
  });

  return { app, control };
}
