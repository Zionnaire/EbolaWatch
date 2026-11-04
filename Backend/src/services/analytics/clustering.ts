import { tokenize } from '../../knowledge/retriever.js';

/**
 * Groups posts that make the same claim, by the words they use (TF-IDF vectors compared by cosine similarity).
 * Deterministic, offline and fast enough for thousands of posts. It needs no embedding service, and it reads only
 * the PII-scrubbed text. Two posts with the same rumour in different wording usually still share their key words
 * ("salt", "water", "bath"); a model-based grouping could join paraphrases that share none, which is a later upgrade.
 */

export interface ClusterDoc {
  id: string;
  text: string;
  /** ms since epoch */
  at: number;
}

type Vec = Map<string, number>;

export interface ClusterOptions {
  /** A post joins a cluster when its similarity to the cluster's centre is at least this. */
  joinThreshold?: number;
  /** After assignment, clusters whose centres are at least this similar are merged. */
  mergeThreshold?: number;
}

export interface TextCluster {
  /** Stable while its first post stays in the window: the id of its earliest post. */
  id: string;
  /** Indexes into the input array, earliest first. */
  members: number[];
  /** Most characteristic stems, strongest first. */
  keyStems: string[];
  /** Index of the member closest to the cluster's centre. */
  centralMember: number;
}

export interface Clustering {
  clusters: TextCluster[];
  /** Cosine similarity of one text to each cluster centre (for placing posts from another window). */
  similarityTo(text: string): Array<{ cluster: number; sim: number }>;
  /** A readable surface form for a stem, from the words actually used. */
  surface(stem: string): string;
}

const PLACEHOLDER = /\[(?:url|phone|email|handle|link|user|name)[a-z_]*\]/gi;
const clean = (t: string) => t.replace(PLACEHOLDER, ' ').replace(/https?:\/\/\S+/g, ' ');

function norm(v: Vec): number {
  let s = 0;
  for (const x of v.values()) s += x * x;
  return Math.sqrt(s);
}

function cosine(a: Vec, an: number, b: Vec, bn: number): number {
  if (an === 0 || bn === 0) return 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const x = large.get(t);
    if (x) dot += w * x;
  }
  return dot / (an * bn);
}

export function clusterTexts(docs: ClusterDoc[], opts: ClusterOptions = {}): Clustering {
  const joinAt = opts.joinThreshold ?? 0.34;
  const mergeAt = opts.mergeThreshold ?? 0.55;

  // surface forms, so a stem is shown as a real word ("bath" not "bat")
  const surfaces = new Map<string, Map<string, number>>();
  const tokensOf = (text: string) => {
    const raw = clean(text)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
    const stems = tokenize(clean(text));
    return { raw, stems };
  };
  const tokenized = docs.map((d) => {
    const t = tokensOf(d.text);
    // remember which word each stem came from (the stemmer maps both ways, so key by the stem of each raw word)
    for (const w of t.raw) {
      const [s] = tokenize(w);
      if (!s) continue;
      const m = surfaces.get(s) ?? new Map<string, number>();
      m.set(w, (m.get(w) ?? 0) + 1);
      surfaces.set(s, m);
    }
    return t.stems;
  });

  const df = new Map<string, number>();
  for (const stems of tokenized) for (const s of new Set(stems)) df.set(s, (df.get(s) ?? 0) + 1);
  const n = Math.max(1, docs.length);
  const idf = (s: string) => Math.log(1 + n / (1 + (df.get(s) ?? 0)));

  const vectorize = (stems: string[]): Vec => {
    const v: Vec = new Map();
    for (const s of stems) v.set(s, (v.get(s) ?? 0) + 1);
    for (const [s, f] of v) v.set(s, (1 + Math.log(f)) * idf(s));
    return v;
  };
  const vecs = tokenized.map(vectorize);
  const norms = vecs.map(norm);

  // oldest first, so the earliest post seeds a cluster and ids are stable
  const order = docs
    .map((_, i) => i)
    .sort((a, b) => docs[a]!.at - docs[b]!.at || docs[a]!.id.localeCompare(docs[b]!.id));

  interface C {
    sum: Vec;
    norm: number;
    members: number[];
  }
  let clusters: C[] = [];
  const addTo = (c: C, i: number) => {
    for (const [t, w] of vecs[i]!) c.sum.set(t, (c.sum.get(t) ?? 0) + w / (norms[i] || 1));
    c.norm = norm(c.sum);
    c.members.push(i);
  };

  const assign = (indexes: number[], seeds: C[]): C[] => {
    const out: C[] = seeds;
    for (const i of indexes) {
      let best = -1;
      let bestSim = 0;
      for (let k = 0; k < out.length; k++) {
        const sim = cosine(vecs[i]!, norms[i]!, out[k]!.sum, out[k]!.norm);
        if (sim > bestSim) {
          bestSim = sim;
          best = k;
        }
      }
      if (best >= 0 && bestSim >= joinAt) addTo(out[best]!, i);
      else {
        const c: C = { sum: new Map(), norm: 0, members: [] };
        addTo(c, i);
        out.push(c);
      }
    }
    return out;
  };

  clusters = assign(order, []);

  // one refinement round: with real centres known, put every post where it fits best (fixes arrival-order effects)
  const reseed = clusters.map((c) => {
    const f: C = { sum: new Map(c.sum), norm: c.norm, members: [] };
    return f;
  });
  const refined = reseed.map(() => ({ sum: new Map() as Vec, norm: 0, members: [] as number[] }));
  const centres = reseed;
  for (const i of order) {
    let best = -1;
    let bestSim = 0;
    for (let k = 0; k < centres.length; k++) {
      const sim = cosine(vecs[i]!, norms[i]!, centres[k]!.sum, centres[k]!.norm);
      if (sim > bestSim) {
        bestSim = sim;
        best = k;
      }
    }
    if (best >= 0 && bestSim >= joinAt) addTo(refined[best]!, i);
    else {
      const fresh = { sum: new Map() as Vec, norm: 0, members: [] as number[] };
      addTo(fresh, i);
      refined.push(fresh);
    }
  }
  clusters = refined.filter((c) => c.members.length > 0);

  // merge clusters whose centres are nearly the same claim
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        if (cosine(clusters[a]!.sum, clusters[a]!.norm, clusters[b]!.sum, clusters[b]!.norm) >= mergeAt) {
          for (const i of clusters[b]!.members) addTo(clusters[a]!, i);
          clusters.splice(b, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  const result: TextCluster[] = clusters.map((c) => {
    const members = [...c.members].sort(
      (a, b) => docs[a]!.at - docs[b]!.at || docs[a]!.id.localeCompare(docs[b]!.id),
    );
    const keyStems = [...c.sum.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([s]) => s);
    let central = members[0]!;
    let bestSim = -1;
    for (const i of members) {
      const sim = cosine(vecs[i]!, norms[i]!, c.sum, c.norm);
      if (sim > bestSim) {
        bestSim = sim;
        central = i;
      }
    }
    return { id: docs[members[0]!]!.id, members, keyStems, centralMember: central };
  });
  result.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));

  const finalCentres = result.map((r) => {
    const sum: Vec = new Map();
    for (const i of r.members)
      for (const [t, w] of vecs[i]!) sum.set(t, (sum.get(t) ?? 0) + w / (norms[i] || 1));
    return { sum, norm: norm(sum) };
  });

  return {
    clusters: result,
    similarityTo(text: string) {
      // terms unseen in the window carry no weight, which is right: they cannot match any cluster
      const v = vectorize(tokenize(clean(text)).filter((s) => df.has(s)));
      const vn = norm(v);
      return finalCentres.map((c, k) => ({ cluster: k, sim: cosine(v, vn, c.sum, c.norm) }));
    },
    surface(stem: string) {
      const m = surfaces.get(stem);
      if (!m) return stem;
      return [...m.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]),
      )[0]![0];
    },
  };
}

export const JOIN_THRESHOLD = 0.34;
