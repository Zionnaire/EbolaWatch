import request from 'supertest';
import { vi } from 'vitest';
import { buildApplication, type Application, type ApplicationOptions } from '../../src/composition.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { OrgType, Role } from '../../src/contracts/api/index.js';
import { OrganizationModel, type OrganizationDoc } from '../../src/models/Organization.js';
import { UserModel, type UserDoc } from '../../src/models/User.js';
import type { Broadcaster } from '../../src/sockets/index.js';
import { signToken } from '../../src/utils/jwt.js';
import { hashPassword } from '../../src/utils/password.js';

export const INGEST_KEY = 'test-ingest-key-0123456789';
export const HASH_SECRET = 'test-hash-secret-0123456789';
export const JWT_SECRET = 'test-jwt-secret-0123456789-0123456789-abcdef';
export const TEST_PASSWORD = 'correct horse battery staple';

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    FRONTEND_URL: 'http://localhost:5173',
    MONGODB_URI: 'mongodb://unused',
    INGEST_API_KEY: INGEST_KEY,
    AUTHOR_HASH_SECRET: HASH_SECRET,
    JWT_SECRET,
    AUTH_RATE_LIMIT_PER_MINUTE: '100000', // tests sign in a lot from one address
    MODEL_MODE: 'mock',
    MODEL_CONTRACT: 'multilabel-v1',
    INGESTION_MODE: 'push', // no synthetic feed in tests
    ...over,
  });
}

export interface RecordedEvent {
  event: string;
  payload: unknown;
}

export function recordingBroadcaster() {
  const events: RecordedEvent[] = [];
  const posts: Array<{ post: unknown; audience: unknown }> = [];
  const disconnected = { orgs: [] as string[], users: [] as string[] };
  const emit = vi.fn((event: string, payload: unknown) => {
    events.push({ event, payload });
  });
  const emitPost = vi.fn((post: unknown, audience: unknown) => {
    events.push({ event: 'post:classified', payload: post });
    posts.push({ post, audience });
  });
  return {
    broadcaster: {
      emit,
      emitPost,
      disconnectOrg: (id: string) => disconnected.orgs.push(id),
      disconnectUser: (id: string) => disconnected.users.push(id),
    } as unknown as Broadcaster,
    events,
    posts,
    disconnected,
    ofType: (t: string) => events.filter((e) => e.event === t),
  };
}

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface TestUser {
  id: string;
  email: string;
  role: Role;
  organizationId: string | null;
  /** A valid access token for this user. */
  token: string;
  headers: { Authorization: string };
}

let passwordHash: Promise<string> | null = null;

export async function createOrg(
  over: Partial<
    Pick<OrganizationDoc, 'name' | 'slug' | 'type' | 'status' | 'scopeStates' | 'settings' | 'region'>
  > = {},
): Promise<OrganizationDoc> {
  const u = unique();
  const doc = await OrganizationModel.create({
    name: over.name ?? `Org ${u}`,
    slug: over.slug ?? `org-${u}`,
    type: (over.type as OrgType | undefined) ?? 'state',
    region: over.region ?? null,
    scopeStates: over.scopeStates ?? [],
    status: over.status ?? 'active',
    settings: over.settings ?? {},
    adminClaimed: true,
  });
  return doc.toObject() as unknown as OrganizationDoc;
}

export async function createUser(
  org: Pick<OrganizationDoc, '_id'> | null,
  role: Role,
  over: { email?: string; password?: string; isActive?: boolean; name?: string } = {},
): Promise<TestUser> {
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const email = over.email ?? `${role}-${unique()}@example.test`;
  const doc = await UserModel.create({
    email,
    name: over.name ?? `Test ${role}`,
    passwordHash: over.password ? await hashPassword(over.password) : await passwordHash,
    role,
    organizationId: org ? org._id : null,
    isActive: over.isActive ?? true,
  });
  return userToken(doc.toObject() as unknown as UserDoc);
}

export function userToken(user: UserDoc, ttlSeconds = 3600): TestUser {
  const token = signToken(
    {
      sub: String(user._id),
      role: user.role,
      org: user.organizationId ? String(user.organizationId) : null,
      tv: user.tokenVersion,
      typ: 'access',
    },
    JWT_SECRET,
    ttlSeconds,
  );
  return {
    id: String(user._id),
    email: user.email,
    role: user.role as Role,
    organizationId: user.organizationId ? String(user.organizationId) : null,
    token,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/** supertest with this user's session on every request. */
export function authed(target: Parameters<typeof request>[0], user: Pick<TestUser, 'headers'>) {
  const base = () => request(target);
  return {
    get: (path: string) => base().get(path).set(user.headers),
    post: (path: string) => base().post(path).set(user.headers),
    patch: (path: string) => base().patch(path).set(user.headers),
    put: (path: string) => base().put(path).set(user.headers),
    delete: (path: string) => base().delete(path).set(user.headers),
  };
}

/**
 * Starts the application against the connected in-memory MongoDB with one default organization (the national
 * body, type `national`) and a supervisor in it. Existing tests use `ctx.api()` as that supervisor; tenancy tests
 * create more organizations with `ctx.makeOrg()` / `ctx.makeUser()`.
 */
export async function startApp(over: Record<string, string> = {}, options: ApplicationOptions = {}) {
  const rec = recordingBroadcaster();
  const config = testConfig(over);
  const application: Application = await buildApplication(config, rec.broadcaster, {
    sweepIntervalMs: 3_600_000,
    ...options,
  });
  await application.start();

  const org = await createOrg({ name: 'NCDC', slug: `ncdc-${unique()}`, type: 'national' });
  const user = await createUser(org, 'supervisor');
  return {
    application,
    config,
    ...rec,
    org,
    user,
    /** The default supervisor's id (used where the old stub user was). */
    userId: user.id,
    /** supertest signed in as the default supervisor. */
    api: () => authed(application.app, user),
    /** supertest with no session. */
    anon: () => request(application.app),
    /** supertest signed in as any user. */
    as: (u: Pick<TestUser, 'headers'>) => authed(application.app, u),
    makeOrg: createOrg,
    makeUser: createUser,
  };
}
