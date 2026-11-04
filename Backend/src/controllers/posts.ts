import type { Scope } from '../auth/scope.js';
import type { Request, Response } from 'express';
import { PostListQuerySchema, ReviewRequestSchema } from '../contracts/api/index.js';
import { currentPrincipal } from '../auth/middleware.js';
import type { PostQueryService } from '../services/postQueries.js';
import type { ReviewService } from '../services/review.js';

export interface PostsControllerDeps {
  queries: PostQueryService;
  reviews: ReviewService;
  /** The current run's isMock: mock data never mixes with real data. */
  scope: (res: Response) => Scope;
}

export function postsController(d: PostsControllerDeps) {
  return {
    list: async (req: Request, res: Response) => {
      res.json(await d.queries.list(PostListQuerySchema.parse(req.query), d.scope(res)));
    },

    detail: async (req: Request, res: Response) => {
      res.json(await d.queries.detail(String(req.params.id), d.scope(res)));
    },

    /** Records the review, then returns the refreshed detail so the UI can update in one round trip. */
    review: async (req: Request, res: Response) => {
      const body = ReviewRequestSchema.parse(req.body);
      await d.reviews.review(String(req.params.id), currentPrincipal(res).userId, body, d.scope(res));
      res.status(201).json(await d.queries.detail(String(req.params.id), d.scope(res)));
    },
  };
}
