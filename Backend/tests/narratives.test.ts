import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DispatchDtoSchema,
  DispatchListDtoSchema,
  NarrativeConfigDtoSchema,
  NarrativeDetailDtoSchema,
  NarrativeListDtoSchema,
  SystemStatusSchema,
} from '../src/contracts/api/index.js';
import { MockDispatcher } from '../src/services/narratives/dispatchService.js';
import { MockGenerator } from '../src/services/narratives/mockGenerator.js';
import { textHash } from '../src/utils/hashing.js';
import { CounterNarrativeModel, DispatchModel, NarrativeReviewModel } from './helpers/anyTenant.js';
import { startApp } from './helpers/app.js';
import { clearCollections, DATA_COLLECTIONS, useMongo } from './helpers/mongo.js';
import { seedPost } from './helpers/seed.js';

useMongo();

type Started = Awaited<ReturnType<typeof startApp>>;
let ctx: Started;
let dispatcher: MockDispatcher;
const api = () => ctx.api();

beforeAll(async () => {
  ctx = await startApp();
  dispatcher = ctx.application.dispatcher as MockDispatcher;
}, 120_000);
afterAll(async () => ctx.application.stop());
beforeEach(async () => {
  await clearCollections(DATA_COLLECTIONS);
  dispatcher.sent.length = 0;
  dispatcher.failNext = null;
});

const gen = (body: Record<string, unknown>) => api().post('/api/narratives/generate').send(body);
const edit = (id: string, text: string) => api().patch(`/api/narratives/${id}`).send({ text });
const post = (id: string, action: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/narratives/${id}/${action}`).send(body);
const detail = async (id: string) => (await api().get(`/api/narratives/${id}`)).body;
const native = (name: string) => mongoose.connection.db!.collection(name);

/** Generates a draft for a freshly seeded post and returns ids. */
async function draftFor(over: Record<string, unknown> = {}, seed: Parameters<typeof seedPost>[0] = {}) {
  const { post: p } = await seedPost({
    platform: 'x',
    text: 'Drink salt water and you cannot get Ebola',
    ...seed,
  });
  const res = await gen({ postId: String(p._id), ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { postId: String(p._id), id: res.body.narrative.id as string, body: res.body };
}

async function approvedNarrative() {
  const d = await draftFor();
  const res = await post(d.id, 'approve', { note: 'checked against NCDC guidance' });
  expect(res.status).toBe(200);
  return d;
}

describe('generate (drafting only, never sends)', () => {
  it('drafts a counter-narrative for a post: fits the platform, cites NCDC/WHO, records provenance', async () => {
    const { body, postId } = await draftFor();
    const detail = NarrativeDetailDtoSchema.parse(body);
    const n = detail.narrative;
    expect(n).toMatchObject({
      postId,
      source: 'post',
      platform: 'x',
      charLimit: 280,
      status: 'draft',
      category: 'fake_cure_prevention',
      taxonomyVersion: 'ebola-tax-1.0',
      claim: 'Drink salt water and you cannot get Ebola',
      language: 'en',
      requestedLanguage: 'en',
      approval: null,
      isMock: true,
      createdBy: ctx.userId,
      generator: { name: 'mock-generator', version: '0.0.0-mock', mode: 'mock' },
    });
    expect(n.text.length).toBeLessThanOrEqual(280);
    expect(n.text).toContain('salt water');
    expect(n.citations.map((c) => c.source)).toEqual(['NCDC', 'WHO']);
    expect(n.versions).toHaveLength(1);
    expect(n.versions[0]).toMatchObject({ kind: 'generated', text: n.text, by: 'generator:mock-generator' });
    expect(detail.reviews).toEqual([]);
    expect(detail.dispatch).toBeNull();
  });

  it('defaults the platform and language from the post and its classification', async () => {
    const { post: p } = await seedPost({ platform: 'bluesky', language: 'yo' });
    const n = (await gen({ postId: String(p._id) })).body.narrative;
    expect(n.platform).toBe('bluesky');
    expect(n.charLimit).toBe(300);
    expect(n.requestedLanguage).toBe('yo');
    expect(n.language).toBe('en'); // the mock only writes English...
    expect(n.warnings.join(' ')).toContain('only drafts in English'); // ...and says so
  });

  it('uses the category from the decision (top over-threshold category), and honours an explicit one', async () => {
    const { post: p } = await seedPost({
      platform: 'x',
      categories: ['burial_resistance', 'fake_cure_prevention'],
    });
    expect((await gen({ postId: String(p._id) })).body.narrative.category).toBe('burial_resistance');
    expect((await gen({ postId: String(p._id), category: 'outbreak_denial' })).body.narrative.category).toBe(
      'outbreak_denial',
    );
  });

  it('manual narrative: needs a claim and a platform; the claim is PII-scrubbed before it is stored', async () => {
    const res = await gen({
      claim: '@ayo_k says call 0803 123 4567 or see https://x.example/p',
      platform: 'bluesky',
      category: 'false_case_report',
    });
    expect(res.status).toBe(201);
    expect(res.body.narrative).toMatchObject({
      source: 'manual',
      postId: null,
      platform: 'bluesky',
      category: 'false_case_report',
    });
    expect(res.body.narrative.claim).toBe('[handle] says call [phone] or see [url]');
    expect((await gen({ claim: 'text only' })).status).toBe(400);
    expect((await gen({ platform: 'x' })).status).toBe(400);
  });

  it('manual narrative without a category gets a general draft and says so', async () => {
    const n = (await gen({ claim: 'some rumour', platform: 'x' })).body.narrative;
    expect(n.category).toBeNull();
    expect(n.warnings.join(' ')).toContain('general statement');
  });

  it('rejects unknown platforms, unknown categories, unknown or malformed posts, and out-of-run posts', async () => {
    const { post: p } = await seedPost();
    const badPlatform = await gen({ postId: String(p._id), platform: 'myspace' });
    expect(badPlatform.status).toBe(400);
    expect(badPlatform.body.error.code).toBe('unknown_platform');
    const badCategory = await gen({ postId: String(p._id), category: 'not_a_category' });
    expect(badCategory.status).toBe(400);
    expect(badCategory.body.error.code).toBe('invalid_category');
    expect((await gen({ postId: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
    expect((await gen({ postId: 'nope' })).status).toBe(400);
    const real = await seedPost({ isMock: false });
    expect((await gen({ postId: String(real.post._id) })).status).toBe(404);
    expect(await CounterNarrativeModel.countDocuments()).toBe(0);
  });

  it('an unclassified post can still be answered (no category, English)', async () => {
    const { post: p } = await seedPost({ classified: false, platform: 'x' });
    const n = (await gen({ postId: String(p._id) })).body.narrative;
    expect(n.category).toBeNull();
    expect(n.requestedLanguage).toBe('en');
  });
});

describe('edit and regenerate', () => {
  it('edit: updates the text, trims it, appends a version attributed to the analyst', async () => {
    const { id } = await draftFor();
    const res = await edit(id, '  Please wash hands and check NCDC guidance.  ');
    expect(res.status).toBe(200);
    const n = res.body.narrative;
    expect(n.text).toBe('Please wash hands and check NCDC guidance.');
    expect(n.status).toBe('draft');
    expect(n.versions.map((v: { kind: string }) => v.kind)).toEqual(['generated', 'edited']);
    expect(n.versions[1].by).toBe(ctx.userId);
  });

  it('edit enforces the platform limit and non-empty text', async () => {
    const { id } = await draftFor();
    const tooLong = await edit(id, 'x'.repeat(281));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('too_long');
    expect((await edit(id, 'x'.repeat(280))).status).toBe(200);
    expect((await edit(id, '   ')).status).toBe(400);
    expect((await api().patch(`/api/narratives/${id}`).send({})).status).toBe(400);
  });

  it('editing an approved narrative sends it back to draft: the earlier approval no longer applies', async () => {
    const { id } = await approvedNarrative();
    expect((await detail(id)).narrative.approval).toMatchObject({
      reviewer: ctx.userId,
      note: 'checked against NCDC guidance',
    });

    const res = await edit(id, 'A different, unreviewed text (NCDC, WHO)');
    expect(res.body.narrative.status).toBe('draft');
    expect(res.body.narrative.approval).toBeNull();
    expect(res.body.reviews[0]).toMatchObject({ decision: 'approved', onCurrentText: false });
  });

  it('regenerate: a new draft, new version, back to draft; text differs from the previous variant', async () => {
    const { id, body } = await draftFor();
    const res = await post(id, 'regenerate');
    expect(res.status).toBe(200);
    expect(res.body.narrative.versions.map((v: { kind: string }) => v.kind)).toEqual([
      'generated',
      'regenerated',
    ]);
    expect(res.body.narrative.text).not.toBe(body.narrative.text);
    expect(res.body.narrative.status).toBe('draft');
  });

  it('override label: regenerating with another category redrafts for that category (validated against the taxonomy)', async () => {
    const { id } = await draftFor();
    const res = await post(id, 'regenerate', { category: 'burial_resistance' });
    expect(res.body.narrative.category).toBe('burial_resistance');
    expect(res.body.narrative.text.toLowerCase()).toMatch(/burial/);
    const bad = await post(id, 'regenerate', { category: 'made_up' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_category');
  });

  it('regenerating for another platform changes the limit and still fits it', async () => {
    const { id } = await draftFor();
    const toInsta = (await post(id, 'regenerate', { platform: 'instagram' })).body.narrative;
    expect(toInsta).toMatchObject({ platform: 'instagram', charLimit: 2200 });
    const back = (await post(id, 'regenerate', { platform: 'x' })).body.narrative;
    expect(back.text.length).toBeLessThanOrEqual(280);
    expect((await post(id, 'regenerate', { platform: 'myspace' })).status).toBe(400);
  });

  it('reject-and-regenerate: a rejected narrative can be regenerated and then needs a fresh approval', async () => {
    const { id } = await draftFor();
    expect((await post(id, 'reject', { note: 'tone is off' })).body.narrative.status).toBe('rejected');
    const regenerated = await post(id, 'regenerate');
    expect(regenerated.body.narrative.status).toBe('draft');
    expect(regenerated.body.narrative.approval).toBeNull();
    expect((await post(id, 'dispatch')).status).toBe(409);
  });
});

describe('approve / reject', () => {
  it('approve records a review bound to the exact text and moves the draft to approved', async () => {
    const { id } = await draftFor();
    const res = await post(id, 'approve', { note: 'ok' });
    const d = NarrativeDetailDtoSchema.parse(res.body);
    expect(d.narrative.status).toBe('approved');
    expect(d.narrative.approval).toMatchObject({ reviewer: ctx.userId, note: 'ok' });
    expect(d.reviews).toHaveLength(1);
    expect(d.reviews[0]).toMatchObject({ decision: 'approved', onCurrentText: true });
    const row = (await NarrativeReviewModel.findOne().lean())!;
    expect(row.textHash).toBe(textHash(d.narrative.text));
  });

  it('only a draft can be approved; only a draft or approved narrative can be rejected', async () => {
    const { id } = await draftFor();
    await post(id, 'approve');
    const again = await post(id, 'approve');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('invalid_state');
    expect((await post(id, 'reject')).status).toBe(200);
    expect((await post(id, 'reject')).status).toBe(409);
    expect((await post(id, 'approve')).status).toBe(409); // rejected, not a draft
  });

  it('reviews are append-only', async () => {
    const { id } = await draftFor();
    await post(id, 'approve');
    await expect(NarrativeReviewModel.updateOne({}, { $set: { decision: 'rejected' } })).rejects.toThrow(
      /append-only/,
    );
    await expect(NarrativeReviewModel.deleteMany({})).rejects.toThrow(/append-only/);
    expect(await NarrativeReviewModel.countDocuments()).toBe(1);
  });

  it('unknown and malformed ids', async () => {
    const missing = String(new mongoose.Types.ObjectId());
    for (const action of ['approve', 'reject', 'regenerate', 'dispatch']) {
      expect((await post(missing, action)).status, action).toBe(404);
      expect((await post('nope', action)).status, action).toBe(400);
    }
    expect((await edit(missing, 'text')).status).toBe(404);
    expect((await api().get(`/api/narratives/${missing}`)).status).toBe(404);
  });
});

describe('NO AUTONOMOUS DISPATCH', () => {
  it('drafting, editing, regenerating, approving and rejecting never send anything', async () => {
    const { id } = await draftFor();
    await edit(id, 'edited text (NCDC, WHO)');
    await post(id, 'regenerate');
    await post(id, 'approve');
    await post(id, 'reject');
    await post(id, 'regenerate');
    await post(id, 'approve');
    expect(dispatcher.sent).toHaveLength(0);
    expect(await DispatchModel.countDocuments()).toBe(0);
  });

  it('refuses a draft that was never approved; nothing is sent or recorded, the draft is untouched', async () => {
    const { id } = await draftFor();
    const res = await post(id, 'dispatch');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_approved');
    expect(res.body.error.message).toContain('approval');
    expect(dispatcher.sent).toHaveLength(0);
    expect(await DispatchModel.countDocuments()).toBe(0);
    expect((await detail(id)).narrative.status).toBe('draft');
  });

  it('refuses a rejected narrative', async () => {
    const { id } = await draftFor();
    await post(id, 'reject');
    const res = await post(id, 'dispatch');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_approved');
    expect(dispatcher.sent).toHaveLength(0);
  });

  it('refuses after an edit-after-approval until the new text is approved', async () => {
    const { id } = await approvedNarrative();
    await edit(id, 'Slightly changed wording (NCDC, WHO)');
    expect((await post(id, 'dispatch')).status).toBe(409);
    expect(dispatcher.sent).toHaveLength(0);
    await post(id, 'approve');
    expect((await post(id, 'dispatch')).status).toBe(201);
    expect(dispatcher.sent).toHaveLength(1);
    expect(dispatcher.sent[0]!.text).toBe('Slightly changed wording (NCDC, WHO)');
  });

  it('a wrong status flag is not enough: with no approval on record it is still refused (approval_missing)', async () => {
    const { id } = await draftFor();
    await native('counternarratives').updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { status: 'approved' } },
    );
    const res = await post(id, 'dispatch');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('approval_missing');
    expect(dispatcher.sent).toHaveLength(0);
    expect((await CounterNarrativeModel.findById(id).lean())!.status).toBe('approved'); // never claimed
  });

  it('a latest REJECTION beats a stale "approved" flag', async () => {
    const { id } = await approvedNarrative();
    // analyst approves, then rejects; someone forces the status flag back to approved
    await post(id, 'reject');
    await native('counternarratives').updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { status: 'approved' } },
    );
    const res = await post(id, 'dispatch');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('approval_missing');
    expect(dispatcher.sent).toHaveLength(0);
  });

  it('text tampered in the DB after approval is caught: approval_stale (hash no longer matches)', async () => {
    const { id } = await approvedNarrative();
    // case 1: text changed, hash left alone
    await native('counternarratives').updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { text: 'Buy my miracle cure now' } },
    );
    const a = await post(id, 'dispatch');
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('approval_stale');
    // case 2: text AND hash changed together (still not what the analyst approved)
    await native('counternarratives').updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { text: 'Buy my miracle cure now', textHash: textHash('Buy my miracle cure now') } },
    );
    const b = await post(id, 'dispatch');
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('approval_stale');
    expect(dispatcher.sent).toHaveLength(0);
  });

  it('sends exactly the approved text, with a verifiable approval proof, and records who approved and who sent', async () => {
    const { id, postId } = await approvedNarrative();
    const approvedText = (await detail(id)).narrative.text;
    const res = await post(id, 'dispatch');
    expect(res.status).toBe(201);
    const d = DispatchDtoSchema.parse(res.body);
    expect(d).toMatchObject({
      narrativeId: id,
      platform: 'x',
      text: approvedText,
      status: 'sent',
      approvedBy: ctx.userId,
      dispatchedBy: ctx.userId,
      dispatcher: { name: 'mock-dispatcher', mode: 'mock' },
      isMock: true,
      error: null,
    });
    expect(d.externalId).toMatch(/^mock-/);
    expect(d.originalPost).toMatchObject({
      id: postId,
      text: 'Drink salt water and you cannot get Ebola',
      platform: 'x',
    });

    expect(dispatcher.sent).toHaveLength(1);
    const sent = dispatcher.sent[0]!;
    expect(sent.text).toBe(approvedText);
    expect(sent.replyToPostId).toBe(postId);
    expect(sent.approval).toMatchObject({ reviewer: ctx.userId, textHash: textHash(approvedText) });
    expect(sent.approval.reviewId).toBeTruthy();

    const after = await detail(id);
    expect(after.narrative.status).toBe('dispatched');
    expect(after.dispatch).toMatchObject({ id: d.id, status: 'sent' });
  });

  it('a dispatched narrative is immutable', async () => {
    const { id } = await approvedNarrative();
    await post(id, 'dispatch');
    for (const res of [
      await edit(id, 'changed'),
      await post(id, 'regenerate'),
      await post(id, 'approve'),
      await post(id, 'reject'),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('already_dispatched');
    }
    expect((await CounterNarrativeModel.findById(id).lean())!.status).toBe('dispatched');
  });

  it('cannot be dispatched twice', async () => {
    const { id } = await approvedNarrative();
    expect((await post(id, 'dispatch')).status).toBe(201);
    const again = await post(id, 'dispatch');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_dispatched');
    expect(dispatcher.sent).toHaveLength(1);
    expect(await DispatchModel.countDocuments({ status: 'sent' })).toBe(1);
  });

  it('concurrent dispatch requests send exactly once', async () => {
    const { id } = await approvedNarrative();
    const results = await Promise.all([
      post(id, 'dispatch'),
      post(id, 'dispatch'),
      post(id, 'dispatch'),
      post(id, 'dispatch'),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    expect(dispatcher.sent).toHaveLength(1);
    expect(
      await DispatchModel.countDocuments({ narrativeId: new mongoose.Types.ObjectId(id), status: 'sent' }),
    ).toBe(1);
    expect((await CounterNarrativeModel.findById(id).lean())!.status).toBe('dispatched');
  });

  it('while a dispatch is in flight the narrative is locked against edits', async () => {
    const { id } = await approvedNarrative();
    await native('counternarratives').updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { status: 'dispatching' } },
    );
    const e = await edit(id, 'sneaky change');
    expect(e.status).toBe(409);
    expect(e.body.error.code).toBe('dispatch_in_progress');
    expect((await post(id, 'dispatch')).body.error.code).toBe('dispatch_in_progress');
    expect(dispatcher.sent).toHaveLength(0);
  });

  it('a platform failure: nothing is marked sent, the failure is recorded, the claim is released, a retry works', async () => {
    const { id } = await approvedNarrative();
    dispatcher.failNext = new Error('platform down');
    const failed = await post(id, 'dispatch');
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('dispatch_failed');
    expect(dispatcher.sent).toHaveLength(0);
    expect((await detail(id)).narrative.status).toBe('approved');
    const row = (await DispatchModel.findOne({ status: 'failed' }).lean())!;
    expect(row.error).toBe('platform down');
    expect((await api().get('/api/dispatches')).body.total).toBe(0); // failures are not "dispatched items"

    const retry = await post(id, 'dispatch');
    expect(retry.status).toBe(201);
    expect(dispatcher.sent).toHaveLength(1);
    expect(await DispatchModel.countDocuments({ narrativeId: new mongoose.Types.ObjectId(id) })).toBe(2); // 1 failed + 1 sent
  });

  it('the database itself allows only one sent row per narrative (partial unique index), but many failures', async () => {
    const { id } = await approvedNarrative();
    await post(id, 'dispatch');
    const first = (await DispatchModel.findOne({ status: 'sent' }).lean())!;
    const clone = { ...first, _id: new mongoose.Types.ObjectId() };
    await expect(DispatchModel.collection.insertOne(clone)).rejects.toMatchObject({ code: 11000 });
    await expect(
      DispatchModel.collection.insertOne({ ...clone, _id: new mongoose.Types.ObjectId(), status: 'failed' }),
    ).resolves.toBeDefined();
    await expect(
      DispatchModel.collection.insertOne({ ...clone, _id: new mongoose.Types.ObjectId(), status: 'failed' }),
    ).resolves.toBeDefined();
  });

  it('a manual narrative can be approved and dispatched too (no original post)', async () => {
    const m = (
      await gen({
        claim: 'a rumour from a WhatsApp group',
        platform: 'bluesky',
        category: 'false_case_report',
      })
    ).body.narrative;
    await post(m.id, 'approve');
    const res = await post(m.id, 'dispatch');
    expect(res.status).toBe(201);
    expect(res.body.originalPost).toBeNull();
    expect(dispatcher.sent[0]!.replyToPostId).toBeNull();
  });
});

describe('listing', () => {
  it('lists narratives newest first with filters and an approval flag', async () => {
    const a = await draftFor({}, { text: 'first rumour' });
    const b = await draftFor({}, { text: 'second rumour' });
    await post(b.id, 'approve');
    const all = NarrativeListDtoSchema.parse((await api().get('/api/narratives')).body);
    expect(all.total).toBe(2);
    expect(all.items.map((n) => n.id)).toEqual([b.id, a.id]);
    expect(all.items[0]!.approval).not.toBeNull();
    expect(all.items[1]!.approval).toBeNull();
    expect(
      (await api().get(`/api/narratives?postId=${a.postId}`)).body.items.map((n: { id: string }) => n.id),
    ).toEqual([a.id]);
    expect((await api().get('/api/narratives?status=approved')).body.total).toBe(1);
    expect((await api().get('/api/narratives?status=weird')).status).toBe(400);
    expect(
      (await api().get('/api/narratives?pageSize=1&page=2')).body.items.map((n: { id: string }) => n.id),
    ).toEqual([a.id]);
  });

  it('GET /api/dispatches lists only sent items, newest first, with the original post, paginated', async () => {
    const a = await approvedNarrative();
    const b = await approvedNarrative();
    await post(a.id, 'dispatch');
    await post(b.id, 'dispatch');
    const c = await approvedNarrative(); // approved but never dispatched
    void c;
    const list = DispatchListDtoSchema.parse((await api().get('/api/dispatches')).body);
    expect(list.total).toBe(2);
    expect(list.items.map((d) => d.narrativeId)).toEqual([b.id, a.id]);
    expect(list.items[0]!.originalPost?.text).toContain('salt water');
    const page2 = (await api().get('/api/dispatches?pageSize=1&page=2')).body;
    expect(page2.items.map((d: { narrativeId: string }) => d.narrativeId)).toEqual([a.id]);
    expect((await api().get('/api/dispatches?pageSize=0')).status).toBe(400);
  });
});

describe('config, auth and provenance', () => {
  it('GET /api/narratives/config returns platform limits (from config), languages and the provider modes', async () => {
    const res = await api().get('/api/narratives/config');
    expect(res.status).toBe(200); // not swallowed by /narratives/:id
    const c = NarrativeConfigDtoSchema.parse(res.body);
    expect(c.platforms.find((p) => p.id === 'x')?.charLimit).toBe(280);
    expect(c.languages).toEqual(['en', 'pcm', 'ha', 'yo', 'ig', 'fr', 'und']);
    expect(c.generator).toEqual({ name: 'mock-generator', mode: 'mock' });
    expect(c.dispatcher).toEqual({ name: 'mock-dispatcher', mode: 'mock' });
  });

  it('platform limits really come from configuration', async () => {
    const custom = await startApp({}, { platforms: [{ id: 'x', name: 'X', charLimit: 120 }] });
    try {
      const { post: p } = await seedPost({ platform: 'x' });
      const res = await custom
        .api()
        .post('/api/narratives/generate')
        .send({ postId: String(p._id) });
      expect(res.body.narrative.charLimit).toBe(120);
      expect(res.body.narrative.text.length).toBeLessThanOrEqual(120);
      expect((await custom.api().get('/api/narratives/config')).body.platforms).toHaveLength(1);
      const other = await custom
        .api()
        .post('/api/narratives/generate')
        .send({ claim: 'c', platform: 'bluesky' });
      expect(other.status).toBe(400);
    } finally {
      await custom.application.stop();
    }
  });

  it('every narrative route needs a session: no session means 401, reads included', async () => {
    const anon = ctx.anon();
    const id = String(new mongoose.Types.ObjectId());
    const calls = [
      anon.get('/api/narratives'),
      anon.get(`/api/narratives/${id}`),
      anon.get('/api/narratives/config'),
      anon.get('/api/dispatches'),
      anon.post('/api/narratives/generate').send({ claim: 'c', platform: 'x' }),
      anon.patch(`/api/narratives/${id}`).send({ text: 't' }),
      anon.post(`/api/narratives/${id}/regenerate`).send({}),
      anon.post(`/api/narratives/${id}/approve`).send({}),
      anon.post(`/api/narratives/${id}/reject`).send({}),
      anon.post(`/api/narratives/${id}/dispatch`).send({}),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('unauthenticated');
    }
    expect(await CounterNarrativeModel.countDocuments()).toBe(0);
  });

  it('provenance cannot lie: /api/system/status reports the real generator and dispatcher modes', async () => {
    const status = SystemStatusSchema.parse((await api().get('/api/system/status')).body);
    expect(status.dataSource).toMatchObject({ generator: 'mock', dispatcher: 'mock' });

    class LiveGenerator extends MockGenerator {
      override readonly mode = 'live' as never;
    }
    class LiveDispatcher extends MockDispatcher {
      override readonly mode = 'live' as never;
    }
    const live = await startApp({}, { generator: new LiveGenerator(), dispatcher: new LiveDispatcher() });
    try {
      const s = SystemStatusSchema.parse((await live.api().get('/api/system/status')).body);
      expect(s.dataSource).toMatchObject({ generator: 'live', dispatcher: 'live' });
      const cfg = (await live.api().get('/api/narratives/config')).body;
      expect(cfg.generator.mode).toBe('live');
      expect(cfg.dispatcher.mode).toBe('live');
      const { post: p } = await seedPost({ platform: 'x' });
      const n = (
        await live
          .api()
          .post('/api/narratives/generate')
          .send({ postId: String(p._id) })
      ).body.narrative;
      expect(n.generator.mode).toBe('live'); // recorded on the draft itself
    } finally {
      await live.application.stop();
    }
  });
});
