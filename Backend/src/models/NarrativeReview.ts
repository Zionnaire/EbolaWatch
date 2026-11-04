import { model, Schema, type Types } from 'mongoose';
import { enforceAppendOnly } from './appendOnly.js';
import { tenantGuard } from './tenantGuard.js';

/**
 * An analyst's approve / reject of a counter-narrative, bound to the exact text it was made on (`textHash`).
 * Append-only. Dispatch is only possible while the latest review is an approval of the current text.
 */
const narrativeReviewSchema = new Schema({
  /** Owner. Every query on this collection must carry it (see tenantGuard). */
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  narrativeId: { type: Schema.Types.ObjectId, required: true, index: true },
  reviewer: { type: String, required: true },
  decision: { type: String, required: true },
  textHash: { type: String, required: true },
  note: { type: String, default: null },
  isMock: { type: Boolean, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
});
enforceAppendOnly(narrativeReviewSchema, 'NarrativeReview');
tenantGuard(narrativeReviewSchema, 'NarrativeReview');

export const NarrativeReviewModel = model('NarrativeReview', narrativeReviewSchema);
export interface NarrativeReviewDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  narrativeId: Types.ObjectId;
  reviewer: string;
  decision: string;
  textHash: string;
  note: string | null;
  isMock: boolean;
  createdAt: Date;
}
