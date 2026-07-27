import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../util/fsAtomic.js";
import { bm25Search, tokenize, type Bm25Index } from "./backpack/bm25.js";
import {
  MAX_FILE_BYTES,
  SCAN_EXTS,
  extOf,
  loadOrBuildGraph,
  normalizeToId,
  pagerank,
  shouldSkipDir,
  type GraphData,
} from "./graph.js";
import { extractSymbolSites, loadOrBuildSymbolIndex, tokensOf, type SymbolIndexData } from "./symbols.js";

/**
 * DETERMINISTIC CODE RETRIEVAL — everything that can be decided about "which
 * code does this request concern" without asking a model.
 *
 * A GENERAL CAPABILITY, not a feature of any one mode. It takes a workspace and
 * a request and returns ranked code; it knows nothing about who is asking.
 * CAREFUL MODE's scout phase is its first caller because that is where the cost
 * was, but a tool, another mode, or a subagent brief can use the same result —
 * which is why {@link retrieveContext} returns DATA and {@link renderRetrieval}
 * formats it separately. A caller that wants to render differently, take only
 * the ranked paths, or feed the chunks somewhere else never has to unpick a
 * string.
 *
 * The problem it solves. An agent handed only file PATHS has to open files to
 * find out whether they matter, and each open is a round trip whose whole
 * context is re-sent. On a large codebase that is the entire cost. So the work
 * moves here: rank, then hand over the code itself.
 *
 * The pipeline, in order:
 *
 *   1. CHUNK      — a file becomes declaration-bounded spans (its symbol index
 *                   already knows where every declaration starts), so a hit is
 *                   a whole function rather than an arbitrary window.
 *   2. QUERY      — the request is prose; code is identifiers. The query is
 *                   built, not taken: tokenized identifier-aware, given the
 *                   user's own answers, and expanded from the corpus itself
 *                   when the raw words have no purchase.
 *   3. LEXICAL    — Okapi BM25 over the chunks (the implementation already in
 *                   this repo, previously pointed only at crew documents).
 *   4. STRUCTURAL — personalized PageRank over the import graph, its teleport
 *                   vector weighted by the lexical scores.
 *   5. FUSE       — Reciprocal Rank Fusion. Ranks, not scores: BM25 sums IDF
 *                   terms while PageRank masses sum to 1, and any weighting
 *                   that balanced them on one repository would be wrong on the
 *                   next. RRF also degrades gracefully — if one leg returns
 *                   noise the other still carries the result.
 *   6. LADDER     — spend a token budget in three grades: paths for everything
 *                   ranked, skeletons for the top files, content for the top
 *                   chunks. The skeleton grade is what makes a large file
 *                   usable: it turns a blind 2900-line Read into a precise
 *                   `offset`/`limit` one.
 *
 * Nothing here calls a model, and every stage is a pure function of the
 * workspace plus the request.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** One indexed span of a file: a declaration and everything until the next. */
export interface CodeChunk {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The declaration this span opens with, or "" for a plain line window. */
  label: string;
}

interface IndexedFile {
  mtimeMs: number;
  size: number;
  chunks: CodeChunk[];
  /** Term frequencies per chunk, aligned to `chunks`. */
  tf: Record<string, number>[];
  /** Token count per chunk, aligned to `chunks`. */
  lengths: number[];
}

export interface CodeIndexData {
  version: 1;
  files: Record<string, IndexedFile>;
}

const INDEX_DIR = ".magentra";
const INDEX_FILE = "codeindex.json";

const MAX_DEPTH = 12;

/**
 * What the code index reads — deliberately WIDER than the graph's `SCAN_EXTS`.
 *
 * The two sets answer different questions. `SCAN_EXTS` is "can we parse imports
 * out of this", so it is a list of programming languages. Retrieval asks "would
 * a person search this file", and the answer includes the stylesheet, the
 * template and the config. Leaving them out made a request about how something
 * LOOKS unable to find the stylesheet, which is the one file that decides it.
 */
const RETRIEVAL_EXTS = new Set([
  ...SCAN_EXTS,
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm", ".xml", ".svg",
  ".md", ".mdx", ".rst", ".txt",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".env",
]);

/** Machine-written files that are large, uninformative, and would swamp the index. */
const RETRIEVAL_SKIP_NAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "composer.lock",
  "cargo.lock", "poetry.lock", "gemfile.lock", "go.sum",
]);
/** Ceiling on indexed chunks. A repository past this is ranked on what fits. */
const MAX_CHUNKS = 20_000;
/** Lines per window when a file yields no declarations at all. */
const WINDOW_LINES = 60;
/** Distinct terms kept per chunk — bounds the persisted index on generated files. */
const MAX_TERMS_PER_CHUNK = 400;

// ---------------------------------------------------------------------------
// 1. Chunking
// ---------------------------------------------------------------------------

/**
 * Split a file into declaration spans. Falls back to fixed windows when the
 * language has no declarations we recognize, so every file is retrievable
 * whatever it is written in.
 */
export function chunkFile(path: string, content: string): CodeChunk[] {
  const lineCount = content.split("\n").length;
  if (lineCount === 0) return [];
  const sites = extractSymbolSites(path, content);
  if (sites.length === 0) {
    const chunks: CodeChunk[] = [];
    for (let start = 1; start <= lineCount; start += WINDOW_LINES) {
      chunks.push({ startLine: start, endLine: Math.min(start + WINDOW_LINES - 1, lineCount), label: "" });
    }
    return chunks;
  }
  const chunks: CodeChunk[] = [];
  // Anything above the first declaration — imports, the file's own header
  // comment — is its own span: it is often the most descriptive text in a file.
  if (sites[0]!.line > 1) {
    chunks.push({ startLine: 1, endLine: sites[0]!.line - 1, label: "" });
  }
  sites.forEach((site, i) => {
    const next = sites[i + 1];
    chunks.push({
      startLine: site.line,
      endLine: next ? next.line - 1 : lineCount,
      label: site.name,
    });
  });
  return chunks;
}

// ---------------------------------------------------------------------------
// 2. Tokenization — prose on one side, identifiers on the other
// ---------------------------------------------------------------------------

/**
 * Text with camelCase and snake_case boundaries opened out, so "renderMarkdown"
 * is indexed as `rendermarkdown`, `render` AND `markdown`.
 *
 * This is the join between the two vocabularies. A user writes "render the
 * markdown"; the code says `renderMarkdown`. Without splitting, BM25 sees two
 * unrelated terms and the whole pipeline retrieves nothing — which is exactly
 * how the shipped substring matcher fails.
 */
export function expandIdentifiers(text: string): string {
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-./\\]+/g, " ");
  // Only append when splitting actually produced something new. Prose has no
  // camelCase, so appending an identical copy would double every token — which
  // inflates the index and distorts document lengths relative to files that are
  // mostly identifiers, exactly the comparison BM25's length normalization makes.
  return split === text ? text : `${text} ${split}`;
}

function chunkTerms(text: string): { tf: Record<string, number>; length: number } {
  const tokens = tokenize(expandIdentifiers(text));
  // Prototype-less: "constructor" and friends are ordinary words in source code.
  const tf: Record<string, number> = Object.create(null) as Record<string, number>;
  let distinct = 0;
  for (const token of tokens) {
    if (tf[token] === undefined) {
      if (distinct >= MAX_TERMS_PER_CHUNK) continue;
      distinct++;
    }
    tf[token] = (tf[token] ?? 0) + 1;
  }
  return { tf, length: tokens.length };
}

// ---------------------------------------------------------------------------
// 3. The index — same incremental contract as graph.json and symbols.json
// ---------------------------------------------------------------------------

function indexPath(cwd: string): string {
  return join(cwd, INDEX_DIR, INDEX_FILE);
}

function isValidIndex(v: unknown): v is CodeIndexData {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return g.version === 1 && typeof g.files === "object" && g.files !== null;
}

/**
 * Walk the workspace and index it, reusing every file whose mtime+size are
 * unchanged. Only changed files are re-read and re-tokenized; the global BM25
 * statistics are re-assembled in memory afterwards, which is linear in postings
 * and touches no disk.
 */
export function buildCodeIndex(cwd: string, prev?: CodeIndexData): CodeIndexData {
  const files: Record<string, IndexedFile> = {};
  let chunkCount = 0;

  const walk = (dir: string, depth: number): void => {
    if (chunkCount >= MAX_CHUNKS) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (chunkCount >= MAX_CHUNKS) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        if (shouldSkipDir(entry.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!RETRIEVAL_EXTS.has(extOf(entry.name).toLowerCase())) continue;
      if (RETRIEVAL_SKIP_NAMES.has(entry.name.toLowerCase())) continue;
      let st: import("node:fs").Stats;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      const id = normalizeToId(cwd, abs);
      const before = prev?.files[id];
      if (before && before.mtimeMs === st.mtimeMs && before.size === st.size) {
        files[id] = before;
        chunkCount += before.chunks.length;
        continue;
      }
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      const chunks = chunkFile(abs, content);
      const tf: Record<string, number>[] = [];
      const lengths: number[] = [];
      for (const chunk of chunks) {
        const text = lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
        // The file's own path is indexed with every chunk: a request naming a
        // module by name should find it even when its body never says the word.
        const terms = chunkTerms(`${id}\n${chunk.label}\n${text}`);
        tf.push(terms.tf);
        lengths.push(terms.length);
      }
      files[id] = { mtimeMs: st.mtimeMs, size: st.size, chunks, tf, lengths };
      chunkCount += chunks.length;
    }
  };

  walk(cwd, 0);
  return { version: 1, files };
}

function saveCodeIndex(cwd: string, index: CodeIndexData): void {
  try {
    // Atomic — see saveGraph. This is the biggest of the three caches (megabytes
    // on a large repo), so it is the one most likely to be caught mid-write.
    writeFileAtomic(indexPath(cwd), JSON.stringify(index));
  } catch {
    // best-effort persistence; an unwritable state dir must not break retrieval
  }
}

export function loadOrBuildCodeIndex(cwd: string): CodeIndexData {
  let prev: CodeIndexData | undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(indexPath(cwd), "utf8"));
    if (isValidIndex(raw)) prev = raw;
  } catch {
    prev = undefined;
  }
  const built = buildCodeIndex(cwd, prev);
  // Cheap staleness test: the file set and their stamps. Comparing postings
  // would cost more than the write it saves.
  const changed =
    prev === undefined ||
    Object.keys(prev.files).length !== Object.keys(built.files).length ||
    Object.entries(built.files).some(([id, f]) => {
      const old = prev.files[id];
      return !old || old.mtimeMs !== f.mtimeMs || old.size !== f.size;
    });
  if (changed) saveCodeIndex(cwd, built);
  return built;
}

/** One chunk of the corpus, flattened for scoring. */
export interface ChunkRef {
  file: string;
  chunk: CodeChunk;
}

/** The corpus as BM25 sees it: a flat chunk list plus the assembled index. */
interface Corpus {
  refs: ChunkRef[];
  bm25: Bm25Index;
}

/** Assemble the global BM25 statistics from the per-file term frequencies. */
function assembleCorpus(index: CodeIndexData): Corpus {
  const refs: ChunkRef[] = [];
  const lengths: number[] = [];
  const df: Record<string, number> = Object.create(null) as Record<string, number>;
  const postings: Record<string, [number, number][]> = Object.create(null) as Record<string, [number, number][]>;
  let totalLen = 0;

  for (const [file, entry] of Object.entries(index.files)) {
    entry.chunks.forEach((chunk, i) => {
      const docIndex = refs.length;
      refs.push({ file, chunk });
      const len = entry.lengths[i] ?? 0;
      lengths.push(len);
      totalLen += len;
      for (const [term, freq] of Object.entries(entry.tf[i] ?? {})) {
        if (typeof freq !== "number") continue;
        df[term] = (df[term] ?? 0) + 1;
        (postings[term] ??= []).push([docIndex, freq]);
      }
    });
  }

  return {
    refs,
    bm25: {
      version: 1,
      n: refs.length,
      lengths,
      avgdl: refs.length > 0 ? totalLen / refs.length : 0,
      df,
      postings,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Query building
// ---------------------------------------------------------------------------

/**
 * Document frequency below which a matched term is treated as incidental
 * rather than topical, in a corpus big enough for the distinction to mean
 * anything.
 *
 * A word the codebase genuinely discusses appears more than twice. A word that
 * appears once is a passing mention in a comment — and because BM25 rewards
 * rarity, that single mention will dominate the ranking and hand back a
 * confident answer built on nothing. This is what makes "improve the visuals"
 * look like a solid match: `visual` occurs twice in the whole repository.
 */
const TOPICAL_MIN_DF = 3;
const TOPICAL_MIN_CORPUS = 200;

/** Expansion terms taken from the first pass, and how far they are trusted. */
const PRF_FEEDBACK_DOCS = 8;
const PRF_MAX_TERMS = 10;
/**
 * Expansion terms are scored as their OWN ranking and fused, rather than mixed
 * into the query. `bm25Search` de-duplicates the query it is given, so weighting
 * a term by repeating it does nothing at all — the weighting has to happen at
 * the ranking level, which is where the fusion primitive already works.
 */

export interface QueryBuild {
  /** The user's own terms, as one BM25 query. */
  text: string;
  /** Every term the request asked for, before the vocabulary check. */
  requested: string[];
  /** Request terms that exist anywhere in this codebase's vocabulary. */
  grounded: string[];
  /** Grounded terms common enough to be a topic rather than a passing mention. */
  topical: string[];
  /** Terms added by feedback, for reporting. */
  expanded: string[];
}

/** Anything quoted, backticked or path-shaped is taken from the request verbatim. */
function verbatimTerms(request: string): string[] {
  const out = new Set<string>();
  for (const re of [/`([^`\n]+)`/g, /"([^"\n]{2,60})"/g, /'([^'\n]{2,60})'/g]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(request)) !== null) out.add(m[1]!);
  }
  for (const m of request.matchAll(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g)) out.add(m[0]);
  return [...out];
}

/**
 * Build the query.
 *
 * The step the shipped code skipped: it split the request on whitespace and
 * searched for those words. "visual enhancements of UI" contains no term this
 * codebase uses, so retrieval began from nothing. Here the request is tokenized
 * the way identifiers are, given whatever the user answered in the question
 * round, checked against the corpus vocabulary, and — only when that check comes
 * back empty-handed — expanded from the corpus itself.
 */
export function buildQuery(
  corpus: Corpus,
  request: string,
  extra: string | undefined,
  symbols: SymbolIndexData,
): QueryBuild {
  const seedTerms = new Set<string>();
  for (const term of tokensOf(expandIdentifiers(request))) seedTerms.add(term);
  // Caller-supplied intent (CAREFUL MODE passes the user's answers from its
  // question round) is the best term source there is: it states the goal in the
  // user's own words, and costs nothing because it already exists.
  if (extra) for (const term of tokensOf(expandIdentifiers(extra))) seedTerms.add(term);
  const verbatim = verbatimTerms(request);
  for (const term of verbatim) for (const t of tokenize(expandIdentifiers(term))) seedTerms.add(t);

  const original = [...seedTerms];
  // Vocabulary check — a DIAGNOSTIC, not a filter. BM25 ignores an unknown term
  // for free, so nothing needs removing; what this tells us is whether the raw
  // request has any purchase at all, and therefore whether to expand.
  const grounded = original.filter((term) => Array.isArray(corpus.bm25.postings[term]));
  const topical =
    corpus.bm25.n >= TOPICAL_MIN_CORPUS
      ? grounded.filter((term) => (corpus.bm25.df[term] ?? 0) >= TOPICAL_MIN_DF)
      : grounded;

  const firstPass = corpus.bm25.n > 0 ? bm25Search(corpus.bm25, original.join(" "), PRF_FEEDBACK_DOCS) : [];

  // Feedback source: the first pass when it found anything, else the files whose
  // SYMBOL NAMES resemble the request. That fallback is what keeps the vague
  // requests — the ones that need this most — from collapsing to an empty query.
  let feedbackDocs = firstPass.map((hit) => hit.i);
  if (feedbackDocs.length === 0) {
    const names = new Set(symbolFallbackFiles(symbols, original));
    feedbackDocs = corpus.refs
      .map((ref, i) => ({ i, file: ref.file }))
      .filter((r) => names.has(r.file))
      .slice(0, PRF_FEEDBACK_DOCS)
      .map((r) => r.i);
  }

  // Expand when the request's own vocabulary is thin — either nothing matched
  // at all, or fewer than half its terms exist in this codebase. Presence alone
  // is a weak test in a repository with prose-rich comments, where an incidental
  // word matches without carrying any signal.
  const thin = firstPass.length === 0 || grounded.length * 2 < original.length;
  const expanded = thin ? expansionTerms(corpus, feedbackDocs, seedTerms) : [];
  return { text: original.join(" "), requested: original, grounded, topical, expanded };
}

/** Files whose declared names resemble the request — the empty-query fallback. */
function symbolFallbackFiles(symbols: SymbolIndexData, terms: string[]): string[] {
  const wanted = new Set(terms);
  const scored: { file: string; hits: number }[] = [];
  for (const [file, entry] of Object.entries(symbols.files)) {
    let hits = 0;
    for (const name of entry.symbols) {
      for (const token of tokensOf(name)) if (wanted.has(token)) hits++;
    }
    if (hits > 0) scored.push({ file, hits });
  }
  return scored
    .sort((a, b) => b.hits - a.hits || a.file.localeCompare(b.file))
    .slice(0, PRF_FEEDBACK_DOCS)
    .map((s) => s.file);
}

/**
 * Pseudo-relevance feedback: the highest-IDF terms of the best-matching chunks,
 * minus what the user already said.
 *
 * Bounded on purpose. Expansion drifts — pull in enough terms and the query
 * retrieves the whole repository, which is worse than retrieving nothing because
 * it looks like an answer. Ten terms, from a handful of documents, one round.
 */
function expansionTerms(corpus: Corpus, docs: number[], already: Set<string>): string[] {
  if (docs.length === 0) return [];
  const wanted = new Set(docs);
  const score = new Map<string, number>();
  for (const [term, posting] of Object.entries(corpus.bm25.postings)) {
    if (already.has(term) || term.length < 3 || !Array.isArray(posting)) continue;
    let inFeedback = 0;
    for (const [docIndex] of posting) if (wanted.has(docIndex)) inFeedback++;
    if (inFeedback === 0) continue;
    // Frequent inside the feedback set, rare outside it.
    const idf = Math.log(1 + corpus.bm25.n / (corpus.bm25.df[term] ?? 1));
    score.set(term, (inFeedback / docs.length) * idf);
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, PRF_MAX_TERMS)
    .map(([term]) => term);
}

// ---------------------------------------------------------------------------
// 5. Fusion
// ---------------------------------------------------------------------------

/** The conventional RRF constant; it damps the influence of the very top ranks. */
const RRF_K = 60;

/** One leg of the fusion, and which documents that leg was ever able to rank. */
export interface FusionLeg {
  ranking: string[];
  /**
   * Documents this leg could rank at all. A stylesheet is not in the import
   * graph, so the structural leg can never mention it — and summing across legs
   * would then punish it for something it is not eligible for. Absent means
   * every document was eligible.
   */
  eligible?: Set<string>;
}

/**
 * Reciprocal Rank Fusion over any number of rankings: the mean of `1/(k + rank)`
 * across the legs that could rank each document.
 *
 * Ranks rather than scores, because BM25 sums unbounded IDF terms while
 * PageRank masses sum to one. Any constant that balanced the two on this
 * repository would be wrong on the next one, and RRF has no such constant.
 *
 * The MEAN rather than the sum is the part that is easy to get wrong. A plain
 * sum treats "this leg ranked it last" and "this leg cannot see it" as the same
 * thing, which quietly buries every file that lives outside the import graph —
 * stylesheets, templates, configuration. Averaging over eligible legs only asks
 * each document to do well where it can be judged.
 */
export function reciprocalRankFusion(legs: FusionLeg[], k = RRF_K): Map<string, number> {
  const total = new Map<string, number>();
  const counted = new Map<string, number>();
  const seen = new Set<string>();
  for (const leg of legs) leg.ranking.forEach((id) => seen.add(id));
  for (const leg of legs) {
    const rankOf = new Map(leg.ranking.map((id, i) => [id, i]));
    for (const id of seen) {
      if (leg.eligible && !leg.eligible.has(id)) continue;
      const rank = rankOf.get(id);
      // Eligible but unranked still counts as a judgement — it was considered
      // and placed nowhere — so it contributes at the tail rather than nothing.
      const contribution = 1 / (k + (rank ?? leg.ranking.length) + 1);
      total.set(id, (total.get(id) ?? 0) + contribution);
      counted.set(id, (counted.get(id) ?? 0) + 1);
    }
  }
  const fused = new Map<string, number>();
  for (const [id, sum] of total) fused.set(id, sum / (counted.get(id) || 1));
  return fused;
}

// ---------------------------------------------------------------------------
// 6. The ladder
// ---------------------------------------------------------------------------

export interface RetrievalOptions {
  /**
   * Extra text folded into the query alongside the request — anything that
   * states intent in the user's own words. CAREFUL MODE passes the answers from
   * its question round; another caller might pass a task description or a
   * mission charter.
   */
  answers?: string | undefined;
  /** Files listed by path. */
  maxPaths?: number;
  /** Files summarized as a skeleton of their declarations. */
  maxSkeletons?: number;
  /** Chunks whose source is quoted in full. */
  maxChunks?: number;
  /** Ceiling on quoted source, in characters. */
  contentBudget?: number;
}

const DEFAULTS: Required<Omit<RetrievalOptions, "answers">> = {
  maxPaths: 30,
  maxSkeletons: 8,
  maxChunks: 6,
  contentBudget: 12_000,
};

/** Keeps one neighbourhood from spending the whole budget. */
const MAX_CHUNKS_PER_FILE = 2;
/** Floor on files admitted per directory; the real allowance scales with how
 *  many directories the ranking actually spans (see the spread, below). */
const MAX_FILES_PER_DIR = 4;
/** Prose files listed beside the code, at most. */
const MAX_DOC_FILES = 5;
/** Extensions that are documentation rather than code. */
const PROSE_EXTS = new Set([".md", ".mdx", ".rst", ".txt"]);
/** Declarations listed per skeleton before it stops being a summary. */
const MAX_SKELETON_LINES = 40;

function dirOf(file: string): string {
  return file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
}

/** One quoted span of source, with the location it came from. */
export interface RetrievedChunk {
  file: string;
  startLine: number;
  endLine: number;
  label: string;
  text: string;
}

/** A file summarized by what it declares and where. */
export interface RetrievedSkeleton {
  file: string;
  declarations: { name: string; line: number }[];
  omitted: number;
}

/** What retrieval knows about a request. Rendering is a separate concern. */
export interface RetrievalResult {
  /** Ranked source files, most relevant first, after fusion and the spread. */
  files: string[];
  /**
   * Ranked prose — documentation, ADRs, READMEs — kept SEPARATE from code.
   *
   * Not a lower score: a different kind of answer. A request phrased in prose
   * matches prose better than it matches code, so mixing the two lets a design
   * document outrank the implementation it describes. Both are worth having;
   * presenting them together buries the thing the reader has to edit.
   */
  docs: string[];
  skeletons: RetrievedSkeleton[];
  chunks: RetrievedChunk[];
  /** Terms the corpus contributed, when the request's own words had no purchase. */
  expandedTerms: string[];
  /**
   * How much of the request this codebase recognizes: terms of the request that
   * exist in the corpus, over terms asked for.
   *
   * The honest confidence signal. "improve the UI" shares almost no vocabulary
   * with the code, so the ranking below it is a guess — and a caller that
   * presents a guess as a fact anchors whoever reads it on the wrong files.
   */
  coverage: { matched: number; requested: number };
  /** True when the request's own words had little purchase on this codebase. */
  weak: boolean;
}

/**
 * Rank a workspace against a request. Pure retrieval — no formatting, no
 * assumptions about the caller. Returns undefined when the workspace yields
 * nothing to rank, so a caller can fall back rather than act on an empty result.
 */
export function retrieveContext(
  cwd: string,
  request: string,
  options: RetrievalOptions = {},
): RetrievalResult | undefined {
  const opts = { ...DEFAULTS, ...options };
  let index: CodeIndexData;
  let graph: GraphData;
  let symbols: SymbolIndexData;
  try {
    index = loadOrBuildCodeIndex(cwd);
    graph = loadOrBuildGraph(cwd);
    symbols = loadOrBuildSymbolIndex(cwd);
  } catch {
    return undefined;
  }
  const corpus = assembleCorpus(index);
  if (corpus.refs.length === 0) return undefined;

  // ── Lexical leg ──────────────────────────────────────────────────────────
  const query = buildQuery(corpus, request, options.answers, symbols);
  if (query.text.trim() === "") return undefined;
  const chunkHits = bm25Search(corpus.bm25, query.text, 200);
  const expandedHits =
    query.expanded.length > 0 ? bm25Search(corpus.bm25, query.expanded.join(" "), 200) : [];
  if (chunkHits.length === 0 && expandedHits.length === 0) return undefined;

  /** A chunk ranking rolled up to files, each file scored by its best chunk. */
  const fileRanking = (hits: { i: number; score: number }[]): Map<string, number> => {
    const best = new Map<string, number>();
    for (const hit of hits) {
      const ref = corpus.refs[hit.i];
      if (!ref) continue;
      best.set(ref.file, Math.max(best.get(ref.file) ?? 0, hit.score));
    }
    return best;
  };
  const ordered = (scores: Map<string, number>): string[] =>
    [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([file]) => file);

  const lexicalFileScore = fileRanking(chunkHits);
  const lexicalRanking = ordered(lexicalFileScore);
  const expandedRanking = ordered(fileRanking(expandedHits));

  // ── Structural leg: the lexical winners become weighted seeds ─────────────
  const seeds = lexicalRanking.filter((file) => graph.files[file] !== undefined).slice(0, 20);
  const structuralRanking =
    seeds.length > 0
      ? [...pagerank(graph, { seeds, seedWeights: lexicalFileScore }).entries()]
          .filter(([id]) => !id.startsWith("pkg:") && graph.files[id] !== undefined)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([id]) => id)
      : [];

  // ── Fuse, then spread the result across directories ──────────────────────
  // The structural leg can only judge files the import graph contains; a
  // stylesheet or a template is retrievable but has no edges, and must not be
  // penalized for that.
  const fused = reciprocalRankFusion([
    { ranking: lexicalRanking },
    { ranking: structuralRanking, eligible: new Set(Object.keys(graph.files)) },
    ...(expandedRanking.length > 0 ? [{ ranking: expandedRanking }] : []),
  ]);
  const ordered_ = [...fused.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // The spread keeps ONE neighbourhood from filling the whole result. In a
  // repository that has only one neighbourhood there is nothing to spread, and
  // a fixed cap then truncates the entire ranking: a flat project — a script, a
  // game, anything without a src/ tree — could never surface more than four
  // files however many it had, and the fifth-best was simply invisible. So the
  // allowance is the budget divided by the directories actually in play, and
  // never tighter than the fixed cap.
  const dirsInPlay = new Set(
    ordered_.filter(([file]) => !PROSE_EXTS.has(extOf(file).toLowerCase())).map(([file]) => dirOf(file)),
  ).size;
  const perDirLimit = Math.max(MAX_FILES_PER_DIR, Math.ceil(opts.maxPaths / Math.max(dirsInPlay, 1)));
  const perDir = new Map<string, number>();
  const files: string[] = [];
  const docs: string[] = [];
  for (const [file] of ordered_) {
    if (PROSE_EXTS.has(extOf(file).toLowerCase())) {
      if (docs.length < MAX_DOC_FILES) docs.push(file);
      continue;
    }
    const dir = dirOf(file);
    const used = perDir.get(dir) ?? 0;
    if (used >= perDirLimit) continue;
    perDir.set(dir, used + 1);
    files.push(file);
    if (files.length >= opts.maxPaths) break;
  }
  if (files.length === 0 && docs.length === 0) return undefined;

  // ── Grade 2: what the top files declare, and where ───────────────────────
  const skeletons: RetrievedSkeleton[] = [];
  for (const file of files.slice(0, opts.maxSkeletons)) {
    const entry = symbols.files[file];
    if (!entry || entry.symbols.length === 0) continue;
    const shown = entry.symbols.slice(0, MAX_SKELETON_LINES);
    skeletons.push({
      file,
      declarations: shown.map((name, i) => ({ name, line: entry.lines[i] ?? 0 })),
      omitted: entry.symbols.length - shown.length,
    });
  }

  // ── Grade 3: the code itself, under a character budget ───────────────────
  const ranked = new Set(files);
  const chunks: RetrievedChunk[] = [];
  const perFile = new Map<string, number>();
  let spent = 0;
  for (const hit of [...chunkHits, ...expandedHits]) {
    if (chunks.length >= opts.maxChunks || spent >= opts.contentBudget) break;
    const ref = corpus.refs[hit.i];
    if (!ref || !ranked.has(ref.file)) continue;
    const used = perFile.get(ref.file) ?? 0;
    if (used >= MAX_CHUNKS_PER_FILE) continue;
    let body: string;
    try {
      body = readFileSync(join(cwd, ref.file), "utf8")
        .split("\n")
        .slice(ref.chunk.startLine - 1, ref.chunk.endLine)
        .join("\n");
    } catch {
      continue; // the index can outlive a file; that is not an error here
    }
    if (body.trim() === "" || spent + body.length > opts.contentBudget) continue;
    spent += body.length;
    perFile.set(ref.file, used + 1);
    chunks.push({
      file: ref.file,
      startLine: ref.chunk.startLine,
      endLine: ref.chunk.endLine,
      label: ref.chunk.label,
      text: body,
    });
  }

  // Coverage counts TOPICAL terms, not merely present ones: a word occurring
  // once in the corpus tells us nothing about what the request is about, however
  // confidently BM25 ranks the file that happens to contain it.
  const coverage = { matched: query.topical.length, requested: query.requested.length };
  return {
    files,
    docs,
    skeletons,
    chunks,
    expandedTerms: query.expanded,
    coverage,
    // Half or fewer of the request's words being words this codebase uses is
    // the point at which the ranking is no longer evidence about the request.
    weak: coverage.requested === 0 || coverage.matched * 2 <= coverage.requested,
  };
}

/**
 * The default rendering of a retrieval result: the three grades as text, in
 * order of cost. Separate from {@link retrieveContext} on purpose — a caller
 * that wants only the paths, or a different layout, uses the data directly.
 */
export function renderRetrieval(result: RetrievalResult): string {
  const out: string[] = [
    result.weak
      ? `Ranked for this request from the import graph and a lexical index of the code. TREAT IT AS A STARTING GUESS, NOT A CONCLUSION: only ${result.coverage.matched} of the ${result.coverage.requested} words in the request are words this codebase actually uses, so the ranking below rests on very little. Confirm it before you build on it.`
      : "Ranked for this request from the import graph and a lexical index of the code — no model produced this.",
    "",
    "Most relevant source files:",
    ...result.files.map((file) => `  ${file}`),
  ];
  if (result.docs.length > 0) {
    out.push("", "Documentation that describes this area (prose, not the implementation):");
    out.push(...result.docs.map((file) => `  ${file}`));
  }
  if (result.expandedTerms.length > 0) {
    out.push(
      "",
      `The request's own words matched little, so the search was expanded with terms taken from the code itself: ${result.expandedTerms.join(", ")}`,
    );
  }
  if (result.skeletons.length > 0) {
    out.push("", "What those files declare, with line numbers — read a range rather than a whole file:");
    for (const skeleton of result.skeletons) {
      const listed = skeleton.declarations.map((d) => `${d.name}:${d.line}`).join(", ");
      out.push(`  ${skeleton.file} — ${listed}${skeleton.omitted > 0 ? `, +${skeleton.omitted} more` : ""}`);
    }
  }
  if (result.chunks.length > 0) {
    out.push("", "The highest-ranked code, quoted so you do not have to open it:", "");
    for (const chunk of result.chunks) {
      const where = `${chunk.file}:${chunk.startLine}-${chunk.endLine}${chunk.label ? ` (${chunk.label})` : ""}`;
      out.push(`--- ${where} ---`, chunk.text, "");
    }
  }
  return out.join("\n").trimEnd();
}
