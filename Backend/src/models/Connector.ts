import { model, Schema } from 'mongoose';

/** Status is data (live, not_integrated, error, paused, ...): the UI renders whatever is stored. */
const connectorSchema = new Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  platform: { type: String, required: true },
  status: { type: String, required: true },
  detail: { type: String, default: null },
  lastRunAt: { type: Date, default: null },
});

export const ConnectorModel = model('Connector', connectorSchema);
