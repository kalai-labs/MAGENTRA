/**
 * `a-tool-call-shows-while-it-is-written`.
 *
 * Field run 2026-09-24/25 (MiMo-V2.6-Pro): gaps of up to 22 minutes with
 * nothing on screen and a frozen token counter while the model wrote tool
 * calls — then each tool ran in milliseconds and its row read "0s". With the
 * lost reasoning (`reasoning-goes-back-to-the-model`) this is the owner's main
 * complaint: all the time seems to go into reasoning and every step after it
 * takes none. A tool call is written as part of the model's response and runs
 * only once the whole response is in, so the writing — often the longest part
 * of a Write — happened where no frame could show it.
 *
 * `fs` + `net` + `ui`, as the record declares. `fs` reads the frames the real
 * engine emits on the scripted provider; `net` runs the real engine on a real
 * OpenAICompatProvider against a 127.0.0.1 endpoint that streams one call's
 * arguments slowly, the only way to prove the writing time is measured rather
 * than stamped; `ui` delivers the frames through the real IPC channel and reads
 * the row the page draws.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CoreEvent } from "@magentra/protocol";
import { OpenAICompatProvider } from "@magentra/providers";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { NetTest } from "../lib/netTest.ts";
import { startEngineOn, startScriptedEngine, type EngineDriver, type ScriptedEngine } from "../lib/scriptedEngine.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "a-tool-call-shows-while-it-is-written";

/** Verbatim from the record. */
const INVARIANT =
  "From the moment the model starts writing a tool call the desktop shows its row, and the time the row shows counts the writing as well as the run.";

type Streaming = Extract<CoreEvent, { type: "tool_call_streaming" }>;
type Started = Extract<CoreEvent, { type: "tool_call_started" }>;

const indexOf = (events: readonly CoreEvent[], pred: (e: CoreEvent) => boolean): number => events.findIndex(pred);
const isStreaming = (id: string) => (e: CoreEvent): boolean => e.type === "tool_call_streaming" && e.id === id;
const isStarted = (id: string) => (e: CoreEvent): boolean => e.type === "tool_call_started" && e.id === id;

/* ---- checklist 1 ----------------------------------------------------- */

class EachCallIsAnnouncedWhileWritten extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "each-call-is-announced-while-written-before-it-starts";
  readonly whyItExists =
    "a tool call was invisible until the whole response was in: the minutes the model spent writing it showed as nothing at all, and the call then read 0s";
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    this.#engine = await startScriptedEngine({
      workspace: this.tempDir("magentra-writing-"),
      turns: [
        { toolCalls: [{ id: "c1", name: "Glob", input: { pattern: "*.nothing" } }, { id: "c2", name: "Glob", input: { pattern: "*.none" } }] },
        { text: "done" },
      ],
    });
    const turn = await this.#engine.runTurn("look around");
    t.assert.deepEqual([...turn.errors], []);

    for (const id of ["c1", "c2"]) {
      const streaming = indexOf(turn.events, isStreaming(id));
      const started = indexOf(turn.events, isStarted(id));
      t.assert.notEqual(streaming, -1, `call ${id} is announced while it is written`);
      t.assert.ok(started > streaming, `and only starts after that (${streaming} → ${started})`);
      const first = turn.events[streaming] as Streaming;
      t.assert.equal(first.tool, "Glob", "the announcement names the tool");
      t.assert.equal(first.argChars, 0, "the first announcement comes before any argument has arrived");
      t.assert.equal(typeof first.at, "number", "and carries the engine's time");
      const start = turn.events[started] as Started;
      t.assert.equal(typeof start.writingMs, "number", `call ${id}'s start carries how long it took to write`);
      t.assert.ok(start.writingMs! >= 0, "a duration, never negative");
    }
    t.assert.ok(
      indexOf(turn.events, isStreaming("c1")) < indexOf(turn.events, isStreaming("c2")),
      "the calls are announced in the order the model writes them",
    );
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheCounterMovesWhileACallIsWritten extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-output-counter-moves-while-a-long-call-is-written";
  readonly whyItExists =
    "the live output counter counted reasoning and prose only, so while the model wrote a long file into a tool call the counter stood still for minutes and the app looked frozen";
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-writing-counter-");
    // Prose, not code: a code file would add the runtime-evidence rung's extra call.
    const content = "The crypt has three floors.\n".repeat(800);
    this.#engine = await startScriptedEngine({
      workspace,
      turns: [{ toolCalls: [{ id: "w1", name: "Write", input: { file_path: join(workspace, "notes.md"), content } }] }, { text: "written" }],
    });
    const turn = await this.#engine.runTurn("write the notes");
    t.assert.deepEqual([...turn.errors], []);

    const streaming = indexOf(turn.events, isStreaming("w1"));
    const started = indexOf(turn.events, isStarted("w1"));
    t.assert.ok(streaming !== -1 && started > streaming, "the Write is announced while written, then starts");
    const during = turn.events
      .slice(streaming, started)
      .filter((e): e is Extract<CoreEvent, { type: "context_update" }> => e.type === "context_update" && typeof e.outputTokens === "number");
    t.assert.ok(during.length > 0, "a live counter update arrives while the call is being written");
    // ~22k characters of arguments: thousands of tokens, where reasoning and prose alone are zero.
    t.assert.ok(Math.max(...during.map((e) => e.outputTokens!)) >= 2_000, `and it counts the arguments (${during.map((e) => e.outputTokens).join(", ")})`);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ASubagentsCallStaysOnItsCard extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-subagents-call-being-written-stays-off-the-top-level-stream";
  readonly whyItExists =
    "the child-event filter passes unknown frames through untouched, so a subagent's call being written would have been drawn untagged in the main console, as if the top-level agent were making it";
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    this.#engine = await startScriptedEngine({
      workspace: this.tempDir("magentra-writing-child-"),
      turns: [
        { toolCalls: [{ id: "a1", name: "Agent", input: { description: "probe the tree", prompt: "Report what you find.", subagent_type: "explore" } }] },
        { toolCalls: [{ id: "child_glob", name: "Glob", input: { pattern: "*.none" } }] },
        { text: "nothing there" },
        { text: "done" },
      ],
    });
    const turn = await this.#engine.runTurn("delegate a look");
    t.assert.deepEqual([...turn.errors], []);

    const childStart = turn.events.find((e) => e.type === "tool_call_started" && e.id === "child_glob") as Started | undefined;
    t.assert.equal(childStart?.subagent, true, "the child's call still reaches the stream, tagged as a subagent's");
    t.assert.equal(indexOf(turn.events, isStreaming("child_glob")), -1, "but its writing is not announced at the top level");
    t.assert.notEqual(indexOf(turn.events, isStreaming("a1")), -1, "while the top-level Agent call's writing is");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

const SSE_HEADERS = { "content-type": "text/event-stream" };
const data = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`;
const ARG_PIECES = ['{"pat', 'tern":', '"*.m', 'd"}'];
const PIECE_GAP_MS = 350;

class TheWritingTimeIsMeasured extends NetTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-call-whose-arguments-stream-slowly-reports-that-writing-time";
  readonly whyItExists =
    "a Write that took minutes to compose was timed from the moment it ran, so the row said 0s — the writing time has to be measured by the engine as the arguments arrive, not assumed";
  override readonly timeoutMs: number = 60_000;

  #engine: EngineDriver | undefined;
  #dirs: string[] = [];
  #savedEnv = new Map<string, string | undefined>();

  /** loadSettings merges ~/.magentra/settings.json: the developer's own must not reach the engine. */
  #isolateHome(): void {
    const home = mkdtempSync(join(tmpdir(), "magentra-writing-home-"));
    this.#dirs.push(home);
    for (const name of ["HOME", "USERPROFILE"]) {
      this.#savedEnv.set(name, process.env[name]);
      process.env[name] = home;
    }
  }

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
    for (const [name, value] of this.#savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true });
  }

  override async run(t: TestRun): Promise<void> {
    this.#isolateHome();
    let call = 0;
    const server = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 200, json: { data: [] } };
      call += 1;
      if (call > 1) {
        return {
          status: 200,
          headers: SSE_HEADERS,
          text:
            data({ choices: [{ delta: { content: "none here" } }] }) +
            data({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 60, completion_tokens: 3 } }) +
            "data: [DONE]\n\n",
        };
      }
      // The call's name arrives first, then its arguments trickle in — a slow
      // model writing a long call, in miniature.
      return {
        status: 200,
        headers: SSE_HEADERS,
        chunks: [
          { text: data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "slow_glob", function: { name: "Glob", arguments: "" } }] } }] }) },
          ...ARG_PIECES.map((piece) => ({
            afterMs: PIECE_GAP_MS,
            text: data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] }),
          })),
          { text: data({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 12 } }) + "data: [DONE]\n\n" },
        ],
      };
    });

    const workspace = mkdtempSync(join(tmpdir(), "magentra-writing-net-"));
    this.#dirs.push(workspace);
    this.#engine = await startEngineOn(new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 }), {
      workspace,
      settings: { model: "m" },
    });
    const turn = await this.#engine.runTurn("find the markdown files");
    t.assert.deepEqual([...turn.errors], [], "the turn ran clean");

    const announced = turn.events.filter((e): e is Streaming => e.type === "tool_call_streaming" && e.id === "slow_glob");
    const startedAt = indexOf(turn.events, isStarted("slow_glob"));
    t.assert.ok(announced.length > 0 && indexOf(turn.events, isStreaming("slow_glob")) < startedAt, "announced while written, before it starts");
    // The arguments took ≥ 4 × 350 ms: long enough for a re-announcement with the characters so far.
    t.assert.ok(announced.some((e) => e.argChars > 0), `a later announcement reports the characters so far (${announced.map((e) => e.argChars).join(", ")})`);
    const start = turn.events[startedAt] as Started;
    const floor = (ARG_PIECES.length - 1) * PIECE_GAP_MS;
    t.assert.ok(
      typeof start.writingMs === "number" && start.writingMs >= floor,
      `the call's writing time covers the arguments' arrival — at least ${floor} ms, got ${start.writingMs}`,
    );
  }
}

/* ---- checklist 5 and 6 (ui) ----------------------------------------- */

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

abstract class WritingRowTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A launched app on a scripted workspace, and a way to hand its tab frames. */
  protected async openTab(): Promise<{ send: (frames: object[]) => Promise<void>; app: Parameters<typeof openWorkspace>[0] }> {
    const home = this.makeTempDir("magentra-writing-ui-home-");
    const workspace = this.makeTempDir("magentra-writing-ui-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "model-one" });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    const tabId = await this.waitFor<string>(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the tab id");
    const send = async (frames: object[]): Promise<void> => {
      const stamped = frames.map((f) => ({ ...f, tabId }));
      await app.evaluateInMain(`for (const f of ${JSON.stringify(stamped)}) win.webContents.send("engine:event", f); return true;`);
    };
    return { send, app };
  }
}

class TheRowAppearsWhileWritten extends WritingRowTest {
  readonly id = "a-row-appears-while-written-and-its-time-counts-the-writing";
  readonly whyItExists =
    "the row for a Write appeared only when it ran and read 0s, after minutes in which the console showed nothing — the user read that as all the work happening in the reasoning";

  override async run(t: TestRun): Promise<void> {
    const { send, app } = await this.openTab();
    const now = Date.now();
    await send([
      { type: "turn_started", turnId: "t_1", at: now - 200_000 },
      { type: "tool_call_streaming", id: "call_w", tool: "Write", argChars: 0, at: now - 150_000 },
      { type: "tool_call_streaming", id: "call_w", tool: "Write", argChars: 3_200, at: now - 100_000 },
    ]);
    const writing = await this.waitFor<{ rows: number; running: boolean; desc: string }>(
      app,
      `(() => {
        const rows = [...document.querySelectorAll(".tool-row")];
        const row = rows.pop();
        if (!row || !row.querySelector(".tool-desc")?.textContent.includes("3.2k")) return null;
        return { rows: rows.length + 1, running: row.classList.contains("running"), desc: row.querySelector(".tool-desc").textContent };
      })()`,
      "the row of the call being written",
    );
    t.assert.equal(writing.rows, 1, "one row, drawn while the call is written");
    t.assert.equal(writing.running, true, "and it is live");
    t.assert.match(writing.desc, /writing · 3\.2k chars/, `it says it is being written, and how far — "${writing.desc}"`);

    // Two minutes of writing (the engine's own measure), then a ten-second run.
    await send([
      { type: "tool_call_started", id: "call_w", tool: "Write", input: { file_path: "/crypt/GameWorld.py", content: "class GameWorld: pass" }, writingMs: 120_000, at: now - 30_000 },
      { type: "tool_call_finished", id: "call_w", tool: "Write", resultPreview: "wrote 1 line", isError: false, at: now - 20_000 },
    ]);
    const done = await this.waitFor<{ rows: number; time: string; title: string; desc: string }>(
      app,
      `(() => {
        const rows = [...document.querySelectorAll(".tool-row")];
        const row = rows[rows.length - 1];
        if (!row || !row.classList.contains("ok")) return null;
        const time = row.querySelector(".tool-time");
        return { rows: rows.length, time: time.textContent, title: time.title, desc: row.querySelector(".tool-desc").textContent };
      })()`,
      "the finished row",
    );
    t.assert.equal(done.rows, 1, "the start turned the same row into the call — no second row");
    t.assert.equal(done.time, "2m10s", "two minutes of writing plus a ten-second run — not the run alone");
    t.assert.equal(done.title, "written in 2m00s · ran in 10s", "the tooltip splits the two");
    t.assert.match(done.desc, /GameWorld\.py/, "and the row now names what the call did");
  }
}

class ARowNeverSentStopsRunning extends WritingRowTest {
  readonly id = "a-row-whose-call-never-started-stops-running-at-turn-end";
  readonly whyItExists =
    "a call the model was still writing when the stream dropped never gets a start, and its row would have ticked on as 'running' long after the turn was over";

  override async run(t: TestRun): Promise<void> {
    const { send, app } = await this.openTab();
    const now = Date.now();
    await send([
      { type: "turn_started", turnId: "t_1", at: now - 60_000 },
      { type: "tool_call_streaming", id: "call_lost", tool: "Write", argChars: 0, at: now - 40_000 },
      { type: "turn_finished", turnId: "t_1", stopReason: "error", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 0, at: now - 5_000 },
    ]);
    const row = await this.waitFor<{ running: boolean; notRun: boolean; desc: string; group: string }>(
      app,
      `(() => {
        const row = [...document.querySelectorAll(".tool-row")].pop();
        const group = [...document.querySelectorAll(".work-group.done .work-group-label")].pop();
        if (!row || !group) return null;
        return { running: row.classList.contains("running"), notRun: row.classList.contains("not-run"), desc: row.querySelector(".tool-desc").textContent, group: group.textContent };
      })()`,
      "the row after the turn ended",
    );
    t.assert.equal(row.running, false, "it no longer runs once the turn is over");
    t.assert.equal(row.notRun, true, "it is marked as never run");
    t.assert.match(row.desc, /not run/, `and says so — "${row.desc}"`);
    t.assert.match(row.group, /· 0 ops ·/, `a call that never ran is not counted as work done — "${row.group}"`);
  }
}

class AReusedIdStartsItsOwnRow extends WritingRowTest {
  readonly id = "a-call-id-reused-by-a-later-reply-gets-a-row-of-its-own";
  readonly whyItExists =
    "some local servers number every reply's calls from call_0; a later reply's call written under a used id would have been folded into the earlier, finished row instead of being shown";

  override async run(t: TestRun): Promise<void> {
    const { send, app } = await this.openTab();
    const now = Date.now();
    await send([
      { type: "turn_started", turnId: "t_1", at: now - 90_000 },
      { type: "tool_call_streaming", id: "call_0", tool: "Glob", argChars: 0, at: now - 80_000 },
      { type: "tool_call_started", id: "call_0", tool: "Glob", input: { pattern: "*.md" }, writingMs: 2_000, at: now - 78_000 },
      { type: "tool_call_finished", id: "call_0", tool: "Glob", resultPreview: "README.md", isError: false, at: now - 77_000 },
      // The next reply's first call, under the same id.
      { type: "tool_call_streaming", id: "call_0", tool: "Read", argChars: 0, at: now - 60_000 },
    ]);
    const rows = await this.waitFor<{ count: number; firstOk: boolean; lastWriting: boolean }>(
      app,
      `(() => {
        const rows = [...document.querySelectorAll(".tool-row")];
        if (rows.length < 2) return null;
        return { count: rows.length, firstOk: rows[0].classList.contains("ok"), lastWriting: rows[1].classList.contains("writing") };
      })()`,
      "a second row for the reused id",
    );
    t.assert.equal(rows.count, 2, "the later call has a row of its own");
    t.assert.equal(rows.firstOk, true, "the earlier call's row keeps its result");
    t.assert.equal(rows.lastWriting, true, "and the new row shows the call being written");

    await send([{ type: "tool_call_started", id: "call_0", tool: "Read", input: { file_path: "README.md" }, writingMs: 1_000, at: now - 58_000 }]);
    const after = await this.waitFor<{ count: number; name: string }>(
      app,
      `(() => {
        const rows = [...document.querySelectorAll(".tool-row")];
        const last = rows[rows.length - 1];
        if (!last || last.classList.contains("writing")) return null;
        return { count: rows.length, name: last.querySelector(".tool-name").textContent };
      })()`,
      "the reused id's call started",
    );
    t.assert.equal(after.count, 2, "its start turns the new row into the call — no third row");
    t.assert.equal(after.name, "Read", "the row is the new call's");
  }
}

registerFeatureTests(
  new EachCallIsAnnouncedWhileWritten(),
  new TheCounterMovesWhileACallIsWritten(),
  new ASubagentsCallStaysOnItsCard(),
  new TheWritingTimeIsMeasured(),
  new TheRowAppearsWhileWritten(),
  new ARowNeverSentStopsRunning(),
  new AReusedIdStartsItsOwnRow(),
);
