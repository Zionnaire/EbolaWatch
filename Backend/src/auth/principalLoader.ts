import { Types } from 'mongoose';
import { OrganizationModel, type OrganizationDoc } from '../models/Organization.js';
import { UserModel, type UserDoc } from '../models/User.js';
import { AppError } from '../utils/appError.js';
import type { Role, OrgStatus, OrgType } from '../contracts/api/index.js';
import type { Principal } from './types.js';

interface CacheEntry {
  principal: Principal;
  tokenVersion: number;
  expiresAt: number;
}

export const PRINCIPAL_CACHE_TTL_MS = 30_000;

export function toPrincipal(user: UserDoc, org: OrganizationDoc | null): Principal {
  return {
    userId: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role as Role,
    organizationId: org ? String(org._id) : null,
    org: org
      ? {
          id: String(org._id),
          name: org.name,
          slug: org.slug,
          type: org.type as OrgType,
          status: org.status as OrgStatus,
          scopeStates: org.scopeStates ?? [],
          settings: org.settings ?? {},
        }
      : null,
  };
}

/**
 * Turns a verified token into a Principal by reading the CURRENT user and organization from the database.
 * Nothing about the user's role, organization, active flag or the organization's status is trusted from the token,
 * so a deactivated user, a demoted user or a suspended organization is cut off within the cache TTL (30 s), and
 * immediately in this process when the change goes through `invalidateUser` / `invalidateOrg`.
 */
export class PrincipalLoader {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? PRINCIPAL_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async load(userId: string, tokenVersion: number): Promise<Principal> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > this.now() && cached.tokenVersion === tokenVersion)
      return cached.principal;
    this.cache.delete(userId);

    const invalid = () =>
      new AppError(401, 'Your session is no longer valid. Please sign in again.', 'session_invalid');
    if (!Types.ObjectId.isValid(userId)) throw invalid();

    const user = (await UserModel.findById(userId).lean()) as unknown as UserDoc | null;
    if (!user || !user.isActive) throw invalid();
    if (user.tokenVersion !== tokenVersion) throw invalid(); // password changed, role changed, deactivated, ...

    let org: OrganizationDoc | null = null;
    if (user.organizationId) {
      org = (await OrganizationModel.findById(
        user.organizationId,
      ).lean()) as unknown as OrganizationDoc | null;
      if (!org) throw invalid();
      if (org.status === 'suspended') {
        throw new AppError(
          403,
          'This organization is suspended. Contact the platform administrator.',
          'organization_suspended',
        );
      }
    }

    const principal = toPrincipal(user, org);
    this.cache.set(userId, { principal, tokenVersion, expiresAt: this.now() + this.ttlMs });
    return principal;
  }

  invalidateUser(userId: string): void {
    this.cache.delete(userId);
  }

  /** Forget every cached user of an organization (suspension, settings or scope changes). */
  invalidateOrg(organizationId: string): void {
    for (const [id, entry] of this.cache)
      if (entry.principal.organizationId === organizationId) this.cache.delete(id);
  }

  clear(): void {
    this.cache.clear();
  }
}
