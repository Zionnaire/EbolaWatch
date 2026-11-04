import { z } from 'zod';
import { PostDtoSchema } from './posts.js';
import { SystemStatusSchema } from './system.js';

export const ModelStatusEventSchema = z.object({
  modelStatus: SystemStatusSchema.shape.modelStatus,
  modelVersion: z.string().nullable(),
  taxonomyVersion: z.string().nullable(),
  retryAvailableAt: z.string().nullable(),
});

export const AlertEventSchema = z.object({
  id: z.string(),
  level: z.enum(['info', 'warning', 'critical']),
  code: z.string(),
  message: z.string(),
  at: z.string(),
});

export const SystemUpdateEventSchema = z.object({ reason: z.string(), status: SystemStatusSchema });

export const SocketEventSchemas = {
  'model:status': ModelStatusEventSchema,
  'post:classified': PostDtoSchema,
  'system:update': SystemUpdateEventSchema,
  alert: AlertEventSchema,
} as const;

export type SocketEventName = keyof typeof SocketEventSchemas;

export interface ServerToClientEvents {
  'model:status': (e: z.infer<typeof ModelStatusEventSchema>) => void;
  'post:classified': (e: z.infer<typeof PostDtoSchema>) => void;
  'system:update': (e: z.infer<typeof SystemUpdateEventSchema>) => void;
  alert: (e: z.infer<typeof AlertEventSchema>) => void;
}
export type ClientToServerEvents = Record<string, never>;
