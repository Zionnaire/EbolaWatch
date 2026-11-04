import type { Citation } from '../../contracts/api/index.js';

export interface GenerateRequest {
  /** PII-scrubbed claim the draft answers. */
  claim: string;
  /** Category id (data from the taxonomy) and its display name, when known. */
  category: string | null;
  categoryName: string | null;
  language: string;
  platform: string;
  /** The draft must fit in this many characters. */
  charLimit: number;
  guidance: string | null;
  /** 0 for the first draft; grows on each regeneration so a generator can vary its output. */
  attempt: number;
}

export interface GeneratedDraft {
  text: string;
  /** The language the text is actually in (may differ from the requested one). */
  language: string;
  citations: Citation[];
  warnings: string[];
}

/**
 * Seam for the counter-narrative generator.
 * TODO(ext): real implementation is RAG: multilingual-e5-base embeddings + pgvector retrieval over NCDC/WHO
 * material + a Groq-hosted LLM. Pin the model names in config and verify they exist before wiring it in.
 */
export interface CounterNarrativeGenerator {
  /** Provenance, reported to the client in /api/system/status. */
  readonly mode: 'mock' | 'live';
  readonly name: string;
  readonly version: string;
  generate(req: GenerateRequest): Promise<GeneratedDraft>;
}
