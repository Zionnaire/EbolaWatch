/** Adapter for the legacy `threeclass-v0` contract. SHAPE ASSUMED: reconfirm with the model developer. */
import type { Classification } from '../../contracts/api/index.js';
import { ThreeClassResponseSchema } from '../../contracts/model/threeClassV0.js';
import type { ModelIdentity } from '../types.js';
import type { ContractAdapter } from './types.js';

export const threeClassV0Adapter: ContractAdapter = {
  contract: 'threeclass-v0',
  maxBatch: 32,
  sendsTaxonomyVersion: false,

  buildRequest(requestId, _taxonomyVersion, inputs) {
    return {
      request_id: requestId,
      items: inputs.map((i) => ({
        item_id: i.itemId,
        text: i.text,
        platform: i.platform,
        language_hint: i.languageHint ?? null,
        context_text: i.contextText ?? null,
      })),
    };
  },

  parseResponse(json) {
    const parsed = ThreeClassResponseSchema.safeParse(json);
    if (!parsed.success) return { ok: false, issues: parsed.error.issues };
    const r = parsed.data;
    const model: ModelIdentity = { name: r.model.name, version: r.model.version, taxonomyVersion: null };
    return {
      ok: true,
      model,
      items: r.results.map((item) => {
        if (item.status === 'failed') {
          return {
            itemId: item.item_id,
            status: 'failed',
            code: item.error.code,
            message: item.error.message,
          };
        }
        const classification: Classification = {
          contract: 'threeclass-v0',
          modelName: r.model.name,
          modelVersion: r.model.version,
          taxonomyVersion: null,
          isRelevant: item.label !== 'irrelevant',
          relevanceConfidence: 1 - item.probabilities.irrelevant,
          language: item.language,
          stance: null,
          categories: [],
          severity: null,
          threeClass: { label: item.label, probabilities: item.probabilities, entropy: item.entropy },
          truncated: false,
          latencyMs: item.latency_ms,
        };
        return { itemId: item.item_id, status: 'completed', classification, raw: item };
      }),
    };
  },
};
