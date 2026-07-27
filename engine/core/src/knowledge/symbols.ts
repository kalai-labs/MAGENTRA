import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { writeFileAtomic } from "../util/fsAtomic.js";
import { SCAN_EXTS, extOf, langOf, shouldSkipDir } from "./graph.js";

/**
 * Tier 1 symbol index: the top-level exported names of every source file in the
 * workspace, built from a conservative regex scan (no AST — the repo has none by
 * design). It mirrors {@link ./graph.ts} exactly: the same caps and skip rules,
 * the same incremental mtime+size refresh, the same silent fs-error skipping,
 * and a sibling `.magentra/symbols.json` persisted alongside `graph.json`. The
 * reuse gate uses it to answer one question cheaply: "does code by this name
 * already exist here?" — see {@link ./reuseGate.ts}.
 */

export interface SymbolFileEntry {
  mtimeMs: number;
  size: number;
  /** Top-level exported symbol names declared in this file (deduped, capped). */
  symbols: string[];
  /**
   * 1-based declaration line of each symbol, aligned to `symbols`.
   *
   * The scanners already had this — every pattern matches at a known offset —
   * and used to discard it. Keeping it turns the index from "what is declared
   * here" into "where it is declared", which is what lets a file be summarized
   * as a skeleton and read by range instead of opened whole.
   */
  lines: number[];
}

export interface SymbolIndexData {
  version: 2;
  files: Record<string, SymbolFileEntry>;
}

const SYMBOLS_DIR = ".magentra";
const SYMBOLS_FILE = "symbols.json";

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB — skip larger files entirely.
const MAX_DEPTH = 12;
const MAX_SYMBOLS_PER_FILE = 200; // cap the per-file symbol list so a generated bundle can't blow up the index.

function toNodeId(cwd: string, absPath: string): string {
  return relative(cwd, absPath).split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Symbol extraction (conservative — prefer missing a symbol over inventing one).
// ---------------------------------------------------------------------------

/** `export [default|abstract|async|declare]* (function|class|const|let|var|interface|type|enum) NAME`. */
const RE_TS_EXPORT_DECL =
  /^\s*export\s+(?:default\s+|abstract\s+|async\s+|declare\s+)*(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
/** `export { a, b as c, type D }` — captures the brace body for per-entry parsing. */
const RE_TS_EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;
/** CommonJS `module.exports.NAME = …`. */
const RE_CJS_EXPORT = /\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=/g;
/** Python top-level (column-0) `def`/`class`, optionally `async def`. */
const RE_PY_DEF = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;

/** A declaration: its name, and the 1-based line it starts on. */
export interface SymbolSite {
  name: string;
  line: number;
}

/**
 * Offset → 1-based line, via binary search over precomputed line starts. Doing
 * it by counting newlines per match would be quadratic on a large file, and
 * these scanners run over every source file in the workspace.
 */
function lineLookup(content: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function extractTsSymbols(content: string, at: (offset: number) => number, out: Map<string, number>): void {
  for (const re of [RE_TS_EXPORT_DECL, RE_CJS_EXPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (!out.has(m[1]!)) out.set(m[1]!, at(m.index));
    }
  }
  RE_TS_EXPORT_LIST.lastIndex = 0;
  let list: RegExpExecArray | null;
  while ((list = RE_TS_EXPORT_LIST.exec(content)) !== null) {
    for (const raw of list[1]!.split(",")) {
      // `b as c` re-exports under `c`; a bare `a` exports `a`; drop `type` prefixes
      // and the `default` sentinel (never a first-party symbol name).
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const halves = part.split(/\s+as\s+/);
      const name = (halves[1] ?? halves[0] ?? "").trim();
      if (name && name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name) && !out.has(name)) {
        out.set(name, at(list.index));
      }
    }
  }
}

function extractPySymbols(content: string, out: Map<string, number>): void {
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const m = RE_PY_DEF.exec(line);
    // Top-level only (no leading indentation) and skip `_private` names.
    if (m && !m[1]!.startsWith("_") && !out.has(m[1]!)) out.set(m[1]!, idx + 1);
  });
}

/**
 * Declaration patterns for the languages the graph scans, each capturing the
 * declared name in group 1. Where a language marks visibility (`pub`, `public`,
 * a capitalized Go identifier) the pattern requires it — an unexported helper is
 * not a reuse signal. Conservative throughout: a missed symbol costs a weaker
 * hint, an invented one sends the reuse gate after code that does not exist.
 */
const DECL_PATTERNS: Record<string, RegExp[]> = {
  c: [
    // A definition (has a body), not a prototype — prototypes repeat in headers.
    /^[A-Za-z_][\w \t*]*[ \t*]+\**([A-Za-z_]\w*)[ \t]*\([^;{]*\)[ \t]*\{/gm,
    /^[ \t]*typedef\b[^;]*?\b([A-Za-z_]\w*)[ \t]*;/gm,
    /^[ \t]*(?:typedef[ \t]+)?(?:struct|union|enum|class)[ \t]+([A-Za-z_]\w*)/gm,
    /^[ \t]*@(?:interface|implementation|protocol)[ \t]+([A-Za-z_]\w*)/gm,
  ],
  ruby: [/^[ \t]*(?:class|module)[ \t]+([A-Z]\w*)/gm, /^[ \t]*def[ \t]+(?:self\.)?([a-z_]\w*)/gm],
  php: [
    /^[ \t]*(?:abstract[ \t]+|final[ \t]+)*(?:class|interface|trait|enum)[ \t]+(\w+)/gm,
    /^[ \t]*function[ \t]+&?(\w+)/gm,
  ],
  jvm: [
    /^[ \t]*(?:@\w+[ \t]+)*(?:public[ \t]+|internal[ \t]+)?(?:final[ \t]+|abstract[ \t]+|sealed[ \t]+|open[ \t]+|data[ \t]+|static[ \t]+)*(?:class|interface|enum|record|object)[ \t]+(\w+)/gm,
    /^[ \t]*(?:public[ \t]+|internal[ \t]+)?(?:suspend[ \t]+|inline[ \t]+)*fun[ \t]+(?:<[^>]*>[ \t]*)?(\w+)/gm,
  ],
  // Go marks export by capitalization, so the pattern carries the visibility rule.
  go: [
    /^func[ \t]+(?:\([^)]*\)[ \t]*)?([A-Z]\w*)/gm,
    /^type[ \t]+([A-Z]\w*)/gm,
    /^(?:var|const)[ \t]+([A-Z]\w*)/gm,
  ],
  rust: [
    /^[ \t]*pub(?:\([^)]*\))?[ \t]+(?:async[ \t]+|unsafe[ \t]+|const[ \t]+)*(?:fn|struct|enum|trait|type|static|mod)[ \t]+([A-Za-z_]\w*)/gm,
  ],
  // Tier 2 languages (C#, Swift, Dart, Scala …) have no import edges, which
  // makes their symbols the ONLY way a graph slice can find them by name.
  none: [
    /^[ \t]*(?:(?:public|internal|open|export|final|abstract|sealed|static|data|partial|record)[ \t]+)*(?:class|struct|interface|protocol|enum|trait|object|extension|actor)[ \t]+([A-Za-z_]\w*)/gm,
    /^[ \t]*(?:(?:public|internal|open|export|static|override|async)[ \t]+)*(?:func|fun|def|sub|function)[ \t]+([A-Za-z_]\w*)/gm,
  ],
};

function extractByPatterns(
  patterns: RegExp[],
  content: string,
  at: (offset: number) => number,
  out: Map<string, number>,
): void {
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1] && !out.has(m[1])) out.set(m[1], at(m.index));
    }
  }
}

/** Declarations of a source file — name and line — deduped and capped, in line order. */
export function extractSymbolSites(path: string, content: string): SymbolSite[] {
  const found = new Map<string, number>();
  const lang = langOf(path);
  const at = lineLookup(content);
  if (lang === "js") extractTsSymbols(content, at, found);
  else if (lang === "py") extractPySymbols(content, found);
  else extractByPatterns(DECL_PATTERNS[lang] ?? [], content, at, found);
  return [...found.entries()]
    .map(([name, line]) => ({ name, line }))
    .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
    .slice(0, MAX_SYMBOLS_PER_FILE);
}

/** Top-level exported symbol names of a source file, deduped and capped. */
export function extractSymbols(path: string, content: string): string[] {
  return extractSymbolSites(path, content).map((s) => s.name);
}

// ---------------------------------------------------------------------------
// Scanner.
// ---------------------------------------------------------------------------

/**
 * Walk the tree and build (or incrementally refresh) the symbol index. If `prev`
 * is given and a file's mtimeMs+size are unchanged, its symbols are reused
 * without re-reading. All fs errors are skipped silently.
 */
export function buildSymbolIndex(cwd: string, prev?: SymbolIndexData): SymbolIndexData {
  const files: Record<string, SymbolFileEntry> = {};
  let count = 0;

  const walk = (dir: string, depth: number): void => {
    if (count >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_FILES) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) continue; // stop descending past the depth cap
        if (shouldSkipDir(entry.name)) continue;
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        if (!SCAN_EXTS.has(extOf(entry.name).toLowerCase())) continue;
        let st: import("node:fs").Stats;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_BYTES) continue; // skip oversized files
        const id = toNodeId(cwd, abs);
        const before = prev?.files[id];
        if (before && before.mtimeMs === st.mtimeMs && before.size === st.size) {
          files[id] = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            symbols: before.symbols,
            lines: before.lines,
          };
        } else {
          let content: string;
          try {
            content = readFileSync(abs, "utf8");
          } catch {
            continue;
          }
          const sites = extractSymbolSites(abs, content);
          files[id] = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            symbols: sites.map((s) => s.name),
            lines: sites.map((s) => s.line),
          };
        }
        count++;
      }
    }
  };

  walk(cwd, 0);
  return { version: 2, files };
}

function symbolsPath(cwd: string): string {
  return join(cwd, SYMBOLS_DIR, SYMBOLS_FILE);
}

function saveSymbolIndex(cwd: string, idx: SymbolIndexData): void {
  try {
    // Atomic — see saveGraph: a half-written index reads as no index at all.
    writeFileAtomic(symbolsPath(cwd), JSON.stringify(idx));
  } catch {
    // best-effort persistence; an unwritable state dir must not break the gate
  }
}

function isValidIndex(v: unknown): v is SymbolIndexData {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return g.version === 2 && typeof g.files === "object" && g.files !== null;
}

function indexesEqual(a: SymbolIndexData, b: SymbolIndexData): boolean {
  const ak = Object.keys(a.files);
  const bk = Object.keys(b.files);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const ea = a.files[k];
    const eb = b.files[k];
    if (!ea || !eb || ea.mtimeMs !== eb.mtimeMs || ea.size !== eb.size) return false;
    if (ea.symbols.length !== eb.symbols.length) return false;
    for (let i = 0; i < ea.symbols.length; i++) {
      if (ea.symbols[i] !== eb.symbols[i]) return false;
    }
  }
  return true;
}

/**
 * Load the persisted symbol index and refresh it incrementally; on a missing or
 * corrupt file, do a full build. Saves only when something actually changed.
 */
export function loadOrBuildSymbolIndex(cwd: string): SymbolIndexData {
  let prev: SymbolIndexData | undefined;
  try {
    const raw = JSON.parse(readFileSync(symbolsPath(cwd), "utf8"));
    if (isValidIndex(raw)) prev = raw;
  } catch {
    prev = undefined;
  }
  if (!prev) {
    const built = buildSymbolIndex(cwd);
    saveSymbolIndex(cwd, built);
    return built;
  }
  const refreshed = buildSymbolIndex(cwd, prev);
  if (!indexesEqual(prev, refreshed)) saveSymbolIndex(cwd, refreshed);
  return refreshed;
}

// ---------------------------------------------------------------------------
// Tokenization + similarity.
// ---------------------------------------------------------------------------

/** Names too generic to signal reuse — a match on these alone is noise, not a hit. */
const STOPWORDS = new Set([
  "get", "set", "is", "has", "to", "of", "for", "the", "and", "new", "make", "create",
  "util", "utils", "helper", "helpers", "index", "main", "mod", "test", "spec",
]);

/**
 * Split an identifier into meaningful lowercase tokens: break on camelCase
 * boundaries and on snake/kebab/dot separators, drop stopwords, and keep only
 * tokens of length >= 3 (shorter fragments carry no reuse signal).
 */
export function tokensOf(name: string): string[] {
  const parts = name
    // camelCase / PascalCase boundaries → space (handles acronyms like HTMLParser).
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const t = p.toLowerCase();
    if (t.length < 3 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Lowercased, non-alphanumerics stripped — the key for an exact-name match. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface SymbolHit {
  /** Workspace-relative file id (forward slashes), as in the index. */
  file: string;
  /** The indexed symbol (or filename stem) the candidate matched. */
  symbol: string;
  /** Similarity in [0, 1]; 1.0 is an exact normalized-name match. */
  score: number;
}

export interface FindSimilarOptions {
  /** Skip this file id — the candidate's own target must never match itself. */
  excludeFile?: string;
  /** Cap the returned hit count (best-first). Default 5. */
  maxHits?: number;
  /** Drop hits scoring below this. Default 0. */
  minScore?: number;
}

/**
 * Score one candidate name against one indexed name. Exact normalized equality
 * is 1.0; otherwise a token-set Jaccard, nudged up when the first or last tokens
 * agree (an ordered-name signal Jaccard alone misses), clamped to 1.
 */
function scoreNames(candNorm: string, candTokens: string[], symNorm: string, symTokens: string[]): number {
  if (candNorm.length > 0 && candNorm === symNorm) return 1;
  if (candTokens.length === 0 || symTokens.length === 0) return 0;
  const candSet = new Set(candTokens);
  const symSet = new Set(symTokens);
  let inter = 0;
  for (const t of candSet) if (symSet.has(t)) inter++;
  const union = candSet.size + symSet.size - inter;
  let score = union === 0 ? 0 : inter / union;
  if (candTokens[0] === symTokens[0]) score += 0.15;
  if (candTokens[candTokens.length - 1] === symTokens[symTokens.length - 1]) score += 0.1;
  return Math.min(1, score);
}

/**
 * Find the existing files whose symbols (or filename stem) best match any of the
 * candidate names. One hit per file (its best-scoring symbol), sorted best-first
 * and capped. Candidates are typically the exported names of a not-yet-written
 * file plus its filename stem.
 */
export function findSimilarSymbols(
  index: SymbolIndexData,
  candidates: string[],
  opts: FindSimilarOptions = {},
): SymbolHit[] {
  const maxHits = opts.maxHits ?? 5;
  const minScore = opts.minScore ?? 0;
  const prepared = candidates.map((name) => ({ norm: normalizeName(name), tokens: tokensOf(name) }));
  if (prepared.every((c) => c.tokens.length === 0 && c.norm.length === 0)) return [];

  const hits: SymbolHit[] = [];
  for (const [file, entry] of Object.entries(index.files)) {
    if (file === opts.excludeFile) continue;
    // The filename stem is scored like an extra symbol — a same-named file is a
    // reuse signal even when its exports don't collide by name.
    const stem = basename(file).replace(/\.[^.]+$/, "");
    const named: string[] = [...entry.symbols, stem];
    let best = 0;
    let bestSym = stem;
    for (const sym of named) {
      const symNorm = normalizeName(sym);
      const symTokens = tokensOf(sym);
      for (const c of prepared) {
        const s = scoreNames(c.norm, c.tokens, symNorm, symTokens);
        if (s > best) {
          best = s;
          bestSym = sym;
        }
      }
    }
    if (best >= minScore && best > 0) hits.push({ file, symbol: bestSym, score: best });
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return hits.slice(0, maxHits);
}
