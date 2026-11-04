import { model, Schema, type Types } from 'mongoose';

/**
 * One row per (classification, rules + mode in force). Decisions are never rewritten: changing the mode
 * or rules and calling recompute appends new rows, so history stays auditable. `inputHash` makes recompute
 * idempotent.
 */
const decisionSchema = new Schema({
  postId: { type: Schema.Types.ObjectId, required: true, index: true },
  classificationId: { type: Schema.Types.ObjectId, required: true },
  mode: { type: String, required: true },
  inputHash: { type: String, required: true },
  isMisinformation: { type: Boolean, required: true },
  finalSeverity: { type: Number, default: null },
  reasons: { type: [String], default: [] },
  priorityScore: { type: Number, required: true, default: 0 },
  urgent: { type: Boolean, required: true, default: false },
  queue: { type: String, required: true },
  needsReview: { type: Boolean, required: true, default: false },
  /** thresholds, floors, keyword rules, bands and the mode actually used */
  rulesSnapshot: { type: Schema.Types.Mixed, required: true },
  isMock: { type: Boolean, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
});

decisionSchema.index({ classificationId: 1, inputHash: 1 }, { unique: true });
decisionSchema.index({ isMock: 1, createdAt: -1 });

export const DecisionModel = model('Decision', decisionSchema);
export type DecisionDoc = {
  _id: Types.ObjectId;
  postId: Types.ObjectId;
  classificationId: Types.ObjectId;
  mode: string;
  inputHash: string;
  isMisinformation: boolean;
  finalSeverity: number | null;
  reasons: string[];
  priorityScore: number;
  urgent: boolean;
  queue: string;
  needsReview: boolean;
  rulesSnapshot: Record<string, unknown>;
  isMock: boolean;
  createdAt: Date;
};
