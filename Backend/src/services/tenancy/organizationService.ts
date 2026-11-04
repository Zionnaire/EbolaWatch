import { Types } from 'mongoose';
import { applySettingsPatch } from '../../auth/settings.js';
import type { PlatformDefaults } from '../../auth/types.js';
import type { PrincipalLoader } from '../../auth/principalLoader.js';
import {
  OrgSettingsSchema,
  type CreateOrganizationResponseSchema,
  type OrgOverviewDto,
  type OrgStatus,
  type OrganizationDto,
} from '../../contracts/api/index.js';
import type { z } from 'zod';
import { canonicalState } from '../../data/nigeriaStates.js';
import { AnalystReviewModel } from '../../models/AnalystReview.js';
import { CounterNarrativeModel } from '../../models/CounterNarrative.js';
import { DispatchModel } from '../../models/Dispatch.js';
import { OrganizationModel, type OrganizationDoc } from '../../models/Organization.js';
import { UserModel } from '../../models/User.js';
import { CROSS_TENANT } from '../../models/tenantGuard.js';
import { AppError } from '../../utils/appError.js';
import { logger } from '../../utils/logger.js';
import { newOpaqueToken } from '../../utils/tokens.js';
import { parseObjectId } from '../review.js';
import { toOrganizationDto } from './dto.js';

export const CLAIM_LINK_DAYS = 30;

export interface OrganizationServiceDeps {
  defaults: PlatformDefaults;
  /** Claim links point at the frontend: `${frontendUrl}/claim-org/<token>`. */
  frontendUrl: string;
  loader: PrincipalLoader;
  /** Called when an organization is suspended, so its live socket connections are dropped at once. */
  onSuspended?: (organizationId: string) => void;
  now?: () => Date;
}

export type CreateOrganizationResult = z.infer<typeof CreateOrganizationResponseSchema>;

export interface CreateOrganizationInput {
  name: string;
  type: OrganizationDto['type'];
  region?: string;
  scopeStates?: string[];
  slug?: string;
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'org';
}

/** Platform administration of tenants. Only reachable by the super admin (see routes). */
export class OrganizationService {
  constructor(private readonly deps: OrganizationServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private claimLink(token: string, expiresAt: Date) {
    return {
      token,
      url: `${this.deps.frontendUrl.replace(/\/$/, '')}/claim-org/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async load(id: string): Promise<OrganizationDoc> {
    const org = (await OrganizationModel.findById(
      parseObjectId(id),
    ).lean()) as unknown as OrganizationDoc | null;
    if (!org) throw new AppError(404, 'Organization not found', 'organization_not_found');
    return org;
  }

  /** States are stored under their canonical names; anything we do not recognise is rejected, not guessed. */
  private normaliseStates(states: string[] | undefined): string[] {
    const out = new Set<string>();
    for (const s of states ?? []) {
      const c = canonicalState(s);
      if (!c) throw new AppError(400, `Unknown state "${s}"`, 'invalid_state');
      out.add(c);
    }
    return [...out];
  }

  private async uniqueSlug(base: string, explicit: boolean): Promise<string> {
    if (explicit) {
      if (await OrganizationModel.exists({ slug: base })) {
        throw new AppError(409, `The slug "${base}" is already taken`, 'slug_taken');
      }
      return base;
    }
    for (let i = 1; i < 1000; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      if (!(await OrganizationModel.exists({ slug: candidate }))) return candidate;
    }
    throw new AppError(409, 'Could not find a free slug', 'slug_taken');
  }

  /** Creates the organization and a single-use claim link for its first admin. The link is shown once. */
  async create(input: CreateOrganizationInput, createdBy: string): Promise<CreateOrganizationResult> {
    const slug = await this.uniqueSlug(input.slug ?? slugify(input.name), input.slug !== undefined);
    const { token, hash } = newOpaqueToken();
    const expiresAt = new Date(this.now().getTime() + CLAIM_LINK_DAYS * 86_400_000);
    const doc = await OrganizationModel.create({
      name: input.name,
      slug,
      type: input.type,
      region: input.region ?? null,
      scopeStates: this.normaliseStates(input.scopeStates),
      status: 'active',
      settings: {},
      claim: { tokenHash: hash, expiresAt },
      adminClaimed: false,
      createdBy,
    });
    logger.info({ organizationId: String(doc._id), slug, by: createdBy }, 'organization created');
    return {
      organization: toOrganizationDto(doc.toObject() as unknown as OrganizationDoc, this.deps.defaults, 0),
      claimLink: this.claimLink(token, expiresAt),
    };
  }

  /** A fresh link replaces the old one. Only while nobody has claimed the organization yet. */
  async regenerateClaimLink(id: string) {
    const org = await this.load(id);
    if (org.adminClaimed)
      throw new AppError(409, 'This organization already has an admin', 'already_claimed');
    const { token, hash } = newOpaqueToken();
    const expiresAt = new Date(this.now().getTime() + CLAIM_LINK_DAYS * 86_400_000);
    await OrganizationModel.updateOne(
      { _id: org._id },
      { $set: { claim: { tokenHash: hash, expiresAt }, updatedAt: this.now() } },
    );
    return this.claimLink(token, expiresAt);
  }

  async get(id: string): Promise<OrganizationDto> {
    const org = await this.load(id);
    const userCount = await UserModel.countDocuments({ organizationId: org._id });
    return toOrganizationDto(org, this.deps.defaults, userCount);
  }

  /** User counts are computed when listed: a stored counter would drift. */
  async list(): Promise<OrganizationDto[]> {
    const [orgs, counts] = await Promise.all([
      OrganizationModel.find().sort({ createdAt: 1 }).lean() as unknown as Promise<OrganizationDoc[]>,
      UserModel.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { organizationId: { $ne: null } } },
        { $group: { _id: '$organizationId', n: { $sum: 1 } } },
      ]),
    ]);
    const byOrg = new Map(counts.map((c) => [String(c._id), c.n]));
    return orgs.map((o) => toOrganizationDto(o, this.deps.defaults, byOrg.get(String(o._id)) ?? 0));
  }

  /** Suspension is enforced everywhere: login, every request, refresh, and live sockets. */
  async setStatus(id: string, status: OrgStatus): Promise<OrganizationDto> {
    const org = await this.load(id);
    await OrganizationModel.updateOne({ _id: org._id }, { $set: { status, updatedAt: this.now() } });
    this.deps.loader.invalidateOrg(String(org._id));
    if (status === 'suspended') this.deps.onSuspended?.(String(org._id));
    logger.info({ organizationId: String(org._id), status }, 'organization status changed');
    return this.get(id);
  }

  /** Only whitelisted settings can be changed (the schema is strict), and `null` returns a field to the default. */
  async updateSettings(id: string, body: unknown): Promise<OrganizationDto> {
    const patch = OrgSettingsSchema.parse(body);
    const org = await this.load(id);
    const next = applySettingsPatch(org.settings, patch);
    await OrganizationModel.updateOne({ _id: org._id }, { $set: { settings: next, updatedAt: this.now() } });
    this.deps.loader.invalidateOrg(String(org._id));
    return this.get(id);
  }

  /** The platform operator's view: usage per organization. */
  async overview(): Promise<OrgOverviewDto> {
    const orgs = await this.list();
    const groupCount = async (model: {
      aggregate: (p: object[]) => {
        option: (o: object) => Promise<Array<{ _id: Types.ObjectId; n: number }>>;
      };
    }) => {
      const rows = await model
        .aggregate([{ $group: { _id: '$organizationId', n: { $sum: 1 } } }])
        .option(CROSS_TENANT);
      return new Map(rows.map((r) => [String(r._id), r.n]));
    };
    const [reviews, narratives, dispatches, active] = await Promise.all([
      groupCount(AnalystReviewModel as never),
      groupCount(CounterNarrativeModel as never),
      groupCount(DispatchModel as never),
      UserModel.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { organizationId: { $ne: null }, isActive: true } },
        { $group: { _id: '$organizationId', n: { $sum: 1 } } },
      ]),
    ]);
    const activeBy = new Map(active.map((r) => [String(r._id), r.n]));
    const rows = orgs.map((organization) => ({
      organization,
      users: organization.userCount ?? 0,
      activeUsers: activeBy.get(organization.id) ?? 0,
      reviews: reviews.get(organization.id) ?? 0,
      narratives: narratives.get(organization.id) ?? 0,
      dispatches: dispatches.get(organization.id) ?? 0,
    }));
    return {
      organizations: rows,
      totals: {
        organizations: rows.length,
        users: rows.reduce((a, r) => a + r.users, 0),
        reviews: rows.reduce((a, r) => a + r.reviews, 0),
      },
    };
  }
}
