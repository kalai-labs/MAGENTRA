import type { Usage } from "./types.js";

/**
 * THE token algebra. Every token quantity Magentra computes — engine, session
 * report, status bar, budgets, cost — is defined here exactly once, so no two
 * surfaces can drift into disagreeing about what "tokens" means.
 *
 * The definitions follow "Token Accounting in Agentic Applications"; the section
 * numbers below refer to it. The three quantities that must never be confused:
 *
 *   B(t)  CURRENT CONTEXT (§4)  — `inputTokensOf` of the latest invocation.
 *         Point-in-time window occupancy. Does NOT accumulate: a 10-round turn
 *         re-sends a similar prompt 10 times, it does not make the window 10x
 *         bigger. Output tokens are NOT part of it (§14).
 *
 *   D(t)  DELIBERATION OUTPUT (§6) — the output tokens generated so far by the
 *         invocations of the CURRENT phase (one agent turn). Starts each phase
 *         at 0 and only grows.
 *
 *   T_turn CUMULATIVE TURN USAGE (§7) — every token billed across every
 *         invocation of the turn, all four classes. This is the cost figure,
 *         and it is NOT the context size.
 *
 * This module lives in `protocol` on purpose: `Usage` is defined here, and every
 * other package (core, providers, host) already depends on it, so there is one
 * import path and no room for a second copy.
 */

/** All four classes at zero — the identity for {@link addUsage}. */
export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Accumulates `add` into `target` in place and returns it — the per-class sum
 * behind every cumulative total (§7). Classes are summed separately because they
 * bill at different rates; collapsing them loses the price (§12).
 */
export function addUsage(target: Usage, add: Usage): Usage {
  target.inputTokens += add.inputTokens;
  target.outputTokens += add.outputTokens;
  target.cacheReadTokens += add.cacheReadTokens;
  target.cacheWriteTokens += add.cacheWriteTokens;
  return target;
}

/**
 * T_in,j — the input context of ONE invocation: its whole tokenized prompt (§2),
 * partitioned by cache treatment into the three disjoint classes (§3).
 *
 * Two mistakes this function exists to make impossible:
 *   - reading `inputTokens` alone. With prompt caching most of the prompt
 *     arrives as `cacheReadTokens`, so input-only reports a near-empty context
 *     for a nearly-full window (§14).
 *   - adding `outputTokens`. Cached tokens still occupy the window, generated
 *     tokens do not — and the next prompt is not "this prompt plus this reply"
 *     anyway, since tool results and compaction rewrite the history (§8, §14).
 */
export function inputTokensOf(usage: Usage): number {
  return usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
}

/**
 * κ — the characters-per-token constant behind every estimate (§10).
 * Deliberately BELOW real-world English (~4) so an estimate over-counts rather
 * than under-counts: compacting a little early is recoverable, overflowing the
 * provider is not.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * T̂ ≈ N_characters / κ (§10) — the fallback when no exact count is available:
 * before the first response, mid-stream, or when a provider omits usage. Takes a
 * string or a character count. ALWAYS replace it with the API's own usage the
 * moment that arrives; an estimate is never an authoritative final count (§14).
 */
export function estimateTokens(input: string | number): number {
  const chars = typeof input === "number" ? input : input.length;
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * Display rounding (§11): "12.3k", "210k", "1.5M". The step coarsens as the
 * number grows, because precision we do not have would be a lie — the raw
 * integer stays available to every caller for telemetry.
 *
 * Each threshold is the point where the NEXT band's rounding takes over, not the
 * round number itself, so the text never reads backwards across one token:
 * 9,949 → "9.9k", 9,950 → "10k" (and not the "10.0k" a naive 10,000 cutoff
 * would print in between).
 */
export function formatTokens(n: number): string {
  const abs = Math.max(0, n);
  if (abs >= 999_500) return `${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 9_950) return `${Math.round(abs / 1_000)}k`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
  return String(Math.round(abs));
}

/**
 * P_used = 100 · T_context / T_window (§9) — window occupancy as a percentage.
 * Returns 0 for a non-positive window, so an unknown window never renders as
 * Infinity or NaN.
 */
export function contextPercentOf(contextTokens: number, windowTokens: number): number {
  if (windowTokens <= 0) return 0;
  return (100 * contextTokens) / windowTokens;
}

/**
 * T_free = T_window − T_context − T_reserved (§9). `reserved` is the space held
 * back for the reply and for compaction headroom; callers state it explicitly so
 * it is never ambiguous whether the reserve is inside or outside the figure.
 * Clamped at 0 — a window that is already over budget has no negative free space.
 */
export function freeContextOf(windowTokens: number, contextTokens: number, reserved = 0): number {
  return Math.max(0, windowTokens - contextTokens - reserved);
}
