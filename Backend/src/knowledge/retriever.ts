import type { FactEntry } from './factBase.js';

/**
 * Keyword retrieval (BM25) over the fact base. There are only a few dozen curated entries, so plain lexical search
 * is accurate, explainable and needs no embedding service; the writer (an LLM) only ever sees what this returns.
 */

const STOPWORDS = new Set(
  'a an and are as at be been but by can could do does for from had has have he her his how i if in into is it its may more most no not of on or our she so than that the their them then there these they this to up was we were what when where which who why will with would you your said says say people person'.split(
    ' ',
  ),
);

/** Folds accents and case, splits on anything that is not a letter or digit. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** A deliberately light stemmer: enough to match "cures"/"cure" and "spreading"/"spread", nothing clever. */
export function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/**
 * How rumours are worded versus how guidance is worded: "cure" in a rumour is "treatment" in a fact sheet.
 * Keys and values are plain words (they are stemmed on use).
 */
const SYNONYMS: Record<string, string[]> = {
  cure: ['treatment', 'treat', 'supportive'],
  heal: ['treatment', 'supportive'],
  remedy: ['treatment', 'supportive'],
  herb: ['treatment'],
  drink: ['treatment'],
  medicine: ['treatment', 'vaccine'],
  drug: ['treatment'],
  prevent: ['prevention', 'protect'],
  protect: ['prevention', 'vaccine'],
  jab: ['vaccine'],
  vaccination: ['vaccine'],
  airborne: ['contact', 'transmission', 'spread'],
  air: ['contact', 'transmission'],
  catch: ['spread', 'transmission', 'contact'],
  contagious: ['spread', 'transmission', 'symptoms'],
  infect: ['spread', 'transmission'],
  touch: ['contact', 'spread'],
  kiss: ['contact'],
  mosquito: ['transmission', 'animals'],
  bat: ['animals', 'origin'],
  bushmeat: ['animals', 'prevention'],
  fake: ['rely', 'official', 'sources'],
  rumour: ['rely', 'official', 'sources'],
  rumor: ['rely', 'official', 'sources'],
  hoax: ['real', 'confirmed', 'rely'],
  lie: ['rely', 'official'],
  created: ['origin', 'animals'],
  engineered: ['origin', 'animals'],
  bioweapon: ['origin', 'animals'],
  hospital: ['treatment', 'isolation'],
  quarantine: ['isolation', 'contact'],
  burial: ['burials', 'safe', 'dignified'],
  corpse: ['burials', 'body'],
  survivor: ['survivors', 'recovered'],
  recovered: ['survivors'],
  hotline: ['contacts', 'ncdc'],
  call: ['contacts', 'ncdc'],
  nigeria: ['nigeria', 'ncdc', 'situation'],
  abuja: ['nigeria', 'ncdc', 'situation'],
  lagos: ['nigeria', 'ncdc', 'situation'],
  case: ['situation', 'confirmed'],
  confirmed: ['situation'],
  outbreak: ['situation'],
  congo: ['situation', 'bundibugyo'],
  drc: ['situation', 'bundibugyo'],
  bundibugyo: ['bundibugyo', 'situation', 'vaccine'],
  ervebo: ['vaccine', 'bundibugyo'],
};

/** Which fact topics a taxonomy category is most likely to need. Category ids are data; unknown ones add nothing. */
export const CATEGORY_TOPICS: Record<string, string[]> = {
  fake_cure_prevention: ['treatment', 'prevention', 'vaccines'],
  transmission_misinfo: ['transmission', 'symptoms'],
  outbreak_denial: ['overview', 'diagnosis', 'situation'],
  origin_conspiracy: ['overview', 'transmission'],
  response_distrust: ['prevention', 'what-to-do'],
  vaccine_trial_distrust: ['vaccines'],
  burial_resistance: ['transmission', 'prevention'],
  stigma_discrimination: ['survivors'],
  false_case_report: ['situation', 'contacts', 'what-to-do'],
  fake_official_notice: ['contacts', 'what-to-do'],
  incitement_against_response: ['prevention'],
};

export interface Retrieved {
  entry: FactEntry;
  score: number;
  /** Why it was picked, for the audit trail. */
  why: 'text-match' | 'topic';
}

export interface RetrieveOptions {
  category?: string | null;
  /** Human name of the category, searched as extra words. */
  categoryName?: string | null;
  k?: number;
  /** A text match scoring below this does not count (the claim shares only a stray word with the entry). */
  minScore?: number;
}

const K1 = 1.4;
const B = 0.75;
const TOPIC_BONUS = 1.2;

export class Retriever {
  private readonly docs: Array<{ entry: FactEntry; terms: Map<string, number>; len: number }>;
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(entries: FactEntry[]) {
    this.docs = entries.map((entry) => {
      // the id and topic are searchable too: "no-proven-home-cure" is the best summary of that entry
      const tokens = tokenize(`${entry.text} ${entry.topic} ${entry.id.replace(/-/g, ' ')}`);
      const terms = new Map<string, number>();
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
      return { entry, terms, len: tokens.length };
    });
    for (const d of this.docs) for (const t of d.terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }

  private queryTerms(claim: string, extra: string): Map<string, number> {
    const base = tokenize(`${claim} ${extra}`);
    const weights = new Map<string, number>();
    for (const t of base) weights.set(t, (weights.get(t) ?? 0) + 1);
    // synonyms count for less than the words actually written
    for (const raw of base) {
      for (const syn of SYNONYMS[raw] ?? []) {
        const s = stem(syn);
        weights.set(s, Math.max(weights.get(s) ?? 0, 0.6));
      }
    }
    return weights;
  }

  private bm25(d: { terms: Map<string, number>; len: number }, query: Map<string, number>): number {
    const n = this.docs.length;
    let score = 0;
    for (const [term, qw] of query) {
      const f = d.terms.get(term);
      if (!f) continue;
      const df = this.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += qw * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / this.avgLen)));
    }
    return score;
  }

  retrieve(claim: string, opts: RetrieveOptions = {}): Retrieved[] {
    const k = opts.k ?? 5;
    const minScore = opts.minScore ?? 2.5;
    const query = this.queryTerms(claim, opts.categoryName ?? '');
    const topics = new Set((opts.category && CATEGORY_TOPICS[opts.category]) || []);

    const scored = this.docs.map((d) => ({ entry: d.entry, text: this.bm25(d, query) }));
    const out: Retrieved[] = [];
    for (const s of scored) {
      const topical = topics.has(s.entry.topic);
      if (s.text >= minScore)
        out.push({ entry: s.entry, score: s.text + (topical ? TOPIC_BONUS : 0), why: 'text-match' });
      else if (topical && s.text > 0) out.push({ entry: s.entry, score: s.text + TOPIC_BONUS, why: 'topic' });
    }
    return out.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, k);
  }
}
