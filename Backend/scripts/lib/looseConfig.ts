import 'dotenv/config';
import { envSchema } from '../../src/config.js';

/**
 * Reads only what a helper script needs from the environment, so it does not demand the full application config
 * (JWT secret, ingest key and so on) just to try one thing.
 */
export function loadConfigLoose() {
  const partial = envSchema.pick({
    GROQ_API_KEY: true,
    GROQ_MODEL: true,
    GROQ_BASE_URL: true,
    GROQ_TIMEOUT_MS: true,
    KNOWLEDGE_FILE: true,
  });
  return partial.parse(process.env);
}
