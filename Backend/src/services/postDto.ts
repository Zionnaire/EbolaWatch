import {
  ClassificationSchema,
  type Classification,
  type DecisionDto,
  type PostDto,
  type ReviewDto,
  type Stance,
} from '../contracts/api/index.js';
import type { AnalystReviewDoc } from '../models/AnalystReview.js';
import type { DecisionDoc } from '../models/Decision.js';
import type { PostDoc } from '../models/Post.js';
import { reviewStatusOf } from '../auth/scope.js';
import { logger } from '../utils/logger.js';
import type { Types } from 'mongoose';

export function toClassification(normalized: unknown, context: string): Classification | null {
  const parsed = ClassificationSchema.safeParse(normalized);
  if (!parsed.success) {
    logger.error({ context, issues: parsed.error.issues }, 'stored classification failed validation');
    return null;
  }
  return parsed.data;
}

export function toDecisionDto(d: DecisionDoc): DecisionDto {
  return {
    isMisinformation: d.isMisinformation,
    finalSeverity: d.finalSeverity as DecisionDto['finalSeverity'],
    reasons: d.reasons,
    priorityScore: d.priorityScore,
    urgent: d.urgent,
    queue: d.queue as DecisionDto['queue'],
    needsReview: d.needsReview,
    rulesSnapshot: d.rulesSnapshot,
    createdAt: d.createdAt.toISOString(),
  };
}

export function isOverdue(
  post: Pick<PostDoc, 'ingestedAt'>,
  reviewStatus: string,
  decision: Pick<DecisionDto, 'queue'> | null,
  now: Date,
  overdueHours: number,
): boolean {
  if (reviewStatus !== 'unreviewed' || !decision || decision.queue === 'none') return false;
  return now.getTime() - post.ingestedAt.getTime() > overdueHours * 3_600_000;
}

export function toPostDto(
  post: PostDoc,
  classification: Classification | null,
  decision: DecisionDoc | null,
  opts: {
    now: Date;
    overdueHours: number;
    /** Whose review state to show. Omitted for the platform operator and for live events: `unreviewed`. */
    organizationId?: Types.ObjectId | string | null;
  },
): PostDto {
  const decisionDto = decision ? toDecisionDto(decision) : null;
  // review state is per organization: one organization reviewing a post never marks it for another
  const reviewStatus = reviewStatusOf(post, opts.organizationId) as PostDto['reviewStatus'];
  return {
    id: String(post._id),
    platform: post.platform,
    text: post.text,
    languageHint: post.languageHint ?? null,
    state: post.state ?? null,
    lga: post.lga ?? null,
    postedAt: post.postedAt.toISOString(),
    ingestedAt: post.ingestedAt.toISOString(),
    engagement: (post.engagement as PostDto['engagement']) ?? null,
    pipelineStatus: post.pipelineStatus as PostDto['pipelineStatus'],
    reviewStatus,
    overdue: isOverdue(post, reviewStatus, decisionDto, opts.now, opts.overdueHours),
    isMock: post.isMock,
    errorDetail: post.errorDetail ?? null,
    classification,
    decision: decisionDto,
  };
}

export function toReviewDto(r: AnalystReviewDoc): ReviewDto {
  return {
    id: String(r._id),
    postId: String(r.postId),
    classificationId: String(r.classificationId),
    reviewer: r.reviewer,
    decision: r.decision as ReviewDto['decision'],
    correction: r.correction
      ? {
          labels: r.correction.labels,
          ...(r.correction.stance ? { stance: r.correction.stance as Stance } : {}),
        }
      : null,
    taxonomyVersion: r.taxonomyVersion ?? null,
    note: r.note ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
