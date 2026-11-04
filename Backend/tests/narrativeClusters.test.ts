import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClustersDtoSchema } from '../src/contracts/api/index.js';
import { clusterTexts } from '../src/services/analytics/clustering.js';
import { AnalyticsService } from '../src/services/analytics/analyticsService.js';
import { GroqNarrativeRefiner, NoRefiner } from '../src/services/analytics/narrativeRefiner.js';
import type { GroqClient } from '../src/services/narratives/groqClient.js';
import { clearCollections, DATA_COLLECTIONS, useMongo } from './helpers/mongo.js';
import { seedPost, type SeedSpec } from './helpers/seed.js';

useMongo();

const NOW = new Date('2026-10-27T12:00:00Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
beforeEach(() => clearCollections(DATA_COLLECTIONS));

const SALT =
  'Drinking hot salt water and bathing in it protects you from Ebola. Share this with your family!';
const SALT_B =
  'Bathe in hot salt water every morning and drink a cup, it protects you from Ebola. Please share';
const SALT_C = 'Salt water bath and drink a cup of hot salt water, protects from Ebola, share with family';
const BURIAL =
  'They want to bury our people without the family. Do not allow the burial team into the compound';
const BURIAL_B =
  'Burial team want to bury our people without the family, do not allow them into the compound';
const ONE_OFF = 'Jollof rice or ofada? This debate will never end in Lagos tonight';

const seed = (o: SeedSpec = {}) =>
  seedPost({
    ingestedAt: new Date(NOW.getTime() - HOUR),
    postedAt: new Date(NOW.getTime() - 2 * HOUR),
    categories: ['fake_cure_prevention'],
    ...o,
  });
const service = (over: Partial<ConstructorParameters<typeof AnalyticsService>[0]> = {}) =>
  new AnalyticsService({ queueCap: 500, overdueHours: 48, now: () => NOW, ...over });

describe('text clustering', () => {
  const docs = (texts: string[]) => texts.map((text, i) => ({ id: `p${i}`, text, at: i * 1000 }));

  it('puts the same rumour in different wording together and keeps different rumours apart', () => {
    const d = docs([SALT, BURIAL, SALT_B, BURIAL_B, SALT_C, ONE_OFF]);
    const c = clusterTexts(d);
    const groups = c.clusters.map((x) => x.members.map((i) => d[i]!.text).sort());
    expect(groups).toContainEqual([SALT, SALT_B, SALT_C].sort());
    expect(groups).toContainEqual([BURIAL, BURIAL_B].sort());
    expect(groups).toContainEqual([ONE_OFF]);
    expect(c.clusters).toHaveLength(3);
  });

  it('is deterministic whatever order the posts arrive in, and the id is the earliest post', () => {
    const d = docs([SALT, BURIAL, SALT_B, BURIAL_B, SALT_C, ONE_OFF]);
    const shuffled = [...d].reverse();
    const key = (cs: ReturnType<typeof clusterTexts>, from: typeof d) =>
      cs.clusters
        .map(
          (x) =>
            `${x.id}:${x.members
              .map((i) => from[i]!.id)
              .sort()
              .join(',')}`,
        )
        .sort();
    expect(key(clusterTexts(shuffled), shuffled)).toEqual(key(clusterTexts(d), d));
    expect(clusterTexts(d).clusters.find((x) => x.members.length === 3)!.id).toBe('p0');
  });

  it('ignores scrubbed placeholders, so two posts are not "the same" just because both have [phone] and [url]', () => {
    const c = clusterTexts(
      docs(['Call [phone] now see [url] [handle]', 'Visit [url] or ring [phone] [handle] today']),
    );
    expect(c.clusters).toHaveLength(2);
  });

  it('places a post from another period against the clusters', () => {
    const d = docs([SALT, SALT_B, BURIAL, BURIAL_B]);
    const c = clusterTexts(d);
    const sims = c.similarityTo(SALT_C).sort((a, b) => b.sim - a.sim);
    expect(c.clusters[sims[0]!.cluster]!.members.map((i) => d[i]!.text)).toContain(SALT);
    expect(sims[0]!.sim).toBeGreaterThan(0.34);
  });

  it('shows real words for key terms, not stems', () => {
    const c = clusterTexts(docs([SALT, SALT_B, SALT_C]));
    const terms = c.clusters[0]!.keyStems.map((s) => c.surface(s));
    expect(terms).toContain('salt');
    expect(terms.every((t) => /^[a-z]+$/.test(t))).toBe(true);
  });
});

describe('narratives (clusters endpoint logic)', () => {
  it('groups this week by claim, counts last week, ranks and describes them', async () => {
    const lastWeek = new Date(NOW.getTime() - 10 * DAY);
    await seed({ text: SALT, priorityScore: 40, state: 'Lagos', platform: 'x' });
    const best = await seed({
      text: SALT_B,
      priorityScore: 90,
      state: 'Lagos',
      platform: 'bluesky',
      urgent: true,
    });
    await seed({ text: SALT_C, priorityScore: 60, state: 'Kano', platform: 'x' });
    await seed({ text: SALT, postedAt: lastWeek }); // same claim last week
    await seed({ text: BURIAL, categories: ['burial_resistance'], state: 'Rivers' });
    await seed({ text: BURIAL_B, categories: ['burial_resistance'], state: 'Rivers' });
    await seed({ text: ONE_OFF }); // a one-off
    await seed({ text: SALT, queue: 'none', categories: [] }); // not flagged
    await seed({ text: SALT, isMock: false }); // other run

    const c = ClustersDtoSchema.parse(await service().clusters(true));
    expect(c.method).toEqual({ grouping: 'text-similarity', refinement: 'none', model: null });
    expect(c.clusters.map((x) => [x.category, x.count])).toEqual([
      ['fake_cure_prevention', 3],
      ['burial_resistance', 2],
    ]);
    expect(c.unclustered).toBe(1);

    const salt = c.clusters[0]!;
    expect(salt).toMatchObject({
      previousCount: 1,
      changePct: 200,
      trend: 'rising',
      urgentCount: 1,
      labelSource: 'keywords',
      summary: null,
    });
    expect(salt.keyTerms).toContain('salt');
    expect(salt.title.toLowerCase()).toContain('salt');
    expect(salt.samplePostId).toBe(String(best.post._id));
    expect(salt.platforms).toEqual([
      { key: 'x', count: 2 },
      { key: 'bluesky', count: 1 },
    ]);
    expect(salt.topStates).toEqual([
      { key: 'Lagos', count: 2 },
      { key: 'Kano', count: 1 },
    ]);
    expect(c.clusters[1]!).toMatchObject({ previousCount: 0, changePct: null, trend: 'new' });
    // shares are of all flagged posts this week, including the one-off
    expect(c.clusters.reduce((a, x) => a + x.share, 0)).toBeCloseTo(5 / 6, 3);
  });

  it('empty when nothing is flagged', async () => {
    const c = await service().clusters(true);
    expect(c.clusters).toEqual([]);
    expect(c.unclustered).toBe(0);
  });

  it('a claim that fades is "falling"; a steady one is "steady"', async () => {
    const lastWeek = new Date(NOW.getTime() - 9 * DAY);
    for (let i = 0; i < 2; i++) await seed({ text: SALT });
    for (let i = 0; i < 5; i++) await seed({ text: SALT, postedAt: lastWeek });
    for (let i = 0; i < 2; i++) await seed({ text: BURIAL, categories: ['burial_resistance'] });
    for (let i = 0; i < 2; i++)
      await seed({ text: BURIAL, categories: ['burial_resistance'], postedAt: lastWeek });
    const c = await service().clusters(true);
    expect(c.clusters.find((x) => x.category === 'fake_cure_prevention')!.trend).toBe('falling');
    expect(c.clusters.find((x) => x.category === 'burial_resistance')!.trend).toBe('steady');
  });

  it('respects what the organization may see: a Lagos-only team does not get Kano posts in its narratives', async () => {
    for (let i = 0; i < 3; i++) await seed({ text: SALT, state: 'Lagos' });
    for (let i = 0; i < 3; i++)
      await seed({ text: BURIAL, categories: ['burial_resistance'], state: 'Kano' });
    const scope = {
      isMock: true,
      tenant: {
        organizationId: null,
        platformWide: false,
        scopeStates: ['Lagos'],
        orgType: 'state' as const,
        settings: null,
      },
    };
    const c = await service().clusters(scope);
    expect(c.clusters.map((x) => x.category)).toEqual(['fake_cure_prevention']);
  });
});

describe('AI refinement', () => {
  const fakeGroq = (...replies: Array<unknown | Error>) => {
    const chatJson = vi.fn();
    for (const r of replies)
      chatJson.mockImplementationOnce(() =>
        r instanceof Error
          ? Promise.reject(r)
          : Promise.resolve({
              content: typeof r === 'string' ? r : JSON.stringify(r),
              model: 'm',
              promptTokens: 1,
              completionTokens: 1,
            }),
      );
    return { model: 'test-model', chatJson } as unknown as GroqClient & {
      chatJson: ReturnType<typeof vi.fn>;
    };
  };

  /** Two clusters that are really one rumour written in two languages, plus an unrelated one. */
  async function seedCrossLanguage() {
    for (let i = 0; i < 2; i++) await seed({ text: SALT });
    for (let i = 0; i < 3; i++)
      await seed({
        text: 'Ana cewa shan ruwan gishiri yana kare mutum daga Ebola, kowa ya sani',
        language: 'ha',
      });
    for (let i = 0; i < 2; i++) await seed({ text: BURIAL, categories: ['burial_resistance'] });
  }

  it('first answers with keyword groups at once, then merges paraphrases and names narratives once the AI has answered', async () => {
    await seedCrossLanguage();
    const probe = new GroqNarrativeRefiner(fakeGroq({ narratives: [] }), { minIntervalMs: 0 });
    const keys = (await service({ refiner: probe }).clusters(true)).clusters.map((c) => c.id);
    await probe.idle();
    expect(keys).toHaveLength(3);

    const groq = fakeGroq({
      narratives: [
        {
          keys: [keys[0], keys[1]],
          title: 'Salt water protects against Ebola',
          summary: 'Posts claim drinking or bathing in salt water prevents Ebola.',
        },
        {
          keys: [keys[2]],
          title: 'Burial teams are not welcome',
          summary: 'Posts urge families to refuse burial teams.',
        },
      ],
    });
    const refiner = new GroqNarrativeRefiner(groq, { minIntervalMs: 0 });
    const svc = service({ refiner });

    const first = await svc.clusters(true);
    expect(first.method.refinement).toBe('none'); // not blocked waiting for the AI
    expect(first.clusters).toHaveLength(3);
    await refiner.idle();

    const second = await svc.clusters(true);
    expect(second.method).toEqual({ grouping: 'text-similarity', refinement: 'ai', model: 'test-model' });
    expect(second.clusters).toHaveLength(2);
    const salt = second.clusters.find((c) => c.title === 'Salt water protects against Ebola')!;
    expect(salt).toMatchObject({
      count: 5,
      labelSource: 'ai',
      summary: expect.stringContaining('salt water'),
    });
    expect(salt.languages.map((l) => l.key).sort()).toEqual(['en', 'ha']);
    expect(second.note).toMatch(/AI model/);
    expect(groq.chatJson).toHaveBeenCalledTimes(1);
  });

  it('sends only scrubbed post text, marks it untrusted, and never asks twice for clusters it already knows', async () => {
    await seedCrossLanguage();
    const groq = fakeGroq({ narratives: [] });
    const refiner = new GroqNarrativeRefiner(groq, { minIntervalMs: 0 });
    const svc = service({ refiner });
    await svc.clusters(true);
    await refiner.idle();
    const msgs = groq.chatJson.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    expect(msgs[0]!.content).toMatch(/untrusted/);
    expect(msgs[1]!.content).toContain('<clusters>');
    await svc.clusters(true);
    await refiner.idle();
    expect(groq.chatJson).toHaveBeenCalledTimes(1); // everything was "seen"
  });

  it('ignores keys the AI made up, a key placed twice, and bad JSON: keyword groups stay', async () => {
    await seedCrossLanguage();
    for (const reply of [
      'sure, here you go',
      { narratives: [{ keys: ['not-a-cluster'], title: 'Made up', summary: '' }] },
      { wrong: 'shape' },
    ]) {
      const refiner = new GroqNarrativeRefiner(fakeGroq(reply), { minIntervalMs: 0 });
      const svc = service({ refiner });
      await svc.clusters(true);
      await refiner.idle();
      const c = await svc.clusters(true);
      expect(c.clusters).toHaveLength(3);
      expect(c.clusters.every((x) => x.labelSource === 'keywords')).toBe(true);
    }
  });

  it('a failing AI service never breaks the page', async () => {
    await seedCrossLanguage();
    const refiner = new GroqNarrativeRefiner(fakeGroq(new Error('boom')), { minIntervalMs: 0 });
    const svc = service({ refiner });
    await expect(svc.clusters(true)).resolves.toMatchObject({ method: { refinement: 'none' } });
    await refiner.idle();
    await expect(svc.clusters(true)).resolves.toHaveProperty('clusters');
  });

  it('does not call the AI more often than its minimum interval', async () => {
    await seedCrossLanguage();
    let t = 1_000_000;
    const groq = fakeGroq(new Error('x'), new Error('x'));
    const refiner = new GroqNarrativeRefiner(groq, { minIntervalMs: 20_000, now: () => t });
    const svc = service({ refiner });
    await svc.clusters(true);
    await refiner.idle();
    t += 5_000;
    await svc.clusters(true);
    await refiner.idle();
    expect(groq.chatJson).toHaveBeenCalledTimes(1);
    t += 20_000;
    await svc.clusters(true);
    await refiner.idle();
    expect(groq.chatJson).toHaveBeenCalledTimes(2);
  });

  it('without a refiner nothing is ever sent anywhere', async () => {
    await seedCrossLanguage();
    const r = new NoRefiner();
    expect(r.model).toBeNull();
    expect((await service({ refiner: r }).clusters(true)).method.refinement).toBe('none');
  });
});
