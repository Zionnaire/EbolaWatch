import { model, Schema, type Types } from 'mongoose';
import { tenantGuard } from './tenantGuard.js';

/**
 * A counter-narrative draft. `text` is the current draft; every change is also kept in `versions`.
 * Status is data. `textHash` identifies the exact text, so an approval can be tied to it.
 */
const narrativeSchema = new Schema({
  /** Owner. Every query on this collection must carry it (see tenantGuard). */
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  postId: { type: Schema.Types.ObjectId, default: null, index: true },
  source: { type: String, required: true },
  platform: { type: String, required: true },
  charLimit: { type: Number, required: true },
  requestedLanguage: { type: String, required: true },
  language: { type: String, required: true },
  category: { type: String, default: null },
  taxonomyVersion: { type: String, default: null },
  /** PII-scrubbed claim the draft answers. */
  claim: { type: String, default: null },
  text: { type: String, required: true },
  textHash: { type: String, required: true },
  status: { type: String, required: true, default: 'draft' },
  citations: { type: Schema.Types.Mixed, default: [] },
  warnings: { type: [String], default: [] },
  versions: { type: Schema.Types.Mixed, default: [] },
  generator: { type: Schema.Types.Mixed, required: true },
  isMock: { type: Boolean, required: true },
  createdBy: { type: String, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
  updatedAt: { type: Date, required: true, default: () => new Date() },
});
narrativeSchema.index({ organizationId: 1, isMock: 1, status: 1, createdAt: -1 });
tenantGuard(narrativeSchema, 'CounterNarrative');

export const CounterNarrativeModel = model('CounterNarrative', narrativeSchema);

export interface NarrativeVersionDoc {
  text: string;
  kind: 'generated' | 'edited' | 'regenerated';
  by: string;
  at: string;
}

export interface CounterNarrativeDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  postId: Types.ObjectId | null;
  source: string;
  platform: string;
  charLimit: number;
  requestedLanguage: string;
  language: string;
  category: string | null;
  taxonomyVersion: string | null;
  claim: string | null;
  text: string;
  textHash: string;
  status: string;
  citations: Array<{ source: string; title: string; url: string }>;
  warnings: string[];
  versions: NarrativeVersionDoc[];
  generator: { name: string; version: string; mode: 'mock' | 'live' };
  isMock: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
