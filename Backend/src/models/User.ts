import { model, Schema, type Types } from 'mongoose';

/**
 * Emails are unique across the whole platform (not per organization), so login needs no organization hint and
 * "the same email in two orgs" can never log into an arbitrary account. A super admin has no organization.
 */
const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, required: true },
  organizationId: { type: Schema.Types.ObjectId, default: null, index: true },
  isActive: { type: Boolean, required: true, default: true },
  /** Bumped on deactivation, role change and password change: older tokens stop working at once. */
  tokenVersion: { type: Number, required: true, default: 0 },
  lastLoginAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, required: true, default: () => new Date() },
});

export const UserModel = model('User', userSchema);

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  role: string;
  organizationId: Types.ObjectId | null;
  isActive: boolean;
  tokenVersion: number;
  lastLoginAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}
