import type { QueryFilter } from 'mongoose';
import {
  resolveScope,
  reviewStatusPath,
  unreviewedFilter,
  visiblePostsFilter,
  type Scope,
  type ScopeLike,
} from '../auth/scope.js';
import type { PostDetailDto, PostDto, PostListDto, PostListQuery } from '../contracts/api/index.js';
import { canonicalState } from '../data/nigeriaStates.js';
import { AnalystReviewModel, type AnalystReviewDoc } from '../models/AnalystReview.js';
import { ClassificationModel, type ClassificationDoc } from '../models/Classification.js';
import { DecisionModel, type DecisionDoc } from '../models/Decision.js';
import { PostModel, type PostDoc } from '../models/Post.js';
import { CROSS_TENANT } from '../models/tenantGuard.js';
import { AppError } from '../utils/appError.js';
import { toClassification, toDecisionDto, toPostDto, toReviewDto } from './postDto.js';
import { parseObjectId } from './review.js';

export interface PostQueryDeps {
  /** Platform default; an organization's own setting wins. */
  overdueHours: number;
  now?: () => Date;
}

/**
 * Read side for posts. Every query is scoped twice:
 *   - to the current run's `isMock`, so mock and real data never mix;
 *   - to the caller's tenant: global posts (limited to the organization's states) plus the organization's own
 *     posts. Review state is the caller's organization's, never another's.
 */
export class PostQueryService {
  constructor(private readonly deps: PostQueryDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private overdueHours(scope: Scope): number {
    return scope.tenant.settings?.overdueHours ?? this.deps.overdueHours;
  }

  /** The base filter every post read starts from: this run, and only posts the tenant may see. */
  baseFilter(scope: Scope): QueryFilter<PostDoc> {
    return { $and: [{ isMock: scope.isMock }, visiblePostsFilter(scope.tenant)] };
  }

  buildFilter(q: PostListQuery, scopeLike: ScopeLike): QueryFilter<PostDoc> {
    const scope = resolveScope(scopeLike);
    const filter: QueryFilter<PostDoc> = {};
    const and: QueryFilter<PostDoc>[] = [this.baseFilter(scope)];

    if (q.queue) filter['triage.queue'] = q.queue;
    if (q.severity !== undefined) filter['triage.finalSeverity'] = q.severity;
    if (q.category) filter['triage.categories'] = q.category;
    if (q.language) filter['triage.language'] = q.language;
    if (q.platform) filter.platform = q.platform.toLowerCase();
    if (q.state) filter.state = canonicalState(q.state) ?? q.state;
    if (q.pipelineStatus) filter.pipelineStatus = q.pipelineStatus;

    if (q.reviewStatus) {
      const path = reviewStatusPath(scope.tenant);
      if (q.reviewStatus === 'unreviewed') and.push(unreviewedFilter(scope.tenant));
      else if (path) filter[path] = q.reviewStatus;
      else and.push({ _id: { $in: [] } }); // the platform operator reviews nothing
    }

    if (q.overdue !== undefined) {
      const cutoff = new Date(this.now().getTime() - this.overdueHours(scope) * 3_600_000);
      const overdue: QueryFilter<PostDoc> = {
        $and: [
          unreviewedFilter(scope.tenant),
          { 'triage.queue': { $in: ['review', 'information_gap'] } },
          { ingestedAt: { $lt: cutoff } },
        ],
      };
      and.push(q.overdue ? overdue : { $nor: [overdue] });
    }
    return { ...filter, $and: and };
  }

  async list(q: PostListQuery, scopeLike: ScopeLike): Promise<PostListDto> {
    const scope = resolveScope(scopeLike);
    const filter = this.buildFilter(q, scope);
    const [total, posts] = await Promise.all([
      PostModel.countDocuments(filter),
      PostModel.find(filter)
        // highest priority first; ties (and unclassified posts, which have no score) newest first
        .sort({ 'triage.priorityScore': -1, postedAt: -1, _id: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean() as unknown as Promise<PostDoc[]>,
    ]);
    const items = await this.hydrate(posts, scope);
    return { items, page: q.page, pageSize: q.pageSize, total };
  }

  /** Attaches the latest classification and the in-force decision with two queries, not N. */
  private async hydrate(posts: PostDoc[], scope: Scope): Promise<PostDto[]> {
    const classIds = posts.map((p) => p.latestClassificationId).filter(Boolean);
    const decisionIds = posts.map((p) => p.latestDecisionId).filter(Boolean);
    const [classes, decisions] = await Promise.all([
      classIds.length
        ? (ClassificationModel.find({ _id: { $in: classIds } }).lean() as unknown as Promise<
            ClassificationDoc[]
          >)
        : [],
      decisionIds.length
        ? (DecisionModel.find({ _id: { $in: decisionIds } }).lean() as unknown as Promise<DecisionDoc[]>)
        : [],
    ]);
    const classById = new Map(classes.map((c) => [String(c._id), c]));
    const decisionById = new Map(decisions.map((d) => [String(d._id), d]));
    const opts = {
      now: this.now(),
      overdueHours: this.overdueHours(scope),
      organizationId: scope.tenant.organizationId,
    };
    return posts.map((p) => {
      const cls = p.latestClassificationId ? classById.get(String(p.latestClassificationId)) : undefined;
      const dec = p.latestDecisionId ? decisionById.get(String(p.latestDecisionId)) : undefined;
      return toPostDto(
        p,
        cls ? toClassification(cls.normalized, `classification ${String(cls._id)}`) : null,
        dec ?? null,
        opts,
      );
    });
  }

  /** A post the tenant may not see is "not found", exactly as if it did not exist. */
  async detail(id: string, scopeLike: ScopeLike): Promise<PostDetailDto> {
    const scope = resolveScope(scopeLike);
    const post = (await PostModel.findOne({
      $and: [{ _id: parseObjectId(id) }, this.baseFilter(scope)],
    }).lean()) as unknown as PostDoc | null;
    if (!post) throw new AppError(404, 'Post not found', 'post_not_found');

    const reviewFilter = scope.tenant.organizationId
      ? { postId: post._id, organizationId: scope.tenant.organizationId }
      : { postId: post._id };
    const [classifications, decisions, reviews] = await Promise.all([
      ClassificationModel.find({ postId: post._id }).sort({ createdAt: -1 }).lean() as unknown as Promise<
        ClassificationDoc[]
      >,
      DecisionModel.find({ postId: post._id }).sort({ createdAt: -1 }).lean() as unknown as Promise<
        DecisionDoc[]
      >,
      // an organization sees only its own reviews; the platform operator may read across tenants
      AnalystReviewModel.find(reviewFilter)
        .setOptions(scope.tenant.platformWide ? CROSS_TENANT : {})
        .sort({ createdAt: -1 })
        .lean() as unknown as Promise<AnalystReviewDoc[]>,
    ]);

    const inForce = post.latestDecisionId ? String(post.latestDecisionId) : null;
    const history = classifications.flatMap((cls) => {
      const classification = toClassification(cls.normalized, `classification ${String(cls._id)}`);
      if (!classification) return [];
      const forThis = decisions.filter((d) => String(d.classificationId) === String(cls._id));
      // the decision currently in force for the latest classification; otherwise the newest one
      const dec = forThis.find((d) => String(d._id) === inForce) ?? forThis[0];
      return [
        {
          classificationId: String(cls._id),
          createdAt: cls.createdAt.toISOString(),
          isMock: cls.isMock,
          classification,
          decision: dec ? toDecisionDto(dec) : null,
        },
      ];
    });

    const latest = history.find((h) => h.classificationId === String(post.latestClassificationId));
    const decisionDoc = decisions.find((d) => String(d._id) === inForce) ?? null;
    return {
      post: toPostDto(post, latest?.classification ?? null, decisionDoc, {
        now: this.now(),
        overdueHours: this.overdueHours(scope),
        organizationId: scope.tenant.organizationId,
      }),
      history,
      reviews: reviews.map(toReviewDto),
    };
  }
}
