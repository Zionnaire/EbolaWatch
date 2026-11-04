import { model, Schema, type Types } from 'mongoose';
import { tenantGuard } from './tenantGuard.js';

/** A staff invitation. Single use, expires, stored only as a hash of the link token. */
const inviteSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  role: { type: String, required: true },
  invitedBy: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, required: true, default: () => new Date() },
});
tenantGuard(inviteSchema, 'Invite');

export const InviteModel = model('Invite', inviteSchema);

export interface InviteDoc {
  _id: Types.ObjectId;
  tokenHash: string;
  organizationId: Types.ObjectId;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}
