import { model, Schema, type Types } from 'mongoose';

/**
 * A tenant. Status, type and settings are data. The claim link is stored only as a hash and is single use:
 * `claim` is cleared and `adminClaimed` set when the first org admin registers through it.
 */
const organizationSchema = new Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  region: { type: String, default: null },
  /** Empty = all states. */
  scopeStates: { type: [String], default: [] },
  status: { type: String, required: true, default: 'active' },
  settings: { type: Schema.Types.Mixed, default: {} },
  claim: { type: Schema.Types.Mixed, default: null }, // { tokenHash, expiresAt } | null
  adminClaimed: { type: Boolean, required: true, default: false },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, required: true, default: () => new Date() },
  updatedAt: { type: Date, required: true, default: () => new Date() },
});
organizationSchema.index({ 'claim.tokenHash': 1 }, { sparse: true });

export const OrganizationModel = model('Organization', organizationSchema);

export interface OrganizationDoc {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  type: string;
  region: string | null;
  scopeStates: string[];
  status: string;
  settings: { overdueHours?: number; queueCap?: number; vocabulary?: Record<string, string> } | null;
  claim: { tokenHash: string; expiresAt: Date } | null;
  adminClaimed: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
