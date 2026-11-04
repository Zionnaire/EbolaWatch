import { z } from 'zod';
import { ContractSchema } from './classification.js';

export const ModelStatusSchema = z.enum(['ready', 'warming', 'degraded', 'error', 'unknown']);
export type ModelStatus = z.infer<typeof ModelStatusSchema>;

export const OperatingModeSchema = z.enum(['dormant', 'surge']);
export type OperatingMode = z.infer<typeof OperatingModeSchema>;

export const DataSourceSchema = z.object({
  ingestion: z.enum(['mock', 'push']),
  classifier: z.enum(['mock-inprocess', 'mock-server', 'live']),
  generator: z.enum(['mock', 'live']),
  dispatcher: z.enum(['mock', 'live']),
});
export type DataSource = z.infer<typeof DataSourceSchema>;

export const SystemStatusSchema = z.object({
  modelMode: z.enum(['mock', 'live']),
  modelContract: ContractSchema,
  dataSource: DataSourceSchema,
  modelStatus: ModelStatusSchema,
  modelVersion: z.string().nullable(),
  taxonomyVersion: z.string().nullable(),
  operatingMode: OperatingModeSchema,
  /** Absolute ISO timestamp; the UI computes the countdown from it. */
  retryAvailableAt: z.string().nullable(),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const TaxonomyDtoSchema = z.object({
  taxonomyVersion: z.string(),
  categories: z.array(z.object({ id: z.string(), displayName: z.string(), description: z.string() })),
  stances: z.array(z.object({ id: z.string(), displayName: z.string() })),
  languages: z.array(z.object({ id: z.string(), displayName: z.string() })),
  severityLevels: z.array(z.number()),
});
export type TaxonomyDto = z.infer<typeof TaxonomyDtoSchema>;

/** Whether any pipeline stage is not live (drives the MOCK DATA badge). */
export function mockStages(ds: DataSource): string[] {
  const out: string[] = [];
  if (ds.ingestion === 'mock') out.push('ingestion');
  if (ds.classifier !== 'live') out.push('classifier');
  if (ds.generator !== 'live') out.push('generator');
  if (ds.dispatcher !== 'live') out.push('dispatcher');
  return out;
}
