import { model, Schema, type Types } from 'mongoose';

/**
 * Append-only: one row per model call per post. `output` is the full validated model output as returned
 * (contract-specific, Mixed); `normalized` is the neutral Classification. The other fields are extracted
 * and indexed for querying only.
 */
const classificationSchema = new Schema({
  postId: { type: Schema.Types.ObjectId, required: true, index: true },
  contract: { type: String, required: true },
  modelName: { type: String, required: true },
  modelVersion: { type: String, required: true },
  taxonomyVersion: { type: String, default: null },
  textHash: { type: String, required: true },
  isMock: { type: Boolean, required: true },
  output: { type: Schema.Types.Mixed, default: null },
  normalized: { type: Schema.Types.Mixed, required: true },
  isRelevant: { type: Boolean, default: null },
  stance: { type: String, default: null },
  topCategory: { type: String, default: null },
  severityLevel: { type: Number, default: null },
  language: { type: String, default: null },
  createdAt: { type: Date, required: true, default: () => new Date() },
});

// A retry of the same (post, modelVersion, taxonomyVersion, textHash) is a no-op.
classificationSchema.index({ postId: 1, modelVersion: 1, taxonomyVersion: 1, textHash: 1 }, { unique: true });
classificationSchema.index({ isMock: 1, createdAt: -1 });
classificationSchema.index({ isMock: 1, modelVersion: 1 });

export const ClassificationModel = model('Classification', classificationSchema);
export type ClassificationDoc = {
  _id: Types.ObjectId;
  postId: Types.ObjectId;
  contract: string;
  modelName: string;
  modelVersion: string;
  taxonomyVersion: string | null;
  textHash: string;
  isMock: boolean;
  /** Extracted from `normalized` for querying. */
  language?: string | null;
  output: unknown;
  normalized: unknown;
  createdAt: Date;
};
