/**
 * EXTERNAL legacy contract `threeclass-v0`. SHAPE ASSUMED: no API doc exists. Reconfirm with the model developer.
 * Read only inside classifier/adapters and the mock model.
 */
import { z } from 'zod';

export const THREECLASS_LABELS = ['misinformation', 'factual', 'irrelevant'] as const;

type ObjectFactory = typeof z.object;

function build(o: ObjectFactory) {
  const p = z.number().min(0).max(1);

  const completedItem = o({
    item_id: z.string(),
    status: z.literal('completed'),
    label: z.enum(THREECLASS_LABELS),
    probabilities: o({ misinformation: p, factual: p, irrelevant: p }),
    entropy: z.number().nonnegative(),
    language: z.string().nullable(),
    latency_ms: z.number().nonnegative(),
  });

  const failedItem = o({
    item_id: z.string(),
    status: z.literal('failed'),
    error: o({ code: z.string(), message: z.string() }),
  });

  const response = o({
    request_id: z.string(),
    status: z.enum(['completed', 'partial', 'failed']),
    model: o({
      name: z.string(),
      version: z.string(),
      taxonomy_version: z.string().nullable(),
      base_model: z.string().nullable(),
      trained_at: z.string().nullable(),
    }),
    results: z.array(z.discriminatedUnion('status', [completedItem, failedItem])),
  }).refine(
    (r) => {
      const failed = r.results.filter((i) => i.status === 'failed').length;
      const ok = r.results.length - failed;
      if (r.status === 'completed') return failed === 0;
      if (r.status === 'partial') return failed >= 1 && ok >= 1;
      return ok === 0;
    },
    { message: 'batch status inconsistent with item statuses', path: ['status'] },
  );

  return { response };
}

export const ThreeClassResponseSchema = build(z.object).response;
export const ThreeClassResponseStrictSchema = build(z.strictObject as unknown as ObjectFactory).response;

export type ThreeClassResponse = z.infer<typeof ThreeClassResponseSchema>;
export type ThreeClassItem = ThreeClassResponse['results'][number];
