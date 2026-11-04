import type { Scope } from '../auth/scope.js';
import type { Request, Response } from 'express';
import { SetModeRequestSchema, type SystemStatus } from '../contracts/api/index.js';
import { currentPrincipal } from '../auth/middleware.js';
import type { ConnectorService } from '../pipeline/connectors/registry.js';
import type { PipelineService } from '../pipeline/pipeline.js';
import type { RulesService } from '../services/rules.js';
import type { SystemStateService } from '../services/systemState.js';
import type { Broadcaster } from '../sockets/index.js';
import { logger } from '../utils/logger.js';

export interface AdminControllerDeps {
  state: SystemStateService;
  pipeline: Pick<PipelineService, 'recomputeDecisions'>;
  rules: Pick<RulesService, 'list'>;
  connectors: Pick<ConnectorService, 'list'>;
  getStatus: () => SystemStatus;
  scope: (res: Response) => Scope;
  broadcaster: Pick<Broadcaster, 'emit'>;
}

export function adminController(d: AdminControllerDeps) {
  return {
    rules: async (_req: Request, res: Response) => {
      res.json(await d.rules.list());
    },

    connectors: async (_req: Request, res: Response) => {
      res.json(await d.connectors.list());
    },

    /**
     * Changes the operating mode. It affects decisions made from now on; it never silently rewrites old
     * ones (use recompute-decisions for that, explicitly).
     */
    setMode: async (req: Request, res: Response) => {
      const { mode } = SetModeRequestSchema.parse(req.body);
      const previous = d.state.mode();
      await d.state.setMode(mode, currentPrincipal(res).userId);
      logger.info({ previous, mode, by: currentPrincipal(res).userId }, 'operating mode changed');
      d.broadcaster.emit('system:update', { reason: 'operating_mode_changed', status: d.getStatus() });
      res.json({ mode, previous });
    },

    recompute: async (_req: Request, res: Response) => {
      const result = await d.pipeline.recomputeDecisions(d.scope(res).isMock);
      logger.info({ ...result, by: currentPrincipal(res).userId }, 'decisions recomputed on request');
      d.broadcaster.emit('system:update', { reason: 'decisions_recomputed', status: d.getStatus() });
      res.json(result);
    },
  };
}
