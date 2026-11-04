import { model, Schema, type Types } from 'mongoose';
import { tenantGuard } from './tenantGuard.js';

/** One row per dispatch attempt. A narrative can have many `failed` rows but only one `sent` row. */
const dispatchSchema = new Schema({
  /** Owner. Every query on this collection must carry it (see tenantGuard). */
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  narrativeId: { type: Schema.Types.ObjectId, required: true },
  postId: { type: Schema.Types.ObjectId, default: null },
  platform: { type: String, required: true },
  /** Exactly the approved text that was sent. */
  text: { type: String, required: true },
  textHash: { type: String, required: true },
  approvedBy: { type: String, required: true },
  approvalReviewId: { type: Schema.Types.ObjectId, required: true },
  dispatchedBy: { type: String, required: true },
  status: { type: String, required: true },
  externalId: { type: String, default: null },
  dispatcher: { type: Schema.Types.Mixed, required: true },
  error: { type: String, default: null },
  isMock: { type: Boolean, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
});
// Second line of defence against double dispatch: at most one `sent` row per narrative.
dispatchSchema.index({ narrativeId: 1 }, { name: 'narrativeId_lookup' });
dispatchSchema.index(
  { narrativeId: 1 },
  { name: 'one_sent_per_narrative', unique: true, partialFilterExpression: { status: 'sent' } },
);
dispatchSchema.index({ organizationId: 1, isMock: 1, createdAt: -1 });
tenantGuard(dispatchSchema, 'Dispatch');

export const DispatchModel = model('Dispatch', dispatchSchema);
export interface DispatchDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  narrativeId: Types.ObjectId;
  postId: Types.ObjectId | null;
  platform: string;
  text: string;
  textHash: string;
  approvedBy: string;
  approvalReviewId: Types.ObjectId;
  dispatchedBy: string;
  status: 'sent' | 'failed';
  externalId: string | null;
  dispatcher: { name: string; mode: 'mock' | 'live' };
  error: string | null;
  isMock: boolean;
  createdAt: Date;
}
