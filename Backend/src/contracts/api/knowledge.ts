import { z } from 'zod';

/** The fact base the counter-narrative writer may draw on, as shown (read-only) in Settings. */
export const KnowledgeEntryDtoSchema = z.object({
  id: z.string(),
  topic: z.string(),
  text: z.string(),
  /** Changes with the outbreak: re-check before using. */
  volatile: z.boolean(),
  asOf: z.string().nullable(),
  validUntil: z.string().nullable(),
  /** Past its validity date: the writer will not use it. */
  expired: z.boolean(),
  note: z.string().nullable(),
  source: z.object({ publisher: z.string(), title: z.string(), url: z.string() }),
});
export type KnowledgeEntryDto = z.infer<typeof KnowledgeEntryDtoSchema>;

export const KnowledgeDtoSchema = z.object({
  version: z.string(),
  /** `approved` once an NCDC reviewer has signed the file off. */
  status: z.enum(['pending_ncdc_review', 'approved']),
  retrievedAt: z.string(),
  note: z.string(),
  entries: z.array(KnowledgeEntryDtoSchema),
  /** What the material does not cover, so reviewers know what is missing. */
  gaps: z.array(z.string()),
});
export type KnowledgeDto = z.infer<typeof KnowledgeDtoSchema>;
