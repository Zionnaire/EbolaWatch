/**
 * Multi-tenancy: sign-in, one-time links, roles, suspension, and the cross-tenant matrix. Posts are global; reviews,
 * counter-narratives, dispatches, users and settings belong to one organization, and no other organization's token
 * may read or change them: 404 by id, absent from lists, absent from analytics.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaimInfoDtoSchema,
  CreateOrganizationResponseSchema,
  InviteResponseSchema,
  MeDtoSchema,
} from '../src/contracts/api/index.js';
import { PostModel } from '../src/models/Post.js';
import { UserModel } from '../src/models/User.js';
import { CounterNarrativeModel, DispatchModel, InviteModel } from './helpers/anyTenant.js';
import { createOrg, createUser, startApp, TEST_PASSWORD } from './helpers/app.js';
import { clearCollections, DATA_COLLECTIONS, useMongo } from './helpers/mongo.js';
import { seedPost, setSeedOrg } from './helpers/seed.js';

useMongo();

type Started = Awaited<ReturnType<typeof startApp>>;
let ctx: Started;
beforeAll(async () => {
  ctx = await startApp();
}, 120_000);
afterAll(async () => ctx.application.stop());
beforeEach(async () => {
  await clearCollections([...DATA_COLLECTIONS, 'invites']);
  setSeedOrg(null);
});

const pid = (s: { post: unknown }) => String((s.post as { _id: unknown })._id);
const oid = () => new mongoose.Types.ObjectId();
const narrativeFor = (organizationId: mongoose.Types.ObjectId | string, over: Record<string, unknown> = {}) =>
  CounterNarrativeModel.create({
    organizationId,
    source: 'generated',
    platform: 'x',
    charLimit: 280,
    requestedLanguage: 'en',
    language: 'en',
    text: 'a counter narrative',
    textHash: `h-${String(oid())}`,
    status: 'draft',
    generator: { name: 'mock-generator', mode: 'mock' },
    isMock: true,
    createdBy: 'seed',
    ...over,
  });

describe('sign-in and sessions', () => {
  it('logs in with email and password, sets HttpOnly cookies and never returns the tokens', async () => {
    const u = await createUser(ctx.org, 'analyst');
    const res = await ctx.anon().post('/api/auth/login').send({ email: u.email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(MeDtoSchema.parse(res.body).user.email).toBe(u.email);
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ/);
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/ew_access=/);
    expect(cookies).toMatch(/ew_refresh=[^\n]*Path=\/api\/auth/);
    expect(cookies).toMatch(/HttpOnly/i);
  });

  it('a wrong password and an unknown email look the same', async () => {
    const u = await createUser(ctx.org, 'analyst');
    const a = await ctx.anon().post('/api/auth/login').send({ email: u.email, password: 'wrong-password-1' });
    const b = await ctx
      .anon()
      .post('/api/auth/login')
      .send({ email: 'nobody@example.test', password: 'wrong-password-1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('a deactivated user is locked out at once, not after the token expires', async () => {
    const u = await createUser(ctx.org, 'analyst');
    expect((await ctx.as(u).get('/api/posts')).status).toBe(200);
    await UserModel.updateOne({ _id: u.id }, { isActive: false });
    ctx.application.loader.invalidateUser(u.id);
    expect((await ctx.as(u).get('/api/posts')).status).toBe(401);
  });

  it('a malformed or tampered token is refused', async () => {
    const u = await createUser(ctx.org, 'analyst');
    const bad = `${u.token.slice(0, -3)}abc`;
    expect((await ctx.anon().get('/api/posts').set('Authorization', `Bearer ${bad}`)).status).toBe(401);
    expect((await ctx.anon().get('/api/posts').set('Authorization', 'Bearer nonsense')).status).toBe(401);
  });

  it('cookie sessions refuse a state-changing request from a foreign origin', async () => {
    const u = await createUser(ctx.org, 'analyst');
    const res = await ctx
      .anon()
      .post('/api/auth/change-password')
      .set('Cookie', `ew_access=${u.token}`)
      .set('Origin', 'https://evil.example')
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'another long passphrase' });
    expect(res.status).toBe(403);
  });

  it('changing a password revokes the older sessions', async () => {
    const u = await createUser(ctx.org, 'analyst');
    const res = await ctx
      .as(u)
      .post('/api/auth/change-password')
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'another long passphrase' });
    expect(res.status).toBeLessThan(300);
    ctx.application.loader.invalidateUser(u.id);
    expect((await ctx.as(u).get('/api/posts')).status).toBe(401);
  });
});

describe('organizations, claim links and invites', () => {
  it('only the platform operator creates organizations; a tenant supervisor cannot', async () => {
    const body = { name: 'Lagos State', type: 'state', scopeStates: ['Lagos'] };
    expect((await ctx.api().post('/api/organizations').send(body)).status).toBe(403);
    expect((await ctx.anon().post('/api/organizations').send(body)).status).toBe(401);
  });

  it('create -> claim link -> first org admin -> invite -> accept, each link single-use', async () => {
    const boss = await createUser(null, 'super_admin');
    const created = CreateOrganizationResponseSchema.parse(
      (await ctx.as(boss).post('/api/organizations').send({ name: 'Lagos State', type: 'state' })).body,
    );
    const token = created.claimLink.token;

    // only a hash of the token is stored
    expect(
      JSON.stringify(await mongoose.connection.db!.collection('organizations').find().toArray()),
    ).not.toContain(token);
    expect(
      ClaimInfoDtoSchema.parse((await ctx.anon().get(`/api/auth/claim/${token}`)).body).organization.slug,
    ).toBe(created.organization.slug);

    const claim = await ctx
      .anon()
      .post(`/api/auth/claim/${token}`)
      .send({ name: 'Ada Admin', email: 'ada@lagos.example', password: 'a long enough password' });
    expect(claim.status).toBe(201);
    expect(MeDtoSchema.parse(claim.body).user.role).toBe('org_admin');

    // single use
    const again = await ctx
      .anon()
      .post(`/api/auth/claim/${token}`)
      .send({ name: 'Eve', email: 'eve@example.test', password: 'a long enough password' });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect((await ctx.anon().get(`/api/auth/claim/${token}`)).status).toBeGreaterThanOrEqual(400);

    // the new org admin invites an analyst
    const login = await ctx
      .anon()
      .post('/api/auth/login')
      .send({ email: 'ada@lagos.example', password: 'a long enough password' });
    const cookie = (login.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';')[0])
      .join('; ');
    const invite = InviteResponseSchema.parse(
      (
        await request(ctx.application.app)
          .post('/api/users-invites')
          .set('Cookie', cookie)
          .send({ email: 'sam@lagos.example', role: 'analyst' })
      ).body,
    );
    const accepted = await ctx
      .anon()
      .post(`/api/auth/invite/${invite.link.token}`)
      .send({ name: 'Sam Analyst', password: 'a long enough password' });
    expect(accepted.status).toBeLessThan(300);
    expect(MeDtoSchema.parse(accepted.body).user.role).toBe('analyst');
    expect(
      (
        await ctx
          .anon()
          .post(`/api/auth/invite/${invite.link.token}`)
          .send({ name: 'Sam Again', password: 'a long enough password' })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('an expired claim link is refused', async () => {
    const boss = await createUser(null, 'super_admin');
    const created = CreateOrganizationResponseSchema.parse(
      (await ctx.as(boss).post('/api/organizations').send({ name: 'Kano State', type: 'state' })).body,
    );
    await mongoose.connection
      .db!.collection('organizations')
      .updateOne(
        { slug: created.organization.slug },
        { $set: { 'claim.expiresAt': new Date(Date.now() - 1000) } },
      );
    const res = await ctx.anon().get(`/api/auth/claim/${created.claimLink.token}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('an org admin cannot invite a super admin or an org admin, nor touch another organization', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const adminA = await createUser(orgA, 'org_admin');
    const victimB = await createUser(orgB, 'analyst');
    expect(
      (await ctx.as(adminA).post('/api/users-invites').send({ email: 'x@example.test', role: 'super_admin' }))
        .status,
    ).toBe(400);
    expect((await ctx.as(adminA).patch(`/api/users/${victimB.id}`).send({ isActive: false })).status).toBe(
      404,
    );
    expect((await UserModel.findById(victimB.id))?.isActive).toBe(true);
    // and lists only show their own staff
    const list = await ctx.as(adminA).get('/api/users');
    expect(JSON.stringify(list.body)).not.toContain(victimB.email);
  });

  it('settings reject unknown keys instead of mass-assigning them', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'org_admin');
    const res = await ctx
      .as(admin)
      .patch('/api/organizations/me/settings')
      .send({ status: 'trial', type: 'national' });
    expect(res.status).toBe(400);
    const ok = await ctx.as(admin).patch('/api/organizations/me/settings').send({ overdueHours: 24 });
    expect(ok.status).toBe(200);
  });

  it('invites are not reachable by another organization (guard applies to the invite store too)', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const adminA = await createUser(orgA, 'org_admin');
    const adminB = await createUser(orgB, 'org_admin');
    const invite = InviteResponseSchema.parse(
      (await ctx.as(adminA).post('/api/users-invites').send({ email: 'n@example.test', role: 'analyst' }))
        .body,
    );
    expect((await ctx.as(adminB).delete(`/api/users-invites/${invite.invite.id}`)).status).toBe(404);
    expect(await InviteModel.countDocuments({ _id: invite.invite.id })).toBe(1);
    expect(JSON.stringify((await ctx.as(adminB).get('/api/users-invites')).body)).not.toContain(
      'n@example.test',
    );
  });
});

describe('roles', () => {
  it('a plain analyst can draft but not approve or dispatch; the super admin never acts inside a tenant', async () => {
    const org = await createOrg();
    const analyst = await createUser(org, 'analyst');
    const boss = await createUser(null, 'super_admin');
    const n = await narrativeFor(org._id);
    expect((await ctx.as(analyst).post(`/api/narratives/${n._id}/approve`).send({})).status).toBe(403);
    expect((await ctx.as(analyst).post(`/api/narratives/${n._id}/dispatch`).send({})).status).toBe(403);
    expect((await ctx.as(boss).get('/api/narratives')).status).toBe(403);
    expect((await ctx.as(analyst).get('/api/organizations')).status).toBe(403);
  });

  it('only a national organization may change the operating mode', async () => {
    const state = await createOrg({ type: 'state' });
    const stateSup = await createUser(state, 'supervisor');
    expect((await ctx.as(stateSup).post('/api/admin/mode').send({ mode: 'surge' })).status).toBe(403);
    expect((await ctx.api().post('/api/admin/mode').send({ mode: 'surge' })).status).toBe(200);
    await ctx.api().post('/api/admin/mode').send({ mode: 'dormant' });
  });
});

describe('cross-tenant matrix: org A data is invisible to org B', () => {
  async function twoOrgs() {
    const orgA = await createOrg({ name: 'Org A' });
    const orgB = await createOrg({ name: 'Org B' });
    const a = await createUser(orgA, 'supervisor');
    const b = await createUser(orgB, 'supervisor');
    return { orgA, orgB, a, b };
  }

  it('narratives and dispatches: 404 by id for every verb, absent from lists', async () => {
    const { orgA, a, b } = await twoOrgs();
    const n = await narrativeFor(orgA._id, { status: 'approved' });
    const id = String(n._id);
    await DispatchModel.create({
      organizationId: orgA._id,
      narrativeId: n._id,
      platform: 'x',
      text: 't',
      textHash: 'h',
      status: 'sent',
      approvedBy: 'a',
      approvalReviewId: oid(),
      dispatchedBy: 'd',
      dispatcher: { name: 'mock-dispatcher', mode: 'mock' },
      isMock: true,
    });

    // sanity: A sees them
    expect((await ctx.as(a).get(`/api/narratives/${id}`)).status).toBe(200);
    expect((await ctx.as(a).get('/api/narratives')).body.items).toHaveLength(1);
    expect(JSON.stringify((await ctx.as(a).get('/api/dispatches')).body)).toContain(id);

    const calls = [
      ctx.as(b).get(`/api/narratives/${id}`),
      ctx.as(b).patch(`/api/narratives/${id}`).send({ text: 'hijack' }),
      ctx.as(b).post(`/api/narratives/${id}/regenerate`).send({}),
      ctx.as(b).post(`/api/narratives/${id}/approve`).send({}),
      ctx.as(b).post(`/api/narratives/${id}/reject`).send({}),
      ctx.as(b).post(`/api/narratives/${id}/dispatch`).send({}),
    ];
    for (const r of await Promise.all(calls)) expect(r.status).toBe(404);

    expect((await ctx.as(b).get('/api/narratives')).body.items).toHaveLength(0);
    expect((await ctx.as(b).get('/api/dispatches')).body.items).toHaveLength(0);
    // nothing of A's changed
    const after = await CounterNarrativeModel.findById(id);
    expect(after?.text).toBe('a counter narrative');
    expect(after?.status).toBe('approved');
  });

  it('review state is per organization: A reviewing a post leaves it unreviewed for B', async () => {
    const { orgA, orgB, a, b } = await twoOrgs();
    setSeedOrg(orgA._id);
    const s = await seedPost({ queue: 'review' });
    const postId = pid(s);

    const res = await ctx.as(a).post(`/api/posts/${postId}/review`).send({ decision: 'confirmed' });
    expect(res.status).toBeLessThan(300);

    const forA = (await ctx.as(a).get(`/api/posts/${postId}`)).body;
    const forB = (await ctx.as(b).get(`/api/posts/${postId}`)).body;
    expect(forA.post.reviewStatus).toBe('confirmed');
    expect(forB.post.reviewStatus).not.toBe('confirmed');
    expect(JSON.stringify(forB)).not.toContain(String(orgA._id));
    expect(JSON.stringify(forB.reviews ?? [])).not.toContain(a.id);

    // the post's own stored review state names only A
    const stored = await PostModel.findById(postId).lean();
    expect(Object.keys((stored as unknown as { orgState: object }).orgState)).toEqual([String(orgA._id)]);
    expect(String(orgB._id)).not.toBe(String(orgA._id));
  });

  it("analytics: B's queue and model-health do not move when A reviews", async () => {
    const { orgA, a, b } = await twoOrgs();
    setSeedOrg(orgA._id);
    const s = await seedPost({ queue: 'review', ingestedAt: new Date(Date.now() - 60 * 60_000) });
    const before = (await ctx.as(b).get('/api/analytics/summary')).body.queue.review;
    await ctx
      .as(a)
      .post(`/api/posts/${pid(s)}/review`)
      .send({ decision: 'confirmed' });
    expect((await ctx.as(a).get('/api/analytics/summary')).body.queue.review).toBe(before - 1);
    expect((await ctx.as(b).get('/api/analytics/summary')).body.queue.review).toBe(before);
    const mh = (await ctx.as(b).get('/api/analytics/model-health')).body;
    expect(JSON.stringify(mh)).not.toMatch(/"reviewed":[1-9]/);
  });

  it('org-visible posts belong to their organization; global posts to everyone', async () => {
    const { orgA, a, b } = await twoOrgs();
    const global = await seedPost({ queue: 'review' });
    const own = await seedPost({ queue: 'review', visibility: 'org', organizationId: orgA._id });

    const idsOf = async (u: typeof a) =>
      ((await ctx.as(u).get('/api/posts?pageSize=100')).body.items as Array<{ id: string }>).map((p) => p.id);
    expect(await idsOf(a)).toEqual(expect.arrayContaining([pid(global), pid(own)]));
    const forB = await idsOf(b);
    expect(forB).toContain(pid(global));
    expect(forB).not.toContain(pid(own));
    expect((await ctx.as(b).get(`/api/posts/${pid(own)}`)).status).toBe(404);
    expect((await ctx.as(a).get(`/api/posts/${pid(own)}`)).status).toBe(200);
  });

  it('a state team only sees posts from its scope states', async () => {
    const lagos = await createOrg({ type: 'state', scopeStates: ['Lagos'] });
    const u = await createUser(lagos, 'analyst');
    const inScope = await seedPost({ queue: 'review', state: 'Lagos' });
    const outOfScope = await seedPost({ queue: 'review', state: 'Kano' });
    const ids = ((await ctx.as(u).get('/api/posts?pageSize=100')).body.items as Array<{ id: string }>).map(
      (p) => p.id,
    );
    expect(ids).toContain(pid(inScope));
    expect(ids).not.toContain(pid(outOfScope));
    expect((await ctx.as(u).get(`/api/posts/${pid(outOfScope)}`)).status).toBe(404);
  });

  it('generating a counter-narrative for a post the org cannot see is a 404', async () => {
    const { orgA, b } = await twoOrgs();
    const own = await seedPost({ queue: 'review', visibility: 'org', organizationId: orgA._id });
    const res = await ctx
      .as(b)
      .post('/api/narratives/generate')
      .send({ postId: pid(own), platform: 'x' });
    expect(res.status).toBe(404);
    expect(await CounterNarrativeModel.countDocuments()).toBe(0);
  });
});

describe('the tenant guard', () => {
  it('a query on a tenant-owned model without a tenant condition throws; with one it runs', async () => {
    const { CounterNarrativeModel: Real } = await import('../src/models/CounterNarrative.js');
    const org = oid();
    await expect(Real.find({}).exec()).rejects.toThrow(/tenant/i);
    await expect(Real.countDocuments({}).exec()).rejects.toThrow(/tenant/i);
    await expect(Real.find({ organizationId: org }).exec()).resolves.toEqual([]);
    await expect(Real.aggregate([{ $match: {} }]).exec()).rejects.toThrow(/organizationId/);
  });

  it('a by-id lookup is scoped: the right id in the wrong organization finds nothing', async () => {
    const { CounterNarrativeModel: Real } = await import('../src/models/CounterNarrative.js');
    const orgA = oid();
    const n = await narrativeFor(orgA);
    expect(await Real.findOne({ _id: n._id, organizationId: orgA })).not.toBeNull();
    expect(await Real.findOne({ _id: n._id, organizationId: oid() })).toBeNull();
  });
});

describe('suspension', () => {
  it('a suspended organization is locked out at once and its sockets are dropped', async () => {
    const org = await createOrg();
    const u = await createUser(org, 'analyst');
    const boss = await createUser(null, 'super_admin');
    expect((await ctx.as(u).get('/api/posts')).status).toBe(200);

    const res = await ctx
      .as(boss)
      .patch(`/api/organizations/${String(org._id)}/status`)
      .send({ status: 'suspended' });
    expect(res.status).toBe(200);
    expect((await ctx.as(u).get('/api/posts')).status).toBe(403);
    expect(ctx.disconnected.orgs).toContain(String(org._id));

    // login is refused too, and reinstating restores access
    const login = await ctx.anon().post('/api/auth/login').send({ email: u.email, password: TEST_PASSWORD });
    expect(login.status).toBeGreaterThanOrEqual(401);
    await ctx
      .as(boss)
      .patch(`/api/organizations/${String(org._id)}/status`)
      .send({ status: 'active' });
    expect((await ctx.as(u).get('/api/posts')).status).toBe(200);
  });
});
