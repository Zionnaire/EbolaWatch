import { model, Schema, type InferSchemaType } from 'mongoose';

/**
 * Schemas only require what our own code guarantees. Status fields are plain strings (their allowed values
 * are validated at the API boundary, not frozen into the DB), and nothing contract-owned is required.
 */
const postSchema = new Schema({
  platform: { type: String, required: true },
  sourceId: { type: String, required: true },
  /** HMAC-SHA256 of the author handle. The handle itself is never stored. */
  authorHash: { type: String, default: null },
  /** PII-scrubbed text. Raw text is never persisted. */
  text: { type: String, required: true },
  languageHint: { type: String, default: null },
  /** Coarse location only. */
  state: { type: String, default: null },
  lga: { type: String, default: null },
  postedAt: { type: Date, required: true },
  ingestedAt: { type: Date, required: true, default: () => new Date() },
  engagement: { type: Schema.Types.Mixed, default: null },
  pipelineStatus: { type: String, required: true, default: 'pending' },
  /** @deprecated Review state is per organization now: see `orgState`. Kept so old rows still load. */
  reviewStatus: { type: String, required: true, default: 'unreviewed' },
  /**
   * Who may see the post. `global`: every organization (within its state scope). `org`: only `organizationId`.
   * Explicit on purpose: a missing value is NOT "public".
   */
  visibility: { type: String, required: true, default: 'global' },
  /** Owner of an `org` post; null for global posts. */
  organizationId: { type: Schema.Types.ObjectId, default: null },
  /**
   * Each organization's own review of this post, keyed by organization id:
   * { "<orgId>": { reviewStatus, reviewedAt, reviewId } }. One organization reviewing never marks it for another.
   */
  orgState: { type: Schema.Types.Mixed, default: {} },
  latestClassificationId: { type: Schema.Types.ObjectId, default: null },
  latestDecisionId: { type: Schema.Types.ObjectId, default: null },
  /**
   * Denormalised from the latest Decision/Classification so queues can filter and sort without joins:
   * { queue, finalSeverity, priorityScore, urgent, isMisinformation, categories[], topCategory, language, stance }.
   * Always recomputable; never the source of truth.
   */
  triage: { type: Schema.Types.Mixed, default: null },
  errorDetail: { type: String, default: null },
  /**
   * True when the post itself is synthetic (it came from the mock feed). Not required: rows written before this
   * field existed fall back to `isMock`.
   */
  originMock: { type: Boolean, default: null },
  /**
   * Whether this post is mock data in the current picture: synthetic origin OR its latest classification was made by
   * a mock classifier. Recomputed at each classification, and every read is scoped to it.
   */
  isMock: { type: Boolean, required: true },
});

postSchema.index({ platform: 1, sourceId: 1 }, { unique: true });
postSchema.index({ isMock: 1, 'triage.queue': 1, 'triage.priorityScore': -1 });
postSchema.index({ isMock: 1, pipelineStatus: 1 });
postSchema.index({ isMock: 1, postedAt: -1 });
postSchema.index({ isMock: 1, state: 1 });

export type PostDoc = InferSchemaType<typeof postSchema> & { _id: import('mongoose').Types.ObjectId };
export const PostModel = model('Post', postSchema);

/** Shape of `Post.triage`. */
export interface Triage {
  queue: 'review' | 'information_gap' | 'none';
  finalSeverity: number | null;
  priorityScore: number;
  urgent: boolean;
  isMisinformation: boolean;
  /** Every category at or above its threshold. */
  categories: string[];
  topCategory: string | null;
  language: string | null;
  stance: string | null;
}
