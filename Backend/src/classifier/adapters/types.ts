import type { ZodIssue } from 'zod';
import type { Classification, Contract } from '../../contracts/api/index.js';
import type { ClassifyInput, ModelIdentity } from '../types.js';

export type AdaptedItem =
  | { itemId: string; status: 'completed'; classification: Classification; raw: unknown }
  | { itemId: string; status: 'failed'; code: string; message: string };

export type ParsedResponse =
  { ok: true; model: ModelIdentity; items: AdaptedItem[] } | { ok: false; issues: ZodIssue[] };

/** One adapter per external model contract. The only code that reads raw model shapes. */
export interface ContractAdapter {
  readonly contract: Contract;
  readonly maxBatch: number;
  /** multilabel-v1 pins requests to a taxonomy_version; the 3-class model has none. */
  readonly sendsTaxonomyVersion: boolean;
  buildRequest(requestId: string, taxonomyVersion: string | null, inputs: ClassifyInput[]): unknown;
  /** Validates the raw JSON against the contract schema and maps it into neutral types. */
  parseResponse(json: unknown): ParsedResponse;
}
