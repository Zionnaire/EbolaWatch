import { EventEmitter } from 'node:events';
import type { ModelStatus } from '../contracts/api/index.js';
import type { ModelHealth } from '../contracts/model/multilabelV1.js';
import { logger } from '../utils/logger.js';
import type { TaxonomyView } from './types.js';

export interface ModelStatusState {
  status: ModelStatus;
  modelVersion: string | null;
  taxonomyVersion: string | null;
  /** Absolute ISO timestamp; the UI derives the countdown from it. */
  retryAvailableAt: string | null;
  detail?: string;
}

const RETRY_AT_DRIFT_MS = 5000;

/** Latest model status. Emits `change` only when something meaningful changed. */
export class ModelStatusStore extends EventEmitter {
  private state: ModelStatusState = {
    status: 'unknown',
    modelVersion: null,
    taxonomyVersion: null,
    retryAvailableAt: null,
  };

  get(): ModelStatusState {
    return { ...this.state };
  }

  update(patch: Partial<ModelStatusState>): void {
    const prev = this.state;
    const next = { ...prev, ...patch };
    if (next.status !== 'warming') next.retryAvailableAt = patch.retryAvailableAt ?? null;
    const retryMoved =
      (prev.retryAvailableAt === null) !== (next.retryAvailableAt === null) ||
      (prev.retryAvailableAt !== null &&
        next.retryAvailableAt !== null &&
        Math.abs(Date.parse(prev.retryAvailableAt) - Date.parse(next.retryAvailableAt)) > RETRY_AT_DRIFT_MS);
    const changed =
      prev.status !== next.status ||
      prev.modelVersion !== next.modelVersion ||
      prev.taxonomyVersion !== next.taxonomyVersion ||
      retryMoved;
    // Keep the original timestamp while warming unless it drifted noticeably.
    this.state = changed ? next : { ...prev, detail: next.detail };
    if (changed) this.emit('change', this.get());
  }

  /** Called when a classify call succeeded: clears transient `error` / `warming`, keeps `degraded`. */
  markClassifySuccess(): void {
    if (this.state.status === 'error' || this.state.status === 'warming') this.update({ status: 'ready' });
  }
}

export interface HealthSource {
  fetchHealth(): Promise<ModelHealth>;
}

export class InProcessHealthSource implements HealthSource {
  constructor(private readonly taxonomyVersion: string | null) {}
  fetchHealth(): Promise<ModelHealth> {
    return Promise.resolve({
      status: 'ready',
      model_version: '0.0.0-mock',
      taxonomy_version: this.taxonomyVersion ?? 'n/a',
      retry_after_seconds: null,
    });
  }
}

export class ModelStatusPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly source: HealthSource,
    private readonly store: ModelStatusStore,
    private readonly taxonomy: TaxonomyView & { get?: () => unknown },
    private readonly opts: { intervalMs: number; syncsTaxonomy: boolean; now?: () => number },
  ) {}

  async poll(): Promise<void> {
    const now = (this.opts.now ?? Date.now)();
    let health: ModelHealth;
    try {
      health = await this.source.fetchHealth();
    } catch (err) {
      logger.warn({ err: String(err) }, 'model health check failed');
      this.store.update({ status: 'error', retryAvailableAt: null, detail: 'health check failed' });
      return;
    }

    // A new taxonomy_version means we must re-sync before classifying further.
    if (
      this.opts.syncsTaxonomy &&
      health.status !== 'warming' &&
      health.taxonomy_version !== this.taxonomy.version()
    ) {
      await this.taxonomy
        .resync()
        .catch((err) => logger.warn({ err: String(err) }, 'taxonomy re-sync failed'));
    }

    this.store.update({
      status: health.status,
      modelVersion: health.model_version,
      taxonomyVersion: this.taxonomy.version() ?? (this.opts.syncsTaxonomy ? null : health.taxonomy_version),
      retryAvailableAt:
        health.retry_after_seconds !== null
          ? new Date(now + health.retry_after_seconds * 1000).toISOString()
          : null,
    });
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
