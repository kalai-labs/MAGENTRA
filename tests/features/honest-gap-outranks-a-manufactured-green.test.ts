/**
 * `honest-gap-outranks-a-manufactured-green`.
 *
 * A finishing rung reminds, it never blocks: when the model answers the
 * runtime-evidence rung by naming what could not be run and what stays
 * unverified, the turn ends on that answer. A rung that came back for more
 * would make standing the dependency in the cheapest way to satisfy it, and the
 * agent would then watch its own assumption agree with itself. The manufactured
 * green is the exact failure the floor exists to catch.
 *
 * `fs`: one real Engine on a scripted provider runs the turn.
 *
 * WHAT THE RUNG SAYS IS NOT ASSERTED HERE. Its wording lives in brain/ and the
 * owner rewords it freely (decided 2026-10-04: no test pins prompt prose). The
 * reminder is found in the history by a stretch of its own shipped template
 * (`promptDefault`), so a rewording moves the locator with it.
 *
 * Nothing here asserts that the scripted provider returned what it was told to
 * return: the assertions are about the events the real Engine emitted and the
 * history the real Session built.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promptDefault } from "@magentra/protocol";
import type { CoreEvent } from "@magentra/protocol";
import type { Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "honest-gap-outranks-a-manufactured-green";

/** Verbatim from the record. */
const INVARIANT =
  "Naming what could not be run and what stays unverified is a FULLY correct ending — the rung must never manufacture a green.";

/** The longest slot-free stretch of the runtime-evidence rung's shipped text: present verbatim in every render of it. */
const EVIDENCE_MARKER = promptDefault("finishing.runtime-evidence")
  .split(/\{\{\w+\}\}/)
  .map((part) => part.trim())
  .reduce((a, b) => (b.length > a.length ? b : a), "");

function userTexts(messages: readonly Msg[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")));
}

class AnHonestGapEndsTheTurn extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-reply-that-states-what-could-not-be-run-ends-the-turn-with-no-second-reminder";
  readonly whyItExists =
    "the rung treated the honest answer as a non-answer: it fired again on the next attempt to end the turn, so a change that genuinely could not be executed here looped the same reminder at a full round trip each time until the model invented a result to escape it";

  /** A real Engine boots and runs one turn of three rounds. */
  override readonly timeoutMs: number = 90_000;

  #engine: ScriptedEngine | undefined;
  #workspace: string | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
    const dir = this.#workspace;
    this.#workspace = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = mkdtempSync(join(tmpdir(), "magentra-honest-gap-"));
    this.#workspace = workspace;
    const target = join(workspace, "src", "device.ts");

    /** What the model answers the rung with: the ending the texts call complete. */
    const HONEST =
      "I cannot run this here — it talks to a serial device this machine does not have. " +
      "I confirmed the exported signature instead; the behaviour against real hardware stays unverified.";

    const engine = await startScriptedEngine({
      workspace,
      turns: [
        {
          toolCalls: [
            { id: "w1", name: "Write", input: { file_path: target, content: "export function open(port: string): boolean {\n  return port.length > 0;\n}\n" } },
          ],
        },
        { text: "the driver is written", stopReason: "end_turn" },
        { text: HONEST, stopReason: "end_turn" },
      ],
    });
    this.#engine = engine;

    const turn = await engine.runTurn("write the serial driver");

    // The rung fired: this turn is the one the feature is about.
    const reminders = userTexts(engine.provider.requests[2]?.messages ?? []).filter((x) => x.includes(EVIDENCE_MARKER));
    t.assert.equal(reminders.length, 1, "the evidence rung fired once, so the honest reply is an answer TO it");

    // And the honest answer was accepted, in every sense the engine has.
    t.assert.deepEqual([...turn.errors], [], "nothing failed — in particular the script was never asked for a fourth turn");
    t.assert.equal(turn.stopReason, "end_turn", "the turn ended where the model ended it; the rung reminds, it does not block");
    t.assert.equal(engine.provider.requests.length, 3, "three model calls — the honest reply bought no further round");
    t.assert.equal(
      turn.events.some((e) => e.type === "permission_request"),
      false,
      "nothing was put to the user: the gap is not an escalation",
    );

    // The user actually receives the honest sentence — it is the turn's reply,
    // not something swallowed as rung bookkeeping.
    const streamed = turn.events
      .filter((e): e is Extract<CoreEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    t.assert.equal(streamed.includes("stays unverified"), true, "the statement of what could not be run reaches the user");

    const history = engine.provider.requests[2]?.messages ?? [];
    const assistants = history.filter((m) => m.role === "assistant");
    const last = assistants[assistants.length - 1];
    const lastText = (last?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    t.assert.equal(lastText.includes("stays unverified"), true, "and it is what the conversation ends on");
    t.assert.equal(
      userTexts(history).filter((x) => x.includes(EVIDENCE_MARKER)).length,
      1,
      "still exactly one reminder after the turn finished — the gap was not answered with the same demand again",
    );
  }
}

registerFeatureTests(new AnHonestGapEndsTheTurn());
