import type { Contract } from '../contracts/api/index.js';
import { adapterFor } from './adapters/index.js';
import {
  MOCK_MODEL_NAME,
  MOCK_MODEL_VERSION,
  MOCK_THREECLASS_NAME,
  pickMultilabel,
  pickThreeClass,
} from './fixtureResponder.js';
import { findUnknownLabels } from './unknownLabels.js';
import type {
  ClassifierClient,
  ClassifierHooks,
  ClassifyInput,
  ClassifyResult,
  TaxonomyView,
} from './types.js';

/** Classifier that answers from fixtures with no network. Goes through the real adapters. */
export class InProcessMockClassifier implements ClassifierClient {
  readonly kind = 'inprocess' as const;

  constructor(
    readonly contract: Contract,
    private readonly taxonomy: Pick<TaxonomyView, 'knownCategoryIds' | 'version'>,
    private readonly hooks: ClassifierHooks = {},
  ) {}

  classify(inputs: ClassifyInput[]): Promise<ClassifyResult[]> {
    const adapter = adapterFor(this.contract);
    const three = this.contract === 'threeclass-v0';
    const taxonomyVersion = this.taxonomy.version();

    const results = inputs.map((it) => {
      if (it.text.trim().length === 0) {
        return {
          item_id: it.itemId,
          status: 'failed',
          error: { code: 'empty_text', message: 'Text was empty after normalisation' },
        };
      }
      const ctx = { languageHint: it.languageHint, text: it.text };
      return three ? pickThreeClass(it.itemId, ctx) : pickMultilabel(it.itemId, ctx);
    });

    const response = {
      request_id: 'inprocess-mock',
      status: results.some((r) => r.status === 'failed') ? 'partial' : 'completed',
      model: three
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
            taxonomy_version: taxonomyVersion ?? 'ebola-tax-1.0',
            base_model: 'mock',
            trained_at: null,
          },
      results,
    };
    // A batch where every item failed is `failed`, never `partial`.
    if (results.every((r) => r.status === 'failed')) response.status = 'failed';

    const parsed = adapter.parseResponse(response);
    if (!parsed.ok) {
      // The fixtures are contract-tested, so this is a programming error.
      return Promise.resolve(
        inputs.map((i) => ({
          itemId: i.itemId,
          outcome: 'error' as const,
          reason: 'invalid_response' as const,
          message: 'InProcessMockClassifier produced an invalid fixture response',
        })),
      );
    }
    this.hooks.onModelIdentity?.(parsed.model);
    const known = this.taxonomy.knownCategoryIds();
    const byId = new Map(parsed.items.map((i) => [i.itemId, i]));

    return Promise.resolve(
      inputs.map((input): ClassifyResult => {
        const item = byId.get(input.itemId);
        if (!item)
          return {
            itemId: input.itemId,
            outcome: 'error',
            reason: 'missing_result',
            message: 'No result for item',
          };
        if (item.status === 'failed') {
          return {
            itemId: item.itemId,
            outcome: 'error',
            reason: 'item_failed',
            code: item.code,
            message: item.message,
          };
        }
        return {
          itemId: item.itemId,
          outcome: 'classified',
          classification: item.classification,
          raw: item.raw,
          model: parsed.model,
          unknownLabels: findUnknownLabels(item.classification, known),
        };
      }),
    );
  }
}
