import type { Role } from '../contracts/api/index.js';
import type { Principal } from './types.js';

const ALL: Role[] = ['analyst', 'senior_analyst', 'supervisor', 'org_admin', 'super_admin'];
const TENANT: Role[] = ['analyst', 'senior_analyst', 'supervisor', 'org_admin'];
const SENIOR: Role[] = ['senior_analyst', 'supervisor', 'org_admin'];

/**
 * Who may do what. This table is the only place roles are interpreted; routes ask for a permission, never a role.
 * It is a default policy and is meant to be edited.
 *
 * The super admin is the platform operator: it administers organizations but never acts inside one, so it holds
 * none of the tenant-owned permissions (review, draft, approve, dispatch).
 */
export const PERMISSIONS = {
  // reading shared, global data (posts are visible according to the organization's scope)
  'posts:read': ALL,
  'analytics:read': ALL,
  'platform:read': ALL, // connectors, rules
  // tenant-owned work
  'posts:review': TENANT,
  'narratives:read': TENANT,
  'narratives:draft': TENANT,
  'narratives:approve': SENIOR,
  'narratives:dispatch': SENIOR,
  // administration
  'users:manage': ['org_admin'],
  'org:settings': ['org_admin'],
  'orgs:manage': ['super_admin'],
  // changes the operating mode for everyone: see `can`
  'platform:operate': ['super_admin', 'supervisor', 'org_admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(principal: Principal, permission: Permission): boolean {
  if (!(PERMISSIONS[permission] as readonly Role[]).includes(principal.role)) return false;
  // The operating mode (dormant / surge) changes decisions for every tenant, so a tenant may only do it if it is
  // the national organization (NCDC). Everyone else asks the platform operator.
  if (permission === 'platform:operate' && principal.role !== 'super_admin')
    return principal.org?.type === 'national';
  return true;
}

export function permissionsOf(principal: Principal): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(principal, p));
}
