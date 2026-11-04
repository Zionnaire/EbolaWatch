/**
 * Regression: the mock classifier used to pick a canned result by hashing the item id, so a Hausa post could come
 * back "Yoruba" and a French one "Pidgin". It must now report the language the post declares, and when none is
 * declared, a guess from the text itself.
 */
import { describe, expect, it } from 'vitest';
import { guessLanguage, mockLanguage, normalizeHint } from '../src/classifier/languageGuess.js';
import { InProcessMockClassifier } from '../src/classifier/inProcessMock.js';
import { SYNTHETIC_CORPUS } from '../src/pipeline/connectors/syntheticCorpus.js';

const taxonomy = { version: () => 'ebola-tax-1.0', knownCategoryIds: () => null };

/** Posts of the kind that were mislabelled in review (written by hand here; none are real). */
const EXAMPLES: Array<[string, string]> = [
  ['pcm', 'Wetin be di symptom of Ebola sef? Na only fever or e get other tin?'],
  ['ha', 'Ana yada jita-jita cewa an samu mai Ebola a asibiti, kar ku je can.'],
  ['ig', "Ha na-ekwu na ịṇụ mmiri nnu na-echebe mmadụ pụọ n'Ebola. Ọ bụ eziokwu?"],
  [
    'en',
    'Official notice: all schools to close for 3 weeks, signed by the Ministry. Forward to your contacts.',
  ],
  ['fr', "Ne partagez pas cette rumeur : l'Ebola ne se soigne pas avec du sel, allez à l'hôpital."],
  ['yo', 'Wọ́n ní kí a máa lo omi iyọ̀ láti dènà Ebola. Ṣé òótọ́ ni?'],
];

describe('mock classifier language', () => {
  it('reports the language every synthetic post declares (it used to be random)', async () => {
    const c = new InProcessMockClassifier('multilabel-v1', taxonomy);
    const inputs = SYNTHETIC_CORPUS.map((p, i) => ({
      itemId: `post-${i}`,
      text: p.text,
      platform: 'bluesky',
      languageHint: p.language,
    }));
    const results = await c.classify(inputs);
    results.forEach((r, i) => {
      expect(r.outcome).toBe('classified');
      if (r.outcome === 'classified')
        expect(r.classification.language, SYNTHETIC_CORPUS[i]!.text).toBe(SYNTHETIC_CORPUS[i]!.language);
    });
  });

  it('the same holds for the 3-class contract', async () => {
    const c = new InProcessMockClassifier('threeclass-v0', taxonomy);
    const [r] = await c.classify([
      { itemId: 'a', text: 'Sannu, wannan ba gaskiya ba ne', platform: 'x', languageHint: 'ha' },
    ]);
    expect(r!.outcome === 'classified' && r!.classification.language).toBe('ha');
  });

  it('with no hint it reads the language from the text', async () => {
    const c = new InProcessMockClassifier('multilabel-v1', taxonomy);
    for (const [lang, text] of EXAMPLES) {
      const [r] = await c.classify([{ itemId: `h-${lang}`, text, platform: 'x' }]);
      expect(r!.outcome === 'classified' && r!.classification.language, text).toBe(lang);
    }
  });

  it('a declared language wins over the guess', () => {
    expect(mockLanguage('yo', 'This is plainly English text about Ebola.')).toBe('yo');
    expect(mockLanguage('xx', 'This is plainly English text about Ebola and the people.')).toBe('en');
    expect(mockLanguage(null, undefined)).toBeNull();
  });
});

describe('language guess', () => {
  it.each(EXAMPLES)('%s', (lang, text) => {
    expect(guessLanguage(text)).toBe(lang);
  });

  it('gets the synthetic corpus right (the one non-Ebola sports post may be "unknown")', () => {
    const wrong = SYNTHETIC_CORPUS.filter((p) => ![p.language, 'und'].includes(guessLanguage(p.text)));
    expect(wrong.map((p) => p.text)).toEqual([]);
  });

  it('very short or wordless text is unknown rather than a confident wrong answer', () => {
    expect(guessLanguage('🧂💧🙏 #Ebola')).toBe('und');
    expect(guessLanguage('ok')).toBe('und');
  });

  it('only known language codes are accepted as hints', () => {
    expect(normalizeHint(' HA ')).toBe('ha');
    expect(normalizeHint('klingon')).toBeNull();
    expect(normalizeHint(null)).toBeNull();
  });
});
