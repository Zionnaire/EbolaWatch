import type { IngestResult } from '../ingest.js';

/** A source of posts. Real platform connectors live in the Python / HuggingFace service and push via POST /api/ingest. */
export interface Connector {
  /** Stable key stored on the Connector document. */
  readonly key: string;
  readonly name: string;
  readonly platform: string;
  /** Status seeded on first boot; afterwards the DB value is authoritative. */
  readonly initialStatus: 'live' | 'not_integrated' | 'paused';
  readonly initialDetail: string | null;
  start?(): void;
  stop?(): void;
}

export interface IngestSink {
  ingest(posts: import('../../contracts/api/index.js').RawPost[]): Promise<IngestResult>;
}
