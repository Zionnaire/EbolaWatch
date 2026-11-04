import { Types } from 'mongoose';
import type { TaxonomyService } from '../classifier/taxonomy.js';
import type { ReviewDto, ReviewRequest } from '../contracts/api/index.js';
import { THREECLASS_LABELS } from '../contracts/model/threeClassV0.js';
import { AnalystReviewModel, type AnalystReviewDoc } from '../models/AnalystReview.js';
import { ClassificationModel, type ClassificationDoc } from '../models/Classification.js';
import { PostModel, type PostDoc } from '../models/Post.js';
import { AppError } from '../utils/appError.js';
import { requireOrg, resolveScope, visiblePostsFilter, type ScopeLike } from '../auth/scope.js';
import { toReviewDto } from './postDto.js';

export function parseObjectId(id: string): Types.ObjectId {
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new AppError(400, 'Invalid id', 'invalid_id');
  return new Types.ObjectId(id);
}

/**
 * Analyst review. Append-only: every review is a new row; the post's `reviewStatus` follows the latest one.
 * A correction is stored in the model's own label space with the taxonomy version it refers to, so the
 * reviews can be exported for retraining.
 */
export class ReviewService {
  constructor(private readonly taxonomy: Pick<TaxonomyService, 'getVersion'>) {}

  async review(
    postId: string,
    reviewer: string,
    body: ReviewRequest,
    scopeLike: ScopeLike,
  ): Promise<ReviewDto> {
    // a review belongs to an organization: the platform operator (no organization) cannot make one
    const organizationId = requireOrg(scopeLike);
    const scope = resolveScope(scopeLike);
    // a post the organization may not see is "not found"
    const post = (await PostModel.findOne({
      $and: [{ _id: parseObjectId(postId) }, { isMock: scope.isMock }, visiblePostsFilter(scope.tenant)],
    }).lean()) as unknown as PostDoc | null;
    if (!post) throw new AppError(404, 'Post not found', 'post_not_found');
    if (!post.latestClassificationId) {
      throw new AppError(
        409,
        'This post has not been classified yet, so there is nothing to review',
        'not_classified',
      );
    }
    const classification = (await ClassificationModel.findById(
      post.latestClassificationId,
    ).lean()) as unknown as ClassificationDoc | null;
    if (!classification) throw new AppError(409, 'Classification missing for this post', 'not_classified');

    if (body.decision !== 'corrected' && body.correction) {
      throw new AppError(400, 'A correction may only be sent with decision "corrected"', 'validation_error');
    }

    let taxonomyVersion = classification.taxonomyVersion;
    if (body.decision === 'corrected' && body.correction) {
      taxonomyVersion = await this.validateCorrection(classification, body.correction.labels);
    }

    const doc = await AnalystReviewModel.create({
      organizationId,
      postId: post._id,
      classificationId: classification._id,
      reviewer,
      decision: body.decision,
      correction: body.decision === 'corrected' ? (body.correction ?? null) : null,
      taxonomyVersion,
      note: body.note ?? null,
      isMock: post.isMock,
    });
    // this organization's review state only: other organizations still see the post as unreviewed
    await PostModel.updateOne(
      { _id: post._id },
      {
        $set: {
          [`orgState.${String(organizationId)}`]: {
            reviewStatus: body.decision,
            reviewedAt: doc.createdAt,
            reviewId: doc._id,
          },
        },
      },
    );
    return toReviewDto(doc.toObject() as unknown as AnalystReviewDoc);
  }

  /** Labels must exist in the label space the classification was made in. Returns the taxonomy version they refer to. */
  private async validateCorrection(c: ClassificationDoc, labels: string[]): Promise<string> {
    if (c.contract === 'threeclass-v0') {
      const bad = labels.filter((l) => !(THREECLASS_LABELS as readonly string[]).includes(l));
      if (bad.length > 0 || labels.length !== 1) {
        throw new AppError(
          400,
          `Correction must be exactly one of: ${THREECLASS_LABELS.join(', ')}`,
          'invalid_label',
        );
      }
      return 'threeclass-v0';
    }
    const taxonomy = c.taxonomyVersion ? await this.taxonomy.getVersion(c.taxonomyVersion) : null;
    if (!taxonomy) {
      throw new AppError(
        409,
        'The taxonomy this classification used is not available',
        'taxonomy_unavailable',
      );
    }
    const known = new Set(taxonomy.categories.map((x) => x.id));
    const bad = labels.filter((l) => !known.has(l));
    if (bad.length > 0) {
      throw new AppError(
        400,
        `Unknown label(s) for taxonomy ${taxonomy.taxonomyVersion}: ${bad.join(', ')}`,
        'invalid_label',
      );
    }
    return taxonomy.taxonomyVersion;
  }
}
