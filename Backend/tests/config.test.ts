import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  FRONTEND_URL: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  INGEST_API_KEY: 'x'.repeat(16),
  AUTHOR_HASH_SECRET: 'y'.repeat(16),
  JWT_SECRET: 'z'.repeat(32),
};

describe('config', () => {
  it('applies defaults and coerces types', () => {
    const cfg = loadConfig(valid);
    expect(cfg.PORT).toBe(4000);
    expect(cfg.MODEL_MODE).toBe('mock');
    expect(cfg.QUEUE_CAP).toBe(500);
  });

  it('fails fast with a clear message listing the bad keys', () => {
    expect(() => loadConfig({})).toThrow(/FRONTEND_URL[\s\S]*INGEST_API_KEY/);
  });

  it('rejects an unknown model contract', () => {
    expect(() => loadConfig({ ...valid, MODEL_CONTRACT: 'v9' })).toThrow(/MODEL_CONTRACT/);
  });
});
