import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));

/** Loads a canonical synthetic fixture. The `_ASSUMED` marker is stripped so schemas see the bare payload. */
export function loadFixture<T = unknown>(name: string): T {
  const raw = JSON.parse(readFileSync(`${dir}${name}`, 'utf8')) as Record<string, unknown>;
  delete raw._ASSUMED;
  return raw as T;
}

export const FIXTURES = {
  categories: 'multilabel_categories.json',
  completed: 'multilabel_completed.json',
  partial: 'multilabel_partial.json',
  irrelevant: 'multilabel_irrelevant.json',
  request: 'multilabel_request.json',
  healthReady: 'health_ready.json',
  healthWarming: 'health_warming.json',
  healthDegraded: 'health_degraded.json',
  taxonomy: 'taxonomy.json',
  threeClass: 'threeclass.ASSUMED.json',
} as const;
