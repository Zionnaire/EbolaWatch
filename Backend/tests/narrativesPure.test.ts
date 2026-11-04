import { describe, expect, it } from 'vitest';
import {
  EditNarrativeRequestSchema,
  GenerateNarrativeRequestSchema,
  NarrativeListQuerySchema,
  RegenerateNarrativeRequestSchema,
} from '../src/contracts/api/index.js';
import { DEFAULT_CATEGORY_FLOORS } from '../src/services/rules.js';
import { DispatchRefusedError, MockDispatcher } from '../src/services/narratives/dispatchService.js';
import { fit, MockGenerator } from '../src/services/narratives/mockGenerator.js';
import { DEFAULT_PLATFORMS, PlatformLimits } from '../src/services/narratives/platforms.js';
import { textHash } from '../src/utils/hashing.js';

const gen = new MockGenerator();
const req = (over: Partial<Parameters<MockGenerator['generate']>[0]> = {}) => ({
  claim: 'a claim',
  category: 'fake_cure_prevention',
  categoryName: 'Fake cure or prevention',
  language: 'en',
  platform: 'x',
  charLimit: 280,
  guidance: null,
  attempt: 0,
  ...over,
});

describe('MockGenerator', () => {
  it('identifies itself as a mock (this is what /api/system/status reports)', () => {
    expect(gen).toMatchObject({ mode: 'mock', name: 'mock-generator', version: '0.0.0-mock' });
  });

  it('every category x every platform x both variants fits the limit and cites NCDC and WHO', async () => {
    for (const category of Object.keys(DEFAULT_CATEGORY_FLOORS)) {
      for (const platform of DEFAULT_PLATFORMS) {
        for (const attempt of [0, 1, 2, 3]) {
          const d = await gen.generate(
            req({ category, platform: platform.id, charLimit: platform.charLimit, attempt }),
          );
          const where = `${category}/${platform.id}/#${attempt}`;
          expect(d.text.length, where).toBeLessThanOrEqual(platform.charLimit);
          expect(d.text.length, where).toBeGreaterThan(40);
          expect(d.text, where).toContain('NCDC');
          expect(d.text, where).toContain('WHO');
        }
      }
    }
  });

  it('regeneration changes the text: variants differ per category and wrap around', async () => {
    for (const category of Object.keys(DEFAULT_CATEGORY_FLOORS)) {
      const a = (await gen.generate(req({ category, attempt: 0 }))).text;
      const b = (await gen.generate(req({ category, attempt: 1 }))).text;
      expect(a, category).not.toBe(b);
      expect((await gen.generate(req({ category, attempt: 2 }))).text, category).toBe(a);
    }
  });

  it('is deterministic for the same input', async () => {
    expect(await gen.generate(req())).toEqual(await gen.generate(req()));
  });

  it('longer platforms get the extra safety line; X drops it to fit', async () => {
    const long = await gen.generate(req({ platform: 'instagram', charLimit: 2200 }));
    expect(long.text).toContain('toll-free line');
    const short = await gen.generate(req({ platform: 'x', charLimit: 280 }));
    expect(short.text.length).toBeLessThanOrEqual(280);
  });

  it('cites NCDC and WHO as real references', async () => {
    const { citations } = await gen.generate(req());
    expect(citations.map((c) => c.source)).toEqual(['NCDC', 'WHO']);
    for (const c of citations) expect(c.url).toMatch(/^https:\/\//);
  });

  it('is honest about what it cannot do: non-English, ignored guidance, no category', async () => {
    const d = await gen.generate(req({ language: 'ha', guidance: 'be gentle', category: null }));
    expect(d.language).toBe('en');
    expect(d.warnings.join(' ')).toContain('only drafts in English');
    expect(d.warnings.join(' ')).toContain('"ha"');
    expect(d.warnings.join(' ')).toContain('ignores analyst guidance');
    expect(d.warnings.join(' ')).toContain('general statement');
    expect((await gen.generate(req())).warnings).toEqual([]);
  });

  it('an unknown category id (labels are data) falls back to the general statement with a warning', async () => {
    const d = await gen.generate(req({ category: 'brand_new_category' }));
    expect(d.warnings.join(' ')).toContain('general statement');
    expect(d.text.length).toBeGreaterThan(40);
  });
});

describe('fit()', () => {
  const core = 'This is the main statement. '.repeat(8).trim();
  it('never exceeds the limit, whatever the limit', () => {
    for (const limit of [1, 5, 20, 40, 60, 100, 150, 280, 300, 1000]) {
      expect(fit(core, limit).length, `limit ${limit}`).toBeLessThanOrEqual(limit);
    }
  });
  it('keeps the source tag when it has to clip the core', () => {
    const out = fit(core, 100);
    expect(out).toContain('(NCDC, WHO)');
    expect(out).toContain('…');
  });
  it('returns the full text when it fits', () => {
    expect(fit('Short.', 1000)).toContain('Short.');
    expect(fit('Short.', 1000)).toContain('(NCDC, WHO)');
  });
});

describe('PlatformLimits (configuration, not UI constants)', () => {
  const limits = new PlatformLimits();
  it('defaults: X is 280, lookups are case-insensitive, unknown is null', () => {
    expect(limits.get('x')?.charLimit).toBe(280);
    expect(limits.get(' X ')?.charLimit).toBe(280);
    expect(limits.get('bluesky')?.charLimit).toBe(300);
    expect(limits.get('myspace')).toBeNull();
    expect(limits.list().map((p) => p.id)).toEqual(['x', 'bluesky', 'instagram', 'youtube']);
  });
  it('can be configured', () => {
    expect(new PlatformLimits([{ id: 'x', name: 'X', charLimit: 100 }]).get('x')?.charLimit).toBe(100);
  });
});

describe('MockDispatcher defends itself', () => {
  const text = 'An approved counter-narrative (NCDC, WHO)';
  const approval = { reviewId: 'r1', reviewer: 'analyst', textHash: textHash(text) };
  const base = { narrativeId: 'abcdef123456', platform: 'x', text, replyToPostId: null };

  it('sends only with a matching approval, and records what it sent', async () => {
    const d = new MockDispatcher();
    const res = await d.send({ ...base, approval });
    expect(res.externalId).toMatch(/^mock-1-/);
    expect(d.sent).toHaveLength(1);
    expect(d.mode).toBe('mock');
  });

  it('refuses without approval, with an empty approval, and when the text differs from the approved text', async () => {
    const d = new MockDispatcher();
    await expect(d.send({ ...base } as never)).rejects.toBeInstanceOf(DispatchRefusedError);
    await expect(d.send({ ...base, approval: { reviewId: '', reviewer: '', textHash: '' } })).rejects.toThrow(
      /refuses to send/,
    );
    await expect(d.send({ ...base, text: text + ' (edited)', approval })).rejects.toMatchObject({
      code: 'approval_missing',
      status: 409,
    });
    expect(d.sent).toHaveLength(0);
  });

  it('failNext simulates one platform failure, then recovers', async () => {
    const d = new MockDispatcher();
    d.failNext = new Error('platform down');
    await expect(d.send({ ...base, approval })).rejects.toThrow('platform down');
    await expect(d.send({ ...base, approval })).resolves.toBeDefined();
    expect(d.sent).toHaveLength(1);
  });
});

describe('narrative request schemas', () => {
  it('generate: needs a postId, or a claim AND a platform for a manual one', () => {
    expect(GenerateNarrativeRequestSchema.safeParse({}).success).toBe(false);
    expect(GenerateNarrativeRequestSchema.safeParse({ postId: 'abc' }).success).toBe(true);
    expect(GenerateNarrativeRequestSchema.safeParse({ claim: 'text' }).success).toBe(false);
    expect(GenerateNarrativeRequestSchema.safeParse({ claim: 'text', platform: 'x' }).success).toBe(true);
    expect(GenerateNarrativeRequestSchema.safeParse({ postId: 'a', language: 'sw' }).success).toBe(false);
    expect(GenerateNarrativeRequestSchema.safeParse({ postId: 'a', language: 'pcm' }).success).toBe(true);
    expect(GenerateNarrativeRequestSchema.safeParse({ claim: '   ', platform: 'x' }).success).toBe(false);
  });
  it('edit and regenerate', () => {
    expect(EditNarrativeRequestSchema.safeParse({ text: '  hi  ' }).data?.text).toBe('hi');
    expect(EditNarrativeRequestSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(EditNarrativeRequestSchema.safeParse({}).success).toBe(false);
    expect(RegenerateNarrativeRequestSchema.safeParse({}).success).toBe(true);
    expect(
      RegenerateNarrativeRequestSchema.safeParse({ category: 'burial_resistance', language: 'yo' }).success,
    ).toBe(true);
  });
  it('list query: defaults and limits', () => {
    expect(NarrativeListQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 25 });
    expect(NarrativeListQuerySchema.safeParse({ pageSize: 500 }).success).toBe(false);
    expect(NarrativeListQuerySchema.safeParse({ status: 'weird' }).success).toBe(false);
  });
});
