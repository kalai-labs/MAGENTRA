import {
  addUsage,
  contextPercentOf,
  emptyUsage,
  formatTokens,
  freeContextOf,
  inputTokensOf,
  type Usage,
} from "@magentra/protocol";
import { formatDuration } from "../config/pricing.js";
import type { Settings } from "../config/settings.js";

/**
 * Whole-session accounting, shared by a session and every subagent it
 * spawns (children hold a reference to the parent's instance, so a `/session`
 * summary — and the live meters — cover the entire tree, not just the
 * orchestrator's own calls).
 *
 * Three quantities live here, and the whole point of this class is that they can
 * never be confused with one another. All three are defined once, in
 * `@magentra/protocol`'s token module; nothing here re-derives them.
 *
 *   CONTEXT  B(t) — a point-in-time measure: how full the model's window is
 *            RIGHT NOW, i.e. the whole INPUT of the latest conversational
 *            invocation (fresh + cache-write + cache-read). It does NOT
 *            accumulate, and it does NOT include generated output.
 *
 *   PHASE    D(t) / T_turn — everything billed since the current agent turn
 *            opened, across this session AND its children. Reset at the start of
 *            each turn; `D(t)` is its output component, the live "deliberation"
 *            figure the UI counts up while the agent works.
 *
 *   USAGE    every token ever billed this session, per model. THIS is what
 *            accumulates over the session, and what cost is computed from.
 *
 * Summing usage and calling it "context", or reading `inputTokens` alone while
 * prompt caching routes most of the prompt through `cacheReadTokens`, are the
 * two classic ways to get this wrong; both produce a context number with no
 * relationship to how full the window actually is.
 */
/**
 * A per-part estimate of what fills the context now, sourced from the live
 * session (system prompt, tool schemas, addons, message history). It is the
 * category-sum form of the input context — the parts are disjoint, so they add.
 * Every field is an estimate; `limit` is the effective auto-compact limit
 * (derived from the connection's context window, 0 = auto-compaction off).
 */
export interface ContextBreakdown {
  systemPrompt: number;
  tools: number;
  addons: number;
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
   * B(t) — current context size in tokens: the whole INPUT of the most recent
   * conversational request. Point-in-time, NOT a running total, and NOT
   * including the reply (see the class docs). Zero until the first provider
   * response, and reset by /clear.
   *
   * This belongs to the LEDGER OWNER's conversation — the root session. Usage
   * accumulates across the whole tree, but a window does not: an orchestrator's
   * context and a subagent's are different conversations, so a child's responses
   * must never be allowed to overwrite this (they bank their usage instead).
   */
  contextTokens = 0;

  /**
   * The open phase's ledger: every invocation banked since {@link beginPhase},
   * across this session and every child sharing this instance. `outputTokens` is
   * D(t) — the live deliberation figure. Closed phases stop accumulating so a
   * post-turn housekeeping call (auto-naming, a summarizer) can't inflate a
   * figure the UI has already reported as final.
   */
  private phase: Usage = emptyUsage();
  private phaseOpen = false;
  /** The highest D(t) already pushed to a frontend this phase — see {@link liveDeliberationTokens}. */
  private liveDeliberation = 0;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  /**
   * Open a fresh deliberation phase — one agent turn. Only the ROOT session may
   * call this: children share this ledger, so a subagent starting its own turn
   * must add to the phase in flight, never restart it.
   */
  beginPhase(): void {
    this.phase = emptyUsage();
    this.liveDeliberation = 0;
    this.phaseOpen = true;
  }

  /**
   * Close the phase and return its final total: T_turn across every invocation
   * the turn made (this session's, its auxiliary prompts, and its children's).
   * `outputTokens` is the authoritative D_final that replaces every live
   * estimate.
   */
  endPhase(): Usage {
    this.phaseOpen = false;
    return { ...this.phase };
  }

  /** D(t) — output tokens generated so far by the open phase. 0 between turns. */
  get deliberationTokens(): number {
    return this.phase.outputTokens;
  }

  /**
   * The live D(t) to display: everything the phase has banked exactly, plus
   * `pendingOutput` — the character-based estimate of the reply still streaming
   * out of the caller's own in-flight invocation.
   *
   * Ratcheted, because several subagents can stream at once: each one knows the
   * banked total and its OWN tail, so without a floor the figure would jump
   * backwards every time a different one reported. A live counter that goes down
   * while the agent is visibly working reads as a bug. Any small over-estimate
   * the ratchet holds onto is corrected by the exact D_final at turn end.
   */
  liveDeliberationTokens(pendingOutput: number): number {
    this.liveDeliberation = Math.max(this.liveDeliberation, this.phase.outputTokens + pendingOutput);
    return this.liveDeliberation;
  }

  /**
   * Bank one model invocation: its billed tokens (per model — a subagent may
   * run on a different one), its API time, and, for a conversational call, the
   * context size its prompt reveals.
   *
   * `conversational` is false for the one-off prompts that never sit in the
   * window — clarification, auto-naming, the compaction
   * summarizer. Those are real spend and real deliberation, so they count toward
   * usage and toward the phase, but their tiny private prompt must NOT be
   * mistaken for the conversation's context size.
   */
  recordResponse(model: string, usage: Usage, apiMs: number, conversational = true): void {
    let entry = this.byModel.get(model);
    if (!entry) {
      entry = emptyUsage();
      this.byModel.set(model, entry);
    }
    addUsage(entry, usage);
    this.apiMs += apiMs;
    if (this.phaseOpen) addUsage(this.phase, usage);
    if (conversational) this.observeContext(usage);
  }

  /**
   * Adopt an exact B(t) from one invocation's usage. Callable as soon as the
   * provider reports the input — the definition counts the latest ACTIVE
   * invocation, not only completed ones, so a long call shows its true window
   * occupancy for its whole duration instead of a stale figure.
   *
   * Some providers intermittently omit usage on very large prompts (or a stream
   * ends without a usage frame), which reports as all-zeros — but a real request
   * always had a prompt, so zero means "not measured", NOT "the context
   * emptied". Collapsing to 0 there would blind the compaction safety (the next
   * turn would think the window is empty, never compact, then overflow), so a
   * zero measurement retains the last known size. Compaction is what actually
   * shrinks the context, and it sets this explicitly.
   */
  observeContext(usage: Usage): void {
    const measured = inputTokensOf(usage);
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
    const total = emptyUsage();
    for (const usage of this.byModel.values()) addUsage(total, usage);
    return total;
  }

  /**
   * The `/session` report — the whole-session summary a user reads at the end.
   * Cost is deliberately omitted: our token counting and a provider's billing
   * can diverge, so any dollar figure risks misinforming. Token counts (which
   * we measure directly) stay; the context line is labelled for what it is — the
   * CURRENT window occupancy, not a session total — and shown "~" whenever it
   * falls back to the estimate.
   */
  format(_settings?: Settings, now: number = Date.now(), breakdown?: ContextBreakdown): string {
    const lines: string[] = ["Session", ""];
    lines.push(`  Total duration (API):  ${formatDuration(this.apiMs)}`);
    lines.push(`  Total duration (wall): ${formatDuration(now - this.startedAt)}`);
    lines.push(`  Total code changes:    ${this.linesAdded} lines added, ${this.linesRemoved} lines removed`);
    const measured = this.contextTokens > 0;
    lines.push(
      `  Current context:       ${measured ? "" : "~"}${formatTokens(this.contextNowValue(breakdown))} tokens` +
        ` (input of the last request${measured ? "" : ", estimated — no response measured yet"})`,
    );
    if (breakdown) lines.push(...this.formatBreakdown(breakdown));

    if (this.byModel.size === 0) {
      lines.push("  Usage by model:        (no model calls yet)");
      return lines.join("\n");
    }
    lines.push("  Usage by model (cumulative, every call this session):");
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
   * The context size to display: the measured B(t) when a provider response has
   * reported one, otherwise the per-part estimate (system prompt + tools +
   * addons + message history). `contextTokens` is 0 before the first response,
   * but the window is NOT empty then — the system prompt and tool schemas always
   * occupy it — so showing 0 would be plainly wrong. The estimate keeps the
   * figure honest until a response measures it exactly.
   */
  private contextNowValue(b?: ContextBreakdown): number {
    if (this.contextTokens > 0) return this.contextTokens;
    if (!b) return 0;
    return b.systemPrompt + b.tools + b.addons + b.messages;
  }

  /**
   * The "what's filling the context" lines under `/session`. Estimated per-part
   * sizes, plus free space when the user has set an auto-compact limit to
   * measure against. All approximate — they show the SHAPE of the context; the
   * measured "Current context" above is the true total, and the two will not sum
   * to each other exactly.
   */
  private formatBreakdown(b: ContextBreakdown): string[] {
    const lines: string[] = ["  Context breakdown (~estimated):"];
    const pad = (label: string) => `${label}:`.padEnd(16);
    lines.push(`      ${pad("System prompt")}~${formatTokens(b.systemPrompt)} tokens`);
    lines.push(`      ${pad("System tools")}~${formatTokens(b.tools)} tokens`);
    if (b.addons > 0) lines.push(`      ${pad("Addons")}~${formatTokens(b.addons)} tokens`);
    lines.push(`      ${pad("Messages")}~${formatTokens(b.messages)} tokens`);
    if (b.limit > 0) {
      // Free space and occupancy against the user's auto-compact limit, with
      // nothing held back: the limit IS the reserve they chose, so the reply's
      // own headroom lives between it and the model's real window.
      const used = this.contextNowValue(b);
      const free = freeContextOf(b.limit, used);
      const percent = Math.round(contextPercentOf(used, b.limit));
      lines.push(
        `      ${pad("Free space")}~${formatTokens(free)} tokens` +
          ` (${percent}% of the ~${formatTokens(b.limit)} auto-compact limit used)`,
      );
    } else {
      lines.push("      (auto-compaction is off — no limit to measure free space against; set the connection's Context size, or a cap in Settings → Context)");
    }
    return lines;
  }
}
