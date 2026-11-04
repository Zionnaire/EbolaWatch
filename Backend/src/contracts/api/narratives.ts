import { z } from 'zod';
import { LanguageSchema } from './classification.js';

/** `dispatching` is transient: a dispatch is in flight and the narrative is locked against edits. */
export const NarrativeStatusSchema = z.enum(['draft', 'approved', 'rejected', 'dispatching', 'dispatched']);
export type NarrativeStatus = z.infer<typeof NarrativeStatusSchema>;

export const ProviderModeSchema = z.enum(['mock', 'live']);

export const CitationSchema = z.object({ source: z.string(), title: z.string(), url: z.string() });
export type Citation = z.infer<typeof CitationSchema>;

export const NarrativeVersionSchema = z.object({
  text: z.string(),
  kind: z.enum(['generated', 'edited', 'regenerated']),
  by: z.string(),
  at: z.string(),
});

export const NarrativeReviewDtoSchema = z.object({
  id: z.string(),
  narrativeId: z.string(),
  reviewer: z.string(),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().nullable(),
  /** True when this review was made on the text as it is now (an edit makes earlier reviews stale). */
  onCurrentText: z.boolean(),
  createdAt: z.string(),
});
export type NarrativeReviewDto = z.infer<typeof NarrativeReviewDtoSchema>;

export const NarrativeDtoSchema = z.object({
  id: z.string(),
  /** null for a manually generated narrative. */
  postId: z.string().nullable(),
  source: z.enum(['post', 'manual']),
  platform: z.string(),
  charLimit: z.number().int(),
  requestedLanguage: z.string(),
  /** The language the draft is actually written in (the mock generator only writes English). */
  language: z.string(),
  category: z.string().nullable(),
  taxonomyVersion: z.string().nullable(),
  /** PII-scrubbed claim the draft responds to. */
  claim: z.string().nullable(),
  text: z.string(),
  status: NarrativeStatusSchema,
  citations: z.array(CitationSchema),
  warnings: z.array(z.string()),
  versions: z.array(NarrativeVersionSchema),
  generator: z.object({ name: z.string(), version: z.string(), mode: ProviderModeSchema }),
  /** Present only while the latest review is an approval of the current text. */
  approval: z.object({ reviewer: z.string(), at: z.string(), note: z.string().nullable() }).nullable(),
  isMock: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NarrativeDto = z.infer<typeof NarrativeDtoSchema>;

export const DispatchDtoSchema = z.object({
  id: z.string(),
  narrativeId: z.string(),
  platform: z.string(),
  /** Exactly the text that was approved and sent. */
  text: z.string(),
  status: z.enum(['sent', 'failed']),
  externalId: z.string().nullable(),
  error: z.string().nullable(),
  approvedBy: z.string(),
  dispatchedBy: z.string(),
  dispatcher: z.object({ name: z.string(), mode: ProviderModeSchema }),
  isMock: z.boolean(),
  createdAt: z.string(),
  /** The post the counter-narrative answers (scrubbed text), when there is one. */
  originalPost: z
    .object({
      id: z.string(),
      text: z.string(),
      platform: z.string(),
      state: z.string().nullable(),
    })
    .nullable(),
});
export type DispatchDto = z.infer<typeof DispatchDtoSchema>;

export const NarrativeDetailDtoSchema = z.object({
  narrative: NarrativeDtoSchema,
  reviews: z.array(NarrativeReviewDtoSchema),
  dispatch: DispatchDtoSchema.nullable(),
});
export type NarrativeDetailDto = z.infer<typeof NarrativeDetailDtoSchema>;

export const NarrativeListDtoSchema = z.object({
  items: z.array(NarrativeDtoSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const DispatchListDtoSchema = z.object({
  items: z.array(DispatchDtoSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

/** Platform limits are configuration, not UI constants. */
export const NarrativeConfigDtoSchema = z.object({
  platforms: z.array(z.object({ id: z.string(), name: z.string(), charLimit: z.number().int() })),
  languages: z.array(LanguageSchema),
  generator: z.object({ name: z.string(), mode: ProviderModeSchema }),
  dispatcher: z.object({ name: z.string(), mode: ProviderModeSchema }),
});
export type NarrativeConfigDto = z.infer<typeof NarrativeConfigDtoSchema>;

// ---- requests ----

export const GenerateNarrativeRequestSchema = z
  .object({
    /** Respond to this post. Omit for a manual narrative (then `claim` is required). */
    postId: z.string().min(1).optional(),
    claim: z.string().trim().min(1).max(2000).optional(),
    platform: z.string().trim().min(1).optional(),
    language: LanguageSchema.optional(),
    category: z.string().trim().min(1).optional(),
    guidance: z.string().trim().max(500).optional(),
  })
  .refine((r) => r.postId !== undefined || r.claim !== undefined, {
    message: 'send a postId, or a claim for a manual narrative',
    path: ['claim'],
  })
  .refine((r) => r.postId !== undefined || r.platform !== undefined, {
    message: 'a manual narrative needs a target platform',
    path: ['platform'],
  });
export type GenerateNarrativeRequest = z.infer<typeof GenerateNarrativeRequestSchema>;

export const EditNarrativeRequestSchema = z.object({ text: z.string().trim().min(1).max(20_000) });

/** "Override label" = regenerate for a different category. */
export const RegenerateNarrativeRequestSchema = z.object({
  category: z.string().trim().min(1).optional(),
  language: LanguageSchema.optional(),
  platform: z.string().trim().min(1).optional(),
  guidance: z.string().trim().max(500).optional(),
});
export type RegenerateNarrativeRequest = z.infer<typeof RegenerateNarrativeRequestSchema>;

export const NarrativeReviewRequestSchema = z.object({ note: z.string().trim().max(1000).optional() });

export const NarrativeListQuerySchema = z.object({
  postId: z.string().min(1).optional(),
  status: NarrativeStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type NarrativeListQuery = z.infer<typeof NarrativeListQuerySchema>;

export const DispatchListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
