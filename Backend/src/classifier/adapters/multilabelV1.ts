import type { Classification } from '../../contracts/api/index.js';
import {
  ClassifyResponseSchema,
  MULTILABEL_MAX_ITEMS,
  type CompletedItem,
} from '../../contracts/model/multilabelV1.js';
import type { ModelIdentity } from '../types.js';
import type { ContractAdapter } from './types.js';

export function toClassification(
  item: CompletedItem,
  model: { name: string; version: string; taxonomy_version: string },
): Classification {
  return {
    contract: 'multilabel-v1',
    modelName: model.name,
    modelVersion: model.version,
    taxonomyVersion: model.taxonomy_version,
    isRelevant: item.relevance.is_ebola_related,
    relevanceConfidence: item.relevance.confidence,
    language: item.language.primary,
    stance: item.stance?.label ?? null,
    categories: item.categories.map((c) => ({ label: c.label, score: c.score })),
    severity: item.severity
      ? {
          level: item.severity.level,
          confidence: item.severity.confidence,
          distribution: [...item.severity.distribution],
        }
      : null,
    threeClass: null,
    truncated: item.truncated,
    latencyMs: item.latency_ms,
  };
}

export const multilabelV1Adapter: ContractAdapter = {
  contract: 'multilabel-v1',
  maxBatch: MULTILABEL_MAX_ITEMS,
  sendsTaxonomyVersion: true,

  buildRequest(requestId, taxonomyVersion, inputs) {
    return {
      request_id: requestId,
      taxonomy_version: taxonomyVersion,
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
    const parsed = ClassifyResponseSchema.safeParse(json);
    if (!parsed.success) return { ok: false, issues: parsed.error.issues };
    const r = parsed.data;
    const model: ModelIdentity = {
      name: r.model.name,
      version: r.model.version,
      taxonomyVersion: r.model.taxonomy_version,
    };
    return {
      ok: true,
      model,
      items: r.results.map((item) =>
        item.status === 'completed'
          ? {
              itemId: item.item_id,
              status: 'completed',
              classification: toClassification(item, r.model),
              raw: item,
            }
          : { itemId: item.item_id, status: 'failed', code: item.error.code, message: item.error.message },
      ),
    };
  },
};
