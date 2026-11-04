import { Types } from 'mongoose';
import type { z } from 'zod';
import type { PrincipalLoader } from '../../auth/principalLoader.js';
import type { Principal } from '../../auth/types.js';
import {
  INVITABLE_ROLES,
  type InviteDtoSchema,
  type InviteResponseSchema,
  type UserDto,
} from '../../contracts/api/index.js';
import { InviteModel, type InviteDoc } from '../../models/Invite.js';
import { UserModel, type UserDoc } from '../../models/User.js';
import { AppError } from '../../utils/appError.js';
import { logger } from '../../utils/logger.js';
import { newOpaqueToken } from '../../utils/tokens.js';
import { parseObjectId } from '../review.js';
import { toUserDto } from './dto.js';

export const INVITE_DAYS = 7;

export interface UserServiceDeps {
  frontendUrl: string;
  loader: PrincipalLoader;
  /** Called when a user is disabled or changed, so their live socket connections are dropped at once. */
  onUserChanged?: (userId: string) => void;
  now?: () => Date;
}

type InviteDto = z.infer<typeof InviteDtoSchema>;

const toInviteDto = (i: InviteDoc): InviteDto => ({
  id: String(i._id),
  email: i.email,
  role: i.role as InviteDto['role'],
  expiresAt: i.expiresAt.toISOString(),
  usedAt: i.usedAt ? i.usedAt.toISOString() : null,
  createdAt: i.createdAt.toISOString(),
});

/**
 * Staff of one organization. Every query is pinned to the CALLER's organization (never one supplied by the client),
 * so an org admin can neither see nor touch another organization's people.
 */
export class UserService {
  constructor(private readonly deps: UserServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private orgId(p: Principal): Types.ObjectId {
    if (!p.organizationId)
      throw new AppError(403, 'This action must be done as a member of an organization', 'org_required');
    return new Types.ObjectId(p.organizationId);
  }

  async list(p: Principal): Promise<UserDto[]> {
    const users = (await UserModel.find({ organizationId: this.orgId(p) })
      .sort({ createdAt: 1 })
      .lean()) as unknown as UserDoc[];
    return users.map(toUserDto);
  }

  /**
   * Change a colleague's role or disable them. An org admin cannot touch themselves (no accidental lockout),
   * another admin, or anyone outside their organization. A role change or deactivation revokes that person's
   * tokens immediately.
   */
  async update(
    p: Principal,
    userId: string,
    patch: { role?: (typeof INVITABLE_ROLES)[number]; isActive?: boolean },
  ): Promise<UserDto> {
    const orgId = this.orgId(p);
    const target = (await UserModel.findOne({
      _id: parseObjectId(userId),
      organizationId: orgId,
    }).lean()) as unknown as UserDoc | null;
    if (!target) throw new AppError(404, 'User not found', 'user_not_found');
    if (String(target._id) === p.userId)
      throw new AppError(400, 'You cannot change your own role or disable yourself', 'self_change');
    if (target.role === 'org_admin' || target.role === 'super_admin') {
      throw new AppError(403, 'Administrators cannot be changed here', 'forbidden');
    }

    const set: Record<string, unknown> = {};
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.isActive !== undefined) set.isActive = patch.isActive;
    const revoke = (patch.role !== undefined && patch.role !== target.role) || patch.isActive === false;
    const updated = (await UserModel.findOneAndUpdate(
      { _id: target._id, organizationId: orgId },
      { $set: set, ...(revoke ? { $inc: { tokenVersion: 1 } } : {}) },
      { returnDocument: 'after' },
    ).lean()) as unknown as UserDoc;
    this.deps.loader.invalidateUser(String(target._id));
    this.deps.onUserChanged?.(String(target._id));
    logger.info({ by: p.userId, userId: String(target._id), patch }, 'user updated');
    return toUserDto(updated);
  }

  // -------------------------------------------------------------------- invites

  async invite(
    p: Principal,
    input: { email: string; role: (typeof INVITABLE_ROLES)[number] },
  ): Promise<z.infer<typeof InviteResponseSchema>> {
    const orgId = this.orgId(p);
    if (!(INVITABLE_ROLES as readonly string[]).includes(input.role)) {
      throw new AppError(
        403,
        'That role cannot be invited. Administrators are created through the claim link.',
        'forbidden',
      );
    }
    if (await UserModel.exists({ email: input.email })) {
      throw new AppError(409, 'An account with this email already exists', 'email_taken');
    }
    const { token, hash } = newOpaqueToken();
    const expiresAt = new Date(this.now().getTime() + INVITE_DAYS * 86_400_000);
    const doc = await InviteModel.create({
      tokenHash: hash,
      organizationId: orgId, // from the caller, never from the request body
      email: input.email,
      role: input.role,
      invitedBy: p.userId,
      expiresAt,
    });
    return {
      invite: toInviteDto(doc.toObject() as unknown as InviteDoc),
      link: {
        token,
        url: `${this.deps.frontendUrl.replace(/\/$/, '')}/accept-invite/${token}`,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  async listInvites(p: Principal): Promise<InviteDto[]> {
    const rows = (await InviteModel.find({
      organizationId: this.orgId(p),
      usedAt: null,
      expiresAt: { $gt: this.now() },
    })
      .sort({ createdAt: -1 })
      .lean()) as unknown as InviteDoc[];
    return rows.map(toInviteDto);
  }

  async revokeInvite(p: Principal, inviteId: string): Promise<void> {
    const res = await InviteModel.deleteOne({
      _id: parseObjectId(inviteId),
      organizationId: this.orgId(p),
      usedAt: null,
    });
    if (res.deletedCount === 0) throw new AppError(404, 'Invitation not found', 'invite_not_found');
  }
}
