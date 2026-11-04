import type { Types } from 'mongoose';
import type { TaxonomyService } from '../../classifier/taxonomy.js';
import {
  requireOrg,
  resolveScope,
  visiblePostsFilter,
  type Scope,
  type ScopeLike,
} from '../../auth/scope.js';
import {
  LanguageSchema,
  type GenerateNarrativeRequest,
  type NarrativeDetailDto,
  type NarrativeDto,
  type NarrativeListQuery,
  type RegenerateNarrativeRequest,
} from '../../contracts/api/index.js';
import { ClassificationModel, type ClassificationDoc } from '../../models/Classification.js';
import {
  CounterNarrativeModel,
  type CounterNarrativeDoc,
  type NarrativeVersionDoc,
} from '../../models/CounterNarrative.js';
import { DispatchModel, type DispatchDoc } from '../../models/Dispatch.js';
import { NarrativeReviewModel, type NarrativeReviewDoc } from '../../models/NarrativeReview.js';
import { PostModel, type PostDoc, type Triage } from '../../models/Post.js';
import { AppError } from '../../utils/appError.js';
import { textHash } from '../../utils/hashing.js';
import { scrubPii } from '../../utils/pii.js';
import { parseObjectId } from '../review.js';
import { toDispatchDto, toNarrativeDto, toNarrativeReviewDto } from './dto.js';
import type { CounterNarrativeGenerator, GeneratedDraft } from './generator.js';
import type { PlatformLimits } from './platforms.js';

/** States in which the text may still change. `dispatching` and `dispatched` are locked. */
const EDITABLE = ['draft', 'approved', 'rejected'];
const MAX_CLAIM_CHARS = 600;

export interface NarrativeServiceDeps {
  generator: CounterNarrativeGenerator;
  platforms: PlatformLimits;
  taxonomy: Pick<TaxonomyService, 'get' | 'getVersion'>;
  now?: () => Date;
}

/**
 * Drafting and review of counter-narratives. Nothing here can send anything: sending lives in DispatchService
 * and requires an analyst approval of the exact current text.
 *
 * Counter-narratives belong to an organization. Every query below carries the caller's `organizationId` (the
 * data layer also refuses a query without one), so another organization's drafts are "not found", by id and in
 * lists alike. A super admin has no organization and therefore cannot use these operations.
 */
export class NarrativeService {
  constructor(private readonly deps: NarrativeServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private requirePlatform(id: string) {
    const platform = this.deps.platforms.get(id);
    if (!platform) {
      const known = this.deps.platforms
        .list()
        .map((p) => p.id)
        .join(', ');
      throw new AppError(400, `Unknown platform "${id}". Known platforms: ${known}`, 'unknown_platform');
    }
    return platform;
  }

  /** A category must exist in the taxonomy it is being used with (labels are data, validated at runtime). */
  private async resolveCategory(
    category: string | null,
    taxonomyVersion: string | null,
  ): Promise<{ category: string | null; name: string | null; taxonomyVersion: string | null }> {
    const taxonomy = taxonomyVersion
      ? await this.deps.taxonomy.getVersion(taxonomyVersion)
      : this.deps.taxonomy.get();
    if (!category)
      return { category: null, name: null, taxonomyVersion: taxonomy?.taxonomyVersion ?? taxonomyVersion };
    if (!taxonomy) return { category, name: null, taxonomyVersion }; // cannot validate without a taxonomy
    const found = taxonomy.categories.find((c) => c.id === category);
    if (!found) {
      throw new AppError(
        400,
        `Unknown category "${category}" for taxonomy ${taxonomy.taxonomyVersion}`,
        'invalid_category',
      );
    }
    return { category, name: found.displayName, taxonomyVersion: taxonomy.taxonomyVersion };
  }

  private assertFits(draft: GeneratedDraft, charLimit: number): void {
    if (draft.text.trim().length === 0 || draft.text.length > charLimit) {
      // a generator bug, not a client error
      throw new AppError(
        502,
        `The generator returned a draft that does not fit ${charLimit} characters`,
        'generator_invalid',
      );
    }
  }

  async generate(
    req: GenerateNarrativeRequest,
    userId: string,
    scopeLike: ScopeLike,
  ): Promise<NarrativeDetailDto> {
    const scope = resolveScope(scopeLike);
    const organizationId = requireOrg(scope);

    let post: PostDoc | null = null;
    let classification: ClassificationDoc | null = null;
    if (req.postId) {
      // only a post this organization may see can be answered
      post = (await PostModel.findOne({
        $and: [
          { _id: parseObjectId(req.postId) },
          { isMock: scope.isMock },
          visiblePostsFilter(scope.tenant),
        ],
      }).lean()) as unknown as PostDoc | null;
      if (!post) throw new AppError(404, 'Post not found', 'post_not_found');
      if (post.latestClassificationId) {
        classification = (await ClassificationModel.findById(
          post.latestClassificationId,
        ).lean()) as unknown as ClassificationDoc | null;
      }
    }

    const claim = post
      ? post.text.slice(0, MAX_CLAIM_CHARS)
      : scrubPii(req.claim ?? '').slice(0, MAX_CLAIM_CHARS);
    const triage = (post?.triage ?? null) as Triage | null;
    const platform = this.requirePlatform(req.platform ?? post?.platform ?? '');
    const requestedCategory = req.category ?? triage?.categories?.[0] ?? triage?.topCategory ?? null;
    const resolved = await this.resolveCategory(requestedCategory, classification?.taxonomyVersion ?? null);
    const language = req.language ?? LanguageSchema.safeParse(classification?.language).data ?? 'en';

    const draft = await this.deps.generator.generate({
      claim,
      category: resolved.category,
      categoryName: resolved.name,
      language,
      platform: platform.id,
      charLimit: platform.charLimit,
      guidance: req.guidance ?? null,
      attempt: 0,
    });
    this.assertFits(draft, platform.charLimit);

    const at = this.now();
    const g = this.deps.generator;
    const doc = await CounterNarrativeModel.create({
      organizationId,
      postId: post?._id ?? null,
      source: post ? 'post' : 'manual',
      platform: platform.id,
      charLimit: platform.charLimit,
      requestedLanguage: language,
      language: draft.language,
      category: resolved.category,
      taxonomyVersion: resolved.taxonomyVersion,
      claim,
      text: draft.text,
      textHash: textHash(draft.text),
      status: 'draft',
      citations: draft.citations,
      warnings: draft.warnings,
      versions: [{ text: draft.text, kind: 'generated', by: `generator:${g.name}`, at: at.toISOString() }],
      generator: { name: g.name, version: g.version, mode: g.mode },
      isMock: scope.isMock,
      createdBy: userId,
      createdAt: at,
      updatedAt: at,
    });
    return this.detail(String(doc._id), scope);
  }

  private async load(id: string, scope: Scope): Promise<CounterNarrativeDoc> {
    const doc = (await CounterNarrativeModel.findOne({
      _id: parseObjectId(id),
      organizationId: requireOrg(scope),
      isMock: scope.isMock,
    }).lean()) as unknown as CounterNarrativeDoc | null;
    if (!doc) throw new AppError(404, 'Counter-narrative not found', 'narrative_not_found');
    return doc;
  }

  private lockedError(status: string): AppError {
    return new AppError(
      409,
      status === 'dispatched'
        ? 'This counter-narrative has already been dispatched and can no longer be changed'
        : 'This counter-narrative is being dispatched and can not be changed right now',
      status === 'dispatched' ? 'already_dispatched' : 'dispatch_in_progress',
    );
  }

  /** Edits the text. An edit always sends the narrative back to `draft`: an earlier approval no longer applies. */
  async edit(id: string, text: string, userId: string, scopeLike: ScopeLike): Promise<NarrativeDetailDto> {
    const scope = resolveScope(scopeLike);
    const doc = await this.load(id, scope);
    if (!EDITABLE.includes(doc.status)) throw this.lockedError(doc.status);
    const next = text.trim();
    if (next.length === 0) throw new AppError(400, 'The text must not be empty', 'validation_error');
    if (next.length > doc.charLimit) {
      throw new AppError(
        400,
        `The text is ${next.length} characters; the ${doc.platform} limit is ${doc.charLimit}`,
        'too_long',
      );
    }
    const version: NarrativeVersionDoc = {
      text: next,
      kind: 'edited',
      by: userId,
      at: this.now().toISOString(),
    };
    const updated = await CounterNarrativeModel.findOneAndUpdate(
      { _id: doc._id, organizationId: doc.organizationId, status: { $in: EDITABLE } },
      {
        $set: { text: next, textHash: textHash(next), status: 'draft', updatedAt: this.now() },
        $push: { versions: version },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw this.lockedError('dispatching'); // changed under us: refuse rather than overwrite
    return this.detail(id, scope);
  }

  /** New draft from the generator. With a different `category` this is "override label". */
  async regenerate(
    id: string,
    req: RegenerateNarrativeRequest,
    scopeLike: ScopeLike,
  ): Promise<NarrativeDetailDto> {
    const scope = resolveScope(scopeLike);
    const doc = await this.load(id, scope);
    if (!EDITABLE.includes(doc.status)) throw this.lockedError(doc.status);

    const platform = this.requirePlatform(req.platform ?? doc.platform);
    const resolved = await this.resolveCategory(req.category ?? doc.category, doc.taxonomyVersion);
    const language = req.language ?? doc.requestedLanguage;
    const attempt = doc.versions?.length ?? 0;

    const draft = await this.deps.generator.generate({
      claim: doc.claim ?? '',
      category: resolved.category,
      categoryName: resolved.name,
      language,
      platform: platform.id,
      charLimit: platform.charLimit,
      guidance: req.guidance ?? null,
      attempt,
    });
    this.assertFits(draft, platform.charLimit);

    const g = this.deps.generator;
    const version: NarrativeVersionDoc = {
      text: draft.text,
      kind: 'regenerated',
      by: `generator:${g.name}`,
      at: this.now().toISOString(),
    };
    const updated = await CounterNarrativeModel.findOneAndUpdate(
      { _id: doc._id, organizationId: doc.organizationId, status: { $in: EDITABLE } },
      {
        $set: {
          platform: platform.id,
          charLimit: platform.charLimit,
          requestedLanguage: language,
          language: draft.language,
          category: resolved.category,
          text: draft.text,
          textHash: textHash(draft.text),
          status: 'draft',
          citations: draft.citations,
          warnings: draft.warnings,
          generator: { name: g.name, version: g.version, mode: g.mode },
          updatedAt: this.now(),
        },
        $push: { versions: version },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw this.lockedError('dispatching');
    return this.detail(id, scope);
  }

  /**
   * Approve the CURRENT text. The review records the text hash, which dispatch re-checks, so the approval can
   * never be carried over to different text.
   */
  async approve(
    id: string,
    userId: string,
    note: string | undefined,
    scopeLike: ScopeLike,
  ): Promise<NarrativeDetailDto> {
    const scope = resolveScope(scopeLike);
    const doc = await this.load(id, scope);
    if (!EDITABLE.includes(doc.status)) throw this.lockedError(doc.status);
    if (doc.status !== 'draft') {
      throw new AppError(409, `Only a draft can be approved (this one is ${doc.status})`, 'invalid_state');
    }
    await NarrativeReviewModel.create({
      organizationId: doc.organizationId,
      narrativeId: doc._id,
      reviewer: userId,
      decision: 'approved',
      textHash: doc.textHash,
      note: note ?? null,
      isMock: doc.isMock,
    });
    // only if the text has not changed since we read it
    const updated = await CounterNarrativeModel.findOneAndUpdate(
      { _id: doc._id, organizationId: doc.organizationId, status: 'draft', textHash: doc.textHash },
      { $set: { status: 'approved', updatedAt: this.now() } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated)
      throw new AppError(409, 'The text changed while it was being approved. Review it again.', 'conflict');
    return this.detail(id, scope);
  }

  async reject(
    id: string,
    userId: string,
    note: string | undefined,
    scopeLike: ScopeLike,
  ): Promise<NarrativeDetailDto> {
    const scope = resolveScope(scopeLike);
    const doc = await this.load(id, scope);
    if (!EDITABLE.includes(doc.status)) throw this.lockedError(doc.status);
    if (!['draft', 'approved'].includes(doc.status)) {
      throw new AppError(
        409,
        `Only a draft or an approved narrative can be rejected (this one is ${doc.status})`,
        'invalid_state',
      );
    }
    await NarrativeReviewModel.create({
      organizationId: doc.organizationId,
      narrativeId: doc._id,
      reviewer: userId,
      decision: 'rejected',
      textHash: doc.textHash,
      note: note ?? null,
      isMock: doc.isMock,
    });
    const updated = await CounterNarrativeModel.findOneAndUpdate(
      { _id: doc._id, organizationId: doc.organizationId, status: { $in: ['draft', 'approved'] } },
      { $set: { status: 'rejected', updatedAt: this.now() } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw this.lockedError('dispatching');
    return this.detail(id, scope);
  }

  private async reviewsFor(
    ids: Types.ObjectId[],
    organizationId: Types.ObjectId,
  ): Promise<Map<string, NarrativeReviewDoc[]>> {
    const rows = (await NarrativeReviewModel.find({ organizationId, narrativeId: { $in: ids } })
      .sort({ createdAt: -1, _id: -1 })
      .lean()) as unknown as NarrativeReviewDoc[];
    const by = new Map<string, NarrativeReviewDoc[]>();
    for (const r of rows) {
      const k = String(r.narrativeId);
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return by;
  }

  async detail(id: string, scopeLike: ScopeLike): Promise<NarrativeDetailDto> {
    const scope = resolveScope(scopeLike);
    const doc = await this.load(id, scope);
    const reviews = (await this.reviewsFor([doc._id], doc.organizationId)).get(String(doc._id)) ?? [];
    const sent = (await DispatchModel.findOne({
      organizationId: doc.organizationId,
      narrativeId: doc._id,
      status: 'sent',
    }).lean()) as unknown as DispatchDoc | null;
    const post = sent?.postId
      ? ((await PostModel.findById(sent.postId).lean()) as unknown as PostDoc | null)
      : null;
    return {
      narrative: toNarrativeDto(doc, reviews),
      reviews: reviews.map((r) => toNarrativeReviewDto(r, doc.textHash)),
      dispatch: sent ? toDispatchDto(sent, post) : null,
    };
  }

  async list(q: NarrativeListQuery, scopeLike: ScopeLike) {
    const scope = resolveScope(scopeLike);
    const organizationId = requireOrg(scope);
    const filter: Record<string, unknown> = { organizationId, isMock: scope.isMock };
    if (q.postId) filter.postId = parseObjectId(q.postId);
    if (q.status) filter.status = q.status;
    const [total, docs] = await Promise.all([
      CounterNarrativeModel.countDocuments(filter),
      CounterNarrativeModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean() as unknown as Promise<CounterNarrativeDoc[]>,
    ]);
    const reviews = await this.reviewsFor(
      docs.map((d) => d._id),
      organizationId,
    );
    const items: NarrativeDto[] = docs.map((d) => toNarrativeDto(d, reviews.get(String(d._id)) ?? []));
    return { items, page: q.page, pageSize: q.pageSize, total };
  }
}
