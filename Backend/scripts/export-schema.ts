/** Exports JSON Schema for the external model contracts, for diffing against the model developer's Pydantic schema. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ClassifyRequestSchema,
  ClassifyResponseSchema,
  HealthSchema,
  TaxonomySchema,
} from '../src/contracts/model/multilabelV1.js';
import { ThreeClassResponseSchema } from '../src/contracts/model/threeClassV0.js';

const outDir = new URL('../schema/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const targets = {
  'multilabel-v1.classify-request': ClassifyRequestSchema,
  'multilabel-v1.classify-response': ClassifyResponseSchema,
  'multilabel-v1.health': HealthSchema,
  'multilabel-v1.taxonomy': TaxonomySchema,
  'threeclass-v0.classify-response.ASSUMED': ThreeClassResponseSchema,
};

for (const [name, schema] of Object.entries(targets)) {
  const json = z.toJSONSchema(schema, { io: 'output' });
  writeFileSync(new URL(`${name}.schema.json`, outDir), JSON.stringify(json, null, 2) + '\n');
  console.log(`wrote schema/${name}.schema.json`);
}
