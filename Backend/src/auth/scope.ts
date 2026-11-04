import { Types, type QueryFilter } from 'mongoose';
import type { EffectiveSettings, OrgType } from '../contracts/api/index.js';
import type { PostDoc } from '../models/Post.js';
import { AppError } from '../utils/appError.js';
import { resolveSettings } from './settings.js';
import type { PlatformDefaults, Principal } from './types.js';

/** Which data a request may touch. Built once per request from the authenticated principal. */
export interface TenantScope {
  /** The caller's organization; null for the platform operator. */
  organizationId: Types.ObjectId | null;
  /** True only for a super admin: sees all posts and spans tenants for read-only platform views. */
  platformWide: boolean;
  /** Empty = all states. */
  scopeStates: string[];
  orgType: OrgType | null;
  /** Effective settings (explicit, else platform defaults); null when platform-wide. */
  settings: EffectiveSettings | null;
}

export const PLATFORM_WIDE: TenantScope = {
  organizationId: null,
  platformWide: true,
  scopeStates: [],
  orgType: null,
  settings: null,
};

/** Everything a query needs to be correct: which run (mock/real) and which tenant. */
export interface Scope {
  isMock: boolean;
  tenant: TenantScope;
}

/**
 * Services accept a bare boolean for the mock/real run only as shorthand for "platform operator" (used by
 * platform jobs and tests). Every HTTP route builds a full Scope from the authenticated user.
 */
export type ScopeLike = boolean | Scope;

export function resolveScope(s: ScopeLike): Scope {
  return typeof s === 'boolean' ? { isMock: s, tenant: PLATFORM_WIDE } : s;
}

export function tenantFromPrincipal(p: Principal, defaults: PlatformDefaults): TenantScope {
  if (!p.org) return PLATFORM_WIDE;
  return {
    organizationId: new Types.ObjectId(p.org.id),
    platformWide: false,
    scopeStates: p.org.scopeStates,
    orgType: p.org.type,
    settings: resolveSettings(p.org.settings, defaults),
  };
}

/** The tenant's organization id, or a 403: tenant-owned work needs an organization (a super admin has none). */
export function requireOrg(scope: ScopeLike): Types.ObjectId {
  const id = resolveScope(scope).tenant.organizationId;
  if (!id) throw new AppError(403, 'This action must be done as a member of an organization', 'org_required');
  return id;
}

/**
 * Which posts a tenant may see. Posts are global; a post is either `global` (visible to every organization,
 * limited to the organization's states when it has a state scope) or `org` (visible only to its owner).
 * Visibility is explicit: a post with no visibility is visible to nobody but the platform operator.
 */
export function visiblePostsFilter(t: TenantScope): QueryFilter<PostDoc> {
  if (t.platformWide) return {};
  const global: QueryFilter<PostDoc> = { visibility: 'global' };
  if (t.scopeStates.length > 0) global.state = { $in: t.scopeStates };
  return { $or: [global, { visibility: 'org', organizationId: t.organizationId }] };
}

/** Field of `Post.orgState` that holds this tenant's review status for a post (null for the platform operator). */
export function reviewStatusPath(t: TenantScope): string | null {
  return t.organizationId ? `orgState.${String(t.organizationId)}.reviewStatus` : null;
}

/** Filter fragment: this tenant has not reviewed the post (nobody has, for the platform operator). */
export function unreviewedFilter(t: TenantScope): QueryFilter<PostDoc> {
  const path = reviewStatusPath(t);
  if (!path) return {};
  return { $or: [{ [path]: { $exists: false } }, { [path]: 'unreviewed' }] };
}

/** This tenant's review status of a stored post. */
export function reviewStatusOf(
  post: { orgState?: Record<string, { reviewStatus?: string }> | null },
  organizationId: Types.ObjectId | string | null | undefined,
): string {
  if (!organizationId) return 'unreviewed';
  return post.orgState?.[String(organizationId)]?.reviewStatus ?? 'unreviewed';
}

/** What a live socket needs to know about its owner to decide which post events it may receive. */
export interface SocketTenant {
  platformWide: boolean;
  organizationId: string | null;
  scopeStates: string[];
}

export interface PostAudience {
  visibility: string;
  organizationId: string | null;
  state: string | null;
}

/** The same rule as `visiblePostsFilter`, applied to a single post for live delivery. */
export function tenantCanSeePost(t: SocketTenant, post: PostAudience): boolean {
  if (t.platformWide) return true;
  if (post.visibility === 'org')
    return post.organizationId !== null && post.organizationId === t.organizationId;
  if (post.visibility !== 'global') return false;
  return t.scopeStates.length === 0 || (post.state !== null && t.scopeStates.includes(post.state));
}
