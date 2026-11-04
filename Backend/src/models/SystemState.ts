import { model, Schema } from 'mongoose';

/** Single document (key "singleton"): the operating mode lives in the DB, not in code. */
const systemStateSchema = new Schema({
  key: { type: String, required: true, unique: true },
  operatingMode: { type: String, required: true },
  updatedAt: { type: Date, required: true, default: () => new Date() },
  updatedBy: { type: String, default: null },
});

export const SystemStateModel = model('SystemState', systemStateSchema);
