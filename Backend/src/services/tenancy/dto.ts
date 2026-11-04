import { resolveSettings } from '../../auth/settings.js';
import type { PlatformDefaults } from '../../auth/types.js';
import type { MeDto, OrganizationDto, UserDto } from '../../contracts/api/index.js';
import { permissionsOf } from '../../auth/permissions.js';
import type { Principal } from '../../auth/types.js';
import type { OrganizationDoc } from '../../models/Organization.js';
import type { UserDoc } from '../../models/User.js';

export function toOrganizationDto(
  org: OrganizationDoc,
  defaults: PlatformDefaults,
  userCount?: number,
): OrganizationDto {
  return {
    id: String(org._id),
    name: org.name,
    slug: org.slug,
    type: org.type as OrganizationDto['type'],
    region: org.region ?? null,
    status: org.status as OrganizationDto['status'],
    scopeStates: org.scopeStates ?? [],
    settings: org.settings ?? {},
    effectiveSettings: resolveSettings(org.settings, defaults),
    adminClaimed: org.adminClaimed,
    ...(userCount !== undefined ? { userCount } : {}),
    createdAt: org.createdAt.toISOString(),
  };
}

/** Never includes the password hash or token version. */
export function toUserDto(u: UserDoc): UserDto {
  return {
    id: String(u._id),
    email: u.email,
    name: u.name,
    role: u.role as UserDto['role'],
    organizationId: u.organizationId ? String(u.organizationId) : null,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

export function toMeDto(
  user: UserDoc,
  org: OrganizationDoc | null,
  principal: Principal,
  defaults: PlatformDefaults,
): MeDto {
  return {
    user: toUserDto(user),
    organization: org ? toOrganizationDto(org, defaults) : null,
    permissions: permissionsOf(principal),
  };
}
