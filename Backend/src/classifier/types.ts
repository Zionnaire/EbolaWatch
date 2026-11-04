import type { Classification, Contract } from '../contracts/api/index.js';

export interface ClassifyInput {
  itemId: string;
  /** Must already be PII-scrubbed. */
  text: string;
  platform: string;
  languageHint?: string | null;
  contextText?: string | null;
}

export interface ModelIdentity {
  name: string;
  version: string;
  taxonomyVersion: string | null;
}

/**
 * Per-item outcome. Items are never dropped: every input yields exactly one result.
 * - classified: success.
 * - pending: could not be classified *yet*; the item stays `pending` (warming, taxonomy problems).
 * - error: terminal for now; the item becomes `classification_error`.
 */
export type ClassifyResult =
  | {
      itemId: string;
      outcome: 'classified';
      classification: Classification;
      /** Full validated model output for this item (stored as Mixed). */
      raw: unknown;
      model: ModelIdentity;
      /** Category labels not present in the synced taxonomy: the post is flagged `needs_review`. */
      unknownLabels: string[];
    }
  | { itemId: string; outcome: 'pending'; reason: 'warming' | 'taxonomy_mismatch' | 'taxonomy_unavailable' }
  | {
      itemId: string;
      outcome: 'error';
      reason:
        | 'invalid_response'
        | 'bad_request'
        | 'unauthorized'
        | 'unavailable'
        | 'item_failed'
        | 'missing_result';
      code?: string;
      message: string;
    };

export interface ClassifierClient {
  readonly kind: 'inprocess' | 'http';
  readonly contract: Contract;
  classify(inputs: ClassifyInput[]): Promise<ClassifyResult[]>;
}

export interface ClassifierAlert {
  level: 'warning' | 'critical';
  code: string;
  message: string;
}

/** Side-channel from the classifier to the rest of the system (status store, alerts, provenance). */
export interface ClassifierHooks {
  onModelStatus?(s: {
    status: 'ready' | 'warming' | 'error';
    retryAvailableAt: string | null;
    detail?: string;
  }): void;
  onAlert?(a: ClassifierAlert): void;
  onModelIdentity?(m: ModelIdentity): void;
}

/** Read-side of the synced taxonomy needed by the classifier. */
export interface TaxonomyView {
  version(): string | null;
  knownCategoryIds(): ReadonlySet<string> | null;
  resync(): Promise<void>;
}
