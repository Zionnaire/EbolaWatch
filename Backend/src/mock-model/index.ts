import 'dotenv/config';
import { z } from 'zod';
import { createMockModelApp } from './app.js';

const env = z
  .object({
    MOCK_MODEL_PORT: z.coerce.number().int().positive().default(4100),
    MOCK_MODEL_CONTRACT: z.enum(['multilabel-v1', 'threeclass-v0']).default('multilabel-v1'),
    MOCK_MODEL_WARMUP_SECONDS: z.coerce.number().nonnegative().default(0),
    MOCK_MODEL_LATENCY_MS: z.coerce.number().nonnegative().default(0),
    MOCK_MODEL_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
    /** When set, /v1/* requires this X-ML-API-Key (like the real service). */
    MOCK_MODEL_API_KEY: z.string().optional(),
  })
  .parse(process.env);

const { app } = createMockModelApp({
  contract: env.MOCK_MODEL_CONTRACT,
  warmupSeconds: env.MOCK_MODEL_WARMUP_SECONDS,
  latencyMs: env.MOCK_MODEL_LATENCY_MS,
  failureRate: env.MOCK_MODEL_FAILURE_RATE,
  apiKey: env.MOCK_MODEL_API_KEY || undefined,
});

const server = app.listen(env.MOCK_MODEL_PORT, () => {
  console.log(`mock-model (${env.MOCK_MODEL_CONTRACT}) listening on :${env.MOCK_MODEL_PORT}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
