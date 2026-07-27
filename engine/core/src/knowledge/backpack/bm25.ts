/**
 * Hand-rolled Okapi BM25 over the backpack chunks. The index is a plain,
 * JSON-serializable object so it can live inside the persisted backpack file.
 * Everything here is pure and deterministic: the same corpus and query always
 * produce the same ranking.
 */

const K1 = 1.2;
const B = 0.75;

export interface Bm25Index {
  version: 1;
  /** Number of documents. */
  n: number;
  /** Token count of each document, by document index. */
  lengths: number[];
  /** Average document length. */
  avgdl: number;
  /** term -> document frequency (how many docs contain it). */
  df: Record<string, number>;
  /** term -> [docIndex, termFrequency][]. */
  postings: Record<string, [number, number][]>;
}

/** Lowercase, split on anything that is not a Unicode letter/digit, drop tokens shorter than 2 chars. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length >= 2) out.push(tok);
  }
  return out;
}

/**
 * Build a serializable BM25 index over the given documents (in order).
 *
 * The term maps are prototype-less. A plain `{}` inherits from Object, so a
 * corpus containing the word "constructor" (or "toString", "valueOf") finds a
 * truthy value already sitting at that key: `postings[term] ??= []` then never
 * assigns and the push fails, while `df[term] ?? 0` adds one to a function.
 * Ordinary prose rarely trips it; source code trips it in the first file.
 */
export function buildBm25(docs: string[]): Bm25Index {
  const lengths: number[] = [];
  const df: Record<string, number> = Object.create(null) as Record<string, number>;
  const postings: Record<string, [number, number][]> = Object.create(null) as Record<string, [number, number][]>;
  let totalLen = 0;

  docs.forEach((doc, i) => {
    const tokens = tokenize(doc);
    lengths.push(tokens.length);
    totalLen += tokens.length;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, freq] of tf) {
      df[term] = (df[term] ?? 0) + 1;
      (postings[term] ??= []).push([i, freq]);
    }
  });

  return {
    version: 1,
    n: docs.length,
    lengths,
    avgdl: docs.length > 0 ? totalLen / docs.length : 0,
    df,
    postings,
  };
}

/** Robertson/Spärck-Jones IDF with the +0.5 smoothing, floored at 0. */
function idf(n: number, df: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** Score the corpus against a query; returns the top-k documents by BM25 score. */
export function bm25Search(index: Bm25Index, query: string, k: number): { i: number; score: number }[] {
  const scores = new Map<number, number>();
  const avgdl = index.avgdl || 1;
  for (const term of new Set(tokenize(query))) {
    const posting = index.postings[term];
    // Array-checked, not truthy-checked: an index that has been through
    // JSON.parse carries Object.prototype again, so a term like "constructor"
    // would hand back a function here.
    if (!Array.isArray(posting)) continue;
    const termIdf = idf(index.n, typeof index.df[term] === "number" ? index.df[term]! : posting.length);
    for (const [docIndex, freq] of posting) {
      const dl = index.lengths[docIndex] ?? 0;
      const denom = freq + K1 * (1 - B + (B * dl) / avgdl);
      const contribution = termIdf * ((freq * (K1 + 1)) / denom);
      scores.set(docIndex, (scores.get(docIndex) ?? 0) + contribution);
    }
  }
  return [...scores.entries()]
    .map(([i, score]) => ({ i, score }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k);
}
