import type { Usage } from "@magentra/protocol";
import { formatDuration, formatTokens } from "../config/pricing.js";
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
/**
 * A per-part estimate of what fills the context now, sourced from the live
 * session (system prompt, tool schemas, skills, message history). Every field is
 * an estimate; `limit` is the user's auto-compact token limit (0 = none set).
 */
export interface ContextBreakdown {
  systemPrompt: number;
  tools: number;
  skills: number;
  messages: number;
  limit: number;
}

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
    // Context size is read from the response's own usage. Some providers
    // intermittently omit usage on very large prompts (or a stream ends without
    // a usage frame), which reports as all-zeros — but a real response always
    // had a prompt, so zero means "not measured", NOT "the context emptied".
    // Collapsing to 0 there would blind the compaction safety (the next turn
    // would think the window is empty and never compact, then overflow), so a
    // zero measurement retains the last known size. Compaction is what actually
    // shrinks contextTokens, and it sets it explicitly.
    const measured = contextSizeOf(usage);
    if (measured > 0) this.contextTokens = measured;
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
   * The `/session` report — the whole-session summary a user reads at the end.
   * Cost is deliberately omitted: our token counting and a provider's billing
   * can diverge, so any dollar figure risks misinforming. Token counts (which
   * we measure directly) stay; context is shown "~" to signal it is an estimate.
   */
  format(_settings?: Settings, now: number = Date.now(), breakdown?: ContextBreakdown): string {
    const lines: string[] = ["Session", ""];
    lines.push(`  Total duration (API):  ${formatDuration(this.apiMs)}`);
    lines.push(`  Total duration (wall): ${formatDuration(now - this.startedAt)}`);
    lines.push(`  Total code changes:    ${this.linesAdded} lines added, ${this.linesRemoved} lines removed`);
    lines.push(`  Context now:            ~${formatTokens(this.contextNowValue(breakdown))} tokens`);
    if (breakdown) lines.push(...this.formatBreakdown(breakdown));

    if (this.byModel.size === 0) {
      lines.push("  Usage by model:        (no model calls yet)");
      return lines.join("\n");
    }
    lines.push("  Usage by model:");
    for (const [model, usage] of this.byModel) {
      lines.push(
        `      ${model}:  ${formatTokens(usage.inputTokens)} input, ` +
          `${formatTokens(usage.outputTokens)} output, ` +
          `${formatTokens(usage.cacheReadTokens)} cache read, ` +
          `${formatTokens(usage.cacheWriteTokens)} cache write`,
      );
    }
    return lines.join("\n");
  }

  /**
   * The "what's filling the context" lines under `/session`. Estimated per-part
   * sizes (system prompt, tools, skills, message history), plus free space when
   * the user has set an auto-compact limit to measure against. All approximate —
   * they show the shape of the context, not an exact accounting; the measured
   * "Context now" above is the true total.
   */
  /**
   * The context size to display: the measured total when a provider response has
   * reported one, otherwise the per-part estimate (system prompt + tools + skills
   * + message history). `contextTokens` is 0 before the first response, but the
   * window is NOT empty then — the system prompt and tool schemas always occupy
   * it — so showing ~0 would be plainly wrong. The estimate keeps the figure
   * honest until a response measures it exactly.
   */
  private contextNowValue(b?: ContextBreakdown): number {
    if (this.contextTokens > 0) return this.contextTokens;
    if (!b) return 0;
    return b.systemPrompt + b.tools + b.skills + b.messages;
  }

  private formatBreakdown(b: ContextBreakdown): string[] {
    const lines: string[] = ["  Context breakdown (~estimated):"];
    const pad = (label: string) => `${label}:`.padEnd(16);
    lines.push(`      ${pad("System prompt")}~${formatTokens(b.systemPrompt)} tokens`);
    lines.push(`      ${pad("System tools")}~${formatTokens(b.tools)} tokens`);
    if (b.skills > 0) lines.push(`      ${pad("Skills")}~${formatTokens(b.skills)} tokens`);
    lines.push(`      ${pad("Messages")}~${formatTokens(b.messages)} tokens`);
    if (b.limit > 0) {
      const free = Math.max(0, b.limit - this.contextNowValue(b));
      lines.push(`      ${pad("Free space")}~${formatTokens(free)} tokens (until auto-compact at ~${formatTokens(b.limit)})`);
    } else {
      lines.push("      (no auto-compact limit set — no fixed window to measure free space against; set one in Settings → Context)");
    }
    return lines;
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
