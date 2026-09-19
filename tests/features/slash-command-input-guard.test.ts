/**
 * `slash-command-input-guard`.
 *
 * A `slash_command` frame must carry a string `command` and, optionally, a
 * single string `args`. The engine checks that before dispatching: a
 * malformed frame — `args` sent as an array, `command` as a number — becomes
 * one readable, non-fatal `error` event naming the received types and the
 * fix, instead of a raw `TypeError` from inside whichever handler ran first.
 *
 * `fs`, and the record said `pure`: the guard sits in `Engine.send`, so it is
 * exercised on a running Engine in a workspace directory. Frames below are
 * built deliberately malformed and cast past the wire type, exactly as a
 * buggy frontend would produce them. Re-declared 2026-09-19.
 */

import type { CoreEvent, FrontendRequest } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "slash-command-input-guard";

/** Verbatim from the record. */
const INVARIANT = "Slash-command input is validated before dispatch.";

type ErrorEvent = Extract<CoreEvent, { type: "error" }>;
type Output = Extract<CoreEvent, { type: "command_output" }>;

abstract class GuardTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  protected async engine(): Promise<ScriptedEngine> {
    this.redirectHome();
    this.#engine = await startScriptedEngine({ workspace: this.tempDir("magentra-guard-"), turns: [] });
    return this.#engine;
  }

  /** A frame the wire type would refuse to spell — the shape a buggy frontend sends. */
  protected malformed(frame: Record<string, unknown>): FrontendRequest {
    return frame as unknown as FrontendRequest;
  }

  /** Prove the engine is still alive: /help answers. */
  protected async helpStillWorks(engine: ScriptedEngine, t: TestRun): Promise<Output> {
    engine.send({ type: "slash_command", command: "/help" });
    const help = await engine.waitFor((e): e is Output => e.type === "command_output" && e.text.startsWith("Built-in commands:"));
    t.assert.ok(help.text.includes("/help"), "the engine dispatched the next well-formed frame");
    return help;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ArrayArgsAreRefusedReadably extends GuardTest {
  readonly id = "array-args-produce-one-non-fatal-error-naming-the-types-and-no-command-output";
  readonly whyItExists = "a frontend that sent CLI-style array args surfaced as 'args?.trim is not a function' from deep inside the settings handler, which told the user nothing about the fix";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send(this.malformed({ type: "slash_command", command: "/help", args: ["a", "b"] }));
    const error = await engine.waitFor((e): e is ErrorEvent => e.type === "error" && e.message.includes("slash_command"));
    t.assert.equal(error.fatal, false, "the frame is refused, the engine is not");
    t.assert.ok(error.message.includes("requires a string command"), error.message);
    t.assert.ok(error.message.includes("args: array"), "the received type is named");
    t.assert.ok(error.message.includes("Join multiple arguments into one space-separated string"), "and the fix");
    t.assert.equal(error.message.includes("TypeError"), false, "no raw TypeError leaks");

    // Nothing was dispatched: the only command_output that ever appears is the
    // one a later, well-formed /help produces.
    await this.helpStillWorks(engine, t);
    const outputs = engine.events.filter((e): e is Output => e.type === "command_output");
    t.assert.equal(outputs.length, 1, "the malformed frame produced no command_output of its own");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ANumericCommandIsRefusedWithoutCrashing extends GuardTest {
  readonly id = "a-numeric-command-produces-the-same-shaped-error-and-the-engine-loop-survives";
  readonly whyItExists = "a non-string command reached `command.replace` and threw out of the dispatcher, ending the engine's event loop for the whole session";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send(this.malformed({ type: "slash_command", command: 42 }));
    const error = await engine.waitFor((e): e is ErrorEvent => e.type === "error" && e.message.includes("slash_command"));
    t.assert.equal(error.fatal, false);
    t.assert.ok(error.message.includes("command: number"), error.message);
    t.assert.ok(error.message.includes("args: undefined"), "an absent args is reported as such, not as an error of its own");
    await this.helpStillWorks(engine, t);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AWellFormedCommandWithoutArgsDispatches extends GuardTest {
  readonly id = "a-string-command-with-no-args-dispatches-normally";
  readonly whyItExists = "a guard that treated absent args as malformed would have refused every bare command the palette sends";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    const help = await this.helpStillWorks(engine, t);
    t.assert.ok(help.text.includes("/settings"), "the real help text came back");
    t.assert.equal(engine.events.some((e) => e.type === "error" && e.message.includes("slash_command")), false, "no guard error for a well-formed frame");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AStringArgsReachesTheHandlerIntact extends GuardTest {
  readonly id = "a-string-args-reaches-the-settings-handler-intact";
  readonly whyItExists = "a guard that split or trimmed args itself changed what the handler received, so a value with a space was set to its first word";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send({ type: "slash_command", command: "/settings", args: "model some model name" });
    const out = await engine.waitFor((e): e is Output => e.type === "command_output" && e.text.startsWith("Set model"));
    t.assert.ok(out.text.startsWith('Set model = "some model name"'), `the whole args string reached handleSettings: ${out.text}`);
    t.assert.equal(engine.settings.model, "some model name", "and was applied");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheGuardIsPerFrame extends GuardTest {
  readonly id = "after-a-refused-frame-the-next-well-formed-one-is-processed";
  readonly whyItExists = "a guard implemented as a sticky 'malformed' state would have needed a restart after one bad frame, which is the failure it replaced";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send(this.malformed({ type: "slash_command", command: ["/help"] }));
    await engine.waitFor((e): e is ErrorEvent => e.type === "error" && e.message.includes("command: object"));
    engine.send(this.malformed({ type: "slash_command", command: "/help", args: 7 }));
    await engine.waitFor((e): e is ErrorEvent => e.type === "error" && e.message.includes("args: number"));
    engine.send({ type: "slash_command", command: "/tasks" });
    const tasks = await engine.waitFor((e): e is Output => e.type === "command_output" && e.text === "No tasks.");
    t.assert.equal(tasks.text, "No tasks.", "two refusals later, a well-formed frame still dispatches");
    t.assert.equal(engine.events.filter((e) => e.type === "error" && e.message.includes("slash_command")).length, 2, "one error per bad frame, no more");
  }
}

registerFeatureTests(new ArrayArgsAreRefusedReadably(), new ANumericCommandIsRefusedWithoutCrashing(), new AWellFormedCommandWithoutArgsDispatches(), new AStringArgsReachesTheHandlerIntact(), new TheGuardIsPerFrame());
