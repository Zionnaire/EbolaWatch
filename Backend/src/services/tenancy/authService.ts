import type { PrincipalLoader } from '../../auth/principalLoader.js';
import { toPrincipal } from '../../auth/principalLoader.js';
import type { PlatformDefaults } from '../../auth/types.js';
import type { ClaimInfoDtoSchema, InviteInfoDtoSchema, MeDto, Role } from '../../contracts/api/index.js';
import type { z } from 'zod';
import { InviteModel, type InviteDoc } from '../../models/Invite.js';
import { OrganizationModel, type OrganizationDoc } from '../../models/Organization.js';
import { CROSS_TENANT } from '../../models/tenantGuard.js';
import { UserModel, type UserDoc } from '../../models/User.js';
import { AppError } from '../../utils/appError.js';
import { logger } from '../../utils/logger.js';
import { signToken, verifyToken } from '../../utils/jwt.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../utils/password.js';
import { hashOpaqueToken } from '../../utils/tokens.js';
import { toMeDto } from './dto.js';

export interface AuthServiceDeps {
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  loader: PrincipalLoader;
  defaults: PlatformDefaults;
  now?: () => Date;
}

export interface Tokens {
  access: string;
  refresh: string;
}

export interface Session {
  tokens: Tokens;
  me: MeDto;
}

const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
const invalidCredentials = () => new AppError(401, 'Invalid email or password', 'invalid_credentials');

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private issue(user: UserDoc): Tokens {
    const claims = {
      sub: String(user._id),
      role: user.role,
      org: user.organizationId ? String(user.organizationId) : null,
      tv: user.tokenVersion,
    };
    const nowMs = this.now().getTime();
    return {
      access: signToken({ ...claims, typ: 'access' }, this.deps.jwtSecret, this.deps.accessTtlSeconds, nowMs),
      refresh: signToken(
        { ...claims, typ: 'refresh' },
        this.deps.jwtSecret,
        this.deps.refreshTtlSeconds,
        nowMs,
      ),
    };
  }

  private async session(user: UserDoc, org: OrganizationDoc | null): Promise<Session> {
    return { tokens: this.issue(user), me: toMeDto(user, org, toPrincipal(user, org), this.deps.defaults) };
  }

  private async orgOf(user: Pick<UserDoc, 'organizationId'>): Promise<OrganizationDoc | null> {
    if (!user.organizationId) return null;
    const org = (await OrganizationModel.findById(
      user.organizationId,
    ).lean()) as unknown as OrganizationDoc | null;
    if (!org) throw invalidCredentials();
    return org;
  }

  private assertOrgActive(org: OrganizationDoc | null): void {
    if (org?.status === 'suspended') {
      throw new AppError(
        403,
        'This organization is suspended. Contact the platform administrator.',
        'organization_suspended',
      );
    }
  }

  /**
   * Email + password. The same error for an unknown email and a wrong password, at the same cost, so the endpoint
   * does not reveal which emails exist. Disabled accounts and suspended organizations are refused here and on
   * every later request.
   */
  async login(email: string, password: string): Promise<Session> {
    const user = (await UserModel.findOne({ email }).lean()) as unknown as UserDoc | null;
    if (!user) {
      await burnPasswordCheck(password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(password, user.passwordHash))) throw invalidCredentials();
    if (!user.isActive) throw new AppError(403, 'This account is disabled', 'account_disabled');
    const org = await this.orgOf(user);
    this.assertOrgActive(org);
    await UserModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: this.now() } });
    return this.session({ ...user, lastLoginAt: this.now() }, org);
  }

  /** New tokens from a valid refresh token, re-checking the user and the organization as login does. */
  async refresh(refreshToken: string): Promise<Session> {
    const claims = verifyToken(refreshToken, this.deps.jwtSecret, 'refresh', this.now().getTime());
    await this.deps.loader.load(claims.sub, claims.tv); // active user, matching tokenVersion, active organization
    const user = (await UserModel.findById(claims.sub).lean()) as unknown as UserDoc;
    return this.session(user, await this.orgOf(user));
  }

  async me(userId: string): Promise<MeDto> {
    const user = (await UserModel.findById(userId).lean()) as unknown as UserDoc | null;
    if (!user) throw new AppError(401, 'Your session is no longer valid', 'session_invalid');
    const org = await this.orgOf(user);
    return toMeDto(user, org, toPrincipal(user, org), this.deps.defaults);
  }

  async changePassword(userId: string, current: string, next: string): Promise<Session> {
    const user = (await UserModel.findById(userId).lean()) as unknown as UserDoc | null;
    if (!user || !(await verifyPassword(current, user.passwordHash))) {
      throw new AppError(400, 'The current password is not correct', 'wrong_password');
    }
    // a new tokenVersion signs out every other session
    const updated = (await UserModel.findOneAndUpdate(
      { _id: user._id },
      { $set: { passwordHash: await hashPassword(next) }, $inc: { tokenVersion: 1 } },
      { returnDocument: 'after' },
    ).lean()) as unknown as UserDoc;
    this.deps.loader.invalidateUser(String(user._id));
    return this.session(updated, await this.orgOf(updated));
  }

  // ---------------------------------------------------------------- claim link

  private async findClaimable(token: string): Promise<OrganizationDoc> {
    const org = (await OrganizationModel.findOne({
      'claim.tokenHash': hashOpaqueToken(token),
      'claim.expiresAt': { $gt: this.now() },
      adminClaimed: false,
    }).lean()) as unknown as OrganizationDoc | null;
    // one message for unknown, expired and already-used links
    if (!org) throw new AppError(404, 'This link is invalid or has expired', 'invalid_link');
    return org;
  }

  async claimInfo(token: string): Promise<z.infer<typeof ClaimInfoDtoSchema>> {
    const org = await this.findClaimable(token);
    return {
      organization: { name: org.name, slug: org.slug, type: org.type as 'national' },
      expiresAt: org.claim!.expiresAt.toISOString(),
    };
  }

  /**
   * The first admin of an organization registers through its claim link. The link is consumed atomically (one
   * winner if two people open it at once) and restored if the registration then fails (e.g. the email is taken).
   */
  async claim(token: string, input: { name: string; email: string; password: string }): Promise<Session> {
    const consumed = (await OrganizationModel.findOneAndUpdate(
      {
        'claim.tokenHash': hashOpaqueToken(token),
        'claim.expiresAt': { $gt: this.now() },
        adminClaimed: false,
      },
      { $set: { adminClaimed: true, claim: null, updatedAt: this.now() } },
      { returnDocument: 'before' },
    ).lean()) as unknown as OrganizationDoc | null;
    if (!consumed) throw new AppError(404, 'This link is invalid or has expired', 'invalid_link');

    try {
      const user = await UserModel.create({
        email: input.email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        role: 'org_admin' satisfies Role,
        organizationId: consumed._id,
        createdBy: 'claim-link',
      });
      logger.info({ organizationId: String(consumed._id), userId: String(user._id) }, 'organization claimed');
      const org = { ...consumed, adminClaimed: true, claim: null };
      return this.session(user.toObject() as unknown as UserDoc, org);
    } catch (err) {
      await OrganizationModel.updateOne(
        { _id: consumed._id },
        { $set: { adminClaimed: false, claim: consumed.claim } },
      );
      if (isDuplicateKey(err))
        throw new AppError(409, 'An account with this email already exists', 'email_taken');
      throw err;
    }
  }

  // -------------------------------------------------------------------- invites

  private async findInvite(token: string): Promise<InviteDoc> {
    // looked up by the secret itself, so this is the one legitimate query that does not know the tenant yet
    const invite = (await InviteModel.findOne({
      tokenHash: hashOpaqueToken(token),
      usedAt: null,
      expiresAt: { $gt: this.now() },
    })
      .setOptions(CROSS_TENANT)
      .lean()) as unknown as InviteDoc | null;
    if (!invite) throw new AppError(404, 'This link is invalid or has expired', 'invalid_link');
    return invite;
  }

  async inviteInfo(token: string): Promise<z.infer<typeof InviteInfoDtoSchema>> {
    const invite = await this.findInvite(token);
    const org = (await OrganizationModel.findById(
      invite.organizationId,
    ).lean()) as unknown as OrganizationDoc | null;
    if (!org) throw new AppError(404, 'This link is invalid or has expired', 'invalid_link');
    return {
      organization: { name: org.name },
      email: invite.email,
      role: invite.role as 'analyst',
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /** The role and organization come from the invite, never from the person accepting it. */
  async acceptInvite(token: string, input: { name: string; password: string }): Promise<Session> {
    const consumed = (await InviteModel.findOneAndUpdate(
      { tokenHash: hashOpaqueToken(token), usedAt: null, expiresAt: { $gt: this.now() } },
      { $set: { usedAt: this.now() } },
      { returnDocument: 'before' },
    )
      .setOptions(CROSS_TENANT)
      .lean()) as unknown as InviteDoc | null;
    if (!consumed) throw new AppError(404, 'This link is invalid or has expired', 'invalid_link');

    const release = () =>
      InviteModel.updateOne(
        { _id: consumed._id, organizationId: consumed.organizationId },
        { $set: { usedAt: null } },
      );
    try {
      const org = (await OrganizationModel.findById(
        consumed.organizationId,
      ).lean()) as unknown as OrganizationDoc | null;
      if (!org) throw new AppError(404, 'This link is invalid or has expired', 'invalid_link');
      this.assertOrgActive(org);
      const user = await UserModel.create({
        email: consumed.email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        role: consumed.role,
        organizationId: consumed.organizationId,
        createdBy: consumed.invitedBy,
      });
      return this.session(user.toObject() as unknown as UserDoc, org);
    } catch (err) {
      await release();
      if (isDuplicateKey(err))
        throw new AppError(409, 'An account with this email already exists', 'email_taken');
      throw err;
    }
  }
}
