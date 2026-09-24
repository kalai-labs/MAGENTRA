/**
 * `durations-come-from-the-engine-clock`.
 *
 * Field test 2026-09-23, findings R-2, U-03, U-04, U-05. Once the renderer had
 * fallen behind (T01), every duration on screen was wrong: 7 s for a
 * two-minute task, 16 s for a seventeen-minute one, and a turn timer standing
 * at 26:53. Each was `Date.now()` at the moment the renderer HANDLED a frame,
 * and no engine frame carried a time — while the main-process log had every
 * update at the right moment.
 *
 * `fs` + `ui`, as the record declares. `fs` reads the stamps the real engine
 * and its real task store write; `ui` delivers frames LATE through the real
 * IPC channel — engine times in the past, handled now — and reads the durations
 * the page shows.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TaskStore } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "durations-come-from-the-engine-clock";

/** Verbatim from the record. */
const INVARIANT =
  "A task, tool or turn duration is the engine's own measurement, so a frame delivered late shows the same duration as one delivered at once.";

/* ---- checklist 1 ----------------------------------------------------- */

class TheEngineStampsItsFrames extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "turn-and-tool-frames-carry-the-engines-time-in-order";
  readonly whyItExists =
    "no engine frame carried a time, so a frontend could only time work by when it happened to handle a frame — minutes late, after the field run's backlog";
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    this.#engine = await startScriptedEngine({
      workspace: this.tempDir("magentra-clock-"),
      turns: [
        { toolCalls: [{ id: "c1", name: "Glob", input: { pattern: "*.nothing" } }, { id: "c2", name: "Glob", input: { pattern: "*.none" } }] },
        { text: "done" },
      ],
    });
    const before = Date.now();
    const turn = await this.#engine.runTurn("look around");
    const after = Date.now();
    t.assert.deepEqual([...turn.errors], []);

    const stamped = turn.events.filter(
      (e): e is Extract<CoreEvent, { type: "turn_started" | "tool_call_started" | "tool_call_finished" | "turn_finished" }> =>
        e.type === "turn_started" || e.type === "tool_call_started" || e.type === "tool_call_finished" || e.type === "turn_finished",
    );
    t.assert.equal(stamped.length, 6, "one turn start, two starts, two finishes and one turn end");
    for (const e of stamped) {
      t.assert.equal(typeof e.at, "number", `${e.type} carries the engine's time`);
      t.assert.ok(e.at! >= before && e.at! <= after, `${e.type}.at lies inside the turn's own span`);
    }
    // The turn's start comes first and its end last. Between them each call's
    // finish is its OWN time, so two parallel calls may finish in either order
    // — only start ≤ finish holds per call.
    const turnStart = stamped.find((e) => e.type === "turn_started")!.at!;
    const turnEnd = stamped.find((e) => e.type === "turn_finished")!.at!;
    for (const e of stamped) {
      t.assert.ok(e.at! >= turnStart, `${e.type} is not stamped before the turn started`);
      t.assert.ok(e.at! <= turnEnd, `${e.type} is not stamped after the turn ended`);
    }
    for (const id of ["c1", "c2"]) {
      const start = stamped.find((e) => e.type === "tool_call_started" && e.id === id)!;
      const end = stamped.find((e) => e.type === "tool_call_finished" && e.id === id)!;
      t.assert.ok(end.at! >= start.at!, `call ${id} finishes after it starts`);
    }
  }
}

/* ---- a call's end is sent when the call ends ------------------------- */

class EachCallFinishesOnItsOwn extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-calls-finished-frame-goes-out-when-it-finishes-not-when-its-batch-does";
  readonly whyItExists =
    "every tool_call_finished of a batch was held until the whole batch ended, so a fast Read beside a long Bash showed 'running' on screen, and its logged duration stretched to the batch's end";
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    // The slow call comes FIRST in the batch: a batch-end flush would send the
    // frames in call order, the slow one's end ahead of the fast one's.
    this.#engine = await startScriptedEngine({
      workspace: this.tempDir("magentra-clock-batch-"),
      turns: [
        {
          toolCalls: [
            { id: "slow", name: "Bash", input: { command: "sleep 0.5 && echo slept", description: "wait a moment", run_in_background: false } },
            { id: "fast", name: "Glob", input: { pattern: "*.nothing" } },
          ],
        },
        { text: "done" },
      ],
    });
    const turn = await this.#engine.runTurn("wait and look");
    t.assert.deepEqual([...turn.errors], []);
    const ends = turn.events.filter((e): e is Extract<CoreEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished");
    t.assert.deepEqual(ends.map((e) => e.id), ["fast", "slow"], "the fast call's end goes out first, while the slow call is still running");
    const fast = ends.find((e) => e.id === "fast")!;
    const slow = ends.find((e) => e.id === "slow")!;
    t.assert.ok(slow.at! - fast.at! >= 300, `the fast call's stamp is its own finish, not the batch's (${fast.at} vs ${slow.at})`);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheTaskStoreKeepsTheTimes extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-task-keeps-when-it-started-and-finished-and-a-resume-keeps-them-too";
  readonly whyItExists =
    "a task's duration existed only in the renderer's memory, measured on arrival — so it was wrong after a backlog and gone after a resume";

  override async run(t: TestRun): Promise<void> {
    const stateDir = join(this.tempDir("magentra-tasks-"), ".magentra");
    const store = new TaskStore(stateDir, "s_clock", () => {});
    const worked = store.create({ subject: "build the rooms", description: "d" });
    const skipped = store.create({ subject: "tidy", description: "d" });

    const t0 = Date.now();
    store.update(worked.id, { status: "in_progress" });
    const started = store.get(worked.id)!.startedAt;
    t.assert.ok(typeof started === "number" && started >= t0, "in_progress stamps startedAt");
    await new Promise((resolve) => setTimeout(resolve, 30));
    store.update(worked.id, { status: "in_progress" });
    t.assert.equal(store.get(worked.id)!.startedAt, started, "a repeated in_progress keeps the first start");
    store.update(worked.id, { status: "completed" });
    const done = store.get(worked.id)!.completedAt;
    t.assert.ok(typeof done === "number" && done - started! >= 25, "completed stamps completedAt, after the start");

    store.update(skipped.id, { status: "completed" });
    t.assert.equal(store.get(skipped.id)!.startedAt, undefined, "a task nobody saw run gets no invented start");

    // What a resume reads back: the same file, a new store.
    const reloaded = new TaskStore(stateDir, "s_clock", () => {});
    t.assert.equal(reloaded.get(worked.id)!.startedAt, started, "the start survives a reload from disk");
    t.assert.equal(reloaded.get(worked.id)!.completedAt, done, "and so does the end");
    const onDisk = JSON.parse(readFileSync(join(stateDir, "tasks", "s_clock.json"), "utf8")) as { tasks: { startedAt?: number }[] };
    t.assert.equal(onDisk.tasks[0]?.startedAt, started, "because they are written into the task file");

    reloaded.update(worked.id, { status: "in_progress" });
    t.assert.equal(reloaded.get(worked.id)!.completedAt, undefined, "reopening a task clears its end");
    t.assert.equal(reloaded.get(worked.id)!.startedAt, started, "and keeps its start");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

class LateFramesShowTheRealDurations extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "frames-delivered-late-show-the-engines-durations-not-the-delivery-gap";
  readonly whyItExists =
    "behind a backlog the rail showed 7 s for a two-minute task and 16 s for a seventeen-minute one, and the turn timer stood at 26:53 — every figure was the time the frame was handled";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-clock-ui-home-");
    const workspace = this.makeTempDir("magentra-clock-ui-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "model-one" });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    const tabId = await this.waitFor<string>(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the tab id");

    // Everything below happened in the past on the engine's clock and is
    // delivered now, in one burst — the field run's situation.
    const now = Date.now();
    // Half a minute clear of a minute boundary: the page reads its own clock,
    // which may lag this process's by a few milliseconds.
    const turnAt = now - (26 * 60 + 30) * 1_000;
    const frames = [
      { type: "turn_started", turnId: "t_1", at: turnAt },
      // The task's two flips, both handled now: the field run's 7-seconds-for-two-minutes.
      {
        type: "task_list_updated",
        tasks: [{ id: "1", subject: "Build the rooms", description: "d", status: "in_progress", blocks: [], blockedBy: [], startedAt: now - 120_000 }],
      },
      {
        type: "task_list_updated",
        tasks: [{ id: "1", subject: "Build the rooms", description: "d", status: "completed", blocks: [], blockedBy: [], startedAt: now - 120_000, completedAt: now - 5_000 }],
      },
      { type: "tool_call_started", id: "call_9", tool: "Bash", input: { command: "python bot.py" }, at: now - 40_000 },
      { type: "tool_call_finished", id: "call_9", tool: "Bash", resultPreview: "ok", isError: false, at: now - 10_000 },
    ].map((f) => ({ ...f, tabId }));
    await app.evaluateInMain(`for (const f of ${JSON.stringify(frames)}) win.webContents.send("engine:event", f); return true;`);

    const shown = await this.waitFor<{ task: string; tool: string; timer: string }>(
      app,
      `(() => {
        const tool = [...document.querySelectorAll(".tool-row")].pop();
        if (!tool || !tool.classList.contains("ok")) return null;
        const task = document.querySelector("#taskList .task-item .t-time");
        return { task: task ? task.textContent : "", tool: tool.querySelector(".tool-time")?.textContent || "", timer: nowTimerEl.textContent };
      })()`,
      "the rail, the tool row and the timer",
    );
    t.assert.equal(shown.task, "1m55s", "the task ran from 120 s ago to 5 s ago — its duration, not the delivery gap");
    t.assert.equal(shown.tool, "30s", "the call started 40 s ago and finished 10 s ago");
    t.assert.match(shown.timer, /^26:[23]\d$/, `the turn began 26½ minutes ago, so the timer reads 26:3x, not 0:00 — it read "${shown.timer}"`);

    // The turn ended 5 s ago on the engine's clock, and its end is handled now.
    // The work group spans its first call's start to the turn's end: 35 s.
    await app.evaluateInMain(`win.webContents.send("engine:event", ${JSON.stringify({
      type: "turn_finished",
      turnId: "t_1",
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 0,
      at: now - 5_000,
      tabId,
    })}); return true;`);
    const group = await this.waitFor<string>(
      app,
      `(() => { const g = [...document.querySelectorAll(".work-group.done .work-group-label")].pop(); return g ? g.textContent : null; })()`,
      "the closed work group",
    );
    t.assert.equal(group, "Agent worked · 1 op · 35s", "the group's time is the engine's span, not the moment its end was handled");

    // Another session in this tab reuses task id 1, and its task went from
    // pending straight to completed: the engine gives it no start, so it shows
    // no duration — never its end minus the earlier session's start.
    await app.evaluateInMain(`win.webContents.send("engine:event", ${JSON.stringify({
      type: "task_list_updated",
      tasks: [{ id: "1", subject: "Tidy up", description: "d", status: "completed", blocks: [], blockedBy: [], completedAt: now - 1_000 }],
      tabId,
    })}); return true;`);
    const reused = await this.waitFor<string>(
      app,
      `(() => { const item = document.querySelector("#taskList .task-item"); return item && item.textContent.includes("Tidy up") ? item.querySelector(".t-time").textContent : null; })()`,
      "the reused task id on the rail",
    );
    t.assert.equal(reused, "", "a task the engine never saw start carries no borrowed start");
  }
}

registerFeatureTests(new TheEngineStampsItsFrames(), new EachCallFinishesOnItsOwn(), new TheTaskStoreKeepsTheTimes(), new LateFramesShowTheRealDurations());
