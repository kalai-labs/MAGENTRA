/**
 * `session-log-reads-on-its-own`.
 *
 * Field test 2026-09-23, findings L-01…L-04. The black-box log of that run
 * could not be read without the transcript: `/key|token|secret/i` hid every
 * `*Tokens` figure; lines were cut at 2,048 characters AFTER `JSON.stringify`,
 * so 107 of them were not JSON (14 of the 20 task updates among them); 113,000
 * one-token delta lines buried everything else in 12.8 MB; tool lines had no
 * duration; the file name was local time beside UTC lines; and with one log
 * file per app session, a background tab's frames landed in the focused
 * workspace's log with nothing naming the tab.
 *
 * `fs` + `ui`, as the record declares. `app/main/logging.js` needs no Electron,
 * so the `fs` half `require`s it exactly as `app/main.js` does and reads the
 * files it writes. The `ui` half is the routing only a running app has: two
 * workspaces, two engines, and a frame to the one that is not focused.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { openWorkspace, waitForSpawn, type LogLine } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "session-log-reads-on-its-own";

/** Verbatim from the record. */
const INVARIANT =
  "Every line of the session log is valid JSON that keeps what a reader needs — counts, durations, which tab — hides only secrets, and lands in its own workspace's log.";

interface Logging {
  redact(data: unknown): unknown;
  logEvent(ch: string, data: unknown, target?: { workspace?: string; tabId?: string }): void;
  logEngineFrame(event: Record<string, unknown>, target?: { workspace?: string; tabId?: string }): void;
  setLogWorkspace(workspace: string): void;
  flushLog(): void;
}

/** The module `app/main.js` loads, loaded the same way. */
const logging = createRequire(import.meta.url)(join(repoRoot(), "app", "main", "logging.js")) as Logging;

/** Every line in a workspace's logs, raw, and the log file names. */
function rawLog(workspace: string): { names: string[]; lines: string[] } {
  const dir = join(workspace, ".magentra", "logs");
  const names = readdirSync(dir);
  const lines = names.flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").filter((l) => l.trim() !== ""));
  return { names, lines };
}

/** The lines, parsed; a line that is not JSON fails the test by name. */
function parsed(workspace: string): LogLine[] {
  return rawLog(workspace).lines.map((line) => {
    try {
      return JSON.parse(line) as LogLine;
    } catch {
      throw new Error(`a log line is not valid JSON: ${line.slice(0, 200)}…`);
    }
  });
}

abstract class LogTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A fresh workspace, made the focused log target. */
  protected focused(): string {
    const workspace = this.tempDir("magentra-log-");
    logging.setLogWorkspace(workspace);
    return workspace;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class OnlySecretsAreHidden extends LogTest {
  readonly id = "token-counts-survive-and-secrets-by-name-or-by-look-do-not";
  readonly whyItExists =
    "`/key|token|secret/i` matched inputTokens, outputTokens and contextTokens, so the field log hid every token figure a reader needed and still looked safe";

  override async run(t: TestRun): Promise<void> {
    const kept = logging.redact({
      type: "turn_finished",
      usage: { inputTokens: 5, outputTokens: 7, cacheRead: 1, cacheWrite: 0 },
      contextTokens: 9,
      maxTokens: 4096,
      keyboard: "us",
    }) as Record<string, unknown>;
    t.assert.deepEqual(kept["usage"], { inputTokens: 5, outputTokens: 7, cacheRead: 1, cacheWrite: 0 }, "token counts are not secrets");
    t.assert.equal(kept["contextTokens"], 9);
    t.assert.equal(kept["maxTokens"], 4096);
    t.assert.equal(kept["keyboard"], "us", "a name that merely contains 'key' is kept");

    const hidden = logging.redact({
      apiKey: "abc",
      api_key: "abc",
      token: "abc",
      password: "abc",
      authorization: "abc",
      headers: [{ "x-api-key": "abc" }, { Authorization: "abc" }],
      sessionToken: "abc",
      env: { OPENAI_API_KEY: "abc" },
      a: { b: { c: { d: { secret: "abc" } } } },
      header: "Bearer abc.def",
      note: "sk-proj-abcdefghijklmnopqrstuvwx",
    });
    const text = JSON.stringify(hidden);
    t.assert.equal(text.includes("abc"), false, `no secret may survive: ${text}`);
    t.assert.equal(text.includes("sk-proj"), false, "a key-shaped value is hidden whatever its key");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class EveryLineIsJson extends LogTest {
  readonly id = "every-line-parses-and-a-shortened-value-says-by-how-much";
  readonly whyItExists =
    "a line cut at 2,048 characters after JSON.stringify is not JSON; 107 lines of the field log could not be parsed, 14 of the 20 task updates among them";

  override async run(t: TestRun): Promise<void> {
    const workspace = this.focused();
    logging.logEvent("engine", { type: "tool_call_started", id: "c1", tool: "Write", input: { content: "x".repeat(50_000), items: Array.from({ length: 300 }, (_, i) => i) } });
    logging.logEvent("engine", {
      type: "question_request",
      id: "q1",
      questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "the first" }, { label: "B", description: "the second" }] }],
    });
    logging.flushLog();

    const lines = parsed(workspace);
    const tool = lines.find((l) => l.data?.["type"] === "tool_call_started");
    const input = tool?.data?.["input"] as { content: string; items: unknown[] };
    t.assert.equal(input.content.endsWith("…[+49000 chars]"), true, "the long string keeps its head and says how much went");
    t.assert.equal(input.items.length, 101);
    t.assert.equal(input.items[100], "…[+200 items]");

    const question = lines.find((l) => l.data?.["type"] === "question_request");
    t.assert.equal(JSON.stringify(question).includes("depth capped"), false, "a question's options are logged, not capped");
    t.assert.match(JSON.stringify(question), /the second/);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class DeltasAreFolded extends LogTest {
  readonly id = "a-thousand-deltas-become-a-few-lines-that-keep-their-count-and-length";
  readonly whyItExists =
    "one line per token wrote 113,000 delta lines in one run, and every tool call, task update and turn end was a needle in that";

  override async run(t: TestRun): Promise<void> {
    const workspace = this.focused();
    const target = { workspace, tabId: "tab1" };
    let chars = 0;
    for (let i = 0; i < 1_000; i++) {
      const text = i % 7 === 0 ? " fjord" : " axolotl";
      chars += text.length;
      logging.logEngineFrame({ type: "thinking_delta", text }, target);
    }
    logging.logEngineFrame({ type: "tool_call_started", id: "c1", tool: "Read", input: {} }, target);
    logging.flushLog();

    const lines = parsed(workspace);
    const runs = lines.filter((l) => l.data?.["type"] === "thinking_delta");
    t.assert.ok(runs.length >= 1 && runs.length <= 3, `1,000 deltas in well under a second are one run or a few, not ${runs.length} lines`);
    t.assert.equal(runs.reduce((n, l) => n + Number(l.data?.["deltas"]), 0), 1_000, "every delta is counted");
    t.assert.equal(runs.reduce((n, l) => n + Number(l.data?.["chars"]), 0), chars, "and every character");
    const order = lines.map((l) => l.data?.["type"]);
    t.assert.equal(order.lastIndexOf("thinking_delta") < order.indexOf("tool_call_started"), true, "the run is written before the frame that ended it");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ToolsAreTimed extends LogTest {
  readonly id = "a-finished-tool-call-carries-how-long-it-ran";
  readonly whyItExists =
    "the field log's tool lines had no duration, so finding the 31-second curl loop meant pairing timestamps by hand across thousands of lines";

  override async run(t: TestRun): Promise<void> {
    const workspace = this.focused();
    const target = { workspace, tabId: "tab1" };
    logging.logEngineFrame({ type: "tool_call_started", id: "c9", tool: "Bash", input: { command: "sleep" } }, target);
    await new Promise((resolve) => setTimeout(resolve, 60));
    logging.logEngineFrame({ type: "tool_call_finished", id: "c9", isError: false, resultPreview: "ok" }, target);
    logging.flushLog();

    const finished = parsed(workspace).find((l) => l.data?.["type"] === "tool_call_finished");
    t.assert.ok(Number(finished?.data?.["durationMs"]) >= 50, `the finished line says how long the call ran: ${JSON.stringify(finished)}`);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ALineLandsInItsTabsLog extends LogTest {
  readonly id = "a-tabs-line-lands-in-its-own-workspace-log-and-nothing-queued-is-lost";
  readonly whyItExists =
    "one currentLogFile meant a background tab's frames were written into the focused workspace's log, with nothing saying which tab — and re-focusing the same workspace emptied the unflushed queue";

  override async run(t: TestRun): Promise<void> {
    const a = this.focused();
    const b = this.tempDir("magentra-log-b-");
    logging.logEngineFrame({ type: "session_list", sessions: [] }, { workspace: b, tabId: "tab2" });
    logging.logEvent("sys", { ev: "queued-before-refocus" });
    logging.setLogWorkspace(a); // the same workspace again
    logging.flushLog();

    const inB = parsed(b);
    t.assert.equal(inB.some((l) => l.data?.["type"] === "session_list" && (l as { tab?: string }).tab === "tab2"), true, "the frame is in its own workspace's log, naming its tab");
    t.assert.equal(parsed(a).some((l) => l.data?.["type"] === "session_list"), false, "and not in the focused one's");
    t.assert.equal(parsed(a).some((l) => l.data?.["ev"] === "queued-before-refocus"), true, "re-focusing the same workspace loses nothing queued");
    t.assert.match(rawLog(a).names[0] ?? "", /^desktop-\d{8}-\d{6}Z\.log$/, "the file name says it is UTC");
  }
}

/* ---- checklist 6 ----------------------------------------------------- */

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

class TheAppRoutesEachTabsLog extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "in-the-app-a-background-tabs-frames-are-in-its-own-workspace-log";
  readonly whyItExists =
    "with two workspaces open, the field build's frames and the other tab's were interleaved in one file, and a line could not be traced to the engine that wrote it";

  #workspace(tag: string): string {
    const dir = this.makeTempDir(`magentra-log-ui-${tag}-`);
    this.writeJsonFile(join(dir, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: `model-${tag}` });
    return dir;
  }

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-log-ui-home-");
    const first = this.#workspace("a");
    const second = this.#workspace("b");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, first);
    await waitForSpawn(first);
    const firstTab = await this.waitFor<string>(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the first tab");
    await openWorkspace(app, second);
    await waitForSpawn(second);
    await this.waitFor(app, `focusedTabId && focusedTabId !== ${JSON.stringify(firstTab)} ? true : null`, "the second tab to take focus");

    // A frame to the BACKGROUND tab's engine, and that engine's answer.
    await app.evaluate(`window.magentra.send({ type: "list_sessions" }, ${JSON.stringify(firstTab)}); true`);
    const deadline = Date.now() + 20_000;
    let reply: LogLine | undefined;
    while (!reply && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      reply = parsed(first).find((l) => l.ch === "engine" && l.data?.["type"] === "session_list" && (l as { tab?: string }).tab === firstTab);
    }
    t.assert.ok(reply, "the background engine's reply is in its own workspace's log, naming its tab");
    t.assert.equal(
      parsed(first).some((l) => l.ch === "ui" && l.data?.["type"] === "list_sessions" && (l as { tab?: string }).tab === firstTab),
      true,
      "and so is the frame written to it",
    );
    t.assert.equal(
      parsed(second).some((l) => (l as { tab?: string }).tab === firstTab),
      false,
      "the focused workspace's log holds nothing of the other tab's",
    );
  }
}

registerFeatureTests(
  new OnlySecretsAreHidden(),
  new EveryLineIsJson(),
  new DeltasAreFolded(),
  new ToolsAreTimed(),
  new ALineLandsInItsTabsLog(),
  new TheAppRoutesEachTabsLog(),
);
