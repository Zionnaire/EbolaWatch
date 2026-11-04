import type { Scope } from '../auth/scope.js';
import type { Request, Response } from 'express';
import {
  DispatchListQuerySchema,
  EditNarrativeRequestSchema,
  GenerateNarrativeRequestSchema,
  LanguageSchema,
  NarrativeListQuerySchema,
  NarrativeReviewRequestSchema,
  RegenerateNarrativeRequestSchema,
  type NarrativeConfigDto,
} from '../contracts/api/index.js';
import { currentPrincipal } from '../auth/middleware.js';
import type { CounterNarrativeGenerator } from '../services/narratives/generator.js';
import type { DispatchService, Dispatcher } from '../services/narratives/dispatchService.js';
import type { NarrativeService } from '../services/narratives/narrativeService.js';
import type { PlatformLimits } from '../services/narratives/platforms.js';
import { logger } from '../utils/logger.js';

export interface NarrativesControllerDeps {
  narratives: NarrativeService;
  dispatch: DispatchService;
  platforms: PlatformLimits;
  generator: Pick<CounterNarrativeGenerator, 'name' | 'mode'>;
  dispatcher: Pick<Dispatcher, 'name' | 'mode'>;
  /** The current run's isMock: mock data never mixes with real data. */
  scope: (res: Response) => Scope;
}

export function narrativesController(d: NarrativesControllerDeps) {
  const id = (req: Request) => String(req.params.id);

  return {
    config: (_req: Request, res: Response) => {
      const body: NarrativeConfigDto = {
        platforms: d.platforms.list(),
        languages: [...LanguageSchema.options],
        generator: { name: d.generator.name, mode: d.generator.mode },
        dispatcher: { name: d.dispatcher.name, mode: d.dispatcher.mode },
      };
      res.json(body);
    },

    list: async (req: Request, res: Response) => {
      res.json(await d.narratives.list(NarrativeListQuerySchema.parse(req.query), d.scope(res)));
    },

    detail: async (req: Request, res: Response) => {
      res.json(await d.narratives.detail(id(req), d.scope(res)));
    },

    /** Drafting only. Generating never sends anything. */
    generate: async (req: Request, res: Response) => {
      const body = GenerateNarrativeRequestSchema.parse(req.body);
      res.status(201).json(await d.narratives.generate(body, currentPrincipal(res).userId, d.scope(res)));
    },

    edit: async (req: Request, res: Response) => {
      const { text } = EditNarrativeRequestSchema.parse(req.body);
      res.json(await d.narratives.edit(id(req), text, currentPrincipal(res).userId, d.scope(res)));
    },

    /** "Reject and regenerate" and "override label" are both a regeneration (the latter with a new category). */
    regenerate: async (req: Request, res: Response) => {
      const body = RegenerateNarrativeRequestSchema.parse(req.body ?? {});
      logger.info(
        { narrativeId: id(req), by: currentPrincipal(res).userId, category: body.category },
        'narrative regenerated',
      );
      res.json(await d.narratives.regenerate(id(req), body, d.scope(res)));
    },

    approve: async (req: Request, res: Response) => {
      const { note } = NarrativeReviewRequestSchema.parse(req.body ?? {});
      res.json(await d.narratives.approve(id(req), currentPrincipal(res).userId, note, d.scope(res)));
    },

    reject: async (req: Request, res: Response) => {
      const { note } = NarrativeReviewRequestSchema.parse(req.body ?? {});
      res.json(await d.narratives.reject(id(req), currentPrincipal(res).userId, note, d.scope(res)));
    },

    /** The only route that can send. It refuses unless an analyst approval is on record (see DispatchService). */
    dispatch: async (req: Request, res: Response) => {
      const dispatch = await d.dispatch.dispatch(id(req), currentPrincipal(res).userId, d.scope(res));
      logger.info(
        { narrativeId: id(req), by: currentPrincipal(res).userId, mode: dispatch.dispatcher.mode },
        'narrative dispatched',
      );
      res.status(201).json(dispatch);
    },

    listDispatches: async (req: Request, res: Response) => {
      const q = DispatchListQuerySchema.parse(req.query);
      res.json(await d.dispatch.list(q.page, q.pageSize, d.scope(res)));
    },
  };
}
