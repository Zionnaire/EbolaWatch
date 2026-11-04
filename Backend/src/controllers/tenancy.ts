import type { Request, Response } from 'express';
import {
  CreateOrganizationRequestSchema,
  InviteRequestSchema,
  SetOrgStatusRequestSchema,
  UpdateUserRequestSchema,
} from '../contracts/api/index.js';
import { currentPrincipal } from '../auth/middleware.js';
import type { OrganizationService } from '../services/tenancy/organizationService.js';
import type { UserService } from '../services/tenancy/userService.js';
import { AppError } from '../utils/appError.js';

export interface TenancyControllerDeps {
  organizations: OrganizationService;
  users: UserService;
}

const id = (req: Request) => String(req.params.id);

export function organizationsController(d: TenancyControllerDeps) {
  return {
    list: async (_req: Request, res: Response) => {
      res.json(await d.organizations.list());
    },

    overview: async (_req: Request, res: Response) => {
      res.json(await d.organizations.overview());
    },

    /** The organization is created with a single-use claim link for its first admin (shown once). */
    create: async (req: Request, res: Response) => {
      const body = CreateOrganizationRequestSchema.parse(req.body);
      res.status(201).json(await d.organizations.create(body, currentPrincipal(res).userId));
    },

    get: async (req: Request, res: Response) => {
      res.json(await d.organizations.get(id(req)));
    },

    regenerateClaimLink: async (req: Request, res: Response) => {
      res.json({ claimLink: await d.organizations.regenerateClaimLink(id(req)) });
    },

    setStatus: async (req: Request, res: Response) => {
      const { status } = SetOrgStatusRequestSchema.parse(req.body);
      res.json(await d.organizations.setStatus(id(req), status));
    },

    updateSettings: async (req: Request, res: Response) => {
      res.json(await d.organizations.updateSettings(id(req), req.body));
    },

    /** The caller's own organization (an org admin managing their settings). The id comes from the session. */
    mine: async (_req: Request, res: Response) => {
      res.json(await d.organizations.get(requireOwnOrg(res)));
    },

    updateMySettings: async (req: Request, res: Response) => {
      res.json(await d.organizations.updateSettings(requireOwnOrg(res), req.body));
    },
  };
}

function requireOwnOrg(res: Response): string {
  const orgId = currentPrincipal(res).organizationId;
  if (!orgId)
    throw new AppError(403, 'This action must be done as a member of an organization', 'org_required');
  return orgId;
}

export function usersController(d: TenancyControllerDeps) {
  return {
    list: async (_req: Request, res: Response) => {
      res.json(await d.users.list(currentPrincipal(res)));
    },

    update: async (req: Request, res: Response) => {
      const patch = UpdateUserRequestSchema.parse(req.body);
      res.json(await d.users.update(currentPrincipal(res), id(req), patch));
    },

    invite: async (req: Request, res: Response) => {
      res.status(201).json(await d.users.invite(currentPrincipal(res), InviteRequestSchema.parse(req.body)));
    },

    listInvites: async (_req: Request, res: Response) => {
      res.json(await d.users.listInvites(currentPrincipal(res)));
    },

    revokeInvite: async (req: Request, res: Response) => {
      await d.users.revokeInvite(currentPrincipal(res), id(req));
      res.status(204).end();
    },
  };
}
