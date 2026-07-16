import type { Usage } from "@magentra/protocol";
import { estimateCost, formatDuration, formatTokens, formatUsd, pricingFor } from "../config/pricing.js";
import type { Settings } from "../config/settings.js";

/**
 * Whole-session accounting, shared by a session and every subagent/crew child it
 * spawns (children hold a reference to the parent's instance, so a `/session`
 * summary covers the entire tree, not just the orchestrator's own calls).
 *
 * The critical distinction this type exists to keep straight:
 *
 *   CONTEXT  — a point-in-time measure: how full the model's window is RIGHT
 *              NOW. It is the last request's whole prompt (input + cacheRead +
 *              cacheWrite) plus the reply appended to history (output). It does
 *              NOT accumulate: a 10-round turn does not make the context 10x
 *              bigger, it just re-sends a similar prompt 10 times.
 *
 *   USAGE    — a cumulative measure: every token ever billed this session, per
 *              model. THIS is what accumulates, and what cost is computed from.
 *
 * Summing usage and calling it "context" (or reading `inputTokens` alone while
 * prompt caching routes most of the prompt through `cacheReadTokens`) are the
 * two classic ways to get this wrong; both produce a context number that has no
 * relationship to how full the window actually is.
 */
export class SessionStats {
  /** Wall-clock start of the session (ms epoch). */
  readonly startedAt: number;
  /** Time spent inside provider streaming calls (ms) — API time, not wall time. */
  apiMs = 0;
  /** Cumulative billed usage, keyed by model id. */
  readonly byModel = new Map<string, Usage>();
  linesAdded = 0;
  linesRemoved = 0;
  /**
   * Current context size in tokens: the whole prompt of the most recent request
   * plus its reply. Point-in-time, NOT a running total — see the class docs.
   * Zero until the first provider response, and reset to zero by /clear.
   */
  contextTokens = 0;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  /** Bank one provider response: its billed tokens, its API time, and the context size it reveals. */
  recordResponse(model: string, usage: Usage, apiMs: number): void {
    const entry = this.byModel.get(model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    entry.inputTokens += usage.inputTokens;
    entry.outputTokens += usage.outputTokens;
    entry.cacheReadTokens += usage.cacheReadTokens;
    entry.cacheWriteTokens += usage.cacheWriteTokens;
    this.byModel.set(model, entry);
    this.apiMs += apiMs;
    this.contextTokens = contextSizeOf(usage);
  }

  /** Serializable view for the transcript `meta` record, restored by /resume. */
  snapshot(): Record<string, unknown> {
    return {
      startedAt: this.startedAt,
      apiMs: this.apiMs,
      linesAdded: this.linesAdded,
      linesRemoved: this.linesRemoved,
      contextTokens: this.contextTokens,
      byModel: Object.fromEntries(this.byModel),
    };
  }

  /**
   * Rebuilds a ledger from a snapshot. Returns undefined on malformed data —
   * a corrupt or missing meta line must never block a resume, it just means
   * the session starts with fresh accounting.
   */
  static fromSnapshot(data: unknown): SessionStats | undefined {
    if (typeof data !== "object" || data === null) return undefined;
    const d = data as Record<string, unknown>;
    if (typeof d.startedAt !== "number") return undefined;
    const stats = new SessionStats(d.startedAt);
    if (typeof d.apiMs === "number") stats.apiMs = d.apiMs;
    if (typeof d.linesAdded === "number") stats.linesAdded = d.linesAdded;
    if (typeof d.linesRemoved === "number") stats.linesRemoved = d.linesRemoved;
    if (typeof d.contextTokens === "number") stats.contextTokens = d.contextTokens;
    if (typeof d.byModel === "object" && d.byModel !== null) {
      for (const [model, usage] of Object.entries(d.byModel)) {
        const u = usage as Partial<Usage>;
        stats.byModel.set(model, {
          inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : 0,
          outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : 0,
          cacheReadTokens: typeof u.cacheReadTokens === "number" ? u.cacheReadTokens : 0,
          cacheWriteTokens: typeof u.cacheWriteTokens === "number" ? u.cacheWriteTokens : 0,
        });
      }
    }
    return stats;
  }

  /** Count a file edit's diff toward the session's code-change totals. */
  recordDiff(diff: string): void {
    for (const line of diff.split("\n")) {
      // Skip the ---/+++ file headers; only real content lines count.
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) this.linesAdded++;
      else if (line.startsWith("-")) this.linesRemoved++;
    }
  }

  /** Total across every model, for the headline cost/token figures. */
  totalUsage(): Usage {
    const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const usage of this.byModel.values()) {
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cacheReadTokens += usage.cacheReadTokens;
      total.cacheWriteTokens += usage.cacheWriteTokens;
    }
    return total;
  }

  /**
   * Session cost, summed per model at that model's own rate card. Returns
   * undefined only when NO model used this session has a rate card at all;
   * a partially-priced session reports what it can price (unpriced models
   * contribute their token counts but nothing to the total).
   */
  totalCost(settings?: Settings): number | undefined {
    let total = 0;
    let priced = false;
    for (const [model, usage] of this.byModel) {
      const cost = estimateCost(usage, pricingFor(model, settings));
      if (cost !== undefined) {
        total += cost;
        priced = true;
      }
    }
    return priced ? total : undefined;
  }

  /** The `/session` report — the whole-session summary a user reads at the end. */
  format(settings?: Settings, now: number = Date.now()): string {
    const lines: string[] = ["Session", ""];
    const cost = this.totalCost(settings);
    lines.push(`  Total cost:            ${cost === undefined ? "— (no rate card for this model)" : formatUsd(cost)}`);
    lines.push(`  Total duration (API):  ${formatDuration(this.apiMs)}`);
    lines.push(`  Total duration (wall): ${formatDuration(now - this.startedAt)}`);
    lines.push(`  Total code changes:    ${this.linesAdded} lines added, ${this.linesRemoved} lines removed`);
    lines.push(`  Context now:           ${formatTokens(this.contextTokens)} tokens`);

    if (this.byModel.size === 0) {
      lines.push("  Usage by model:        (no model calls yet)");
      return lines.join("\n");
    }
    lines.push("  Usage by model:");
    for (const [model, usage] of this.byModel) {
      const modelCost = estimateCost(usage, pricingFor(model, settings));
      const priced = modelCost === undefined ? "" : ` (${formatUsd(modelCost)})`;
      lines.push(
        `      ${model}:  ${formatTokens(usage.inputTokens)} input, ` +
          `${formatTokens(usage.outputTokens)} output, ` +
          `${formatTokens(usage.cacheReadTokens)} cache read, ` +
          `${formatTokens(usage.cacheWriteTokens)} cache write${priced}`,
      );
    }
    return lines.join("\n");
  }
}

/**
 * The context size a single provider response implies: its ENTIRE prompt — fresh
 * input plus cache reads plus cache writes — plus the reply that is appended to
 * the history. Reading `inputTokens` alone is the classic bug: with prompt
 * caching most of the prompt arrives as `cacheReadTokens`, so input-only reports
 * a near-empty context for a nearly-full window.
 */
export function contextSizeOf(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}
