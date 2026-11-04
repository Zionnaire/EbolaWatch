import type { Request, Response } from 'express';
import type { IngestResponse } from '../contracts/api/index.js';
import type { IngestService } from '../pipeline/ingest.js';

export function ingestController(ingest: Pick<IngestService, 'ingestBody'>) {
  return {
    /** 202: accepted for asynchronous classification. Invalid posts are reported, not fatal to the batch. */
    ingest: async (req: Request, res: Response) => {
      const { accepted, duplicates, rejected } = await ingest.ingestBody(req.body);
      const body: IngestResponse = { accepted, duplicates, rejected };
      res.status(202).json(body);
    },
  };
}
