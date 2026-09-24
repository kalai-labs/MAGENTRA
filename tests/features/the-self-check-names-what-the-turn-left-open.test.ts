/**
 * `the-self-check-names-what-the-turn-left-open`.
 *
 * Field test 2026-09-23, findings V-02, V-03, V-04. At 18:48:57 the agent
 * reported "The player never kills anything and enemies never damage the
 * player"; 32 seconds later it claimed "combat confirmed working" from one
 * kill, and the second symptom was never re-checked. Its 11-second OVERDRIVE
 * self-check said "verified — nothing left to do" while its own final answer
 * said "two stray test sessions may still be registered server-side" — and at
 * 19:06:32 those sessions filled the server's 8 slots. A model asked "is
 * everything handled?" does not reliably find its own loose ends, so the engine
 * finds them and quotes them.
 *
 * `pure` + `fs`, as the record declares. `pure` reads the shipped clauses from
 * the prompt registry. `fs` replays the field shape through the real Engine on
 * the scripted provider in OVERDRIVE and reads the self-check the Session sent.
 * `findSymptoms` and `findHedges` are module-private to the finishing rungs, so
 * they are proved through the turn that consults them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promptCatalog, type PromptEntry } from "@magentra/protocol";
import type { Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "the-self-check-names-what-the-turn-left-open";

/** Verbatim from the record. */
const INVARIANT =
  "The self-check quotes back the symptoms the turn reported and the hedges in its answer, so each is re-tested, settled, or left as a plain note to the user.";

/** The self-check's head — how its message is found in a history. */
const HEAD = "Internal self-check — this is NOT a new user message";

function shipped(id: string): PromptEntry {
  const entry = promptCatalog().find((p) => p.id === id);
  if (entry === undefined) throw new Error(`no prompt "${id}" is registered`);
  return entry;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheClausesAsShipped extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-two-clauses-are-registered-reminders-and-none-demands-a-pass";
  readonly whyItExists =
    "a clause that asked the model to 'make sure it passes' would turn the self-check into a demand for a green result, which a stand-in satisfies cheapest";

  override run(t: TestRun): void {
    const symptoms = shipped("finishing.self-verify.symptoms");
    const hedges = shipped("finishing.self-verify.hedges");
    t.assert.deepEqual([...(symptoms.placeholders ?? [])], ["symptoms"]);
    t.assert.deepEqual([...(hedges.placeholders ?? [])], ["hedges"]);
    t.assert.equal(symptoms.channel, "reminder");
    t.assert.equal(hedges.channel, "reminder");
    t.assert.match(symptoms.defaultText, /re-tested after its fix/);
    t.assert.match(symptoms.defaultText, /does not settle another/, "one passing case is named as not enough");
    t.assert.match(hedges.defaultText, /keep it in your answer as a plain note to the user; that is fine/, "an honest note is a complete answer");
    t.assert.match(hedges.defaultText, /never stand in for a cleanup you could do yourself/);
    t.assert.match(shipped("finishing.self-verify.closing-code").defaultText, /search every file for it/, "a repeated mistake is searched for everywhere");
    for (const entry of [symptoms, hedges]) {
      const text = entry.defaultText.toLowerCase();
      for (const demand of ["must pass", "make sure it passes", "until it passes", "all tests pass"]) {
        t.assert.equal(text.includes(demand), false, `${entry.id} must not demand a pass ("${demand}")`);
      }
    }
  }
}

/* ---- checklist 2 and 3 ----------------------------------------------- */

abstract class OverdriveTurnTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;
  #workspace: string | undefined;

  /** Engine closed first; the Bash shell holds the workspace as its cwd on Windows. */
  override async tearDown(): Promise<void> {
    await this.#engine?.close();
    if (this.#workspace !== undefined) rmSync(this.#workspace, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }

  /** An OVERDRIVE turn played from `turns`; returns the self-check message the Session sent. */
  protected async selfCheck(turns: FakeTurn[]): Promise<string> {
    this.redirectHome();
    this.#workspace = mkdtempSync(join(tmpdir(), "magentra-open-"));
    this.#engine = await startScriptedEngine({ workspace: this.#workspace, turns, permissions: "allow_once" });
    this.#engine.send({ type: "set_overdrive", enabled: true });
    const turn = await this.#engine.runTurn("build the game");
    if (turn.errors.length > 0) throw new Error(turn.errors.join(" | "));
    const history = (this.#engine.provider.requests.at(-1)?.messages ?? []) as readonly Msg[];
    const checks = history
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .filter((text) => text.includes(HEAD));
    if (checks.length !== 1) throw new Error(`expected one self-check, the history holds ${checks.length}`);
    return checks[0]!;
  }
}

class TheFieldShapeIsQuotedBack extends OverdriveTurnTest {
  readonly id = "the-field-turns-unchecked-symptom-and-its-may-still-hedge-are-quoted-to-the-self-check";
  readonly whyItExists =
    "the field self-check answered 'nothing left to do' in 11 seconds, past a symptom reported and never re-tested and a 'may still be registered' in its own answer that filled the server's slots twenty minutes later";

  override async run(t: TestRun): Promise<void> {
    const text = await this.selfCheck([
      {
        text: "The player never kills anything and enemies never damage the player. Checking the combat code.",
        toolCalls: [{ id: "b1", name: "Bash", input: { command: "echo combat", description: "Look at combat" } }],
      },
      { text: "Combat confirmed working. Two stray test sessions may still be registered server-side.", stopReason: "end_turn" },
      { text: "DONE", stopReason: "end_turn" },
    ]);
    t.assert.match(text, /While you worked you reported: «The player never kills anything and enemies never damage the player\.»/, "the symptom the turn reported is quoted back");
    t.assert.match(text, /Your answer hedges: «Two stray test sessions may still be registered server-side\.»/, "and the hedge from its own answer");
    t.assert.equal(text.includes("«Combat confirmed working.»"), false, "a confident sentence is not a hedge");
    t.assert.equal(text.includes("«Checking the combat code.»"), false, "a sentence that reports no failure is not a symptom");
    t.assert.equal(text.trimEnd().endsWith("</system-reminder>"), true, "the clauses ride inside the one closing slot");
  }
}

class ACleanTurnPaysNothing extends OverdriveTurnTest {
  readonly id = "a-clean-turn-is-self-checked-with-neither-clause";
  readonly whyItExists =
    "a clause that appeared on every self-check would be skimmed on the turn where it matters, and would cost context on every OVERDRIVE turn";

  override async run(t: TestRun): Promise<void> {
    const text = await this.selfCheck([
      { text: "Listing the folder.", toolCalls: [{ id: "b1", name: "Bash", input: { command: "echo listed", description: "List it" } }] },
      { text: "The folder holds three files.", stopReason: "end_turn" },
      { text: "DONE", stopReason: "end_turn" },
    ]);
    t.assert.equal(text.includes("While you worked you reported"), false, "no failure was reported, so none is quoted");
    t.assert.equal(text.includes("Your answer hedges"), false, "the answer left nothing open");
  }
}

registerFeatureTests(new TheClausesAsShipped(), new TheFieldShapeIsQuotedBack(), new ACleanTurnPaysNothing());
