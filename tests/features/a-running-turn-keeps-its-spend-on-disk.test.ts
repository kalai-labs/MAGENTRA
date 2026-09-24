/**
 * `a-running-turn-keeps-its-spend-on-disk`.
 *
 * Field test 2026-09-23, finding E-06: the session ledger reached the
 * transcript only when a turn ended. The field turn ran 56 minutes; a crash
 * at minute 55 would have lost every token of it.
 *
 * `fs`: the real Engine on the scripted provider, over a real workspace. The
 * turn is held in the middle the way a real one is — on a permission card no
 * one has answered yet — and the transcript is read off the disk while it
 * waits, which is exactly what a crash at that moment would leave behind.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "a-running-turn-keeps-its-spend-on-disk";

/** Verbatim from the record. */
const INVARIANT = "The spend of the model calls a turn has already made is on disk while the turn is still running.";

/** Output tokens banked in the latest meta record of a transcript file, or undefined when there is none. */
function bankedOutput(file: string): number | undefined {
  const metas = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes('"kind":"meta"'))
    .map((line) => JSON.parse(line) as { data: { stats?: { byModel?: Record<string, { outputTokens: number }> } } });
  const last = metas.at(-1)?.data.stats?.byModel;
  return last === undefined ? undefined : Object.values(last).reduce((n, u) => n + u.outputTokens, 0);
}

class TheSpendIsOnDiskMidTurn extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-turn-held-on-a-prompt-already-has-its-first-calls-spend-in-the-transcript";
  readonly whyItExists =
    "the ledger was written only in the turn's finally block, so a crash during the field run's 56-minute turn would have lost all of its token data";
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-spend-");
    this.#engine = await startScriptedEngine({
      workspace,
      turns: [
        {
          toolCalls: [{ id: "rm1", name: "Bash", input: { command: "rm -f nothing.txt", description: "tidy", run_in_background: false } }],
          usage: { outputTokens: 1_234 },
        },
        { text: "done", usage: { outputTokens: 66 } },
      ],
    });
    const engine = this.#engine;
    engine.send({ type: "user_message", text: "tidy up" });
    const card = await engine.waitFor((e): e is Extract<CoreEvent, { type: "permission_request" }> => e.type === "permission_request");

    const started = engine.events.find((e): e is Extract<CoreEvent, { type: "session_started" }> => e.type === "session_started");
    const file = join(workspace, ".magentra", "sessions", `${started!.sessionId}.jsonl`);
    t.assert.equal(bankedOutput(file), 1_234, "while the turn waits, the first call's spend is already in the transcript");

    engine.send({ type: "permission_response", id: card.id, decision: "deny" });
    await engine.waitFor((e) => e.type === "turn_finished");
    await engine.engine.idle();
    t.assert.equal(bankedOutput(file), 1_300, "and at the turn's end the last record counts both calls");
  }
}

registerFeatureTests(new TheSpendIsOnDiskMidTurn());
