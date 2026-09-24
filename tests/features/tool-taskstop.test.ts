/**
 * `tool-taskstop`.
 *
 * In the 2026-09-23 field test the agent stopped its own game server with
 * `taskkill //IM python.exe`, which stops every Python process on the machine;
 * four seconds later it used TaskStop, the tool that stops only its own job.
 * Since then the Bash description tells the model "To stop a background
 * command, use TaskStop with its task id" and the process-kill guard refuses
 * the kill by name in OVERDRIVE with the same pointer — so TaskStop has to
 * really end the job's process, which nothing pinned.
 *
 * `proc`, as the record declares: the job is a real background Bash command
 * started by the real Bash tool, and "stopped" is proven by its process being
 * gone, not by a status field.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BackgroundManager, type SessionServices, type ToolContext, type ToolResult } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";
import { bashTool, taskStopTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";

const FEATURE = "tool-taskstop";

/** Verbatim from the record. */
const INVARIANT =
  "TaskStop reports whether the task was running, and an unknown or finished id is reported rather than raised as an error to retry.";

/** Whether an OS process with this pid exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

abstract class TaskStopTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  override readonly timeoutMs: number = 60_000;

  protected dir = "";
  protected manager!: BackgroundManager;
  protected session!: SessionServices;
  protected readonly events: CoreEvent[] = [];
  /** Pids a job reported. If TaskStop ever leaves one running, tearDown ends
   *  it — a live child would otherwise hold this test file open forever. */
  protected readonly pids: number[] = [];

  override setUp(): void {
    this.dir = realpathSync.native(mkdtempSync(join(tmpdir(), "magentra-taskstop-")));
    this.manager = new BackgroundManager(join(this.dir, ".magentra"), (e) => this.events.push(e), () => {});
    this.session = strictServices({ background: this.manager });
  }

  override async tearDown(): Promise<void> {
    this.manager.stopAll();
    for (const pid of this.pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }

  protected ctx(): ToolContext {
    return { cwd: this.dir, session: this.session };
  }

  protected async startJob(command: string): Promise<string> {
    const result = await runTool(bashTool, { command, description: "a background job", run_in_background: true }, this.ctx());
    const id = /task id: (\S+?)\./.exec(resultText(result))?.[1];
    if (id === undefined) throw new Error(`Bash did not start a background job: ${resultText(result)}`);
    return id;
  }

  protected stop(taskId: string): Promise<ToolResult> {
    return runTool(taskStopTool, { task_id: taskId }, this.ctx());
  }

  protected async until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/* ---- checklist 1, 4 and 5 --------------------------------------------- */

class ItEndsTheProcess extends TaskStopTest {
  readonly id = "stopping-a-running-job-ends-its-process-and-says-so-and-a-second-stop-reports-it-stopped";
  readonly whyItExists =
    "TaskStop is the tool the model is told to use instead of a kill by name; a TaskStop that marked the job stopped and left its process running would send the model straight back to taskkill";

  override async run(t: TestRun): Promise<void> {
    // node writes its OWN pid, which is the OS pid on every platform (a Git
    // Bash `$$` on Windows is not).
    const node = process.execPath.replace(/\\/g, "/");
    const id = await this.startJob(`"${node}" -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000)"`);
    const pidFile = join(this.dir, "pid.txt");
    await this.until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the job to write its pid");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    this.pids.push(pid);
    t.assert.equal(alive(pid), true, "the job's process is running");

    const first = await this.stop(id);
    t.assert.equal(first.isError, undefined, "stopping a running job is not an error");
    t.assert.equal(resultText(first), `Stopped task ${id}.`, "and it says the job was stopped");
    t.assert.equal(this.manager.get(id)?.status, "stopped");
    await this.until(() => !alive(pid), "the job's process to be gone");
    t.assert.equal(
      this.events.some((e) => e.type === "background_notification" && e.taskId === id && e.kind === "exit" && (e.payload as { stopped?: boolean }).stopped === true),
      true,
      "the frontends are told the job ended, so it does not look alive forever",
    );

    const second = await this.stop(id);
    t.assert.equal(second.isError, true, "a second stop does not stop anything again");
    t.assert.equal(resultText(second), `Task ${id} was not running (status: stopped).`);
  }
}

/* ---- checklist 2 and 3 ------------------------------------------------ */

class FinishedAndUnknown extends TaskStopTest {
  readonly id = "a-finished-or-unknown-id-is-reported-as-a-tool-error-and-never-thrown";
  readonly whyItExists =
    "an exception on an id that already finished made the agent retry a stop that could never succeed";

  override async run(t: TestRun): Promise<void> {
    const id = await this.startJob("echo quick");
    await this.until(() => this.manager.get(id)?.status === "completed", "the quick job to finish");
    const finished = await this.stop(id);
    t.assert.equal(finished.isError, true);
    t.assert.equal(resultText(finished), `Task ${id} was not running (status: completed).`);

    const unknown = await this.stop("monitor_zzz");
    t.assert.equal(unknown.isError, true);
    t.assert.equal(resultText(unknown), "No background task with id monitor_zzz.");
  }
}

registerFeatureTests(new ItEndsTheProcess(), new FinishedAndUnknown());
