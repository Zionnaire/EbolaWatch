import { model, Schema } from 'mongoose';
import { RulesConfigSchema, type RulesConfig } from '../contracts/api/index.js';
import type { RulesRepo } from '../services/rules.js';

const rulesSchema = new Schema({
  taxonomyVersion: { type: String, required: true, unique: true },
  payload: { type: Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, required: true, default: () => new Date() },
});

export const RulesConfigModel = model('RulesConfig', rulesSchema);

export class MongoRulesRepo implements RulesRepo {
  async get(key: string): Promise<RulesConfig | null> {
    const doc = await RulesConfigModel.findOne({ taxonomyVersion: key }).lean();
    if (!doc) return null;
    // Stored settings are data and may be edited by hand: validate, and fail loudly rather than reseed over them.
    return RulesConfigSchema.parse(doc.payload);
  }

  async save(rules: RulesConfig): Promise<void> {
    await RulesConfigModel.updateOne(
      { taxonomyVersion: rules.taxonomyVersion },
      { $set: { payload: rules, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  async list(): Promise<RulesConfig[]> {
    const docs = await RulesConfigModel.find().sort({ taxonomyVersion: 1 }).lean();
    return docs.map((d) => RulesConfigSchema.parse(d.payload));
  }
}
