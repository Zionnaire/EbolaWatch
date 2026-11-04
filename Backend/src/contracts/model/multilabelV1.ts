/**
 * EXTERNAL model contract `multilabel-v1`. Read only inside classifier/adapters and the mock model.
 * Runtime schemas strip unknown keys; the `*Strict` variants reject them and are used in contract tests only.
 */
import { z } from 'zod';

export const MULTILABEL_STANCES = ['endorses', 'refutes', 'questions', 'neutral_report'] as const;
export const MULTILABEL_LANGUAGES = ['en', 'pcm', 'ha', 'yo', 'ig', 'fr', 'und'] as const;
export const MULTILABEL_SEVERITY_LEVELS = [0, 1, 2, 3, 4] as const;
export const MULTILABEL_ERROR_CODES = [
  'empty_text',
  'text_too_long',
  'unsupported_input',
  'internal',
] as const;
export const MULTILABEL_MAX_ITEMS = 32;
export const MULTILABEL_MAX_TEXT_CHARS = 2000;

const DISTRIBUTION_TOLERANCE = 0.01;

type ObjectFactory = typeof z.object;

function build(o: ObjectFactory) {
  const confidence = z.number().min(0).max(1);
  const stanceId = z.enum(MULTILABEL_STANCES);
  const languageId = z.enum(MULTILABEL_LANGUAGES);
  const severityLevel = z.literal([...MULTILABEL_SEVERITY_LEVELS]);

  const modelInfo = o({
    name: z.string(),
    version: z.string(),
    taxonomy_version: z.string(),
    base_model: z.string().nullable(),
    trained_at: z.string().nullable(),
  });

  const completedItem = o({
    item_id: z.string(),
    status: z.literal('completed'),
    language: o({ primary: languageId, confidence, code_switched: z.boolean() }),
    relevance: o({ is_ebola_related: z.boolean(), confidence }),
    stance: o({ label: stanceId, confidence }).nullable(),
    // Category labels are data: validated against the synced taxonomy at runtime, not a TS union.
    categories: z.array(o({ label: z.string(), score: confidence })),
    severity: o({
      level: severityLevel,
      confidence,
      distribution: z.array(confidence).length(5),
    }).nullable(),
    truncated: z.boolean(),
    latency_ms: z.number().nonnegative(),
  })
    .refine(
      (i) => i.categories.every((c, idx) => idx === 0 || (i.categories[idx - 1]?.score ?? 0) >= c.score),
      {
        message: 'categories must be sorted by score descending',
        path: ['categories'],
      },
    )
    .refine((i) => new Set(i.categories.map((c) => c.label)).size === i.categories.length, {
      message: 'categories must be unique',
      path: ['categories'],
    })
    .refine(
      (i) =>
        i.severity === null ||
        Math.abs(i.severity.distribution.reduce((a, b) => a + b, 0) - 1) <= DISTRIBUTION_TOLERANCE,
      { message: 'severity.distribution must sum to 1 (±0.01)', path: ['severity', 'distribution'] },
    )
    .refine((i) => i.relevance.is_ebola_related || (i.stance === null && i.severity === null), {
      message: 'is_ebola_related=false requires stance and severity to be null',
      path: ['relevance'],
    });

  const failedItem = o({
    item_id: z.string(),
    status: z.literal('failed'),
    error: o({ code: z.enum(MULTILABEL_ERROR_CODES), message: z.string() }),
  });

  const item = z.discriminatedUnion('status', [completedItem, failedItem]);

  const classifyResponse = o({
    request_id: z.string(),
    status: z.enum(['completed', 'partial', 'failed']),
    model: modelInfo,
    results: z.array(item),
  }).refine(
    (r) => {
      const failed = r.results.filter((i) => i.status === 'failed').length;
      const ok = r.results.length - failed;
      if (r.status === 'completed') return failed === 0;
      if (r.status === 'partial') return failed >= 1 && ok >= 1;
      return ok === 0;
    },
    { message: 'batch status inconsistent with item statuses', path: ['status'] },
  );

  const classifyRequest = o({
    request_id: z.string(),
    taxonomy_version: z.string(),
    items: z
      .array(
        o({
          item_id: z.string(),
          text: z.string(),
          platform: z.string(),
          language_hint: z.string().nullable(),
          context_text: z.string().nullable(),
        }),
      )
      .min(1)
      .max(MULTILABEL_MAX_ITEMS),
  });

  const health = o({
    status: z.enum(['ready', 'warming', 'degraded']),
    model_version: z.string(),
    taxonomy_version: z.string(),
    retry_after_seconds: z.number().nonnegative().nullable(),
  });

  // Stance / language element shapes are ASSUMED ({id, display_name}); see docs/model-api-questions.md.
  const taxonomy = o({
    taxonomy_version: z.string(),
    categories: z.array(o({ id: z.string(), display_name: z.string(), description: z.string() })),
    stances: z.array(o({ id: z.string(), display_name: z.string() })),
    severity_levels: z.array(severityLevel),
    languages: z.array(o({ id: z.string(), display_name: z.string() })),
  });

  return { classifyRequest, classifyResponse, health, taxonomy, item, completedItem, failedItem };
}

const runtime = build(z.object);
const strict = build(z.strictObject as unknown as ObjectFactory);

export const ClassifyRequestSchema = runtime.classifyRequest;
export const ClassifyResponseSchema = runtime.classifyResponse;
export const HealthSchema = runtime.health;
export const TaxonomySchema = runtime.taxonomy;
export const ResultItemSchema = runtime.item;

export const ClassifyRequestStrictSchema = strict.classifyRequest;
export const ClassifyResponseStrictSchema = strict.classifyResponse;
export const HealthStrictSchema = strict.health;
export const TaxonomyStrictSchema = strict.taxonomy;

export type ClassifyRequest = z.infer<typeof ClassifyRequestSchema>;
export type ClassifyResponse = z.infer<typeof ClassifyResponseSchema>;
export type ResultItem = z.infer<typeof ResultItemSchema>;
export type CompletedItem = Extract<ResultItem, { status: 'completed' }>;
export type FailedItem = Extract<ResultItem, { status: 'failed' }>;
export type ModelHealth = z.infer<typeof HealthSchema>;
export type ModelTaxonomy = z.infer<typeof TaxonomySchema>;
