import { normalizeToId, type GraphData } from "./graph.js";
import { findSimilarSymbols, loadOrBuildSymbolIndex, type SymbolIndexData } from "./symbols.js";

/**
 * Turning a request into graph seeds — the one place that decides "which files
 * does this topic concern", shared by the GraphQuery tool and by CAREFUL MODE's
 * scout map so the two can never disagree about it.
 */

/** Symbol-matched seeds: how many, and how close a name has to be to count. */
const SYMBOL_SEED_MAX_HITS = 12;
const SYMBOL_SEED_MIN_SCORE = 0.4;

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
