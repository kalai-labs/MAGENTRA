/**
 * `hooks`.
 *
 * A project can hang its own shell commands off the agent's lifecycle:
 * SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop. Each one gets
 * the event's JSON payload on stdin. Exit 0 means "here is some context", and
 * its stdout is fed to the model. Exit 2 means BLOCK — and blocking is the
 * whole point: a linter or a policy check whose verdict the agent may ignore
 * is not a gate, it is a comment.
 *
 * `proc`, as the record declares, and it is the only honest kind: every
 * assertion below turns on a real child process and the code it really exited
 * with. A stub that "returned 2" would prove the switch statement and skip the
 * thing that has actually broken here — stdin delivery, a kill on timeout, and
 * a spawn that fails without an exit event at all.
 *
 * THE CHILDREN ARE THE PRODUCT'S, NOT THE KIND'S. `HookRunner` spawns them
 * itself (`spawn(command, { shell: true, cwd })`), so they never pass through
 * `ProcTest.spawn` and its teardown cannot see them. What this file owns
 * instead is the order: every `run()` is awaited before the test ends, the one
 * hook that must be killed is killed by the runner under test, and the temp
 * directories go last — in `tearDown`, with retries, because Windows keeps a
 * handle on a directory for a moment after the process that held it is gone.
 * Each hook command is `node <script>` spawned directly; nothing here goes
 * near `npx`, which is a shell script on this platform and resolves to a
 * different program depending on what is installed.
 *
 * HOME IS REDIRECTED BY HAND in the three tests that boot an Engine. The kind
 * that offers `redirectHome()` is `fs`, and these are not `fs` tests — but
 * `loadSettings(workspace)` merges `~/.magentra/settings.json` OVER the
 * workspace's, so without it a developer's own `permissions` or `hooks` block
 * would decide the result. Saved and restored in `tearDown`, which
 * `registerFeatureTests` runs from a `finally`.
 *
 * WHAT IS FAKED: the model, and only the model (`scriptedEngine.ts`). The
 * Session, the registry, the tools and every hook process are the shipped
 * code, and nothing below asserts on what the scripted provider answered — the
 * assertions are on exit codes, on files that were or were not written, and on
 * what the real Session put into the next request.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookRunner, type HookConfig, type HookOutcome } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "hooks";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT = "Configured hooks run at their event and their outcome reaches the turn.";

/** The variables `os.homedir()` consults, in the order it consults them. */
const HOME_VARS = ["HOME", "USERPROFILE"] as const;

/**
 * A command that never finishes, spelled as each shell can express it.
 *
 * Both forms run INSIDE the shell the runner spawned, with no grandchild: the
 * runner's timeout calls `child.kill()`, which reaches one process, and a
 * grandchild it could not reach would be a process this test leaked onto the
 * machine. `for /l` with a step of 0 never terminates; `exec` replaces the
 * shell with `sleep` so the signal lands on the thing that is waiting.
 */
const NEVER_FINISHES = process.platform === "win32" ? "for /l %i in (0,0,1) do @rem" : "exec sleep 30";

/** A shell command that runs one of this test's own scripts, quoted for both shells. */
function nodeCommand(script: string, ...args: string[]): string {
  return [process.execPath, script, ...args].map((part) => JSON.stringify(part)).join(" ");
}

/** Echoes stdin back, and records on disk that it ran at all. */
const ECHO_SOURCE = `import { appendFileSync } from "node:fs";
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  appendFileSync(process.argv[2], "ran\\n");
  process.stdout.write(stdin);
});
`;

/**
 * Exits 2 — the block convention — with a reason on stderr.
 *
 * `writeSync(2, …)` rather than `process.stderr.write`, because stderr to a
 * pipe is asynchronous and `process.exit()` would discard the buffer holding
 * the very reason the hook exists to report.
 */
const BLOCK_SOURCE = `import { appendFileSync, writeSync } from "node:fs";
appendFileSync(process.argv[2], "ran\\n");
writeSync(2, process.argv[3]);
process.exit(2);
`;

/** Exits 0 with something to say — the context path. */
const CONTEXT_SOURCE = `import { appendFileSync, writeSync } from "node:fs";
appendFileSync(process.argv[2], "ran\\n");
writeSync(1, process.argv[3]);
`;

abstract class HookTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #dirs: string[] = [];
  #savedEnv = new Map<string, string | undefined>();
  #engine: ScriptedEngine | undefined;

  /** A throwaway directory this test owns. Removed in `tearDown`. */
  protected makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /** See the header: `os.homedir()` decides which settings file is merged over the workspace's. */
  protected redirectHome(): void {
    const home = this.makeDir("magentra-hooks-home-");
    for (const name of HOME_VARS) {
      if (!this.#savedEnv.has(name)) this.#savedEnv.set(name, process.env[name]);
      process.env[name] = home;
    }
  }

  /** Write one of the scripts above into `dir` and hand back the shell command that runs it. */
  protected script(dir: string, name: string, source: string, ...args: string[]): string {
    const path = join(dir, name);
    writeFileSync(path, source, "utf8");
    return nodeCommand(path, ...args);
  }

  /** The engine is closed before the directories go — see `tearDown`. */
  protected async startEngine(options: Parameters<typeof startScriptedEngine>[0]): Promise<ScriptedEngine> {
    this.#engine = await startScriptedEngine(options);
    return this.#engine;
  }

  /** How many times a hook script recorded itself as having run. */
  protected timesRun(marker: string): number {
    if (!existsSync(marker)) return 0;
    return readFileSync(marker, "utf8").split("\n").filter((line) => line.trim() !== "").length;
  }

  /**
   * Poll `read` until it returns something, or fail saying what was waited for.
   *
   * A poll and not a pause: a hook is a process, and how long one takes to
   * start is the machine's business. A fixed wait long enough on this laptop
   * is the flake the suite's own README catalogues.
   */
  protected async until<T>(read: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) throw new Error(`waited ${timeoutMs}ms for ${what} and it never happened`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Order matters: the engine stops first (it is what starts hook processes),
   * then the environment goes back, then the directories — the last of which
   * is the step Windows can refuse for a moment after a child has exited, so
   * it retries rather than failing a test whose every assertion had passed.
   */
  override async tearDown(): Promise<void> {
    try {
      await this.#engine?.close();
      this.#engine = undefined;
    } finally {
      for (const [name, value] of this.#savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      this.#savedEnv.clear();
      const dirs = this.#dirs;
      this.#dirs = [];
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ThePayloadArrivesOnStdinAndTheMatcherDecides extends HookTest {
  readonly id = "the-event-payload-reaches-the-hooks-stdin-and-a-matcher-keeps-the-wrong-tool-out";
  readonly whyItExists =
    "the payload was passed as an argument rather than written to stdin, so every documented hook — which reads JSON from stdin — got an empty object and made its decision on nothing";

  override async run(t: TestRun): Promise<void> {
    const dir = this.makeDir("magentra-hooks-");
    const marker = join(dir, "ran.log");
    const command = this.script(dir, "echo.mjs", ECHO_SOURCE, marker);
    const runner = new HookRunner({ cwd: dir, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } });

    t.assert.equal(runner.has("PreToolUse"), true, "the cheap gate must see a hook that is configured");
    t.assert.equal(runner.has("PostToolUse"), false, "and must not see one that is not");

    // The matcher is checked against the tool name, so a Write call never
    // reaches a Bash-only hook.
    const wrongTool = await runner.run("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "a.txt" } });
    t.assert.deepEqual(wrongTool, [], "a non-matching tool must produce no outcome at all");
    t.assert.equal(this.timesRun(marker), 0, "the hook process ran anyway — the matcher is decorative");

    const payload = { hook_event_name: "PreToolUse", session_id: "s1", cwd: dir, tool_name: "Bash", tool_input: { command: "ls -la" } };
    const outcomes = await runner.run("PreToolUse", payload);
    t.assert.equal(outcomes.length, 1, "one matching hook, one outcome");
    t.assert.equal(outcomes[0]?.exitCode, 0);
    t.assert.equal(this.timesRun(marker), 1, "the matching call must run the hook exactly once");

    // What the hook read is what the event carried — the same JSON, not a
    // summary of it and not an empty object.
    t.assert.equal(outcomes[0]?.stdout.trim(), JSON.stringify(payload), "the hook's stdin was not the event payload");

    // A hook with no matcher is the "every tool" case, and it is also the only
    // shape that can work for an event that has no tool name at all.
    const always = new HookRunner({ cwd: dir, hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
    const stop = await always.run("Stop", { hook_event_name: "Stop", session_id: "s1" });
    t.assert.equal(stop.length, 1, "an unmatched entry must run for an event that names no tool");
    t.assert.equal(this.timesRun(marker), 2);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ExitTwoBlocksAndExitZeroIsContext extends HookTest {
  readonly id = "exit-2-is-a-block-with-its-stderr-as-the-reason-and-exit-0-is-context";
  readonly whyItExists =
    "the summary read stdout for everything, so a blocking hook's reason — written to stderr, as the convention requires — arrived empty and the model was told it had been blocked for no stated reason";

  override async run(t: TestRun): Promise<void> {
    const dir = this.makeDir("magentra-hooks-");
    const marker = join(dir, "ran.log");
    const blocks = this.script(dir, "block.mjs", BLOCK_SOURCE, marker, "nope");
    const speaks = this.script(dir, "context.mjs", CONTEXT_SOURCE, marker, "ctx");

    const blocking = new HookRunner({ cwd: dir, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: blocks }] }] } });
    const blocked = await blocking.run("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Bash" });
    t.assert.equal(blocked[0]?.exitCode, 2, "the convention is the exit code, and this is the process's real one");
    const blockSummary = blocking.summarize(blocked);
    t.assert.equal(blockSummary.blocked, true);
    t.assert.equal(blockSummary.blockReason, "nope", "the reason comes from stderr, trimmed");
    t.assert.equal(blockSummary.contextText, "", "a blocked hook contributes nothing to the model's context");

    const talking = new HookRunner({ cwd: dir, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: speaks }] }] } });
    const spoke = await talking.run("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Bash" });
    t.assert.equal(spoke[0]?.exitCode, 0);
    const contextSummary = talking.summarize(spoke);
    t.assert.equal(contextSummary.blocked, false, "exit 0 is not a block — only 2 is");
    t.assert.equal(contextSummary.contextText, "ctx");
    t.assert.equal(contextSummary.blockReason, "");

    // Several hooks on one event: a block anywhere in the list blocks, every
    // reason is kept, and an exit-0 hook alongside still contributes context.
    const both = new HookRunner({
      cwd: dir,
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: speaks }] },
          { hooks: [{ type: "command", command: blocks }] },
          { hooks: [{ type: "command", command: this.script(dir, "block2.mjs", BLOCK_SOURCE, marker, "and also no") }] },
        ],
      },
    });
    const mixed = await both.run("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Bash" });
    t.assert.equal(mixed.length, 3, "every configured hook for the event runs");
    const mixedSummary = both.summarize(mixed);
    t.assert.equal(mixedSummary.blocked, true, "one blocking hook out of three is still a block");
    t.assert.equal(mixedSummary.blockReason, "nope\nand also no", "both reasons reach the model, newline-separated");
    t.assert.equal(mixedSummary.contextText, "ctx", "and the hook that had something to say is still heard");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AHookThatCannotFinishIsNotAllowedToHang extends HookTest {
  readonly id = "a-hook-that-never-exits-is-killed-and-one-that-cannot-be-spawned-reports-127";
  readonly whyItExists =
    "a hook that waited on input nobody would send held the turn open forever, and a mistyped command threw out of the runner and took the whole turn down with it — both of them a user's own configuration stopping the agent dead";

  override async run(t: TestRun): Promise<void> {
    const dir = this.makeDir("magentra-hooks-");

    const runner = new HookRunner({
      cwd: dir,
      hooks: { Stop: [{ hooks: [{ type: "command", command: NEVER_FINISHES }] }] },
      defaultTimeoutMs: 600,
    });
    const started = Date.now();
    const timedOut = await runner.run("Stop", { hook_event_name: "Stop" });
    const elapsed = Date.now() - started;

    t.assert.equal(timedOut[0]?.timedOut, true, "the outcome must say it was killed, not merely that it failed");
    t.assert.equal(timedOut[0]?.exitCode, null, "a killed process has no exit code, and null is how that is spelled");
    t.assert.ok(elapsed >= 600, `the timeout fired after ${elapsed}ms, which is before it was due`);
    t.assert.ok(elapsed < 15_000, `the hook ran ${elapsed}ms — the kill never landed`);

    // A killed hook is not a block. `null` is not 2, and reading it as one
    // would turn a machine under load into a policy refusal.
    const summary = runner.summarize(timedOut);
    t.assert.equal(summary.blocked, false, "a hook that timed out must not be read as a verdict");

    // The per-hook `timeout` is in SECONDS and overrides the default.
    const perHook = new HookRunner({
      cwd: dir,
      hooks: { Stop: [{ hooks: [{ type: "command", command: NEVER_FINISHES, timeout: 1 }] }] },
      defaultTimeoutMs: 600_000,
    });
    const overrideStarted = Date.now();
    const overridden = await perHook.run("Stop", { hook_event_name: "Stop" });
    const overrideElapsed = Date.now() - overrideStarted;
    t.assert.equal(overridden[0]?.timedOut, true, "a per-hook timeout must be honoured over the default");
    t.assert.ok(overrideElapsed >= 1_000, `timeout: 1 means one second, but it fired after ${overrideElapsed}ms — the unit is wrong`);

    // A hook that cannot be spawned at all: there is no exit event for this,
    // only an `error`, and the runner has to answer with an outcome anyway.
    const nowhere = new HookRunner({
      cwd: join(dir, "a-directory-that-does-not-exist"),
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hello" }] }] },
    });
    let threw: unknown;
    let unspawnable: HookOutcome[] = [];
    try {
      unspawnable = await nowhere.run("Stop", { hook_event_name: "Stop" });
    } catch (err) {
      threw = err;
    }
    t.assert.equal(threw, undefined, `the runner threw instead of reporting: ${String(threw)}`);
    t.assert.equal(unspawnable[0]?.exitCode, 127, "a spawn failure is reported as 127, the shell's own code for it");
    t.assert.equal(unspawnable[0]?.timedOut, false);
    t.assert.equal(nowhere.summarize(unspawnable).blocked, false, "a broken hook command must not block the agent");

    // The other way a command can fail to exist: the shell finds nothing to
    // run. The code it returns for that is the platform's, not this repo's —
    // POSIX shells use 127, cmd.exe uses 1 — so what is asserted is the part
    // this repo owns: it resolves, and it is not mistaken for a block.
    const notFound = new HookRunner({ cwd: dir, hooks: { Stop: [{ hooks: [{ type: "command", command: "magentra-no-such-hook-command" }] }] } });
    const missing = await notFound.run("Stop", { hook_event_name: "Stop" });
    t.assert.equal(missing.length, 1);
    t.assert.notEqual(missing[0]?.exitCode, 0, "a command the shell could not find must not read as success");
    t.assert.equal(notFound.summarize(missing).blocked, false);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

/** A hooks block, typed as the settings schema produces one. */
function hooksFor(config: HookConfig): HookConfig {
  return config;
}

class APreToolUseBlockStopsTheCallBeforeItRuns extends HookTest {
  readonly id = "a-pretooluse-hook-exiting-2-stops-the-tool-before-it-runs-and-the-model-is-told-why";
  readonly whyItExists =
    "the hook's verdict was summarized and then dropped — the tool ran anyway and the block reached the model as advice, so a policy check could report a violation and watch the write land regardless";

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.makeDir("magentra-hooks-ws-");
    const marker = join(workspace, "ran.log");
    const target = join(workspace, "src", "policy.ts");

    const engine = await this.startEngine({
      workspace,
      settings: {
        hooks: hooksFor({
          PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: this.script(workspace, "block.mjs", BLOCK_SOURCE, marker, "policy: this file is generated") }] }],
        }),
      },
      turns: [
        { toolCalls: [{ name: "Write", input: { file_path: target, content: "export const x = 1;\n" } }] },
        { text: "the hook refused, so I stopped" },
        { text: "nothing further" },
        { text: "nothing further" },
        { text: "nothing further" },
      ],
    });

    const turn = await engine.runTurn("write the policy file");
    t.assert.deepEqual(turn.errors, [], turn.errors.join(" | "));

    t.assert.equal(this.timesRun(marker), 1, "the hook must run once for the call it guards");

    t.assert.equal(turn.toolResults.length, 1, "the call was still answered — a blocked call is a result, not a silence");
    const result = turn.toolResults[0];
    t.assert.equal(result?.isError, true, "a block must reach the model as an error, or it reads as a successful write");
    t.assert.ok(
      (result?.resultPreview ?? "").startsWith("PreToolUse hook blocked this call:"),
      `the result must name the hook as the cause; it said ${JSON.stringify(result?.resultPreview)}`,
    );
    t.assert.match(result?.resultPreview ?? "", /policy: this file is generated/, "the hook's own reason must survive to the model");

    // The tool never ran: no file, and no `tool_call_started` — the block
    // returns before the Session announces the call at all.
    t.assert.equal(existsSync(target), false, "the Write executed despite the block, which is the whole failure");
    const started = turn.events.filter((e) => e.type === "tool_call_started");
    t.assert.deepEqual(started, [], "a blocked call must never be announced as started");

    // And the permission engine was never consulted, because the hook sits
    // ahead of it: nothing asked, and nothing was allowed by a rule either.
    const asked = turn.events.filter((e) => e.type === "permission_request");
    t.assert.deepEqual(asked, [], "the block must come before the permission check, not instead of the tool's execute");

    // The model really received it, in the tool_result block of the next request.
    const results = engine.provider.requests
      .flatMap((request) => request.messages)
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result");
    t.assert.ok(
      results.some((block) => JSON.stringify(block).includes("PreToolUse hook blocked this call")),
      "the blocked result never made it into a request, so the model was never told",
    );
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AStopBlockSendsTheModelBackToWork extends HookTest {
  readonly id = "a-stop-hook-exiting-2-pushes-its-reason-and-buys-one-more-model-turn";
  readonly whyItExists =
    "a blocked Stop hook ended the turn anyway, so the one hook whose entire job is 'you are not finished' was the one hook that could not keep the agent working";

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.makeDir("magentra-hooks-ws-");
    const marker = join(workspace, "ran.log");

    const engine = await this.startEngine({
      workspace,
      settings: {
        hooks: hooksFor({
          Stop: [{ hooks: [{ type: "command", command: this.script(workspace, "block.mjs", BLOCK_SOURCE, marker, "finish tests") }] }],
        }),
      },
      turns: [
        { text: "all done" },
        { text: "tests run and pass" },
        { text: "nothing further" },
        { text: "nothing further" },
      ],
    });

    const turn = await engine.runTurn("do the work");
    t.assert.deepEqual(turn.errors, [], turn.errors.join(" | "));
    t.assert.equal(turn.stopReason, "end_turn", "the turn still has to end — the hook buys one more round, not a loop");
    t.assert.equal(this.timesRun(marker), 1, "the Stop hook fires once per turn, or a blocked turn could never end");

    // One more model call than the script's first turn: the hook is what
    // bought it.
    t.assert.equal(engine.provider.requests.length, 2, "the block must send the model back for another turn");

    // The reason is in the history the second call was made on. `messages` is
    // the live array, so this reads what is in it rather than trusting an
    // index — the push is a user message carrying the hook's own words.
    const pushed = engine.provider.requests[1]?.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    t.assert.ok(
      (pushed ?? []).some((text) => text.includes("Stop hook: finish tests")),
      `the hook's reason never reached the model; the user turns were ${JSON.stringify(pushed)}`,
    );
  }
}

class ASessionStartHooksOutputBecomesContext extends HookTest {
  readonly id = "a-sessionstart-hooks-stdout-becomes-a-system-reminder-the-model-sees";
  readonly whyItExists =
    "SessionStart's stdout was summarized and discarded, so the one hook meant to tell the agent about the project at boot — branch, ticket, house rules — said its piece into nothing";

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.makeDir("magentra-hooks-ws-");
    const marker = join(workspace, "ran.log");
    const note = "PROJECT NOTE: this repo deploys on Fridays";

    const engine = await this.startEngine({
      workspace,
      settings: {
        hooks: hooksFor({
          SessionStart: [{ hooks: [{ type: "command", command: this.script(workspace, "context.mjs", CONTEXT_SOURCE, marker, note) }] }],
        }),
      },
      turns: [{ text: "understood" }, { text: "nothing further" }, { text: "nothing further" }],
    });

    const started = await engine.waitFor(
      (event): event is Extract<CoreEvent, { type: "session_started" }> => event.type === "session_started",
    );
    const transcript = join(workspace, ".magentra", "sessions", `${started.sessionId}.jsonl`);

    // The hook is launched at boot and its output lands whenever the process
    // finishes, so the turn below must not race it. The transcript is where
    // `addContextMessage` writes, and it is written synchronously — so the
    // line appearing there is the moment the context message exists.
    await this.until(
      () => (existsSync(transcript) && readFileSync(transcript, "utf8").includes(note) ? true : undefined),
      "the SessionStart hook's output to be added to the session",
    );
    t.assert.equal(this.timesRun(marker), 1, "the hook runs once, at session start");

    const turn = await engine.runTurn("hello");
    t.assert.deepEqual(turn.errors, [], turn.errors.join(" | "));

    const texts = engine.provider.requests[0]?.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    const carried = (texts ?? []).find((text) => text.includes(note));
    t.assert.ok(carried !== undefined, `the note never reached the model; the first request carried ${JSON.stringify(texts)}`);
    t.assert.equal(
      carried?.includes(`<system-reminder>${note}</system-reminder>`),
      true,
      "the hook's words must be wrapped as a reminder, or the model reads them as something the user said",
    );
  }
}

registerFeatureTests(
  new ThePayloadArrivesOnStdinAndTheMatcherDecides(),
  new ExitTwoBlocksAndExitZeroIsContext(),
  new AHookThatCannotFinishIsNotAllowedToHang(),
  new APreToolUseBlockStopsTheCallBeforeItRuns(),
  new AStopBlockSendsTheModelBackToWork(),
  new ASessionStartHooksOutputBecomesContext(),
);
