import { model, Schema } from 'mongoose';
import type { TaxonomyDto } from '../contracts/api/index.js';
import type { TaxonomyRepo } from '../classifier/taxonomy.js';

// Only the version is required; the payload is stored whole as Mixed so new fields never break old rows.
const taxonomySchema = new Schema(
  {
    taxonomyVersion: { type: String, required: true, unique: true },
    payload: { type: Schema.Types.Mixed, required: true },
    syncedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

export const TaxonomyModel = model('Taxonomy', taxonomySchema);

export class MongoTaxonomyRepo implements TaxonomyRepo {
  async save(t: TaxonomyDto): Promise<void> {
    await TaxonomyModel.updateOne(
      { taxonomyVersion: t.taxonomyVersion },
      { $set: { payload: t, syncedAt: new Date() } },
      { upsert: true },
    );
  }

  async loadLatest(): Promise<TaxonomyDto | null> {
    const doc = await TaxonomyModel.findOne().sort({ syncedAt: -1 }).lean();
    return (doc?.payload as TaxonomyDto | undefined) ?? null;
  }

  async loadVersion(version: string): Promise<TaxonomyDto | null> {
    const doc = await TaxonomyModel.findOne({ taxonomyVersion: version }).lean();
    return (doc?.payload as TaxonomyDto | undefined) ?? null;
  }
}
