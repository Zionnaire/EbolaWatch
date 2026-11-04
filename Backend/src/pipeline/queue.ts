import { logger } from '../utils/logger.js';

export type EnqueueResult = 'queued' | 'duplicate' | 'full';

export interface WorkQueueOptions {
  /** Max ids held in memory. When full the post simply stays `pending` in the DB and is swept up later. */
  cap: number;
  batchSize: number;
  handler: (ids: string[]) => Promise<void>;
  /** Called after the queue drains: used to pull in posts that did not fit. */
  onDrained?: () => Promise<void> | void;
}

/**
 * In-process FIFO queue (no Kafka). The database is the source of truth: this only schedules work and is
 * rebuilt on boot from `pending|classifying` posts.
 */
export class WorkQueue {
  private readonly ids = new Set<string>();
  private running = false;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly opts: WorkQueueOptions) {}

  enqueue(id: string): EnqueueResult {
    if (this.stopped) return 'full';
    if (this.ids.has(id)) return 'duplicate';
    if (this.ids.size >= this.opts.cap) return 'full';
    this.ids.add(id);
    this.kick();
    return 'queued';
  }

  size(): number {
    return this.ids.size;
  }

  /** Free slots, so a sweeper knows how many pending posts it may add. */
  capacityLeft(): number {
    return Math.max(0, this.opts.cap - this.ids.size);
  }

  /** Resolves when the queue is empty and nothing is running. */
  idle(): Promise<void> {
    if (!this.running && this.ids.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  stop(): void {
    this.stopped = true;
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    setImmediate(() => void this.run());
  }

  private async run(): Promise<void> {
    try {
      while (this.ids.size > 0 && !this.stopped) {
        const batch = [...this.ids].slice(0, this.opts.batchSize);
        // Ids leave the set only once handled, so a concurrent enqueue of the same id stays a duplicate.
        try {
          await this.opts.handler(batch);
        } catch (err) {
          logger.error(
            { err },
            'queue handler failed; batch dropped from memory (posts remain pending in the DB)',
          );
        } finally {
          for (const id of batch) this.ids.delete(id);
        }
      }
      if (!this.stopped && this.opts.onDrained) {
        await Promise.resolve(this.opts.onDrained()).catch((err) =>
          logger.error({ err }, 'queue onDrained failed'),
        );
      }
    } finally {
      this.running = false;
      // onDrained may have enqueued more; pick that up
      if (this.ids.size > 0 && !this.stopped) this.kick();
      else for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
