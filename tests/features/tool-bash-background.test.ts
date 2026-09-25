/**
 * `tool-bash-background`.
 *
 * `run_in_background` hands the command to the BackgroundManager: the call
 * returns a task id at once, the output streams to a file, and the exit is
 * announced twice — a `background_notification` for the frontends and a
 * `<task-notification>` reminder the model reads with its next tool results.
 * Nothing tested any of it (FIX-PLAN T12, E-03); this pins the lifecycle as it
 * is, before anything about waiting on a job changes.
 *
 * `proc`: the real Engine on the scripted provider, and the Bash tool spawning
 * a real shell in a real workspace.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CoreEvent } from "@magentra/protocol";
import type { Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "tool-bash-background";

/** Verbatim from the record. */
const INVARIANT =
  "run_in_background returns a task id immediately, streams output to a file, and fires a notification when the command exits.";

class TheLifecycle extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-background-command-returns-its-id-at-once-writes-its-output-file-and-announces-its-exit";
  readonly whyItExists =
    "in the field run a server died at 18:44:17 and the model polled it for 31 s; nothing proved when the exit reaches the model, or that the start, the output file and the exit notice exist at all";
  override readonly timeoutMs: number = 90_000;

  #engine: ScriptedEngine | undefined;
  #dirs: string[] = [];
  #savedEnv = new Map<string, string | undefined>();

  override setUp(): void {
    const home = this.#dir("magentra-bg-home-");
    for (const name of ["HOME", "USERPROFILE"] as const) {
      this.#savedEnv.set(name, process.env[name]);
      process.env[name] = home;
    }
  }

  #dir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /** Engine first: its shells hold the workspace as their cwd on Windows. */
  override async tearDown(): Promise<void> {
    try {
      await this.#engine?.close();
    } finally {
      for (const [name, value] of this.#savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      for (const dir of this.#dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }

  override async run(t: TestRun): Promise<void> {
    this.#engine = await startScriptedEngine({
      workspace: this.#dir("magentra-bg-ws-"),
      turns: [
        { toolCalls: [{ id: "bg", name: "Bash", input: { command: "echo started && sleep 1 && echo finished && exit 3", description: "a short job", run_in_background: true } }] },
        { toolCalls: [{ id: "wait", name: "Bash", input: { command: "sleep 3; echo waited", description: "wait a moment", run_in_background: false } }] },
        { text: "done" },
      ],
    });
    const turn = await this.#engine.runTurn("start the job");
    t.assert.deepEqual([...turn.errors], []);

    const events = turn.events;
    const started = events.findIndex((e) => e.type === "background_notification" && e.kind === "start");
    const result = events.findIndex((e) => e.type === "tool_call_finished" && e.id === "bg");
    const exited = events.findIndex((e) => e.type === "background_notification" && e.kind === "exit");
    t.assert.ok(started !== -1 && started < result, "the start is announced before the call returns");
    t.assert.ok(result !== -1 && result < exited, "the call returns BEFORE the command exits — at once, with its id");

    const preview = (events[result] as Extract<CoreEvent, { type: "tool_call_finished" }>).resultPreview;
    const id = /task id: (\S+?)\./.exec(preview)?.[1];
    t.assert.ok(id, `the result names the task id: ${preview}`);
    const exit = events[exited] as Extract<CoreEvent, { type: "background_notification" }>;
    t.assert.equal(exit.taskId, id, "the exit is the same task's");
    const payload = exit.payload as { code: number; outputFile: string };
    t.assert.equal(payload.code, 3, "with its exit code");
    t.assert.equal(existsSync(payload.outputFile), true, "the output file exists");
    const output = readFileSync(payload.outputFile, "utf8");
    t.assert.match(output, /started[\s\S]*finished/, `and holds what the command printed: ${JSON.stringify(output)}`);

    // The model hears of the exit with the results of the round it happened in.
    const history = (this.#engine.provider.requests.at(-1)?.messages ?? []) as readonly Msg[];
    const carried = history
      .filter((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"))
      .map((m) => JSON.stringify(m.content));
    t.assert.equal(carried[0]?.includes("<task-notification>"), false, "not before it exited");
    t.assert.match(carried[1] ?? "", new RegExp(`task-notification>Background bash task ${id}[^<]*exit code 3`), "and then with the next round's results");
  }
}

registerFeatureTests(new TheLifecycle());
