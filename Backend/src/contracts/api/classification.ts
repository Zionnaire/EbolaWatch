/** Neutral internal Classification. Both model adapters produce it; decisions, DTOs and the UI depend only on this. */
import { z } from 'zod';

export const CONTRACTS = ['multilabel-v1', 'threeclass-v0'] as const;
export const ContractSchema = z.enum(CONTRACTS);
export type Contract = z.infer<typeof ContractSchema>;

export const StanceSchema = z.enum(['endorses', 'refutes', 'questions', 'neutral_report']);
export type Stance = z.infer<typeof StanceSchema>;

export const LanguageSchema = z.enum(['en', 'pcm', 'ha', 'yo', 'ig', 'fr', 'und']);

export const SeverityLevelSchema = z.literal([0, 1, 2, 3, 4]);
export type SeverityLevel = z.infer<typeof SeverityLevelSchema>;

export const ThreeClassLabelSchema = z.enum(['misinformation', 'factual', 'irrelevant']);

export const ClassificationSchema = z.object({
  contract: ContractSchema,
  modelName: z.string(),
  modelVersion: z.string(),
  taxonomyVersion: z.string().nullable(),
  isRelevant: z.boolean(),
  relevanceConfidence: z.number().min(0).max(1),
  /** string, not a union: 3-class models report free-form language codes. */
  language: z.string().nullable(),
  stance: StanceSchema.nullable(),
  /** Labels are data, validated against the synced taxonomy at runtime. */
  categories: z.array(z.object({ label: z.string(), score: z.number().min(0).max(1) })),
  severity: z
    .object({
      level: SeverityLevelSchema,
      confidence: z.number().min(0).max(1),
      distribution: z.array(z.number()).length(5),
    })
    .nullable(),
  threeClass: z
    .object({
      label: ThreeClassLabelSchema,
      probabilities: z.object({ misinformation: z.number(), factual: z.number(), irrelevant: z.number() }),
      entropy: z.number(),
    })
    .nullable(),
  truncated: z.boolean(),
  latencyMs: z.number().nonnegative(),
});

export type Classification = z.infer<typeof ClassificationSchema>;
