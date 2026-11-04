import type {
  DispatchDto,
  NarrativeDto,
  NarrativeReviewDto,
  NarrativeStatus,
} from '../../contracts/api/index.js';
import type { CounterNarrativeDoc } from '../../models/CounterNarrative.js';
import type { DispatchDoc } from '../../models/Dispatch.js';
import type { NarrativeReviewDoc } from '../../models/NarrativeReview.js';
import type { PostDoc } from '../../models/Post.js';

/** Reviews are given newest first. The approval counts only if it is the latest review and is of the current text. */
export function currentApproval(
  doc: Pick<CounterNarrativeDoc, 'textHash'>,
  reviewsNewestFirst: NarrativeReviewDoc[],
): NarrativeReviewDoc | null {
  const latest = reviewsNewestFirst[0];
  return latest && latest.decision === 'approved' && latest.textHash === doc.textHash ? latest : null;
}

export function toNarrativeDto(
  doc: CounterNarrativeDoc,
  reviewsNewestFirst: NarrativeReviewDoc[],
): NarrativeDto {
  const approval = currentApproval(doc, reviewsNewestFirst);
  return {
    id: String(doc._id),
    postId: doc.postId ? String(doc.postId) : null,
    source: doc.source as NarrativeDto['source'],
    platform: doc.platform,
    charLimit: doc.charLimit,
    requestedLanguage: doc.requestedLanguage,
    language: doc.language,
    category: doc.category ?? null,
    taxonomyVersion: doc.taxonomyVersion ?? null,
    claim: doc.claim ?? null,
    text: doc.text,
    status: doc.status as NarrativeStatus,
    citations: doc.citations ?? [],
    warnings: doc.warnings ?? [],
    versions: doc.versions ?? [],
    generator: doc.generator,
    approval: approval
      ? { reviewer: approval.reviewer, at: approval.createdAt.toISOString(), note: approval.note ?? null }
      : null,
    isMock: doc.isMock,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toNarrativeReviewDto(r: NarrativeReviewDoc, currentTextHash: string): NarrativeReviewDto {
  return {
    id: String(r._id),
    narrativeId: String(r.narrativeId),
    reviewer: r.reviewer,
    decision: r.decision as NarrativeReviewDto['decision'],
    note: r.note ?? null,
    onCurrentText: r.textHash === currentTextHash,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toDispatchDto(d: DispatchDoc, post: PostDoc | null): DispatchDto {
  return {
    id: String(d._id),
    narrativeId: String(d.narrativeId),
    platform: d.platform,
    text: d.text,
    status: d.status,
    externalId: d.externalId ?? null,
    error: d.error ?? null,
    approvedBy: d.approvedBy,
    dispatchedBy: d.dispatchedBy,
    dispatcher: d.dispatcher,
    isMock: d.isMock,
    createdAt: d.createdAt.toISOString(),
    originalPost: post
      ? { id: String(post._id), text: post.text, platform: post.platform, state: post.state ?? null }
      : null,
  };
}
