import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { SCAN_EXTS, extOf, shouldSkipDir } from "./graph.js";
import { extractSymbols, findSimilarSymbols, tokensOf, type SymbolHit, type SymbolIndexData } from "./symbols.js";
import type { Settings } from "../config/settings.js";

/**
 * Search-before-write reuse check. When the agent tries to Write a brand-new
 * source file, this checks — with zero model calls — whether code by a similar
 * name already exists and whether the agent did any related search or read
 * this session. If similar code exists and no such evidence is on record, a
 * reminder listing the closest matches rides along with the (allowed) Write —
 * the signal survives, the refusal doesn't; silent refusals were the root of
 * "it suddenly stops". Fail-open on any uncertainty. See the decision table
 * in {@link evaluateReuseGate} — it is normative, top-down first-match.
 */

/** Tokenized evidence that the agent searched/queried for related code this session. */
export class SearchLog {
  private readonly tokens = new Set<string>();
  /** Bound the log so a long session can't grow it without limit. */
  private static readonly CAP = 500;

  /** Record the search terms of one tool call (regex metachars stripped, tokenized). */
  record(terms: string[]): void {
    for (const term of terms) {
      for (const tok of tokenizeSearchTerm(term)) {
        if (this.tokens.size >= SearchLog.CAP) return;
        this.tokens.add(tok);
      }
    }
  }

  /** True if any candidate token was already searched for this session. */
  overlaps(candidateTokens: string[]): boolean {
    for (const t of candidateTokens) if (this.tokens.has(t)) return true;
    return false;
  }
}

/** Strip regex metacharacters, then split into the same tokens the index uses. */
function tokenizeSearchTerm(term: string): string[] {
  return tokensOf(term.replace(/[\\^$.*+?()[\]{}|/]/g, " "));
}

export type ReuseGateResult = { kind: "pass" } | { kind: "remind"; text: string };

const PASS: ReuseGateResult = { kind: "pass" };

/** `foo.test.ts`, `bar.spec.tsx`, `test_x.py`, `conftest.py`, or a test/fixture dir segment. */
function isTestPath(base: string, dirSegments: string[]): boolean {
  if (/\.(test|spec)\.[^.]+$/.test(base)) return true;
  if (/^test_.*\.py$/.test(base)) return true;
  if (base === "conftest.py") return true;
  return dirSegments.some((s) => s === "test" || s === "tests" || s === "__tests__" || s === "fixtures");
}

/**
 * Evaluate the reuse check for a would-be Write of `filePath` with `content`.
 * Pure and side-effect-free. Decision table (top-down, first match wins):
 *
 *  1. mode `off`                                              → pass
 *  2. extension not a scanned source ext (md/json/configs)    → pass
 *  3. under a skip-dir (dot-dirs, node_modules, dist, …) or   → pass
 *     outside the workspace
 *  4. test/fixture file                                       → pass
 *  5. file already exists (overwrite — Write freshness rules) → pass
 *  6. the target was Read this session (recreate a deletion)  → pass
 *  7. no candidate tokens from content+stem (index not even   → pass
 *     loaded before here)
 *  8. a related term was searched/queried this session        → pass
 *  9. one of the top matches was Read this session            → pass
 * 10. best score ≥ blockThreshold                             → REMIND (firm)
 * 11. best score ≥ remindThreshold                            → REMIND
 * 12. otherwise                                               → pass
 */
export function evaluateReuseGate(
  cwd: string,
  filePath: string,
  content: string,
  cfg: Settings["reuseCheck"],
  searchLog: SearchLog,
  wasRead: (path: string) => boolean,
  loadIndex: () => SymbolIndexData,
): ReuseGateResult {
  if (cfg.mode === "off") return PASS; // 1

  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  if (!SCAN_EXTS.has(extOf(abs))) return PASS; // 2

  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return PASS; // 3 (outside cwd)
  const segments = rel.split(/[\\/]/);
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.some((s) => shouldSkipDir(s))) return PASS; // 3 (skip-dir)

  const base = basename(abs);
  if (isTestPath(base, dirSegments)) return PASS; // 4
  if (existsSync(abs)) return PASS; // 5
  if (wasRead(abs)) return PASS; // 6

  const stem = base.replace(/\.[^.]+$/, "");
  const candidates = [...extractSymbols(abs, content), stem];
  const candidateTokens = [...new Set(candidates.flatMap(tokensOf))];
  if (candidateTokens.length === 0) return PASS; // 7

  if (searchLog.overlaps(candidateTokens)) return PASS; // 8

  // Index loaded lazily only past here; fail open if it throws (never wrongly block).
  let index: SymbolIndexData;
  try {
    index = loadIndex();
  } catch {
    return PASS;
  }

  const relId = segments.join("/");
  const hits = findSimilarSymbols(index, candidates, {
    excludeFile: relId,
    maxHits: cfg.maxHits,
    minScore: cfg.remindThreshold,
  });
  if (hits.length === 0) return PASS; // 12 (nothing similar enough)
  if (hits.some((h) => wasRead(join(cwd, h.file)))) return PASS; // 9

  const best = hits[0]!.score;
  if (best >= cfg.blockThreshold) {
    return { kind: "remind", text: firmRemindMessage(hits, rel) }; // 10
  }
  if (best >= cfg.remindThreshold) {
    return { kind: "remind", text: remindMessage(hits, rel) }; // 11
  }
  return PASS; // 12
}

/** `- <relPath> — <symbols> (0.87)` lines for the closest existing matches. */
function hitLines(hits: SymbolHit[]): string {
  return hits.map((h) => `- ${h.file} — ${h.symbol} (${h.score.toFixed(2)})`).join("\n");
}

function firmRemindMessage(hits: SymbolHit[], relTarget: string): string {
  return (
    `Reuse check: ${relTarget} was just created, but very similar code already exists and no related search/read happened this session:\n` +
    hitLines(hits) +
    "\nRead the closest match now. If it already covers this, extend it (Edit) and delete the new file; keep the new file only if it is genuinely distinct."
  );
}

function remindMessage(hits: SymbolHit[], relTarget: string): string {
  return (
    `Reuse check: ${relTarget} was just created, but similar code may already exist:\n` +
    hitLines(hits) +
    "\nIf one of these already covers it, extend that with Edit and remove the new file rather than keeping a parallel implementation."
  );
}
