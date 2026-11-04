import { model, Schema, type Types } from 'mongoose';
import { enforceAppendOnly } from './appendOnly.js';
import { tenantGuard } from './tenantGuard.js';

/**
 * Append-only and exportable for retraining. A correction is stored in the model's own label space
 * together with the taxonomy version it refers to.
 */
const reviewSchema = new Schema({
  /** Owner. Every query on this collection must carry it (see tenantGuard). */
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  postId: { type: Schema.Types.ObjectId, required: true, index: true },
  classificationId: { type: Schema.Types.ObjectId, required: true, index: true },
  reviewer: { type: String, required: true },
  decision: { type: String, required: true },
  correction: { type: Schema.Types.Mixed, default: null },
  taxonomyVersion: { type: String, default: null },
  note: { type: String, default: null },
  isMock: { type: Boolean, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
});
reviewSchema.index({ isMock: 1, createdAt: -1 });

enforceAppendOnly(reviewSchema, 'AnalystReview');
tenantGuard(reviewSchema, 'AnalystReview');

export const AnalystReviewModel = model('AnalystReview', reviewSchema);
export type AnalystReviewDoc = {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  postId: Types.ObjectId;
  classificationId: Types.ObjectId;
  reviewer: string;
  decision: string;
  correction: { labels: string[]; stance?: string } | null;
  taxonomyVersion: string | null;
  note: string | null;
  isMock: boolean;
  createdAt: Date;
};
