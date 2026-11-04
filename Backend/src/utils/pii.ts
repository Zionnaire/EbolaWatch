/**
 * PII scrubber. Runs before anything is stored and before anything is sent to the model.
 * Replaces handles, mentions, URLs (with or without a scheme), emails and phone numbers
 * (including Nigerian formats: +234…, 0803…, spaced, dashed) with neutral tokens.
 */

export const PII_TOKENS = {
  email: '[email]',
  url: '[url]',
  handle: '[handle]',
  phone: '[phone]',
} as const;

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

// http(s)://… and www.… up to whitespace; trailing sentence punctuation is left in place.
const URL_WITH_SCHEME = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi;

// Scheme-less: host.tld[/path]. A TLD allow-list keeps "ebola.It" typos and "e.g." from matching.
const TLDS =
  'com|org|net|edu|gov|ng|co|io|info|me|ly|tv|app|dev|xyz|social|news|ai|fm|gl|link|page|site|online|africa|uk|us|za|gh|fr';
const URL_BARE = new RegExp(
  String.raw`(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${TLDS})\b(?::\d{2,5})?(?:/[^\s<>"')\]]*[^\s<>"')\].,;:!?])?`,
  'gi',
);

// @handle or @user.bsky.social (also catches RT @user: and mid-word-safe mentions)
const HANDLE = /(?<![\w@])@[a-z0-9_](?:[a-z0-9_.-]{0,48}[a-z0-9_])?/gi;

// Nigerian mobile: 0 + [789][01]x + 7 digits (11 digits), or +234 / 234 / +234(0) followed by the same
// 10 digits, with optional space, dot or dash between any two digits.
const SEP = String.raw`[\s.-]?`;
const NG_TAIL = String.raw`[789]${SEP}[01]${SEP}\d(?:${SEP}\d){7}`;
const PHONE_NG = new RegExp(
  String.raw`(?<![\w+])(?:\+?234${SEP}(?:\(0\)${SEP})?|0${SEP})${NG_TAIL}(?!\d)`,
  'g',
);
// Any other international number must start with "+" (avoids eating dates, counts and ids).
const PHONE_INTL = new RegExp(
  String.raw`(?<![\w+])\+\d{1,3}(?:${SEP}\(?\d{1,4}\)?){2,5}(?:${SEP}\d){0,4}(?!\d)`,
  'g',
);

export function scrubPii(input: string): string {
  return input
    .replace(EMAIL, PII_TOKENS.email)
    .replace(URL_WITH_SCHEME, PII_TOKENS.url)
    .replace(HANDLE, PII_TOKENS.handle)
    .replace(URL_BARE, PII_TOKENS.url)
    .replace(PHONE_NG, PII_TOKENS.phone)
    .replace(PHONE_INTL, PII_TOKENS.phone);
}
