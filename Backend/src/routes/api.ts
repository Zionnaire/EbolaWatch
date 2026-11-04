import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requirePermission } from '../auth/middleware.js';
import { adminController, type AdminControllerDeps } from '../controllers/admin.js';
import { analyticsController, type AnalyticsControllerDeps } from '../controllers/analytics.js';
import { ingestController } from '../controllers/ingest.js';
import { narrativesController, type NarrativesControllerDeps } from '../controllers/narratives.js';
import { postsController, type PostsControllerDeps } from '../controllers/posts.js';
import type { KnowledgeDto } from '../contracts/api/index.js';
import type { IngestService } from '../pipeline/ingest.js';
import { AppError } from '../utils/appError.js';

export interface ApiRouteDeps {
  posts: PostsControllerDeps;
  admin: AdminControllerDeps;
  narratives: NarrativesControllerDeps;
  analytics: AnalyticsControllerDeps;
  ingest: Pick<IngestService, 'ingestBody'>;
  /** The fact base behind the writer, or null when none is available. */
  knowledge: () => KnowledgeDto | null;
  /** Verifies the session and loads the current user and organization. Everything below needs it. */
  authenticate: RequestHandler;
  /** Protects POST /api/ingest (machine-to-machine: no session). */
  ingestKey: RequestHandler;
}

/**
 * Every route below requires a session, then a permission (see auth/permissions.ts): routes name what the caller
 * must be allowed to do, never a role. Tenant isolation is applied inside the services, from the session.
 */
export function apiRouter(d: ApiRouteDeps): Router {
  const r = Router();
  const posts = postsController(d.posts);
  const admin = adminController(d.admin);
  const ingest = ingestController(d.ingest);
  const narratives = narrativesController(d.narratives);
  const analytics = analyticsController(d.analytics);
  const auth = d.authenticate;
  const need = requirePermission;

  r.get('/posts', auth, need('posts:read'), posts.list);
  r.get('/posts/:id', auth, need('posts:read'), posts.detail);
  r.post('/posts/:id/review', auth, need('posts:review'), posts.review);

  r.get('/connectors', auth, need('platform:read'), admin.connectors);
  r.get('/rules', auth, need('platform:read'), admin.rules);
  // the operating mode changes decisions for every tenant
  r.post('/admin/mode', auth, need('platform:operate'), admin.setMode);
  r.post('/admin/recompute-decisions', auth, need('platform:operate'), admin.recompute);

  r.post('/ingest', d.ingestKey, ingest.ingest);

  // Counter-narratives and dispatch belong to the caller's organization.
  r.get('/knowledge', auth, need('platform:read'), (_req, res) => {
    const k = d.knowledge();
    if (!k) throw new AppError(404, 'No fact base is loaded', 'knowledge_unavailable');
    res.json(k);
  });
  r.get('/narratives/config', auth, need('narratives:read'), narratives.config); // before /:id
  r.get('/narratives', auth, need('narratives:read'), narratives.list);
  r.get('/narratives/:id', auth, need('narratives:read'), narratives.detail);
  r.post('/narratives/generate', auth, need('narratives:draft'), narratives.generate);
  r.patch('/narratives/:id', auth, need('narratives:draft'), narratives.edit);
  r.post('/narratives/:id/regenerate', auth, need('narratives:draft'), narratives.regenerate);
  r.post('/narratives/:id/approve', auth, need('narratives:approve'), narratives.approve);
  r.post('/narratives/:id/reject', auth, need('narratives:approve'), narratives.reject);
  r.post('/narratives/:id/dispatch', auth, need('narratives:dispatch'), narratives.dispatch);
  r.get('/dispatches', auth, need('narratives:read'), narratives.listDispatches);

  // Analytics are read-only, over the posts the caller's organization may see.
  r.get('/analytics/summary', auth, need('analytics:read'), analytics.summary);
  r.get('/analytics/timeseries', auth, need('analytics:read'), analytics.timeseries);
  r.get('/analytics/breakdown', auth, need('analytics:read'), analytics.breakdown);
  r.get('/analytics/clusters', auth, need('analytics:read'), analytics.clusters);
  r.get('/analytics/geo', auth, need('analytics:read'), analytics.geo);
  r.get('/analytics/model-health', auth, need('analytics:read'), analytics.modelHealth);
  return r;
}
