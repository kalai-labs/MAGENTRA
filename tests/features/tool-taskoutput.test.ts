/**
 * `tool-taskoutput`.
 *
 * TaskOutput is how the agent collects a background Agent's report or checks
 * on a long command without reading the output file by hand — and since the
 * 2026-09-23 field test it is the tool the Bash description names for keeping
 * a wait short: "check its job between tries (TaskOutput with block: false
 * shows whether it is still running)". That sentence is only true if
 * block:false returns at once with the job's status, which nothing pinned.
 *
 * `proc`, as the record declares: the job is a real background Bash command,
 * started by the real Bash tool into the real BackgroundManager, and TaskOutput
 * reads the file that command writes. Nothing stands in for either side.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BackgroundManager, type SessionServices, type ToolContext, type ToolResult } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";
import { bashTool, taskOutputTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";

const FEATURE = "tool-taskoutput";

/** Verbatim from the record. */
const INVARIANT = "block:true waits for finish or timeout; block:false returns whatever output exists right now.";

abstract class TaskOutputTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  override readonly timeoutMs: number = 60_000;

  protected dir = "";
  protected manager!: BackgroundManager;
  protected session!: SessionServices;
  protected readonly events: CoreEvent[] = [];

  override setUp(): void {
    // Resolved: macOS's tmpdir is a symlink, and the shell reports the real path.
    this.dir = realpathSync.native(mkdtempSync(join(tmpdir(), "magentra-taskout-")));
    this.manager = new BackgroundManager(join(this.dir, ".magentra"), (e) => this.events.push(e), () => {});
    // The background path of Bash and both task tools reach only this service.
    this.session = strictServices({ background: this.manager });
  }

  /** Every job is stopped before its folder goes: a live shell holds its cwd on Windows. */
  override async tearDown(): Promise<void> {
    this.manager.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }

  protected ctx(): ToolContext {
    return { cwd: this.dir, session: this.session };
  }

  /** Start `command` with the real Bash tool in the background; its task id. */
  protected async startJob(command: string): Promise<string> {
    const result = await runTool(bashTool, { command, description: "a background job", run_in_background: true }, this.ctx());
    const id = /task id: (\S+?)\./.exec(resultText(result))?.[1];
    if (id === undefined) throw new Error(`Bash did not start a background job: ${resultText(result)}`);
    return id;
  }

  protected output(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    return runTool(taskOutputTool, input, this.ctx(), signal);
  }

  /** Poll until `check` holds — a condition on the real job, never a fixed sleep. */
  protected async until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/* ---- checklist 1 and 3 ------------------------------------------------ */

class NowAndAtTheEnd extends TaskOutputTest {
  readonly id = "block-false-returns-what-is-there-now-and-block-true-waits-for-the-exit";
  readonly whyItExists =
    "the Bash description tells the model to check a background job between tries with TaskOutput block:false; if that call waited, or hid the status, a wait on a dead server would still spin unnoticed";

  override async run(t: TestRun): Promise<void> {
    const id = await this.startJob("printf 'partial\\n'; sleep 1; printf 'done\\n'");
    const file = this.manager.get(id)!.outputFile;
    await this.until(() => existsSync(file) && readFileSync(file, "utf8").includes("partial"), "the job's first line");

    const now = resultText(await this.output({ task_id: id, block: false }));
    t.assert.equal(now.split("\n")[0], `Task ${id} [running]:`, "block:false says the job is still running");
    t.assert.match(now, /partial/, "and returns the output that exists right now");
    t.assert.doesNotMatch(now, /done/, "without waiting for the rest");

    const end = resultText(await this.output({ task_id: id, block: true, timeout: 20_000 }));
    t.assert.equal(end.split("\n")[0], `Task ${id} [completed, exit 0]:`, "block:true waits for the job to finish and says how it ended");
    t.assert.match(end, /partial\s+done/, "and returns all of its output");
  }
}

/* ---- checklist 2 and 5 ------------------------------------------------ */

class ItGivesUp extends TaskOutputTest {
  readonly id = "a-blocking-read-gives-up-at-its-timeout-or-on-an-abort-and-says-the-job-still-runs";
  readonly whyItExists =
    "a blocking read that ignored its timeout, or the user's Esc, would hold the whole turn hostage to a job that runs for minutes";

  override async run(t: TestRun): Promise<void> {
    const id = await this.startJob("sleep 8; true");

    const started = Date.now();
    const timedOut = resultText(await this.output({ task_id: id, block: true, timeout: 300 }));
    t.assert.ok(Date.now() - started >= 250, "it waited for its timeout");
    t.assert.equal(timedOut.split("\n")[0], `Task ${id} [running]:`, "and returned with the job still running, not at its exit");
    t.assert.match(timedOut, /\(no output yet\)/, "an empty output file reads as no output yet");

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 150);
    const aborted = resultText(await this.output({ task_id: id, block: true, timeout: 30_000 }, abort.signal));
    t.assert.equal(aborted.split("\n")[0], `Task ${id} [running]:`, "an abort ends the wait long before the 30 s timeout or the job's exit");
  }
}

/* ---- checklist 4 ------------------------------------------------------ */

class AnUnknownId extends TaskOutputTest {
  readonly id = "an-unknown-id-is-a-tool-error-not-an-exception";
  readonly whyItExists =
    "a thrown exception on a mistyped id reaches the model as a crash to retry, where a plain error tells it the id is wrong";

  override async run(t: TestRun): Promise<void> {
    const result = await this.output({ task_id: "bash_nope", block: false });
    t.assert.equal(result.isError, true);
    t.assert.equal(resultText(result), "No background task with id bash_nope.");
  }
}

registerFeatureTests(new NowAndAtTheEnd(), new ItGivesUp(), new AnUnknownId());
