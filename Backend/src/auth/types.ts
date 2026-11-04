import type { EffectiveSettings, OrgStatus, OrgType, Role } from '../contracts/api/index.js';

export interface PrincipalOrg {
  id: string;
  name: string;
  slug: string;
  type: OrgType;
  status: OrgStatus;
  scopeStates: string[];
  /** Explicit organization settings (unset fields inherit the platform defaults). */
  settings: { overdueHours?: number; queueCap?: number; vocabulary?: Record<string, string> };
}

/** Who is making the request. Built from the database (not trusted from the token) and re-checked every 30 s. */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  role: Role;
  /** null only for a super admin. */
  organizationId: string | null;
  org: PrincipalOrg | null;
}

/** Platform-wide defaults that organizations inherit from. */
export type PlatformDefaults = EffectiveSettings;
