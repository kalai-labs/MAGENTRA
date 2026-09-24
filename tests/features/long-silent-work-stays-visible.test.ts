/**
 * `long-silent-work-stays-visible`.
 *
 * Field test 2026-09-23, findings M-06 and R-3: from 18:06:29 to 18:30:12 the
 * user saw no text at all. The model only reasoned, through tool rounds, and
 * the collapsed reasoning block said "reasoning" the whole time — a window that
 * looked frozen while work went on. `SECTION_COMMUNICATION` already asks for a
 * sentence before the first tool call; nothing reacted when the model did not.
 *
 * `fs` + `ui`, as the record declares.
 *
 *   - `fs` is the silent-reasoning rung: the real Engine on the scripted
 *     provider, reading what the Session actually SENT the model. The reminder
 *     is a registry prompt, so it is found by the words of the request, and
 *     counted in the last request's history — every reminder ever attached is
 *     still there, so the count is how many times it fired.
 *   - `ui` is the reasoning block's summary and the now-line, in the real app,
 *     with frames sent on the channel main sends them on.
 */

import { join } from "node:path";

import type { StreamRequest } from "@magentra/providers";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";
import { PureTest } from "../lib/pureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

import { secs } from "../../tui/src/format.ts";

const FEATURE = "long-silent-work-stays-visible";

/** Verbatim from the record. */
const INVARIANT =
  "Long silent work shows that it is going on: the live reasoning block counts its time and size, and after a long stretch of reasoning with no word to the user the next request asks the model for one sentence, once per stretch.";

/** The reminder's opening words — enough to find it, nothing about how it is phrased after. */
const REMINDER = "The user has seen nothing from you for a while";

let roundNo = 0;

/**
 * A model call that reasons `chars` characters and calls one harmless tool;
 * `text` makes it not silent. Each round globs a different pattern, so no two
 * rounds are identical and the stall detector stays out of the history.
 */
function round(chars: number, text?: string): FakeTurn {
  roundNo += 1;
  return {
    thinking: "x".repeat(chars),
    ...(text !== undefined ? { text } : {}),
    toolCalls: [{ name: "Glob", input: { pattern: `round-${roundNo}-*` } }],
  };
}

/**
 * Whether the reminder rode with each round's tool results, in order. Read
 * from the history, not per request: `provider.requests[i].messages` is the
 * Session's LIVE array, so every recorded request shows the final history.
 */
function reminded(requests: readonly StreamRequest[]): boolean[] {
  const history = requests[requests.length - 1]?.messages ?? [];
  return history
    .filter((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"))
    .map((m) => JSON.stringify(m.content).includes(REMINDER));
}

abstract class SilentRungTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  /** One user turn played from `turns`; returns every request the real Session sent. */
  protected async play(turns: FakeTurn[]): Promise<readonly StreamRequest[]> {
    this.redirectHome();
    this.#engine = await startScriptedEngine({ workspace: this.tempDir("magentra-silent-"), turns });
    const turn = await this.#engine.runTurn("build the game");
    if (turn.errors.length > 0) throw new Error(turn.errors.join(" | "));
    return this.#engine.provider.requests;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheRungFiresOncePerStretch extends SilentRungTest {
  readonly id = "a-long-silent-stretch-gets-one-reminder-on-the-next-request-and-no-more";
  readonly whyItExists =
    "the field run reasoned for 24 minutes through its planning rounds without a word to the user, and nothing in the loop reacted to silence — every existing rung keys off tool-call patterns";

  override async run(t: TestRun): Promise<void> {
    const requests = await this.play([round(5_000), round(5_000), round(5_000), { text: "done" }]);
    t.assert.equal(requests.length, 4, "three tool rounds and a final answer are four model calls");
    const [first, second, third] = reminded(requests);
    t.assert.equal(first, false, "5,000 silent characters are not yet a long stretch");
    t.assert.equal(second, true, "10,000 are: the next request carries the reminder with that round's results");
    t.assert.equal(third, false, "and a third silent round does not add it again — once per stretch");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TextReArmsIt extends SilentRungTest {
  readonly id = "text-to-the-user-ends-the-stretch-and-a-round-with-text-never-gets-the-reminder";
  readonly whyItExists =
    "a rung that never re-armed would stay quiet through a second silent hour, and one that ignored text would scold a model that had just told the user what it was doing";

  override async run(t: TestRun): Promise<void> {
    const requests = await this.play([
      round(9_000),
      round(20_000, "Laying out the rooms first."),
      round(9_000),
      { text: "done" },
    ]);
    t.assert.deepEqual(
      reminded(requests),
      [true, false, true],
      "9,000 silent characters get the reminder; a round that spoke to the user gets none however long it reasoned; the next silent stretch is reminded again",
    );
  }
}

/* ---- a cut-off or a blank answer is still silence ---------------------- */

class CutOffAndBlankStaySilent extends SilentRungTest {
  readonly id = "a-response-cut-off-mid-reasoning-counts-and-whitespace-is-not-a-word-to-the-user";
  readonly whyItExists =
    "a response cut off at the output limit was neither counted nor ended the stretch, so a silent hour that began with a cut-off stayed unreminded; and a response of blank text reset the stretch as if the model had spoken";

  override async run(t: TestRun): Promise<void> {
    const cutOff = await this.play([{ thinking: "x".repeat(9_000), stopReason: "max_tokens" }, round(100), { text: "done" }]);
    t.assert.deepEqual(reminded(cutOff), [true], "9,000 characters reasoned before a cut-off are silence: the next results carry the reminder");
    await this.tearDown();

    const blank = await this.play([round(9_000, "   "), { text: "done" }]);
    t.assert.deepEqual(reminded(blank), [true], "a response whose text is only whitespace said nothing to the user");
  }
}

/* ---- the TUI reads a long stretch in minutes too ------------------------ */

class TheTerminalReadsMinutes extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-terminal-now-line-reads-a-long-stretch-in-minutes-as-the-desktop-does";
  readonly whyItExists =
    "the desktop was fixed to read 8m12s, but the TUI's activity line still printed a 24-minute silent stretch as \"1440.0s\" — the same unreadable counter on the other frontend";

  override run(t: TestRun): void {
    t.assert.equal(secs(4_200), "4.2s", "under a minute it keeps its tenth of a second");
    t.assert.equal(secs(59_900), "59.9s");
    t.assert.equal(secs(60_000), "1m00s");
    t.assert.equal(secs(492_000), "8m12s", "eight minutes read as the desktop reads them");
    t.assert.equal(secs(1_440_000), "24m00s", "the field run's silent stretch, not 1440.0s");
    t.assert.equal(secs(-5), "0.0s", "a clock a hair ahead never reads as a negative duration");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

class TheBlockCountsItsWork extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-reasoning-summary-counts-time-and-size-and-the-now-line-reads-in-minutes";
  readonly whyItExists =
    "a collapsed reasoning block that says only 'reasoning' for 24 minutes, above a timer reading '1440s', is indistinguishable from a hung window — the owner could not tell work from a freeze";

  async #send(app: AppHandle, frames: Record<string, unknown>[]): Promise<void> {
    await app.evaluateInMain(`for (const f of ${JSON.stringify(frames)}) win.webContents.send("engine:event", f); return true;`);
  }

  async #summary(app: AppHandle, selector: string): Promise<string> {
    return this.waitFor<string>(app, `(() => { const s = streamEl.querySelector(${JSON.stringify(selector)}); return s ? s.textContent : null; })()`, selector);
  }

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-silent-ui-home-");
    const workspace = this.makeTempDir("magentra-silent-ui-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "model-one" });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    const tabId = await this.waitFor<string>(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the tab id");

    const live = /^reasoning · (\d+m)?\d+s · ~([\d.]+k?) tokens$/;
    await this.#send(app, [{ type: "turn_started", turnId: "t_1", tabId }, { type: "thinking_delta", text: "y".repeat(3_500), tabId }]);
    const first = await this.waitFor<string>(app, `(() => { const s = currentThinkingEl && currentThinkingEl.querySelector("summary"); return s && s.textContent !== "reasoning" ? s.textContent : null; })()`, "a live summary");
    t.assert.match(first, live, `a live block counts its time and size: "${first}"`);
    t.assert.equal(first.match(live)?.[2], "1.0k", "3,500 characters estimate to 1.0k tokens, the renderer's own estimate");

    await this.#send(app, [{ type: "thinking_delta", text: "y".repeat(35_000), tabId }]);
    const grown = await this.waitFor<string>(app, `(() => { const s = currentThinkingEl && currentThinkingEl.querySelector("summary"); return s && s.textContent.includes("~11k") ? s.textContent : null; })()`, "the summary to grow");
    t.assert.match(grown, live, "and the figure grows with the text");

    // A tool call ends the block; its summary keeps what it counted.
    await this.#send(app, [{ type: "tool_call_started", id: "call_1", tool: "TaskList", input: {}, tabId }]);
    const ended = await this.#summary(app, ".msg-thinking summary");
    t.assert.match(ended, live, `an ended block keeps its figures: "${ended}"`);
    t.assert.match(ended, /~11k tokens/);

    // A restored block has a size and no time: nobody watched it.
    await this.#send(app, [{ type: "turn_finished", turnId: "t_1", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, contextTokens: 0, tabId }]);
    await this.#send(app, [{ type: "session_restored", sessionId: "s_x", messages: [{ role: "assistant", thinking: "z".repeat(7_000), text: "Done." }], tabId }]);
    const restored = await this.waitFor<string>(app, `(() => { const s = streamEl.querySelector(".msg-thinking.done summary"); return s ? s.textContent : null; })()`, "the restored block");
    t.assert.equal(restored, "reasoning · ~2.0k tokens", "a restored block shows its size and no time");

    // The now-line's timer reads in minutes past the first one.
    const nowLine = await app.evaluate<string>(`(() => { setNowActivity("thinking", ""); nowActivityStart = Date.now() - 492000; renderNowText(); return nowTextEl.textContent; })()`);
    t.assert.equal(nowLine, "thinking · 8m12s", "eight minutes read as minutes, not '492s'");
  }
}

registerFeatureTests(new TheRungFiresOncePerStretch(), new TextReArmsIt(), new CutOffAndBlankStaySilent(), new TheTerminalReadsMinutes(), new TheBlockCountsItsWork());
