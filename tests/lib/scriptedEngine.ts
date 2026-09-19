/**
 * A real Engine in THIS process, on a scripted provider — the fixture for the
 * kinds that prove a tool or a turn-loop rung by what it leaves on disk or
 * emits, rather than by what crosses the stdio wire.
 *
 * WHY IN-PROCESS AND NOT THE CHILD HARNESS. `engineHarness.ts` exists for the
 * wire: a feature whose subject is a frame (`set_connection`) has to be proved
 * through the real NDJSON loop. A tool's behaviour is not a frame. The Read
 * tool refusing an image, the Write tool landing bytes, the evidence floor
 * pushing a reminder — each is observable in the events the Engine emits and
 * in the requests the provider receives, and spawning a child to reach them
 * buys nothing but a slower test and a script that cannot carry tool calls
 * (the child harness's provider answers text only). `LlmTest` already boots
 * the engine in-process for the same reason; this is the same shape with the
 * one double the suite allows in place of the model.
 *
 * WHAT IS FAKED, AND ONLY THAT. `FakeProvider` is the repo's own scripted
 * provider — `EngineOptions.provider` exists so a test can hand one in. It
 * plays the turns it is given, in order, and RECORDS every request the real
 * Session sends it, so a test can read what the model was actually told (a
 * pushed reminder, a tool result) instead of inferring it. Everything else is
 * the shipped code: the real Engine, Session, PermissionEngine, registry and
 * tools, on a real workspace directory, writing real state files.
 *
 * NEVER ASSERT THAT THE FAKE SAID WHAT IT WAS TOLD TO SAY. A test of a tool
 * asserts on the TOOL's result (`tool_call_finished`, the file on disk, the
 * `tool_result` block in the next request); the scripted text is only there to
 * end the turn. tests/README rule 4 and decisions/0009 are about exactly this.
 *
 * TWO SETTINGS THE FIXTURE PINS, so a script can be read as the sequence of
 * model calls it will really consume:
 *
 *   clarify: false      — the clarify pre-layer is an EXTRA model call before
 *                         the first real one (Session.maybeClarify), and a
 *                         script written for a tool would be consumed by it.
 *                         A test about the pre-layer switches it back on.
 *   contextWindow       — a connection the wizard wrote always has one; without
 *                         it the engine emits a warning `error` frame at boot
 *                         that is about the fixture, not the feature.
 *
 * THE MODEL-CALL SEQUENCE A SCRIPT MUST COVER. Session.runTurn is a ladder of
 * finishing rungs, and several of them cost another model call before the
 * turn is allowed to end. Read the rung comments in session.ts before writing
 * a script; the ones a plain tool test meets are:
 *
 *   - a tool batch with an error  → ERROR_BATCH_REMINDER on the next request,
 *                                    and if the model then ends the turn,
 *                                    one recovery nudge (another call)
 *   - a successful Write/Edit of a CODE file with no Bash run → the runtime
 *                                    evidence reminder (another call)
 *   - pending tasks at end_turn   → the incomplete-tasks nudge (another call)
 *   - ≥5 tool calls and a short final text → the wrap-up nudge (another call)
 *
 * A script that runs out is loud: FakeProvider throws "script exhausted", the
 * turn ends with an `error` event and stopReason "error", and {@link runTurn}
 * reports both. That is the right failure — a test that did not know how many
 * calls its turn makes did not understand the feature it is testing.
 *
 * ONE EVENT CONSUMER. `Engine.events` is single-consumer by contract (the
 * AsyncQueue hands each event to whichever waiter asked first), so this file
 * owns the one drain loop and collects into {@link ScriptedEngine.events}. A
 * permission request is answered from INSIDE that loop, in the same tick it
 * arrives, when the test asked for that — never from a timer.
 *
 * HOME IS THE CALLER'S JOB. `loadSettings(workspace)` merges the developer's
 * own `~/.magentra/settings.json` under the workspace's; a test that does not
 * redirect `HOME`/`USERPROFILE` first (FsTest.redirectHome) reads whatever
 * endpoint this machine is configured for. This helper does not touch the
 * environment, because putting it back is the kind's teardown, not this file's.
 *
 * REQUIRES `npm run build`: the engine is imported through its package entry
 * points, which resolve to each package's gitignored `dist/`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { Engine, loadSettings, type Addon, type Settings } from "@magentra/core";
import type { CoreEvent, FrontendRequest, PermissionDecision } from "@magentra/protocol";
import { FakeProvider, type FakeTurn } from "@magentra/providers";
import { createDefaultRegistry } from "@magentra/tools";

import { repoRoot } from "./inventory.ts";

export type { FakeTurn, FakeToolCall } from "@magentra/providers";

/** Long enough for a tool round that spawns a shell; short enough to fail a hung turn inside the kind's own timeout. */
const TURN_TIMEOUT_MS = 45_000;

export interface ScriptedEngineOptions {
  /** The workspace the engine runs on. A temp directory the test owns. */
  readonly workspace: string;
  /** The provider's script, one entry per model call, in order. */
  readonly turns: readonly FakeTurn[];
  /** Overlaid on the settings loaded from the workspace (and the fixture's two pins). */
  readonly settings?: Partial<Settings>;
  /**
   * The addon roster the engine starts with — `EngineOptions.addons`, passed
   * through untouched. Omit it and the engine has none (the option is absent,
   * as it is for an embedder that never loads any); pass `loadAddons(workspace)`
   * to get what the host would load, built-ins included.
   */
  readonly addons?: Addon[];
  /**
   * Answer every `permission_request` with this decision, in the tick it
   * arrives — the frontend's role, played by the test. Omit it and the test
   * reads the request from {@link ScriptedEngine.events} and answers itself,
   * which is what a test ABOUT the prompt does.
   */
  readonly permissions?: PermissionDecision;
}

/** What one `runTurn` produced. */
export interface TurnOutcome {
  /** Every event from this turn's `turn_started` to its `turn_finished`, inclusive. */
  readonly events: readonly CoreEvent[];
  readonly stopReason: string;
  /** `tool_call_finished` events of this turn, in order — the tools' own account of what they did. */
  readonly toolResults: readonly Extract<CoreEvent, { type: "tool_call_finished" }>[];
  /** `command_output` texts of this turn — where the finishing rungs announce themselves. */
  readonly notes: readonly string[];
  /** `error` frames of this turn. A script that ran out lands here. */
  readonly errors: readonly string[];
}

export interface ScriptedEngine {
  readonly engine: Engine;
  /** The scripted provider — `provider.requests` is what the real Session sent the model. */
  readonly provider: FakeProvider;
  readonly workspace: string;
  /** Everything emitted so far, in order. Live; copy it across an `await`. */
  readonly events: readonly CoreEvent[];
  /** The resolved settings the engine was built on. */
  readonly settings: Settings;
  send(request: FrontendRequest): void;
  /** One user turn, start to finish. */
  runTurn(text: string, timeoutMs?: number): Promise<TurnOutcome>;
  /** The next event satisfying `predicate` that has not been handed out by a previous `waitFor`. */
  waitFor<T extends CoreEvent>(predicate: (event: CoreEvent) => event is T, timeoutMs?: number): Promise<T>;
  waitFor(predicate: (event: CoreEvent) => boolean, timeoutMs?: number): Promise<CoreEvent>;
  /** Stop what the engine started, close the queue, let the drain loop end. Idempotent. */
  close(): Promise<void>;
}

/** Fails loudly when the engine has not been built — the same message the other harnesses give. */
function requireBuiltEngine(): void {
  const built = join(repoRoot(), "engine", "core", "dist", "index.js");
  if (!existsSync(built)) {
    throw new Error(
      `engine/core/dist/index.js does not exist, so the engine cannot be constructed. Run \`npm run build\` — ` +
        `this fixture runs the built engine, which is what the desktop app spawns, and dist/ is gitignored.`,
    );
  }
}

export async function startScriptedEngine(opts: ScriptedEngineOptions): Promise<ScriptedEngine> {
  requireBuiltEngine();

  const loaded = loadSettings(opts.workspace).settings;
  const settings: Settings = {
    ...loaded,
    clarify: false,
    contextWindow: 200_000,
    ...opts.settings,
  };

  const provider = new FakeProvider([...opts.turns]);
  const engine = new Engine({
    cwd: opts.workspace,
    settings,
    provider,
    registry: createDefaultRegistry(),
    ...(opts.addons !== undefined ? { addons: opts.addons } : {}),
  });

  const events: CoreEvent[] = [];
  const waiters = new Set<() => void>();
  const wakeAll = (): void => {
    const pending = [...waiters];
    waiters.clear();
    for (const wake of pending) wake();
  };

  // Point 3 of the header: the ONE consumer, opened here and nowhere else.
  const draining = (async () => {
    for await (const event of engine.events) {
      events.push(event);
      if (opts.permissions !== undefined && event.type === "permission_request") {
        engine.send({ type: "permission_response", id: event.id, decision: opts.permissions });
      }
      wakeAll();
    }
    wakeAll();
  })();

  let closed = false;
  /** Index of the first event no `waitFor` has consumed yet. */
  let cursor = 0;

  const waitFor = async (predicate: (event: CoreEvent) => boolean, timeoutMs = TURN_TIMEOUT_MS): Promise<CoreEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (cursor < events.length) {
        const event = events[cursor]!;
        cursor += 1;
        if (predicate(event)) return event;
      }
      if (closed) throw new Error("the engine was closed before the awaited event arrived");
      const left = deadline - Date.now();
      if (left <= 0) {
        const tail = events.slice(-6).map((e) => e.type).join(", ");
        throw new Error(`waited ${timeoutMs}ms for an engine event that never came; the last events were: ${tail || "none"}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve();
        }, Math.min(left, 250));
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        waiters.add(wake);
      });
    }
  };

  const scripted: ScriptedEngine = {
    engine,
    provider,
    workspace: opts.workspace,
    events,
    settings,
    send: (request) => engine.send(request),
    runTurn: async (text, timeoutMs = TURN_TIMEOUT_MS) => {
      const from = events.length;
      engine.send({ type: "user_message", text });
      const finished = await waitFor((e) => e.type === "turn_finished", timeoutMs);
      const turn = events.slice(from);
      const started = turn.findIndex((e) => e.type === "turn_started");
      const slice = started === -1 ? turn : turn.slice(started);
      return {
        events: slice,
        stopReason: finished.type === "turn_finished" ? finished.stopReason : "unknown",
        toolResults: slice.filter((e): e is Extract<CoreEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished"),
        notes: slice.filter((e) => e.type === "command_output").map((e) => (e.type === "command_output" ? e.text : "")),
        errors: slice.filter((e) => e.type === "error").map((e) => (e.type === "error" ? e.message : "")),
      };
    },
    waitFor: waitFor as ScriptedEngine["waitFor"],
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        engine.stopBackgroundJobs();
      } finally {
        engine.events.close();
        await draining;
      }
    },
  };

  engine.start();
  return scripted;
}
