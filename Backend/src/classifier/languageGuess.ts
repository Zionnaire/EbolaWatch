/**
 * A small language guesser for the MOCK classifier only (the real model reports its own language). It exists so the
 * mock does not label a Hausa post "Yoruba": it uses the language a post declares, and otherwise looks at common
 * words and letters of English, Nigerian Pidgin, Hausa, Yoruba, Igbo and French. It is not a general detector.
 */
export type GuessedLanguage = 'en' | 'pcm' | 'ha' | 'yo' | 'ig' | 'fr' | 'und';

const KNOWN = new Set<string>(['en', 'pcm', 'ha', 'yo', 'ig', 'fr', 'und']);

const WORDS: Record<Exclude<GuessedLanguage, 'und'>, string[]> = {
  en: 'the is are of and to that this with for you not from they have it was be do does will can people ebola'.split(
    ' ',
  ),
  pcm: 'dem wetin dey na di una abeg wahala sef tin make e no go don wey for am oga pikin comot'.split(' '),
  ha: 'cewa kar ku da na ba ne ce wannan mai an samu jita-jita asibiti ruwa kuma yana ga cikin shi su'.split(
    ' ',
  ),
  yo: 'ni ati ti ko si fun pe lati yi wa ba bi je o awon nitori kii maa ọ ẹ'.split(' '),
  ig: 'na ndi bu nke ya anyi ha ka otu mmiri nna-ekwu iji ọ ụ ị ihe ma ọ bụ'.split(' '),
  fr: 'le la les des est pas nous vous une un et dans pour que sur avec ce cette sont fièvre'.split(' '),
};

/** Letters that give a language away on their own. */
const MARKS: Array<[GuessedLanguage, RegExp, number]> = [
  ['yo', /[ẹṣọ]|ń|à|á.*ẹ/giu, 2],
  ['ig', /[ịụọ]|ṅ/giu, 2],
  ['fr', /[éèêçœ]|\b(?:qu'|l'|d'|n')/giu, 2],
];

export function normalizeHint(hint: string | null | undefined): GuessedLanguage | null {
  const h = hint?.trim().toLowerCase();
  return h && KNOWN.has(h) ? (h as GuessedLanguage) : null;
}

export function guessLanguage(text: string): GuessedLanguage {
  const lower = text.toLowerCase();
  const tokens = lower.split(/[^\p{L}\p{M}'-]+/u).filter(Boolean);
  if (tokens.length < 3) return 'und';

  const score = new Map<GuessedLanguage, number>();
  const add = (k: GuessedLanguage, n: number) => score.set(k, (score.get(k) ?? 0) + n);
  for (const [lang, words] of Object.entries(WORDS) as Array<[GuessedLanguage, string[]]>) {
    const set = new Set(words);
    for (const t of tokens) if (set.has(t)) add(lang, 1);
  }
  for (const [lang, re, weight] of MARKS) add(lang, (lower.match(re)?.length ?? 0) * weight);

  // Pidgin shares many words with English: it must be clearly ahead on its own markers to win.
  const en = score.get('en') ?? 0;
  const pcm = score.get('pcm') ?? 0;
  if (pcm > 0 && pcm * 1.6 < en && !/\b(?:dem|wetin|abeg|wahala|dey|una)\b/.test(lower)) score.set('pcm', 0);

  let best: GuessedLanguage = 'und';
  let top = 0;
  for (const [lang, n] of score) {
    if (n > top) {
      top = n;
      best = lang;
    }
  }
  return top >= 2 ? best : 'und';
}

/** The language a mock result should report: what the post declares, else our guess from the text. */
export function mockLanguage(
  hint: string | null | undefined,
  text: string | undefined,
): GuessedLanguage | null {
  return normalizeHint(hint) ?? (text ? (guessLanguage(text) === 'und' ? null : guessLanguage(text)) : null);
}
