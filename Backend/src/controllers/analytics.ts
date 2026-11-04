import type { Scope } from '../auth/scope.js';
import type { Request, Response } from 'express';
import { DaysQuerySchema, GeoQuerySchema } from '../contracts/api/index.js';
import type { AnalyticsService } from '../services/analytics/analyticsService.js';
import { geoToCsv } from '../services/analytics/geoRollup.js';
import { dayKey } from '../services/analytics/time.js';

export interface AnalyticsControllerDeps {
  analytics: AnalyticsService;
  /** The current run's isMock: mock data never mixes with real data. */
  scope: (res: Response) => Scope;
}

const DEFAULT_BREAKDOWN_DAYS = 7;
const DEFAULT_MODEL_HEALTH_DAYS = 30;

export function analyticsController(d: AnalyticsControllerDeps) {
  return {
    summary: async (_req: Request, res: Response) => {
      res.json(await d.analytics.summary(d.scope(res)));
    },

    timeseries: async (_req: Request, res: Response) => {
      res.json(await d.analytics.timeseries(d.scope(res)));
    },

    breakdown: async (req: Request, res: Response) => {
      const { days } = DaysQuerySchema.parse(req.query);
      res.json(await d.analytics.breakdown(days ?? DEFAULT_BREAKDOWN_DAYS, d.scope(res)));
    },

    clusters: async (_req: Request, res: Response) => {
      res.json(await d.analytics.clusters(d.scope(res)));
    },

    /** JSON by default; `?format=csv` downloads the same data as a spreadsheet-safe CSV. */
    geo: async (req: Request, res: Response) => {
      const { format } = GeoQuerySchema.parse(req.query);
      const geo = await d.analytics.geo(d.scope(res));
      if (format === 'csv') {
        res
          .type('text/csv; charset=utf-8')
          .set(
            'Content-Disposition',
            `attachment; filename="geo-surge-${dayKey(new Date(geo.generatedAt))}.csv"`,
          )
          .send(geoToCsv(geo));
        return;
      }
      res.json(geo);
    },

    modelHealth: async (req: Request, res: Response) => {
      const { days } = DaysQuerySchema.parse(req.query);
      res.json(await d.analytics.modelHealth(days ?? DEFAULT_MODEL_HEALTH_DAYS, d.scope(res)));
    },
  };
}
