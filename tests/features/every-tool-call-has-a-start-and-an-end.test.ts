/**
 * `every-tool-call-has-a-start-and-an-end`.
 *
 * Field test 2026-09-23, finding E-02. Four ways a call is refused before it
 * can run — the tool is switched off, the tool does not exist, its arguments
 * were cut off mid-JSON, its input fails the schema — and one more found in
 * review (the permission engine refuses it: a deny rule, a declined card, the
 * OVERDRIVE kill refusal) each sent a
 * `tool_call_finished` with no `tool_call_started` before it. A frontend keys
 * its rows on the start frame, so the refused call simply vanished from the
 * console while the model read its error.
 *
 * `fs`: the real Engine on the scripted provider over a real workspace. A tool
 * is switched off the way an operator does it — an EMPTY override file in the
 * prompts directory, which `isToolDisabled` reads.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "every-tool-call-has-a-start-and-an-end";

/** Verbatim from the record. */
const INVARIANT =
  "Every tool_call_finished is preceded by a tool_call_started for the same call, including the calls refused before they run.";

class RefusedCallsStillStart extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-call-refused-before-it-runs-still-starts-before-it-finishes";
  readonly whyItExists =
    "a switched-off, unknown, cut-off, schema-invalid or permission-denied call sent only a finished frame, so the desktop drew no row for it and the call vanished from the console — an OVERDRIVE kill refusal among them";
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const prompts = this.tempDir("magentra-prompts-");
    this.setEnv("MAGENTRA_PROMPTS_DIR", prompts);
    writeFileSync(join(prompts, "tool.Glob.txt"), ""); // empty override: Glob is switched off

    this.#engine = await startScriptedEngine({
      workspace: this.tempDir("magentra-pairs-"),
      // A deny rule turns one call away at the permission engine.
      settings: { permissions: { allow: [], deny: ["Bash(echo refused)"], allowExact: [] } },
      turns: [
        {
          toolCalls: [
            { id: "off", name: "Glob", input: { pattern: "*.ts" } },
            { id: "unknown", name: "NoSuchTool", input: {} },
            { id: "cutoff", name: "Read", input: null, json: '{"file_path": "C:/tmp/a' },
            { id: "invalid", name: "Read", input: {} },
            { id: "denied", name: "Bash", input: { command: "echo refused", description: "refused by a rule", run_in_background: false } },
          ],
        },
        // Enough answers for the finishing rungs an all-error batch sets off; the
        // assertions are about frames, not about how many rounds were spent.
        ...Array.from({ length: 8 }, () => ({ text: "done" })),
      ],
    });
    const turn = await this.#engine.runTurn("try some tools");
    t.assert.deepEqual([...turn.errors], []);

    const frames = turn.events.filter(
      (e): e is Extract<CoreEvent, { type: "tool_call_started" | "tool_call_finished" }> =>
        e.type === "tool_call_started" || e.type === "tool_call_finished",
    );
    for (const id of ["off", "unknown", "cutoff", "invalid", "denied"]) {
      const started = frames.findIndex((e) => e.type === "tool_call_started" && e.id === id);
      const finished = frames.findIndex((e) => e.type === "tool_call_finished" && e.id === id);
      t.assert.notEqual(started, -1, `the ${id} call has a tool_call_started`);
      t.assert.ok(finished > started, `and it comes before the ${id} call's tool_call_finished`);
      const end = frames[finished] as Extract<CoreEvent, { type: "tool_call_finished" }>;
      t.assert.equal(end.isError, true, `the ${id} call is reported as refused`);
    }
  }
}

registerFeatureTests(new RefusedCallsStillStart());
