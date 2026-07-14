import { basename, join, relative, sep } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { ATLAS_MAX_AGENTS, type AtlasArea } from "./atlas.js";
import { pagerank, shouldSkipDir, type GraphData } from "./graph.js";
import type { SymbolIndexData } from "./symbols.js";

/**
 * The deterministic half of the atlas build. The import graph and the symbol
 * index already know the codebase's structure; this module turns that into
 *
 *   - a PARTITION of the workspace into areas (one agent each), and
 *   - a FACTS block per area, stating what an agent would otherwise have to
 *     spend model rounds grepping for.
 *
 * Nothing here calls a model. Every number it produces is exact.
 */

/** Files listed per area in the facts block. Enough to be representative, small enough to stay cheap. */
const MAX_FILES_PER_AREA = 14;
/** Symbols quoted per file. A long export list adds noise, not signal. */
const MAX_SYMBOLS_PER_FILE = 6;

/**
 * Group a file into an area key at `depth` path segments — "engine/core/src/x.ts"
 * at depth 2 is "engine/core". A file shallower than `depth` is its own area.
 */
function areaKeyOf(file: string, depth: number): string {
  const parts = file.split("/");
  if (parts.length <= depth) return parts.slice(0, -1).join("/") || ".";
  return parts.slice(0, depth).join("/");
}

/**
 * Choose how finely to cut the repo: the DEEPEST path level that still fits
 * within the agent ceiling.
 *
 * Depth alone is not the goal — granularity is. A monorepo cut at depth 1 gives
 * `engine`, `app`, `tools`: three agents, one of which swallows most of the
 * codebase and produces a vague section. Cut at depth 2 it gives `engine/core`,
 * `engine/tools`, `app/renderer`, … — more agents running in parallel, each with
 * a boundary tight enough to describe precisely. So descend while the split
 * still fits the ceiling, and stop before it shatters into noise.
 */
function chooseDepth(files: string[], maxAgents: number): number {
  // Score a depth by how many agents it would actually put to work. Going over
  // the ceiling is not disqualifying — the overflow is merged into one area — so
  // a depth that yields 12 areas still scores the full 10, and beats a depth that
  // yields 3. Ties go to the SHALLOWER cut: same parallelism, coarser (and so
  // more meaningful) boundaries.
  let best = 1;
  let bestScore = 0;
  for (let depth = 1; depth <= 3; depth++) {
    const count = new Set(files.map((f) => areaKeyOf(f, depth))).size;
    const score = Math.min(count, maxAgents);
    if (score > bestScore) {
      bestScore = score;
      best = depth;
    }
  }
  return best;
}

/**
 * Partition the workspace into at most {@link ATLAS_MAX_AGENTS} areas — this is
 * the orchestrator deciding its own fan-out, from the repo's real shape rather
 * than a guess.
 *
 * Areas are ranked by importance (summed PageRank over the import graph, so a
 * module everything depends on outranks a big pile of leaf files). When the repo
 * has more areas than the ceiling allows, the tail is merged into one final area
 * rather than dropped — the atlas stays complete.
 */
export function planAtlasAreas(
  graph: GraphData,
  maxAgents: number = ATLAS_MAX_AGENTS,
  /** Set to enable the language-agnostic fallback when the graph cannot see this repo. */
  cwd?: string,
): AtlasArea[] {
  let files = Object.keys(graph.files);

  // The import graph only parses TS/JS/Python. In a Go, Rust, Java, C# … repo it
  // comes back empty — which must not mean "no atlas". Fall back to walking the
  // tree: the partition is then by directory alone, with no import edges, but an
  // area map is still an area map.
  const fromGraph = files.length > 0;
  if (!fromGraph) {
    if (cwd === undefined) return [];
    files = walkSourceFiles(cwd);
    if (files.length === 0) return [];
  }

  const depth = chooseDepth(files, maxAgents);
  // No graph means no PageRank; every file weighs the same, so areas rank by size.
  const rank = fromGraph ? pagerank(graph) : new Map<string, number>();

  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const key = areaKeyOf(file, depth);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(file);
    else buckets.set(key, [file]);
  }

  // With a graph: summed PageRank, so a module everything depends on outranks a
  // pile of leaves. Without one (rank is empty): file count, the only signal left.
  const weightOf = (fs: string[]): number =>
    rank.size === 0 ? fs.length : fs.reduce((sum, f) => sum + (rank.get(f) ?? 0), 0);

  const ranked = [...buckets.entries()]
    .map(([name, areaFiles]) => ({
      name,
      // Most important file first: that is the one an agent should read.
      files: [...areaFiles].sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0)),
      weight: weightOf(areaFiles),
    }))
    .sort((a, b) => b.weight - a.weight);

  if (ranked.length <= maxAgents) {
    return ranked.map(({ name, files: f }) => ({ name, files: f }));
  }

  // Over the ceiling: keep the heaviest, fold everything else into one area so
  // no file goes unmapped.
  const kept = ranked.slice(0, maxAgents - 1).map(({ name, files: f }) => ({ name, files: f }));
  const restFiles = ranked.slice(maxAgents - 1).flatMap((a) => a.files);
  kept.push({ name: "other", files: restFiles });
  return kept;
}

/**
 * Source extensions for the language-agnostic fallback. Deliberately wider than
 * the import graph's set (which only PARSES TS/JS/Python): here we only need to
 * know a file is source, not to read its imports. Every language the agent might
 * ever be pointed at belongs in this list — the atlas must not be a TypeScript
 * feature.
 */
const FALLBACK_SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".php", ".pl",
  ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".swift", ".m", ".mm",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".cs",
  ".ex", ".exs", ".erl", ".hs", ".ml", ".clj", ".lua", ".dart", ".zig", ".nim",
  ".sh", ".bash", ".ps1",
  ".sql", ".proto", ".graphql",
  ".vue", ".svelte",
]);

const FALLBACK_MAX_FILES = 3000;
const FALLBACK_MAX_DEPTH = 10;

/** Walk the workspace for source files of ANY language, honouring the same skip-dirs as the graph. */
function walkSourceFiles(cwd: string): string[] {
  const out: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > FALLBACK_MAX_DEPTH || out.length >= FALLBACK_MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip it, never fail the build
    }
    for (const entry of entries) {
      if (out.length >= FALLBACK_MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf(".");
        if (dot >= 0 && FALLBACK_SOURCE_EXTS.has(entry.name.slice(dot).toLowerCase())) {
          out.push(relative(cwd, full).split(sep).join("/"));
        }
      }
    }
  };

  walk(cwd, 0);
  return out;
}

/** External packages an area pulls in, most-used first. */
function externalDeps(area: AtlasArea, graph: GraphData): string[] {
  const counts = new Map<string, number>();
  for (const file of area.files) {
    for (const imp of graph.files[file]?.imports ?? []) {
      if (!imp.startsWith("pkg:")) continue;
      const name = imp.slice("pkg:".length);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** Which OTHER areas this one imports from, and which import from it. */
function crossAreaEdges(
  area: AtlasArea,
  areas: AtlasArea[],
  graph: GraphData,
): { dependsOn: string[]; usedBy: string[] } {
  const areaOf = new Map<string, string>();
  for (const a of areas) for (const f of a.files) areaOf.set(f, a.name);

  const mine = new Set(area.files);
  const dependsOn = new Set<string>();
  const usedBy = new Set<string>();

  for (const [file, entry] of Object.entries(graph.files)) {
    const from = areaOf.get(file);
    for (const imp of entry.imports) {
      if (imp.startsWith("pkg:")) continue;
      const to = areaOf.get(imp);
      if (mine.has(file) && to !== undefined && to !== area.name) dependsOn.add(to);
      if (mine.has(imp) && from !== undefined && from !== area.name) usedBy.add(from);
    }
  }
  return { dependsOn: [...dependsOn].sort(), usedBy: [...usedBy].sort() };
}

/**
 * The facts block for one area: its files with their exported symbols, the
 * areas it depends on and that depend on it, and its external packages.
 *
 * This is the whole point of the redesign — the agent is handed the structure it
 * used to spend model rounds discovering, and spends its rounds on meaning
 * instead.
 */
export function areaFacts(area: AtlasArea, areas: AtlasArea[], graph: GraphData, symbols: SymbolIndexData): string {
  const lines: string[] = [];

  lines.push(`Files in ${area.name} (${area.files.length} total, most-depended-on first):`);
  for (const file of area.files.slice(0, MAX_FILES_PER_AREA)) {
    const exported = symbols.files[file]?.symbols ?? [];
    const shown = exported.slice(0, MAX_SYMBOLS_PER_FILE);
    const more = exported.length > shown.length ? `, +${exported.length - shown.length} more` : "";
    const exportsText = shown.length > 0 ? ` — exports: ${shown.join(", ")}${more}` : "";
    lines.push(`- ${file}${exportsText}`);
  }
  if (area.files.length > MAX_FILES_PER_AREA) {
    lines.push(`- …and ${area.files.length - MAX_FILES_PER_AREA} more files`);
  }

  // Import edges only exist for languages the graph can parse. In a repo it
  // cannot (Go, Rust, Java …) the facts are the file/symbol listing alone — say
  // so plainly, so the agent reads the code for its dependencies instead of
  // assuming it has none.
  const graphed = area.files.some((f) => graph.files[f] !== undefined);
  lines.push("");
  if (!graphed) {
    lines.push("(No import graph for this language — determine dependencies by reading the code.)");
    return lines.join("\n");
  }

  const { dependsOn, usedBy } = crossAreaEdges(area, areas, graph);
  lines.push(`This area imports from: ${dependsOn.length ? dependsOn.join(", ") : "(nothing internal)"}`);
  lines.push(`These areas import from it: ${usedBy.length ? usedBy.join(", ") : "(nothing — it is a leaf)"}`);

  const deps = externalDeps(area, graph);
  if (deps.length > 0) lines.push(`External packages used: ${deps.slice(0, 10).join(", ")}`);

  return lines.join("\n");
}

/** Project name from package.json, else the workspace folder name. */
export function projectName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.trim();
  } catch {
    /* no package.json — fall back to the folder name */
  }
  return basename(cwd) || "workspace";
}

/** One deterministic line of scale for the overview prompt. */
export function graphSummary(graph: GraphData, areas: AtlasArea[]): string {
  const files = areas.reduce((n, a) => n + a.files.length, 0);
  // Only claim an import count when the graph actually parsed this language;
  // otherwise "0 internal imports" would be a lie the overview repeats.
  if (Object.keys(graph.files).length === 0) {
    return `${files} source files, ${areas.length} areas.`;
  }
  const edges = Object.values(graph.files).reduce(
    (n, e) => n + e.imports.filter((i) => !i.startsWith("pkg:")).length,
    0,
  );
  return `${files} source files, ${edges} internal imports, ${areas.length} areas.`;
}
