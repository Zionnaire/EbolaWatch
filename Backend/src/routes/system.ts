import { Router } from 'express';
import type { TaxonomyService } from '../classifier/taxonomy.js';
import type { SystemStatus } from '../contracts/api/index.js';
import { AppError } from '../utils/appError.js';

export interface SystemRouteDeps {
  getStatus: () => SystemStatus;
  taxonomy: Pick<TaxonomyService, 'get' | 'getVersion'>;
}

export function systemRouter(deps: SystemRouteDeps): Router {
  const r = Router();

  r.get('/system/status', (_req, res) => {
    res.json(deps.getStatus());
  });

  /** `?version=` returns the taxonomy a classification was made with; default is the current one. */
  r.get('/taxonomy', async (req, res) => {
    const version = typeof req.query.version === 'string' ? req.query.version : null;
    const taxonomy = version ? await deps.taxonomy.getVersion(version) : deps.taxonomy.get();
    if (!taxonomy) {
      throw version
        ? new AppError(404, `Unknown taxonomy version: ${version}`, 'taxonomy_not_found')
        : new AppError(503, 'Taxonomy not synced yet', 'taxonomy_unavailable');
    }
    res.json(taxonomy);
  });

  return r;
}
