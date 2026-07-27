import { loadOrBuildGraph, normalizeToId, slice, type GraphData } from "./graph.js";
import { findSimilarSymbols, loadOrBuildSymbolIndex, type SymbolIndexData } from "./symbols.js";

/**
 * Turning a request into graph seeds — the one place that decides "which files
 * does this topic concern", shared by the GraphQuery tool and by CAREFUL MODE's
 * scout map so the two can never disagree about it.
 */

/** Symbol-matched seeds: how many, and how close a name has to be to count. */
const SYMBOL_SEED_MAX_HITS = 12;
const SYMBOL_SEED_MIN_SCORE = 0.4;

/** Files listed in a request digest before it stops being a glance. */
const DIGEST_MAX_FILES = 14;

/**
 * Seeds for a personalized-PageRank query: explicit files, plus `query`
 * keywords matched against file PATHS and against declared SYMBOL names.
 *
 * Paths alone are a weak source — they only fire when the request happens to use
 * a word that appears in a filename, and "make the approval card show progress"
 * matches no path in most repositories. Symbols cover that, and for a Tier 2
 * language (ADR 0004) they are the only seed source there is, since those files
 * carry no import edges for rank to spread through.
 */
export function resolveSeeds(
  graph: GraphData,
  cwd: string,
  input: { files?: string[]; query?: string },
  symbols?: SymbolIndexData,
): string[] {
  const seeds = new Set<string>();
  for (const file of input.files ?? []) {
    const id = normalizeToId(cwd, file);
    if (graph.files[id]) seeds.add(id);
  }
  if (!input.query) return [...seeds];

  const keywords = input.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return [...seeds];

  for (const id of Object.keys(graph.files)) {
    if (keywords.some((k) => id.toLowerCase().includes(k))) seeds.add(id);
  }
  try {
    const index = symbols ?? loadOrBuildSymbolIndex(cwd);
    for (const hit of findSimilarSymbols(index, keywords, {
      maxHits: SYMBOL_SEED_MAX_HITS,
      minScore: SYMBOL_SEED_MIN_SCORE,
    })) {
      if (graph.files[hit.file]) seeds.add(hit.file);
    }
  } catch {
    // The symbol index enriches the seed set; losing it must not lose the paths.
  }
  return [...seeds];
}

/**
 * A compact "where this request lands" digest for CAREFUL MODE's scout map: the
 * highest-ranked files for the request, and the areas they fall in.
 *
 * This is why the Scout Phase no longer has to open a file merely to earn the
 * right to name it (ADR 0003) — the location comes from the graph, so it states
 * what the repository contains rather than what a model assumes it contains.
 * Returns undefined when the request matches nothing, which is honest: a scout
 * with no starting position is better off knowing that.
 */
export function requestSliceDigest(cwd: string, request: string): string | undefined {
  let graph: GraphData;
  try {
    graph = loadOrBuildGraph(cwd);
  } catch {
    return undefined;
  }
  if (Object.keys(graph.files).length === 0) return undefined;

  const seeds = resolveSeeds(graph, cwd, { query: request });
  if (seeds.length === 0) return undefined;

  const selected = slice(graph, seeds, 12000).slice(0, DIGEST_MAX_FILES);
  if (selected.length === 0) return undefined;

  const areas = new Map<string, number>();
  for (const { file } of selected) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    areas.set(dir, (areas.get(dir) ?? 0) + 1);
  }
  const areaLine = [...areas.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dir, n]) => `${dir} (${n})`)
    .join(", ");

  return [
    "Files this request most likely concerns, ranked by the import graph:",
    ...selected.map(({ file }) => `  ${file}`),
    "",
    `Areas: ${areaLine}`,
  ].join("\n");
}
