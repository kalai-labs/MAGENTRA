/**
 * `session-report`.
 *
 * `/session` prints the plain-text bill for a conversation: time spent inside
 * provider calls against wall-clock time, lines added and removed by Write and
 * Edit, the current context size — measured from the last request, or flagged
 * estimated before any response — with its per-part breakdown, free space and
 * percent of the auto-compact limit, and cumulative token usage per model in
 * the four billed classes. No dollar figure, because our counting and a
 * provider's billing can diverge.
 *
 * `pure` + `fs`, and the record said `pure`. Re-declared 2026-09-20: items 1–4
 * are `SessionStats` formatting its own fields, a function of its arguments and
 * of the `now` it is handed. Item 5 is the command, and the command's text is
 * `stats.format(...)` joined with `session.contextBreakdown()`, which estimates
 * the live system prompt, tool schemas and message history of a real Engine on
 * a real workspace — so it needs one, with HOME redirected before `loadSettings`
 * reads it.
 *
 * ONE SPELLING FROM THE CHECKLIST DOES NOT REACH THE COMMAND. Item 5 sends
 * `{type:"user_message", text:"/session"}`; at `Engine.send` that is a message
 * beginning with a slash, not a command — the frontend parses the slash and
 * sends `{type:"slash_command", command:"session"}`, which is the frame used
 * here. Both spellings are checked, so the difference is asserted rather than
 * assumed.
 */

import { join } from "node:path";

import { SessionStats, type ContextBreakdown } from "@magentra/core";
import type { CoreEvent, Usage } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "session-report";

/** Verbatim from the record. */
const INVARIANT =
  "/session reports API vs wall time, code churn, current context with its breakdown, and cumulative usage per model.";

/** One billed invocation, in the four classes the report prints. */
function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

abstract class SessionReportTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class ApiTimeIsNotWallTime extends SessionReportTest {
  readonly id = "api-time-and-wall-time-are-reported-as-two-different-numbers";
  readonly whyItExists =
    "the report printed one duration for both, so a session that spent two minutes open and one minute inside the model read as if the model had been busy the whole time — and there was no way to see that the wait was somewhere else";

  override run(t: TestRun): void {
    const startedAt = 1_000_000_000_000;
    const stats = new SessionStats(startedAt);
    stats.recordResponse("m", usage(10, 5), 65_000);

    const report = stats.format(undefined, startedAt + 120_000);
    t.assert.match(report, /Total duration \(API\): +1m 05s/, "65s of provider time, padded to two digits");
    t.assert.match(report, /Total duration \(wall\): +2m 00s/, "two minutes of wall clock since the session opened");
    t.assert.equal(report.startsWith("Session"), true, "the report names itself first");

    // The two really are independent: more wall time, the same API time.
    const later = stats.format(undefined, startedAt + 3_600_000);
    t.assert.match(later, /Total duration \(API\): +1m 05s/, "API time did not move with the clock");
    t.assert.match(later, /Total duration \(wall\): +1h 0m 0s/);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ChurnCountsContentLinesOnly extends SessionReportTest {
  readonly id = "code-churn-counts-the-diff-body-and-never-its-file-headers";
  readonly whyItExists =
    "the `---`/`+++` header of every unified diff was counted as a removed and an added line, so every file touched inflated the session's churn by one of each and the number could not be compared with anything";

  override run(t: TestRun): void {
    const stats = new SessionStats(0);
    stats.recordDiff("--- a\n+++ b\n+x\n+y\n-z\n");
    t.assert.equal(stats.linesAdded, 2);
    t.assert.equal(stats.linesRemoved, 1);
    t.assert.match(stats.format(undefined, 0), /Total code changes: +2 lines added, 1 lines removed/);

    // A second edit accumulates onto the first, headers skipped again.
    stats.recordDiff("--- a\n+++ b\n-gone\n");
    t.assert.equal(stats.linesAdded, 2, "the second diff added nothing");
    t.assert.equal(stats.linesRemoved, 2);
    t.assert.match(stats.format(undefined, 0), /2 lines added, 2 lines removed/);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheContextLineSaysWhetherItWasMeasured extends SessionReportTest {
  readonly id = "before-any-response-the-context-is-the-estimate-and-says-so-and-the-limit-decides-the-free-space-line";
  readonly whyItExists =
    "with no response measured yet the report printed a context of 0 tokens for a window that already held the system prompt and every tool schema, and with auto-compaction off it printed a free space computed against a limit of zero";

  override run(t: TestRun): void {
    const breakdown: ContextBreakdown = { systemPrompt: 1000, tools: 500, addons: 0, messages: 200, limit: 0 };
    const stats = new SessionStats(0);
    t.assert.equal(stats.contextTokens, 0, "nothing has been measured");

    const off = stats.format(undefined, 0, breakdown);
    t.assert.match(off, /Current context: +~1\.7k tokens/, "the parts add up to the estimate, marked with a tilde");
    t.assert.match(off, /estimated — no response measured yet/, "and the line says it is an estimate");
    t.assert.match(off, /Context breakdown \(~estimated\):/);
    t.assert.match(off, /System prompt: +~1\.0k tokens/);
    t.assert.match(off, /System tools: +~500 tokens/);
    t.assert.match(off, /Messages: +~200 tokens/);
    t.assert.equal(off.includes("Addons:"), false, "no addons loaded, no addons line");
    t.assert.match(off, /auto-compaction is off/, "with no limit there is nothing to measure free space against");
    t.assert.equal(off.includes("Free space"), false);

    const limited = stats.format(undefined, 0, { ...breakdown, limit: 10_000 });
    t.assert.match(limited, /Free space: +~8\.3k tokens/, "10k less the 1.7k estimate");
    t.assert.match(limited, /17% of the ~10k auto-compact limit used/);
    t.assert.equal(limited.includes("auto-compaction is off"), false);

    // Once a response measures the window, the tilde and the caveat go away.
    stats.recordResponse("m", usage(4_000, 10, 2_000, 0), 1);
    const measured = stats.format(undefined, 0, { ...breakdown, limit: 10_000 });
    t.assert.match(measured, /Current context: +6\.0k tokens/, "input + cache read + cache write, not the estimate");
    t.assert.equal(measured.includes("estimated — no response measured yet"), false);
    t.assert.equal(measured.includes("~6.0k"), false, "a measured figure carries no tilde");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class UsageIsPerModelAndCarriesNoPrice extends SessionReportTest {
  readonly id = "usage-is-one-line-per-model-in-four-classes-and-the-report-prints-no-price";
  readonly whyItExists =
    "a session that ran a subagent on a second model summed both into one row, so the per-model spend was unrecoverable — and an earlier report priced that sum in dollars from rates that were not the ones the user was billed at";

  override run(t: TestRun): void {
    const empty = new SessionStats(0).format(undefined, 0);
    t.assert.match(empty, /Usage by model: +\(no model calls yet\)/, "an unused session says so rather than printing nothing");

    const stats = new SessionStats(0);
    stats.recordResponse("m1", usage(1_000, 200, 3_000, 40), 10);
    stats.recordResponse("m2", usage(7, 8, 9, 10), 10);
    stats.recordResponse("m1", usage(1_000, 100, 0, 0), 10);

    const report = stats.format(undefined, 0);
    t.assert.match(report, /Usage by model \(cumulative, every call this session\):/);
    t.assert.match(report, /m1: +2\.0k input, 300 output, 3\.0k cache read, 40 cache write/, "m1's two calls, summed per class");
    t.assert.match(report, /m2: +7 input, 8 output, 9 cache read, 10 cache write/, "m2 keeps its own row");
    t.assert.equal(report.includes("$"), false, "no dollar figure anywhere in the report");

    const rows = report.split("\n").filter((line) => /^ {6}m[12]:/.test(line));
    t.assert.equal(rows.length, 2, "one row per model, not one per call");
  }
}

/* ---- checklist 5 — fs ------------------------------------------------ */

class TheCommandReportsTheLiveSession extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-slash-command-emits-a-session-report-carrying-the-live-context-breakdown";
  readonly whyItExists =
    "`/session` answered with the ledger alone: the breakdown lines were computed from a session object the command never asked, so the user was shown a total with nothing behind it and no way to see what was filling the window";

  /** A real Engine boots. */
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-session-report-");
    this.writeFile(join(workspace, "src", "app.ts"), "export const app = 1;\n");
    // One scripted turn, for the `/session` spelled as a user message below —
    // which is a message, so it really does go to the model.
    const engine = await startScriptedEngine({ workspace, turns: [{ text: "ok", stopReason: "end_turn" }] });
    this.#engine = engine;

    // The frontend parses the slash and sends the command frame; a user_message
    // beginning with "/" is just a message. Both are checked below.
    engine.send({ type: "slash_command", command: "session" });
    const report = await engine.waitFor(
      (e): e is Extract<CoreEvent, { type: "session_report" }> => e.type === "session_report",
    );

    t.assert.equal(report.text.startsWith("Session"), true, "the report is the one SessionStats formats");
    t.assert.match(report.text, /Total duration \(API\):/);
    t.assert.match(report.text, /Total duration \(wall\):/);
    t.assert.match(report.text, /Total code changes: +0 lines added, 0 lines removed/);
    t.assert.match(report.text, /Usage by model: +\(no model calls yet\)/, "nothing has been sent to a model yet");

    // The breakdown is the live session's, not a placeholder: the system prompt
    // and the tool schemas of a real Engine are never zero.
    t.assert.match(report.text, /Context breakdown \(~estimated\):/);
    const systemPrompt = /System prompt: +~([\d.]+)k tokens/.exec(report.text);
    t.assert.notEqual(systemPrompt, null, "the system prompt line carries a real figure");
    t.assert.equal(Number(systemPrompt?.[1]) > 0, true);
    const tools = /System tools: +~([\d.]+)k tokens/.exec(report.text);
    t.assert.notEqual(tools, null, "and so does the tool-schema line");
    t.assert.equal(Number(tools?.[1]) > 0, true);
    t.assert.match(report.text, /Current context: +~[\d.]+k tokens \(input of the last request, estimated/);

    // The checklist's other spelling: at Engine.send this is a message, and it
    // produces no report.
    const before = engine.events.length;
    engine.send({ type: "user_message", text: "/session" });
    await engine.engine.idle();
    const after = engine.events.slice(before);
    t.assert.equal(
      after.some((e) => e.type === "session_report"),
      false,
      "a user_message starting with a slash is not the command — the frontend sends slash_command",
    );
  }
}

registerFeatureTests(
  new ApiTimeIsNotWallTime(),
  new ChurnCountsContentLinesOnly(),
  new TheContextLineSaysWhetherItWasMeasured(),
  new UsageIsPerModelAndCarriesNoPrice(),
  new TheCommandReportsTheLiveSession(),
);
