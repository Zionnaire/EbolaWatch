import { Types, type AnyBulkWriteOperation } from 'mongoose';
import {
  IngestRequestSchema,
  RawPostSchema,
  type IngestResponse,
  type RawPost,
} from '../contracts/api/index.js';
import { canonicalState } from '../data/nigeriaStates.js';
import { PostModel } from '../models/Post.js';
import { hashAuthor } from '../utils/hashing.js';
import { logger } from '../utils/logger.js';
import { scrubPii } from '../utils/pii.js';
import type { EnqueueResult } from './queue.js';

/** Scrubbed text is capped so one huge post cannot bloat the DB; the model truncates further itself. */
export const MAX_STORED_CHARS = 10_000;

export interface IngestDeps {
  authorHashSecret: string;
  /** Provisional `isMock` for a new post: synthetic origin, or a classifier already known to be mock. */
  isMock: () => boolean;
  /** Is the post synthetic by origin (mock ingestion)? Never changes afterwards. */
  originIsMock: () => boolean;
  enqueue: (id: string) => EnqueueResult;
}

export interface IngestResult extends IngestResponse {
  ids: string[];
}

/**
 * ingest -> scrub PII -> store -> enqueue. Raw text and raw handles never reach the DB or the model.
 * Duplicates (same platform + sourceId) are ignored, which makes re-delivery from connectors safe.
 */
export class IngestService {
  constructor(private readonly deps: IngestDeps) {}

  /** Validates a loose request body, accepting valid posts and reporting the rest. */
  async ingestBody(body: unknown): Promise<IngestResult> {
    const { posts } = IngestRequestSchema.parse(body);
    const valid: RawPost[] = [];
    const rejected: IngestResponse['rejected'] = [];
    // Keep the original index so rejections point at the caller's array position.
    posts.forEach((p, index) => {
      const parsed = RawPostSchema.safeParse(p);
      if (parsed.success) valid.push(parsed.data);
      else
        rejected.push({
          index,
          reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
    });
    const result = await this.ingest(valid);
    return { ...result, rejected };
  }

  async ingest(posts: RawPost[]): Promise<IngestResult> {
    if (posts.length === 0) return { accepted: 0, duplicates: 0, rejected: [], ids: [] };
    const isMock = this.deps.isMock();
    const originMock = this.deps.originIsMock();
    const now = new Date();

    // Two upserts of the same new key inside one unordered bulk write can race on the unique index,
    // so collapse repeats within the batch first. They still count as duplicates in the result.
    const unique = new Map<string, RawPost>();
    for (const p of posts) {
      const key = `${p.platform.toLowerCase()}\u0000${p.sourceId}`;
      if (!unique.has(key)) unique.set(key, p);
    }

    const ops: AnyBulkWriteOperation[] = [...unique.values()].map((p) => {
      const platform = p.platform.toLowerCase();
      return {
        updateOne: {
          filter: { platform, sourceId: p.sourceId },
          update: {
            $setOnInsert: {
              platform,
              sourceId: p.sourceId,
              authorHash: p.authorHandle
                ? hashAuthor(this.deps.authorHashSecret, platform, p.authorHandle)
                : null,
              text: scrubPii(p.text).slice(0, MAX_STORED_CHARS),
              languageHint: p.language ?? null,
              // coarse location only; unrecognised states are kept as given rather than guessed at
              state: canonicalState(p.state) ?? p.state ?? null,
              lga: p.lga ?? null,
              postedAt: new Date(p.postedAt),
              ingestedAt: now,
              engagement: p.engagement ?? null,
              pipelineStatus: 'pending',
              reviewStatus: 'unreviewed',
              latestClassificationId: null,
              latestDecisionId: null,
              triage: null,
              errorDetail: null,
              // posts from the platform's ingest are visible to every organization (within its state scope)
              visibility: 'global',
              organizationId: null,
              orgState: {},
              originMock,
              isMock,
            },
          },
          upsert: true,
        },
      };
    });

    const res = await PostModel.bulkWrite(ops, { ordered: false });
    const ids = Object.values(res.upsertedIds ?? {}).map((id) => String((id as Types.ObjectId) ?? id));
    for (const id of ids) {
      if (this.deps.enqueue(id) === 'full')
        logger.debug({ id }, 'queue full: post stays pending for the sweeper');
    }
    return { accepted: ids.length, duplicates: posts.length - ids.length, rejected: [], ids };
  }
}
