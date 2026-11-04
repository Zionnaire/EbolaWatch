import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.url(),
  COOKIE_SECURE: bool.default(false),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().min(1).default('ebolawatch'),
  INGEST_API_KEY: z.string().min(16),
  AUTHOR_HASH_SECRET: z.string().min(16),
  /** Signs session tokens (HS256). At least 32 characters; generate with `openssl rand -base64 48`. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /** Sign-in, claim and invite attempts per minute per client address. */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  MODEL_MODE: z.enum(['mock', 'live']).default('mock'),
  MODEL_CONTRACT: z.enum(['multilabel-v1', 'threeclass-v0']).default('multilabel-v1'),
  MODEL_BASE_URL: z.url().default('http://localhost:4100'),
  /** Sent as the X-ML-API-Key header to the model service. Empty means none (the mock model needs none). */
  MODEL_API_KEY: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  /** Texts longer than this are cut before they are sent (the model service documents 2,000; it may change). */
  MODEL_MAX_TEXT_CHARS: z.coerce.number().int().min(50).default(2000),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MODEL_MOCK_MARKER: z.string().min(1).default('mock'),
  MODEL_WARMUP_MAX_WAIT_MS: z.coerce.number().int().positive().default(120_000),
  /** Who writes counter-narrative drafts: the canned mock, or Groq grounded in the fact base. */
  GENERATOR_MODE: z.enum(['mock', 'groq']).default('mock'),
  GROQ_API_KEY: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  /** Pin the model explicitly and verify it exists in your Groq console; Groq retires models. */
  GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-120b'),
  GROQ_BASE_URL: z.url().default('https://api.groq.com/openai/v1'),
  GROQ_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** `ai` lets Groq merge the same claim across languages and name the narratives on the dashboard (needs GROQ_API_KEY). */
  CLUSTER_REFINER: z.enum(['none', 'ai']).default('none'),
  /** The curated, source-attributed facts the writer may use (relative to where the backend runs). */
  KNOWLEDGE_FILE: z.string().min(1).default('knowledge/ebola-facts.v1.json'),
  /** When true the writer refuses until the fact base file says "status": "approved". */
  KNOWLEDGE_REQUIRE_REVIEW: bool.default(false),
  INGESTION_MODE: z.enum(['mock', 'push']).default('mock'),
  QUEUE_CAP: z.coerce.number().int().positive().default(500),
  OVERDUE_HOURS: z.coerce.number().positive().default(48),
  MOCK_MODEL_PORT: z.coerce.number().int().positive().default(4100),
});

export type Config = z.infer<typeof envSchema>;

/** Validates env and fails fast with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const cfg = parsed.data;
  if (cfg.FRONTEND_URL === '*') throw new Error('FRONTEND_URL must never be "*"');
  // Browsers drop SameSite=None cookies that are not Secure, which would silently break sign-in.
  if (cfg.COOKIE_SAME_SITE === 'none' && !cfg.COOKIE_SECURE) {
    throw new Error(
      'Invalid environment configuration:\n  - COOKIE_SAME_SITE=none requires COOKIE_SECURE=true',
    );
  }
  if (cfg.CLUSTER_REFINER === 'ai' && !cfg.GROQ_API_KEY) {
    throw new Error('Invalid environment configuration:\n  - CLUSTER_REFINER=ai requires GROQ_API_KEY');
  }
  if (cfg.GENERATOR_MODE === 'groq' && !cfg.GROQ_API_KEY) {
    throw new Error('Invalid environment configuration:\n  - GENERATOR_MODE=groq requires GROQ_API_KEY');
  }
  if (cfg.NODE_ENV === 'production' && !cfg.COOKIE_SECURE) {
    throw new Error('Invalid environment configuration:\n  - COOKIE_SECURE must be true in production');
  }
  return cfg;
}
