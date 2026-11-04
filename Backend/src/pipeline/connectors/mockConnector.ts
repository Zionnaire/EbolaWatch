import { randomUUID } from 'node:crypto';
import type { RawPost } from '../../contracts/api/index.js';
import { logger } from '../../utils/logger.js';
import type { IngestResult } from '../ingest.js';
import { SYNTHETIC_CORPUS, SYNTHETIC_PLATFORMS } from './syntheticCorpus.js';
import type { Connector, IngestSink } from './types.js';

export interface MockConnectorOptions {
  intervalMs: number;
  /** Posts emitted per tick. */
  batchSize: number;
  /** Becomes part of every sourceId so a restart never collides with earlier synthetic posts. */
  runId?: string;
  now?: () => Date;
  onRun?: (outcome: { ok: true; result: IngestResult } | { ok: false; error: unknown }) => void;
}

/** Emits synthetic posts on an interval through the same ingest path as real posts. */
export class MockConnector implements Connector {
  readonly key = 'mock';
  readonly name = 'Synthetic mock feed';
  readonly platform = 'mock';
  readonly initialStatus: Connector['initialStatus'];
  readonly initialDetail = 'Generates synthetic posts for development and demos. Not real data.';

  private counter = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly runId: string;

  constructor(
    private readonly sink: IngestSink,
    private readonly opts: MockConnectorOptions,
    enabled: boolean,
  ) {
    this.initialStatus = enabled ? 'live' : 'paused';
    this.runId = opts.runId ?? randomUUID().slice(0, 8);
  }

  /** Builds the next batch (pure apart from the counter). */
  nextBatch(): RawPost[] {
    const now = (this.opts.now ?? (() => new Date()))();
    return Array.from({ length: this.opts.batchSize }, () => {
      const n = this.counter++;
      const sample = SYNTHETIC_CORPUS[n % SYNTHETIC_CORPUS.length]!;
      return {
        platform: SYNTHETIC_PLATFORMS[n % SYNTHETIC_PLATFORMS.length]!,
        sourceId: `mock-${this.runId}-${n}`,
        authorHandle: `@synthetic_user_${n % 17}`,
        text: sample.text,
        language: sample.language,
        postedAt: now.toISOString(),
        state: sample.state,
        lga: sample.lga,
        engagement: { likes: (n * 37) % 400, reposts: (n * 11) % 90, replies: (n * 7) % 40, views: null },
      } satisfies RawPost;
    });
  }

  async tick(): Promise<IngestResult> {
    const result = await this.sink.ingest(this.nextBatch());
    this.opts.onRun?.({ ok: true, result });
    return result;
  }

  start(): void {
    if (this.timer) return;
    const run = () =>
      this.tick().catch((error: unknown) => {
        logger.error({ err: error }, 'mock connector tick failed');
        this.opts.onRun?.({ ok: false, error });
      });
    void run();
    this.timer = setInterval(() => void run(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
