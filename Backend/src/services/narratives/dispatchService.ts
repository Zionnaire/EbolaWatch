import { requireOrg, resolveScope, type ScopeLike } from '../../auth/scope.js';
import type { DispatchDto } from '../../contracts/api/index.js';
import { CounterNarrativeModel, type CounterNarrativeDoc } from '../../models/CounterNarrative.js';
import { DispatchModel, type DispatchDoc } from '../../models/Dispatch.js';
import { NarrativeReviewModel, type NarrativeReviewDoc } from '../../models/NarrativeReview.js';
import { PostModel, type PostDoc } from '../../models/Post.js';
import { AppError } from '../../utils/appError.js';
import { textHash } from '../../utils/hashing.js';
import { logger } from '../../utils/logger.js';
import { parseObjectId } from '../review.js';
import { toDispatchDto } from './dto.js';

/** Proof that an analyst approved this exact text. Built only by DispatchService from a verified review. */
export interface ApprovalProof {
  reviewId: string;
  reviewer: string;
  /** Hash of the approved text; the dispatcher checks it against the text it is asked to send. */
  textHash: string;
}

export interface DispatchRequest {
  narrativeId: string;
  platform: string;
  text: string;
  /** The post being answered, when there is one. */
  replyToPostId: string | null;
  approval: ApprovalProof;
}

export interface DispatchResult {
  externalId: string;
}

/**
 * Seam for publishing to a platform.
 * TODO(ext): real platform posting (X, Bluesky, Instagram, YouTube). It must keep requiring an ApprovalProof.
 */
export interface Dispatcher {
  /** Provenance, reported to the client in /api/system/status. */
  readonly mode: 'mock' | 'live';
  readonly name: string;
  send(req: DispatchRequest): Promise<DispatchResult>;
}

/** A dispatch was refused. 409: the request is understood but the state of the narrative does not allow it. */
export class DispatchRefusedError extends AppError {
  constructor(message: string, code: string) {
    super(409, message, code);
    this.name = 'DispatchRefusedError';
  }
}

/** Records what it was asked to send; posts nowhere. Defends itself: it refuses a request without valid approval. */
export class MockDispatcher implements Dispatcher {
  readonly mode = 'mock' as const;
  readonly name = 'mock-dispatcher';
  readonly sent: DispatchRequest[] = [];
  /** Test hook: make the next send fail. */
  failNext: Error | null = null;

  send(req: DispatchRequest): Promise<DispatchResult> {
    const a = req.approval as ApprovalProof | undefined;
    if (!a?.reviewId || !a.reviewer || !a.textHash || a.textHash !== textHash(req.text)) {
      return Promise.reject(
        new DispatchRefusedError(
          'The dispatcher refuses to send text without a matching approval',
          'approval_missing',
        ),
      );
    }
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      return Promise.reject(err);
    }
    this.sent.push(req);
    return Promise.resolve({ externalId: `mock-${this.sent.length}-${req.narrativeId.slice(-6)}` });
  }
}

export interface DispatchServiceDeps {
  dispatcher: Dispatcher;
  now?: () => Date;
}

/**
 * NO AUTONOMOUS DISPATCH. Nothing is sent unless an analyst approved a review for this exact text.
 * Checked here, in this order, against the database (never against the client's claim):
 *   1. the narrative is `approved`;
 *   2. its latest review is an approval, made on the current text hash;
 *   3. the stored text still hashes to that value;
 *   4. the narrative can be atomically claimed (so two requests cannot both send).
 * The dispatcher then verifies the approval proof again before sending.
 */
export class DispatchService {
  constructor(private readonly deps: DispatchServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  async dispatch(narrativeId: string, userId: string, scopeLike: ScopeLike): Promise<DispatchDto> {
    const scope = resolveScope(scopeLike);
    // only the owning organization can dispatch (or even find) its counter-narrative
    const organizationId = requireOrg(scope);
    const doc = (await CounterNarrativeModel.findOne({
      _id: parseObjectId(narrativeId),
      organizationId,
      isMock: scope.isMock,
    }).lean()) as unknown as CounterNarrativeDoc | null;
    if (!doc) throw new AppError(404, 'Counter-narrative not found', 'narrative_not_found');

    if (doc.status === 'dispatched') {
      throw new DispatchRefusedError(
        'This counter-narrative has already been dispatched',
        'already_dispatched',
      );
    }
    if (doc.status === 'dispatching') {
      throw new DispatchRefusedError(
        'This counter-narrative is already being dispatched',
        'dispatch_in_progress',
      );
    }
    if (doc.status !== 'approved') {
      throw new DispatchRefusedError(
        `Nothing is dispatched without analyst approval. This counter-narrative is "${doc.status}"; approve it first.`,
        'not_approved',
      );
    }

    // Trust the review record, not the status flag: a status can be wrong, a review row is append-only evidence.
    const review = (await NarrativeReviewModel.findOne({ organizationId, narrativeId: doc._id })
      .sort({ createdAt: -1, _id: -1 })
      .lean()) as unknown as NarrativeReviewDoc | null;
    if (!review || review.decision !== 'approved') {
      throw new DispatchRefusedError(
        'No analyst approval is recorded for this counter-narrative',
        'approval_missing',
      );
    }
    if (review.textHash !== doc.textHash || textHash(doc.text) !== doc.textHash) {
      throw new DispatchRefusedError(
        'The text has changed since it was approved. Approve the current text first.',
        'approval_stale',
      );
    }
    if (doc.text.length > doc.charLimit) {
      throw new DispatchRefusedError(
        `The text exceeds the ${doc.platform} limit of ${doc.charLimit} characters`,
        'text_too_long',
      );
    }

    // Atomic claim: exactly one caller moves approved -> dispatching; edits are locked out from here on.
    const claimed = (await CounterNarrativeModel.findOneAndUpdate(
      { _id: doc._id, organizationId, status: 'approved', textHash: review.textHash },
      { $set: { status: 'dispatching', updatedAt: this.now() } },
      { returnDocument: 'after' },
    ).lean()) as unknown as CounterNarrativeDoc | null;
    if (!claimed) {
      throw new DispatchRefusedError(
        'This counter-narrative changed or is being dispatched by someone else',
        'conflict',
      );
    }

    const base = {
      organizationId,
      narrativeId: claimed._id,
      postId: claimed.postId ?? null,
      platform: claimed.platform,
      text: claimed.text,
      textHash: claimed.textHash,
      approvedBy: review.reviewer,
      approvalReviewId: review._id,
      dispatchedBy: userId,
      dispatcher: { name: this.deps.dispatcher.name, mode: this.deps.dispatcher.mode },
      isMock: claimed.isMock,
    };

    let externalId: string;
    try {
      ({ externalId } = await this.deps.dispatcher.send({
        narrativeId: String(claimed._id),
        platform: claimed.platform,
        text: claimed.text,
        replyToPostId: claimed.postId ? String(claimed.postId) : null,
        approval: { reviewId: String(review._id), reviewer: review.reviewer, textHash: review.textHash },
      }));
    } catch (err) {
      // Nothing was sent. Record the failure and release the claim so an analyst can try again.
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, narrativeId: String(claimed._id) }, 'dispatch failed');
      await DispatchModel.create({ ...base, status: 'failed', externalId: null, error: message });
      await CounterNarrativeModel.updateOne(
        { _id: claimed._id, organizationId, status: 'dispatching' },
        { $set: { status: 'approved', updatedAt: this.now() } },
      );
      if (err instanceof DispatchRefusedError) throw err;
      throw new AppError(502, `Dispatch failed: ${message}`, 'dispatch_failed');
    }

    // The message is out. If recording it fails we must NOT release the claim (that could send it twice).
    try {
      const row = (
        await DispatchModel.create({ ...base, status: 'sent', externalId, error: null })
      ).toObject() as unknown as DispatchDoc;
      await CounterNarrativeModel.updateOne(
        { _id: claimed._id, organizationId },
        { $set: { status: 'dispatched', updatedAt: this.now() } },
      );
      const post = claimed.postId
        ? ((await PostModel.findById(claimed.postId).lean()) as unknown as PostDoc | null)
        : null;
      return toDispatchDto(row, post);
    } catch (err) {
      logger.fatal(
        { err, narrativeId: String(claimed._id), externalId },
        'MESSAGE WAS SENT but recording it failed; narrative left in "dispatching" to prevent a second send',
      );
      throw new AppError(
        500,
        'The message was sent but could not be recorded. Do not retry; contact an administrator.',
        'dispatch_record_failed',
      );
    }
  }

  async list(page: number, pageSize: number, scopeLike: ScopeLike) {
    const scope = resolveScope(scopeLike);
    const filter = { organizationId: requireOrg(scope), isMock: scope.isMock, status: 'sent' };
    const [total, rows] = await Promise.all([
      DispatchModel.countDocuments(filter),
      DispatchModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean() as unknown as Promise<DispatchDoc[]>,
    ]);
    const postIds = rows.map((r) => r.postId).filter(Boolean);
    const posts = postIds.length
      ? ((await PostModel.find({ _id: { $in: postIds } }).lean()) as unknown as PostDoc[])
      : [];
    const byId = new Map(posts.map((p) => [String(p._id), p]));
    const items = rows.map((r) => toDispatchDto(r, r.postId ? (byId.get(String(r.postId)) ?? null) : null));
    return { items, page, pageSize, total };
  }
}
