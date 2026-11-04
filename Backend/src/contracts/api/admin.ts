import { z } from 'zod';
import { OperatingModeSchema } from './system.js';

export const ConnectorDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  /** Data, not a union: the UI shows whatever the API says (live, not_integrated, error, paused, ...). */
  status: z.string(),
  detail: z.string().nullable(),
  lastRunAt: z.string().nullable(),
});
export type ConnectorDto = z.infer<typeof ConnectorDtoSchema>;

export const SetModeRequestSchema = z.object({ mode: OperatingModeSchema });
export type SetModeRequest = z.infer<typeof SetModeRequestSchema>;

export const RecomputeResultSchema = z.object({
  mode: OperatingModeSchema,
  examined: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
});
export type RecomputeResult = z.infer<typeof RecomputeResultSchema>;

/** Body of POST /api/ingest (called by the Python / HuggingFace connectors). */
export const RawPostSchema = z.object({
  platform: z.string().trim().min(1).max(32),
  sourceId: z.string().trim().min(1).max(200),
  /** Handle or id of the author. Only an HMAC of it is stored. */
  authorHandle: z.string().max(200).nullish(),
  /** Raw text. It is PII-scrubbed on arrival and never persisted as received. */
  text: z.string().refine((t) => t.trim().length > 0, 'text must not be empty'),
  language: z.string().max(16).nullish(),
  postedAt: z.iso.datetime({ offset: true }),
  /** Coarse location only (state / LGA). */
  state: z.string().trim().max(80).nullish(),
  lga: z.string().trim().max(80).nullish(),
  engagement: z
    .object({
      likes: z.number().int().nonnegative().nullish(),
      reposts: z.number().int().nonnegative().nullish(),
      replies: z.number().int().nonnegative().nullish(),
      views: z.number().int().nonnegative().nullish(),
    })
    .nullish(),
});
export type RawPost = z.infer<typeof RawPostSchema>;

export const MAX_INGEST_BATCH = 100;

export const IngestRequestSchema = z.object({
  /** Items are validated one by one so a single bad post does not reject the batch. */
  posts: z.array(z.unknown()).min(1).max(MAX_INGEST_BATCH),
});

export const IngestResponseSchema = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  rejected: z.array(z.object({ index: z.number().int(), reason: z.string() })),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;
