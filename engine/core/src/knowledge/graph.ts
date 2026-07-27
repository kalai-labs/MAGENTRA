import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { estimateTokens } from "@magentra/protocol";
import { writeFileAtomic } from "../util/fsAtomic.js";

/**
 * Tier 1 code graph: a directed graph over the workspace's source files, built
 * from a conservative regex scan of import statements. Node ids are
 * workspace-relative paths with forward slashes; external package imports live
 * under synthetic `pkg:<name>` nodes that participate as graph nodes but are
 * never scanned. The analytics below (PageRank, blast radius, articulation
 * points, dependency slicing) are pure functions over GraphData.
 */

export interface GraphFileEntry {
  mtimeMs: number;
  size: number;
  /** Resolved node ids this file imports (file ids and `pkg:<name>` ids). */
  imports: string[];
}

export interface GraphData {
  version: 1;
  files: Record<string, GraphFileEntry>;
}

const GRAPH_DIR = ".magentra";
const GRAPH_FILE = "graph.json";

const MAX_FILES = 5000;
/** Shared with every scanner over the same tree: graph, symbols, code index. */
export const MAX_FILE_BYTES = 1024 * 1024; // 1 MB — skip larger files entirely.
const MAX_DEPTH = 12;

/**
 * Source extensions the graph and symbol scanners walk — the single source of
 * truth, shared with `symbols.ts`.
 *
 * Two tiers, per ADR 0004. TIER 1 languages have an extractor and a resolver
 * below, so their files carry real import edges. TIER 2 languages are scanned as
 * NODES ONLY: their imports do not name files (Swift imports modules; a C#
 * `using` names a namespace that need not correspond to any path), so inventing
 * edges for them would be guessing. A node without edges is still found and
 * ranked by `slice`, which seeds on paths and symbols — the failure that
 * mattered was a language producing no graph at all.
 */
export const SCAN_EXTS = new Set([
  // Tier 1 — imports resolve to files.
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".m", ".mm",
  ".rb",
  ".php",
  ".java", ".kt", ".kts",
  ".go",
  ".rs",
  // Tier 2 — nodes only.
  ".cs", ".swift", ".scala", ".dart", ".lua", ".ex", ".exs", ".erl", ".hs",
  ".clj", ".zig", ".nim", ".pl", ".sh", ".bash", ".ps1", ".sql",
]);
/** Extensions tried when a relative TS/JS specifier omits its extension. */
const TRY_EXTS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"];
/** Extensions a JVM `import a.b.C` may land on. */
const JVM_EXTS = [".java", ".kt", ".kts"];

/** Which extractor an extension routes to; "none" is Tier 2 (node, no edges). */
type Lang = "js" | "py" | "c" | "ruby" | "php" | "jvm" | "go" | "rust" | "none";

const LANG_BY_EXT = new Map<string, Lang>([
  [".ts", "js"], [".tsx", "js"], [".mts", "js"], [".cts", "js"], [".js", "js"],
  [".jsx", "js"], [".mjs", "js"], [".cjs", "js"], [".vue", "js"], [".svelte", "js"],
  [".py", "py"],
  [".c", "c"], [".h", "c"], [".cc", "c"], [".cpp", "c"], [".cxx", "c"],
  [".hpp", "c"], [".hh", "c"], [".hxx", "c"], [".m", "c"], [".mm", "c"],
  [".rb", "ruby"],
  [".php", "php"],
  [".java", "jvm"], [".kt", "jvm"], [".kts", "jvm"],
  [".go", "go"],
  [".rs", "rust"],
]);

export function langOf(path: string): Lang {
  return LANG_BY_EXT.get(extOf(path).toLowerCase()) ?? "none";
}

// "build-resources" is this repo's own packaging output (minified bundles). It
// is not the only such name in the wild, but any dir whose name STARTS with
// "build" is a safe skip: first-party source does not live in one.
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "coverage", "vendor", "target"]);
const SKIP_DIR_PREFIXES = ["tmp", "build"];

export function shouldSkipDir(name: string): boolean {
  // Any dir starting with "." (covers .git, .magentra), anything named for build
  // or temp output, plus the named vendor dirs — none of these hold first-party
  // source worth mapping, and a minified bundle in one of them would poison the
  // graph, the symbol index, and the reuse gate alike.
  return name.startsWith(".") || SKIP_DIR_PREFIXES.some((p) => name.startsWith(p)) || SKIP_DIRS.has(name);
}

/**
 * A path — absolute or workspace-relative, either separator — as a graph node
 * id: workspace-relative with forward slashes. The single normalizer, shared
 * with the seed resolver and the GraphQuery tool, because a node id that two
 * callers spell differently is a file the graph silently cannot find.
 */
export function normalizeToId(cwd: string, path: string): string {
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  return rel.split(/[\\/]/).join("/").replace(/^\.\//, "");
}

export function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return dot > slash ? path.slice(dot) : "";
}

// ---------------------------------------------------------------------------
// Import extraction (conservative — prefer missing an edge over inventing one).
// ---------------------------------------------------------------------------

const RE_FROM = /\b(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g;
const RE_BARE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const RE_REQUIRE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const RE_DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function extractJsSpecs(content: string): string[] {
  const specs = new Set<string>();
  for (const re of [RE_FROM, RE_BARE_IMPORT, RE_REQUIRE, RE_DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) specs.add(m[1]!);
  }
  return [...specs];
}

const RE_PY_IMPORT = /^\s*import\s+(.+)$/;
const RE_PY_FROM = /^\s*from\s+(\.*[\w.]+)\s+import\s+/;

/** Returns raw python module tokens including any leading dots (e.g. "..pkg.mod"). */
function extractPySpecs(content: string): string[] {
  const specs = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const fromM = RE_PY_FROM.exec(line);
    if (fromM) {
      specs.add(fromM[1]!);
      continue;
    }
    const impM = RE_PY_IMPORT.exec(line);
    if (impM) {
      for (const part of impM[1]!.split(",")) {
        const name = (part.trim().split(/\s+as\s+/)[0] ?? "").trim();
        if (name && /^[\w.]+$/.test(name)) specs.add(name);
      }
    }
  }
  return [...specs];
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

function fileExists(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function pkgNodeId(spec: string): string {
  // First path segment, or first two for a scoped @org/name package.
  const parts = spec.split("/");
  const name = spec.startsWith("@") && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  return `pkg:${name ?? spec}`;
}

/** Resolve a TS/JS import specifier to a node id, or undefined to drop the edge. */
function resolveJsSpec(cwd: string, fileDir: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return pkgNodeId(spec);

  const base = join(fileDir, spec);
  const candidates: string[] = [base];

  // Our own ESM convention: ".js" specifiers are compiled from ".ts" sources.
  const jsToTs: Record<string, string[]> = {
    ".js": [".ts", ".tsx", ".mts"],
    ".mjs": [".mts", ".ts"],
    ".cjs": [".cts", ".ts"],
    ".jsx": [".tsx", ".ts"],
  };
  const specExt = extOf(spec);
  if (jsToTs[specExt]) {
    const stem = base.slice(0, base.length - specExt.length);
    for (const ext of jsToTs[specExt]) candidates.push(stem + ext);
  }

  for (const ext of TRY_EXTS) candidates.push(base + ext);
  for (const ext of TRY_EXTS) candidates.push(join(base, "index") + ext);

  for (const cand of candidates) {
    if (fileExists(cand)) return normalizeToId(cwd, cand);
  }
  return undefined; // unresolvable relative spec — drop the edge
}

/** Resolve a python module token (with optional leading dots) to a node id. */
function resolvePySpec(cwd: string, fileDir: string, token: string): string {
  let dots = 0;
  while (dots < token.length && token[dots] === ".") dots++;
  const rest = token.slice(dots);
  const parts = rest.split(".").filter(Boolean);

  if (dots > 0) {
    // Relative import: one dot = the file's package dir, each extra dot goes up.
    let baseDir = fileDir;
    for (let i = 1; i < dots; i++) baseDir = dirname(baseDir);
    // Strip trailing components until a matching module file/dir is found.
    for (let take = parts.length; take >= 0; take--) {
      const rel = parts.slice(0, take);
      const asFile = join(baseDir, ...rel) + ".py";
      if (fileExists(asFile)) return normalizeToId(cwd, asFile);
      const asPkg = join(baseDir, ...rel, "__init__.py");
      if (fileExists(asPkg)) return normalizeToId(cwd, asPkg);
    }
    return pkgNodeId(parts[0] ?? "relative");
  }

  // Absolute module path: resolve against the file's dir first, then the cwd.
  for (const root of [fileDir, cwd]) {
    for (let take = parts.length; take >= 1; take--) {
      const rel = parts.slice(0, take);
      const asFile = join(root, ...rel) + ".py";
      if (fileExists(asFile)) return normalizeToId(cwd, asFile);
      const asPkg = join(root, ...rel, "__init__.py");
      if (fileExists(asPkg)) return normalizeToId(cwd, asPkg);
    }
  }
  return pkgNodeId(parts[0] ?? rest);
}

// ---------------------------------------------------------------------------
// Resolution context.
//
// Relative specifiers (`./x`, `#include "x.h"`) resolve against the filesystem,
// one candidate at a time. Namespace specifiers (`com.example.Foo`, `App\Bar`)
// and Go package paths cannot: they name a position in a package tree whose
// mapping to directories is a project convention, so resolving them needs the
// whole file list. That is what this carries.
// ---------------------------------------------------------------------------

interface ResolveContext {
  cwd: string;
  /** Every scanned node id, for exact membership tests. */
  ids: Set<string>;
  /** Node ids grouped by their directory ("" at the root) — Go package resolution. */
  byDir: Map<string, string[]>;
  /** Node ids grouped by basename — the index behind suffix matching. */
  byBasename: Map<string, string[]>;
  /** The module path declared in go.mod, when the workspace has one. */
  goModule: string | undefined;
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function readGoModule(cwd: string): string | undefined {
  try {
    return /^\s*module\s+(\S+)/m.exec(readFileSync(join(cwd, "go.mod"), "utf8"))?.[1];
  } catch {
    return undefined; // not a Go workspace, or unreadable
  }
}

function buildResolveContext(cwd: string, ids: string[]): ResolveContext {
  const byDir = new Map<string, string[]>();
  const byBasename = new Map<string, string[]>();
  for (const id of ids) {
    const slash = id.lastIndexOf("/");
    pushInto(byDir, slash < 0 ? "" : id.slice(0, slash), id);
    pushInto(byBasename, slash < 0 ? id : id.slice(slash + 1), id);
  }
  return { cwd, ids: new Set(ids), byDir, byBasename, goModule: readGoModule(cwd) };
}

/**
 * The scanned file whose path ends with `suffix` (e.g. "com/example/Foo.java").
 * Returns undefined when nothing matches AND when more than one thing does: an
 * ambiguous namespace is a guess, and this graph never guesses.
 */
function bySuffix(ctx: ResolveContext, suffix: string): string | undefined {
  const slash = suffix.lastIndexOf("/");
  const candidates = ctx.byBasename.get(slash < 0 ? suffix : suffix.slice(slash + 1));
  if (!candidates) return undefined;
  const hits = candidates.filter((id) => id === suffix || id.endsWith(`/${suffix}`));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Suffix matching that tolerates a namespace root mapped to a source directory
 * (PSR-4's `App\` → `src/`, a Maven `src/main/java` prefix): try the whole path
 * first, then drop leading segments until one unique file matches.
 */
function bySuffixProgressive(ctx: ResolveContext, segments: string[], exts: string[]): string | undefined {
  for (let start = 0; start < segments.length; start++) {
    const tail = segments.slice(start).join("/");
    for (const ext of exts) {
      const hit = bySuffix(ctx, tail + ext);
      if (hit) return hit;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-language edge extraction. Each returns node ids, not raw specifiers, so a
// language owns both halves of its own convention.
// ---------------------------------------------------------------------------

const RE_C_INCLUDE = /^[ \t]*#[ \t]*include[ \t]*(["<])([^">]+)[">]/gm;
const RE_RUBY_REQUIRE = /\brequire(_relative)?\s*\(?\s*['"]([^'"]+)['"]/g;
const RE_PHP_INCLUDE = /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g;
const RE_PHP_USE = /^[ \t]*use[ \t]+\\?([A-Za-z_][\w\\]*)/gm;
const RE_JVM_IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)/gm;
const RE_GO_IMPORT_BLOCK = /\bimport[ \t]*\(([\s\S]*?)\)/g;
const RE_GO_IMPORT_ONE = /\bimport[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/g;
const RE_GO_QUOTED = /"([^"]+)"/g;
const RE_RUST_MOD = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm;
const RE_RUST_USE = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([A-Za-z_][\w:]*)/gm;

/** Rust path roots that name the current crate rather than an external one. */
const RUST_LOCAL_ROOTS = new Set(["crate", "super", "self"]);
/** Rust roots that are the toolchain, never a dependency worth a node. */
const RUST_STD_ROOTS = new Set(["std", "core", "alloc"]);

function jsEdges(absPath: string, content: string, ctx: ResolveContext, out: Set<string>): void {
  const fileDir = dirname(absPath);
  for (const spec of extractJsSpecs(content)) {
    const id = resolveJsSpec(ctx.cwd, fileDir, spec);
    if (id !== undefined) out.add(id);
  }
}

function pyEdges(absPath: string, content: string, ctx: ResolveContext, out: Set<string>): void {
  const fileDir = dirname(absPath);
  for (const token of extractPySpecs(content)) out.add(resolvePySpec(ctx.cwd, fileDir, token));
}

function cEdges(absPath: string, content: string, ctx: ResolveContext, out: Set<string>): void {
  const fileDir = dirname(absPath);
  RE_C_INCLUDE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_C_INCLUDE.exec(content)) !== null) {
    const spec = m[2]!;
    // <angle> is the system/dependency include path; "quoted" is project-local.
    if (m[1] !== '"') {
      out.add(pkgNodeId(spec));
      continue;
    }
    const local = join(fileDir, spec);
    if (fileExists(local)) {
      out.add(normalizeToId(ctx.cwd, local));
      continue;
    }
    const fromRoot = join(ctx.cwd, spec);
    if (fileExists(fromRoot)) {
      out.add(normalizeToId(ctx.cwd, fromRoot));
      continue;
    }
    // An include path relative to some -I root we cannot know: match by tail.
    const hit = bySuffix(ctx, spec.split(/[\\/]/).filter(Boolean).join("/"));
    if (hit) out.add(hit);
  }
}

function rubyEdges(absPath: string, content: string, ctx: ResolveContext, out: Set<string>): void {
  const fileDir = dirname(absPath);
  RE_RUBY_REQUIRE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_RUBY_REQUIRE.exec(content)) !== null) {
    const spec = m[2]!;
    // Only `require_relative` names a file; bare `require` goes through the load
    // path, which is a runtime concern we cannot resolve statically.
    if (m[1] === undefined) {
      out.add(pkgNodeId(spec));
      continue;
    }
    const base = join(fileDir, spec);
    for (const cand of [base, `${base}.rb`]) {
      if (fileExists(cand)) {
        out.add(normalizeToId(ctx.cwd, cand));
        break;
      }
    }
  }
}

function phpEdges(absPath: string, content: string, ctx: ResolveContext, out: Set<string>): void {
  const fileDir = dirname(absPath);
  RE_PHP_INCLUDE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_PHP_INCLUDE.exec(content)) !== null) {
    const spec = m[1]!;
    const base = join(fileDir, spec);
    for (const cand of [base, `${base}.php`]) {
      if (fileExists(cand)) {
        out.add(normalizeToId(ctx.cwd, cand));
        break;
      }
    }
  }
  RE_PHP_USE.lastIndex = 0;
  while ((m = RE_PHP_USE.exec(content)) !== null) {
    // `use App\Service\Mailer` — PSR-4 maps the namespace root to a source dir,
    // so the tail of the path is what actually appears on disk.
    const segments = m[1]!.split("\\").filter(Boolean);
    if (segments.length < 2) continue;
    const hit = bySuffixProgressive(ctx, segments, [".php"]);
    if (hit) out.add(hit);
  }
}

function jvmEdges(_absPath: string, content: string, ctx: ResolveContext, out: Set<string>): void {
  RE_JVM_IMPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_JVM_IMPORT.exec(content)) !== null) {
    const segments = m[1]!.split(".").filter(Boolean);
    if (segments.length < 2) continue;
    // A static import ends in a member name, so the type is one segment up.
    // Nothing is added when neither resolves: unlike JS, a JVM import gives no
    // syntactic hint whether it is first-party or a dependency, so a pkg node
    // here would invent an external dependency that may not exist.
    const hit =
      bySuffixProgressive(ctx, segments, JVM_EXTS) ??
      (segments.length > 2 ? bySuffixProgressive(ctx, segments.slice(0, -1), JVM_EXTS) : undefined);
    if (hit) out.add(hit);
  }
}

/** Go dependency node id: the module path for a domain-style import, else the bare package. */
function goPkgNodeId(spec: string): string {
  const parts = spec.split("/");
  return `pkg:${parts.slice(0, parts[0]?.includes(".") ? 3 : 1).join("/")}`;
}

function goEdges(_absPath: string, content: string, ctx: ResolveContext, out: Set<string>): void {
  const specs = new Set<string>();
  RE_GO_IMPORT_BLOCK.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = RE_GO_IMPORT_BLOCK.exec(content)) !== null) {
    RE_GO_QUOTED.lastIndex = 0;
    let quoted: RegExpExecArray | null;
    while ((quoted = RE_GO_QUOTED.exec(block[1]!)) !== null) specs.add(quoted[1]!);
  }
  RE_GO_IMPORT_ONE.lastIndex = 0;
  let single: RegExpExecArray | null;
  while ((single = RE_GO_IMPORT_ONE.exec(content)) !== null) specs.add(single[1]!);

  const module = ctx.goModule;
  for (const spec of specs) {
    // A Go import names a PACKAGE, which is a directory — so one import edge
    // becomes an edge to every .go file that makes up that package.
    if (module !== undefined && (spec === module || spec.startsWith(`${module}/`))) {
      const dir = spec === module ? "" : spec.slice(module.length + 1);
      for (const id of ctx.byDir.get(dir) ?? []) {
        if (extOf(id) === ".go") out.add(id);
      }
      continue;
    }
    out.add(goPkgNodeId(spec));
  }
}

/** The crate's source root for a file id: the last `src/` on its path, else its own directory. */
function rustCrateRoot(id: string): string {
  const parts = id.split("/");
  const srcAt = parts.lastIndexOf("src");
  return srcAt >= 0 ? parts.slice(0, srcAt + 1).join("/") : parts.slice(0, -1).join("/");
}

/** First module file matching `dir/segs…`, shortening the path until one exists (a tail segment may name an item, not a module). */
function rustModuleFile(ctx: ResolveContext, dir: string, segments: string[]): string | undefined {
  for (let take = segments.length; take >= 1; take--) {
    const path = [dir, ...segments.slice(0, take)].filter(Boolean).join("/");
    for (const cand of [`${path}.rs`, `${path}/mod.rs`]) {
      if (ctx.ids.has(cand)) return cand;
    }
  }
  return undefined;
}

function rustEdges(absPath: string, content: string, ctx: ResolveContext, out: Set<string>): void {
  const id = normalizeToId(ctx.cwd, absPath);
  const dir = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
  const stem = id.slice(id.lastIndexOf("/") + 1).replace(/\.rs$/, "");
  // A `mod x;` in foo.rs looks for foo/x.rs; in mod.rs/lib.rs/main.rs it looks
  // beside itself. Trying both covers either layout.
  const modDirs = ["mod", "lib", "main"].includes(stem) ? [dir] : [dir, [dir, stem].filter(Boolean).join("/")];

  RE_RUST_MOD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_RUST_MOD.exec(content)) !== null) {
    for (const base of modDirs) {
      const hit = rustModuleFile(ctx, base, [m[1]!]);
      if (hit) {
        out.add(hit);
        break;
      }
    }
  }

  RE_RUST_USE.lastIndex = 0;
  while ((m = RE_RUST_USE.exec(content)) !== null) {
    const segments = m[1]!.split("::").filter(Boolean);
    const root = segments[0];
    if (root === undefined) continue;
    if (!RUST_LOCAL_ROOTS.has(root)) {
      if (!RUST_STD_ROOTS.has(root)) out.add(`pkg:${root}`);
      continue;
    }
    const rest = segments.slice(1);
    if (rest.length === 0) continue;
    const base =
      root === "crate" ? rustCrateRoot(id)
      : root === "self" ? dir
      : dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ""; // super
    const hit = rustModuleFile(ctx, base, rest);
    if (hit) out.add(hit);
  }
}

/**
 * Import edges for one file, or an empty list for a Tier 2 language whose
 * imports do not name files (ADR 0004) — such a file is still a graph node.
 */
function extractImports(absPath: string, content: string, ctx: ResolveContext): string[] {
  const out = new Set<string>();
  switch (langOf(absPath)) {
    case "js": jsEdges(absPath, content, ctx, out); break;
    case "py": pyEdges(absPath, content, ctx, out); break;
    case "c": cEdges(absPath, content, ctx, out); break;
    case "ruby": rubyEdges(absPath, content, ctx, out); break;
    case "php": phpEdges(absPath, content, ctx, out); break;
    case "jvm": jvmEdges(absPath, content, ctx, out); break;
    case "go": goEdges(absPath, content, ctx, out); break;
    case "rust": rustEdges(absPath, content, ctx, out); break;
    case "none": break;
  }
  out.delete(normalizeToId(ctx.cwd, absPath)); // a self-edge is noise in every metric
  return [...out];
}

// ---------------------------------------------------------------------------
// Scanner.
// ---------------------------------------------------------------------------

/**
 * Walk the tree and build (or incrementally refresh) the graph. If `prev` is
 * given and a file's mtimeMs+size are unchanged, its imports are reused without
 * re-reading. All fs errors are skipped silently.
 */
export function buildGraph(cwd: string, prev?: GraphData): GraphData {
  // PHASE 1 — find every source file. No content is read here on purpose:
  // namespace and package specifiers (Java's `com.example.Foo`, PHP's `App\Bar`,
  // a Go import path) resolve against the WHOLE file list, so nothing can be
  // resolved until the walk has finished.
  const scanned: { id: string; abs: string; mtimeMs: number; size: number }[] = [];

  const walk = (dir: string, depth: number): void => {
    if (scanned.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned.length >= MAX_FILES) return;
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
        scanned.push({ id: normalizeToId(cwd, abs), abs, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };

  walk(cwd, 0);

  // PHASE 2 — resolve each file's imports against the finished file list. An
  // entry whose mtime+size are unchanged keeps its already-resolved imports; a
  // specifier that only became resolvable because some OTHER file appeared is
  // picked up the next time this file itself changes, which is the ordinary
  // trade of an incremental cache.
  const ctx = buildResolveContext(cwd, scanned.map((s) => s.id));
  const files: Record<string, GraphFileEntry> = {};
  for (const entry of scanned) {
    const before = prev?.files[entry.id];
    if (before && before.mtimeMs === entry.mtimeMs && before.size === entry.size) {
      files[entry.id] = { mtimeMs: entry.mtimeMs, size: entry.size, imports: before.imports };
      continue;
    }
    let content: string;
    try {
      content = readFileSync(entry.abs, "utf8");
    } catch {
      continue;
    }
    files[entry.id] = {
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      imports: extractImports(entry.abs, content, ctx),
    };
  }
  return { version: 1, files };
}

function graphPath(cwd: string): string {
  return join(cwd, GRAPH_DIR, GRAPH_FILE);
}

function saveGraph(cwd: string, g: GraphData): void {
  try {
    // Atomic: the app SIGKILLs the engine 3s into a shutdown, and a cache
    // truncated mid-write reads as absent — a full rebuild of work already done.
    writeFileAtomic(graphPath(cwd), JSON.stringify(g));
  } catch {
    // best-effort persistence; an unwritable state dir must not break queries
  }
}

function isValidGraph(v: unknown): v is GraphData {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return g.version === 1 && typeof g.files === "object" && g.files !== null;
}

function graphsEqual(a: GraphData, b: GraphData): boolean {
  const ak = Object.keys(a.files);
  const bk = Object.keys(b.files);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const ea = a.files[k];
    const eb = b.files[k];
    if (!ea || !eb || ea.mtimeMs !== eb.mtimeMs || ea.size !== eb.size) return false;
    if (ea.imports.length !== eb.imports.length) return false;
    for (let i = 0; i < ea.imports.length; i++) {
      if (ea.imports[i] !== eb.imports[i]) return false;
    }
  }
  return true;
}

/**
 * Load the persisted graph and refresh it incrementally; on a missing or
 * corrupt file, do a full build. Saves only when something actually changed.
 */
export function loadOrBuildGraph(cwd: string): GraphData {
  let prev: GraphData | undefined;
  try {
    const raw = JSON.parse(readFileSync(graphPath(cwd), "utf8"));
    if (isValidGraph(raw)) prev = raw;
  } catch {
    prev = undefined;
  }
  if (!prev) {
    const built = buildGraph(cwd);
    saveGraph(cwd, built);
    return built;
  }
  const refreshed = buildGraph(cwd, prev);
  if (!graphsEqual(prev, refreshed)) saveGraph(cwd, refreshed);
  return refreshed;
}

// ---------------------------------------------------------------------------
// Shared graph views.
// ---------------------------------------------------------------------------

function isPkg(id: string): boolean {
  return id.startsWith("pkg:");
}

/** Every node id in the graph: scanned files plus every import target. */
function allNodes(g: GraphData): string[] {
  const set = new Set<string>();
  for (const [id, entry] of Object.entries(g.files)) {
    set.add(id);
    for (const t of entry.imports) set.add(t);
  }
  return [...set];
}

/** Undirected adjacency over non-pkg nodes only (structural cohesion view). */
function undirectedAdjacency(g: GraphData): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const ensure = (id: string): Set<string> => {
    let s = adj.get(id);
    if (!s) {
      s = new Set();
      adj.set(id, s);
    }
    return s;
  };
  for (const [id, entry] of Object.entries(g.files)) {
    if (isPkg(id)) continue;
    ensure(id);
    for (const t of entry.imports) {
      if (isPkg(t)) continue;
      ensure(t).add(id);
      ensure(id).add(t);
    }
  }
  return adj;
}

// ---------------------------------------------------------------------------
// PageRank.
// ---------------------------------------------------------------------------

export interface PageRankOptions {
  damping?: number;
  epsilon?: number;
  maxIter?: number;
  /** Personalized teleport: over these nodes; else uniform over all. */
  seeds?: string[];
  /**
   * Relative teleport mass per seed. Absent seeds fall back to 1.
   *
   * The teleport vector IS the personalization, so telling it that one seed
   * matched the request far better than another is the whole difference between
   * "start from these files" and "start from these files, in this order of
   * confidence". Normalized here, so callers may pass raw retrieval scores.
   */
  seedWeights?: Map<string, number>;
  /** Observe convergence for tests without polluting the returned Map. */
  onStats?: (stats: { iterations: number; converged: boolean }) => void;
}

/**
 * Personalized PageRank via the power method.
 *
 * The random walk uses edges in BOTH directions: an import edge u→v carries
 * weight 1.0 (relevance flows to what a seed uses) and its reverse v→u carries
 * weight 0.5 (relevance also flows to what uses a seed); rows are then
 * normalized per node. Dangling nodes teleport their mass (the standard patch).
 *
 * Perron–Frobenius theorem: the Google matrix G = α·S + (1−α)·1·vᵀ is a
 * positive column-stochastic matrix, so it has a unique stationary
 * distribution — the eigenvector for the dominant eigenvalue 1 — which is the
 * PageRank vector. Haveliwala–Kamvar (2003) show the subdominant eigenvalue
 * satisfies |λ₂| ≤ α, so power iteration converges geometrically at rate α and
 * the iteration count ≈ ln ε / ln α is independent of graph size. The invariant
 * Σrank = 1 (± ε) is preserved by construction (teleport and each row sum to 1)
 * and renormalized at the end to kill floating-point drift.
 */
export function pagerank(g: GraphData, opts: PageRankOptions = {}): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const epsilon = opts.epsilon ?? 1e-8;
  const maxIter = opts.maxIter ?? 200;

  const nodes = allNodes(g);
  const n = nodes.length;
  const result = new Map<string, number>();
  if (n === 0) {
    opts.onStats?.({ iterations: 0, converged: true });
    return result;
  }
  const index = new Map<string, number>();
  nodes.forEach((id, i) => index.set(id, i));

  // Accumulate directed weights: import edge (1.0) and its reverse (0.5).
  const outWeights: Map<number, number>[] = nodes.map(() => new Map());
  const addWeight = (from: number, to: number, w: number): void => {
    const row = outWeights[from]!;
    row.set(to, (row.get(to) ?? 0) + w);
  };
  for (const [id, entry] of Object.entries(g.files)) {
    const u = index.get(id);
    if (u === undefined) continue;
    for (const target of entry.imports) {
      const v = index.get(target);
      if (v === undefined) continue;
      addWeight(u, v, 1.0);
      addWeight(v, u, 0.5);
    }
  }
  // Row-normalize per node.
  const dangling: boolean[] = new Array(n).fill(false);
  for (let u = 0; u < n; u++) {
    const row = outWeights[u]!;
    let sum = 0;
    for (const w of row.values()) sum += w;
    if (sum === 0) {
      dangling[u] = true;
    } else {
      for (const [to, w] of row) row.set(to, w / sum);
    }
  }

  // Personalized teleport vector.
  const teleport = new Array<number>(n).fill(0);
  const seedIds = (opts.seeds ?? []).filter((s) => index.get(s) !== undefined);
  if (seedIds.length > 0) {
    const weightOf = (id: string): number => {
      const w = opts.seedWeights?.get(id);
      return w !== undefined && Number.isFinite(w) && w > 0 ? w : 1;
    };
    let total = 0;
    for (const id of seedIds) total += weightOf(id);
    for (const id of seedIds) teleport[index.get(id)!] = weightOf(id) / total;
  } else {
    teleport.fill(1 / n);
  }
  const tele = (v: number): number => teleport[v] ?? 0;

  let rank = teleport.slice();
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIter; iterations++) {
    const next = new Array<number>(n).fill(0);
    let danglingMass = 0;
    for (let u = 0; u < n; u++) {
      const ru = rank[u]!;
      if (dangling[u]) {
        danglingMass += ru;
        continue;
      }
      for (const [v, p] of outWeights[u]!) next[v] = next[v]! + damping * ru * p;
    }
    // Dangling mass and the teleport term both distribute over the teleport vector.
    const teleportMass = damping * danglingMass + (1 - damping);
    let delta = 0;
    for (let v = 0; v < n; v++) {
      next[v] = next[v]! + teleportMass * tele(v);
      delta += Math.abs(next[v]! - rank[v]!);
    }
    rank = next;
    if (delta < epsilon) {
      converged = true;
      iterations++;
      break;
    }
  }

  // Renormalize to enforce Σrank = 1 exactly (invariant maintenance).
  let total = 0;
  for (const r of rank) total += r;
  for (let i = 0; i < n; i++) result.set(nodes[i]!, total > 0 ? rank[i]! / total : rank[i]!);
  opts.onStats?.({ iterations, converged });
  return result;
}

// ---------------------------------------------------------------------------
// Blast radius / dependencies.
// ---------------------------------------------------------------------------

/**
 * Reverse reachability from a seed set: every module that transitively imports
 * a seed, with its hop distance (seeds and pkg nodes excluded). This makes
 * Ousterhout's "change amplification" computable — the set of code that a change
 * to the seeds could ripple into.
 */
export function blastRadius(g: GraphData, files: string[]): { file: string; distance: number }[] {
  const reverse = new Map<string, string[]>(); // target -> importers
  for (const [id, entry] of Object.entries(g.files)) {
    for (const t of entry.imports) {
      const arr = reverse.get(t);
      if (arr) arr.push(id);
      else reverse.set(t, [id]);
    }
  }
  const seedSet = new Set(files);
  const distance = new Map<string, number>();
  let frontier = [...files];
  let dist = 0;
  const visited = new Set(files);
  while (frontier.length > 0) {
    dist++;
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      for (const importer of reverse.get(node) ?? []) {
        if (visited.has(importer)) continue;
        visited.add(importer);
        if (!isPkg(importer) && !seedSet.has(importer)) distance.set(importer, dist);
        nextFrontier.push(importer);
      }
    }
    frontier = nextFrontier;
  }
  return [...distance.entries()]
    .map(([file, d]) => ({ file, distance: d }))
    .sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));
}

/** Forward BFS closure: everything `file` transitively depends on, with distances. */
export function dependencies(
  g: GraphData,
  file: string,
  maxDepth = Infinity,
): { file: string; distance: number }[] {
  const distance = new Map<string, number>();
  const visited = new Set([file]);
  let frontier = [file];
  let dist = 0;
  while (frontier.length > 0 && dist < maxDepth) {
    dist++;
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      for (const target of g.files[node]?.imports ?? []) {
        if (visited.has(target)) continue;
        visited.add(target);
        distance.set(target, dist);
        nextFrontier.push(target);
      }
    }
    frontier = nextFrontier;
  }
  return [...distance.entries()]
    .map(([f, d]) => ({ file: f, distance: d }))
    .sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------
// Articulation points and bridges (iterative Tarjan/Hopcroft lowlink DFS).
// ---------------------------------------------------------------------------

/**
 * Articulation points and bridges of the UNDIRECTED, pkg-free view.
 *
 * Lowlink characterization (Hopcroft–Tarjan): in a DFS tree with discovery
 * times disc[·] and low[v] = min discovery time reachable from v's subtree via
 * one back edge, a non-root vertex v is an articulation point iff some DFS child
 * w has low[w] ≥ disc[v]; the root is one iff it has ≥ 2 DFS children; and a
 * tree edge (v,w) is a bridge iff low[w] > disc[v]. The DFS is iterative (an
 * explicit stack) so that 5000-node chains cannot overflow the call stack.
 * Multiple components are handled by restarting the DFS from each unvisited node.
 */
export function articulationPoints(g: GraphData): { points: string[]; bridges: [string, string][] } {
  const adj = undirectedAdjacency(g);
  const nodes = [...adj.keys()];
  const neighbors = new Map<string, string[]>();
  for (const [id, s] of adj) neighbors.set(id, [...s]);

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const points = new Set<string>();
  const bridges: [string, string][] = [];
  let timer = 0;

  interface Frame {
    u: string;
    parent: string | null;
    i: number;
    skippedParent: boolean;
  }

  for (const start of nodes) {
    if (disc.has(start)) continue;
    disc.set(start, timer);
    low.set(start, timer);
    timer++;
    let rootChildren = 0;
    const stack: Frame[] = [{ u: start, parent: null, i: 0, skippedParent: false }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const nb = neighbors.get(frame.u) ?? [];
      if (frame.i < nb.length) {
        const v = nb[frame.i++]!;
        if (v === frame.parent && !frame.skippedParent) {
          frame.skippedParent = true; // skip exactly one edge back to the parent
          continue;
        }
        if (!disc.has(v)) {
          if (frame.parent === null) rootChildren++;
          disc.set(v, timer);
          low.set(v, timer);
          timer++;
          stack.push({ u: v, parent: frame.u, i: 0, skippedParent: false });
        } else {
          // back edge
          low.set(frame.u, Math.min(low.get(frame.u)!, disc.get(v)!));
        }
      } else {
        stack.pop();
        const parent = frame.parent;
        if (parent !== null) {
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.u)!));
          // Articulation: non-root parent with a child whose subtree can't
          // escape above it. (The root case is handled by rootChildren below.)
          if (parent !== start && low.get(frame.u)! >= disc.get(parent)!) points.add(parent);
          // Bridge: the child's subtree has no back edge above the tree edge.
          if (low.get(frame.u)! > disc.get(parent)!) bridges.push([parent, frame.u]);
        }
      }
    }
    if (rootChildren >= 2) points.add(start);
  }

  return { points: [...points].sort(), bridges };
}

// ---------------------------------------------------------------------------
// Slicing / stats.
// ---------------------------------------------------------------------------

/** Estimated token cost of putting a file in the context, from its byte size —
 *  the same characters-per-token estimate every other Magentra token figure uses. */
function estTokensOf(g: GraphData, file: string): number {
  return Math.max(1, estimateTokens(g.files[file]?.size ?? 0));
}

/**
 * Greedy top-k selection by personalized PageRank under a token budget: rank
 * non-pkg files from the seeds, always include the seeds first, then take files
 * in descending rank while the cumulative estimated tokens stay within budget.
 *
 * This is a budget-relaxed prize-collecting selection (each file's "prize" is
 * its personalized-PageRank relevance to the seeds). The connectivity
 * constraint of the full prize-collecting Steiner-tree variant is deferred —
 * that remains future work.
 */
export function slice(
  g: GraphData,
  seeds: string[],
  tokenBudget: number,
): { file: string; score: number; estTokens: number }[] {
  const ranks = pagerank(g, { seeds });
  const seedSet = new Set(seeds.filter((s) => g.files[s] !== undefined));

  const out: { file: string; score: number; estTokens: number }[] = [];
  let cumulative = 0;
  // Seeds first, unconditionally.
  for (const seed of seedSet) {
    const est = estTokensOf(g, seed);
    out.push({ file: seed, score: ranks.get(seed) ?? 0, estTokens: est });
    cumulative += est;
  }
  // Remaining non-pkg files by descending rank, greedily within budget.
  const ranked = [...ranks.entries()]
    .filter(([id]) => !isPkg(id) && g.files[id] !== undefined && !seedSet.has(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [file, score] of ranked) {
    const est = estTokensOf(g, file);
    if (cumulative + est > tokenBudget) continue;
    out.push({ file, score, estTokens: est });
    cumulative += est;
  }
  return out;
}

export interface GraphStats {
  fileCount: number;
  edgeCount: number;
  componentCount: number;
}

/** Counts connected components of the undirected, pkg-free view. */
function countComponents(adj: Map<string, Set<string>>): number {
  const seen = new Set<string>();
  let components = 0;
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    components++;
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const u = stack.pop()!;
      for (const v of adj.get(u) ?? []) {
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }
  }
  return components;
}

export function graphStats(g: GraphData): GraphStats {
  let edgeCount = 0;
  for (const entry of Object.values(g.files)) edgeCount += entry.imports.length;
  return {
    fileCount: Object.keys(g.files).length,
    edgeCount,
    componentCount: countComponents(undirectedAdjacency(g)),
  };
}
