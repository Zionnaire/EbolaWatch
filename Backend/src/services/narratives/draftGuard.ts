import type { FactEntry } from '../../knowledge/factBase.js';

export interface DraftCheckInput {
  text: string;
  usedIds: string[];
  /** Every fact the writer was shown. */
  offered: FactEntry[];
  charLimit: number;
}

export interface DraftCheck {
  ok: boolean;
  problems: string[];
}

const normalise = (s: string) => s.toLowerCase().replace(/[\s,]+/g, ' ');

/** Numbers that carry meaning, as written: digit groups with percent signs and phone-style spacing kept together. */
function numbersIn(text: string): string[] {
  return text.match(/\d[\d\s-]{0,14}\d%?|\d%/g) ?? [];
}

const joined = (n: string) => n.replace(/[\s-]/g, '');
const pieces = (n: string) => n.split(/[\s-]+/).filter(Boolean);

/**
 * The checks every draft must pass before a person sees it. The writer is told to use only the facts, but a model
 * can ignore that, so this verifies it: it cites only facts it was given, adds no number, phone number, link or
 * email that the cited facts do not contain, and fits the platform. It cannot judge tone; people do that.
 */
export function checkDraft(i: DraftCheckInput): DraftCheck {
  const problems: string[] = [];
  const text = i.text.trim();
  if (!text) problems.push('The reply is empty.');
  if (text.length > i.charLimit)
    problems.push(`The reply is ${text.length} characters; the limit is ${i.charLimit}.`);

  const offered = new Map(i.offered.map((e) => [e.id, e]));
  if (i.usedIds.length === 0) problems.push('The reply cites no fact.');
  const unknown = i.usedIds.filter((id) => !offered.has(id));
  if (unknown.length) problems.push(`It cites facts that were not provided: ${unknown.join(', ')}.`);

  const used = i.usedIds.map((id) => offered.get(id)).filter((e): e is FactEntry => !!e);
  const factText = used.map((e) => e.text).join(' ');
  const allowed = new Set<string>();
  for (const n of numbersIn(factText)) {
    allowed.add(joined(n));
    for (const p of pieces(n)) allowed.add(p);
  }
  // a number is fine if it appears as written in a cited fact, or if each part of it does ("2014 20 cases")
  const extra = numbersIn(text)
    .filter((n) => !allowed.has(joined(n)) && !pieces(n).every((p) => allowed.has(p) || /^\d$/.test(p)))
    .map(joined);
  if (extra.length)
    problems.push(`It contains numbers that are not in the cited facts: ${[...new Set(extra)].join(', ')}.`);

  const factNorm = normalise(factText);
  for (const url of text.match(/https?:\/\/\S+|www\.\S+/gi) ?? []) {
    if (!factNorm.includes(normalise(url).replace(/[).,]+$/, '')))
      problems.push(`It contains a link that is not in the cited facts: ${url}.`);
  }
  for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []) {
    if (!factNorm.includes(normalise(email)))
      problems.push(`It contains an email address that is not in the cited facts: ${email}.`);
  }
  return { ok: problems.length === 0, problems };
}
