import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Logic-only tests (node environment): the contract copy, formatters, config tables and the API client.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'tests/**/*.test.ts'] },
});
