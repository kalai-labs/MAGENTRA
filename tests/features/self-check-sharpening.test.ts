/**
 * `self-check-sharpening`.
 *
 * The self-verify rung is an OVERDRIVE-only end-of-turn round: the model is
 * asked, silently, whether the user's query is fully handled, and answers with
 * the DONE sentinel or with the work it had left. One head, two closings. On a
 * turn that changed no source it says to judge against the query alone and
 * never invent verification rituals; on a turn that rewrote source it names the
 * files and defines "fully handled" as SETTLED — observed against the real
 * thing, or an honest statement of what could not be run.
 *
 * `pure` + `fs`, and the record said `pure`. Re-declared 2026-09-20.
 *
 * WHY NOT ALL PURE. The checklist calls `selfVerifyText()`. It is not
 * reachable: `engine/core/src/runtime/finishing.ts` is not re-exported by
 * `engine/core/src/index.ts` and `@magentra/core` ships a single `"."` export,
 * so the module is private to the package (`isSelfVerifyDone`, which lives in
 * `session.ts`, is the only thing near it that is exported). The two observable
 * surfaces carry the two halves of the claim:
 *
 *   pure — the shipped PROMPTS, through `promptCatalog()` in
 *          `@magentra/protocol`. `finishing.self-verify` and its two closings
 *          are registered by `definePrompt` when the engine module loads, and
 *          `defaultText` is the committed text, unaffected by any override file
 *          this machine holds. Items 1–3 are claims about what those say.
 *   fs   — WHICH closing a real turn gets, and whether the round happens at
 *          all: items 4 and 5, read off the message the real Session pushed
 *          into the real history.
 *
 * ITEM 3 IS PROVEN ON BOTH SIDES, deliberately. That the two variants "keep the
 * shared head" is structural in the prompt (one text with a `{{closing}}` slot),
 * so the pure test asserts the head is in the shared prompt and the slot is the
 * only thing that varies — and the two fs tests then assert the head really did
 * arrive in front of each closing, which is the claim a shared template can
 * still break by being rendered from the wrong place.
 *
 * THE SCRIPTS PAY FOR THE RUNG. A self-verify round IS an extra model call, and
 * the count is asserted rather than assumed: a script one turn short does not
 * hang, it produces an `error` event and `stopReason: "error"`, so `turn.errors`
 * is asserted empty everywhere. The third call answers `DONE`, which is what
 * ends the turn — that sentinel is never shown to the user.
 *
 * Nothing here asserts that the scripted provider returned what it was told to
 * return: every assertion is about the reminder the real Session pushed and the
 * events the real Engine emitted.
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

const FEATURE = "self-check-sharpening";

/** Verbatim from the record. */
const INVARIANT =
  "The self-check's closing clause flips on whether the turn changed code: demand evidence if it did, forbid invented rituals if it did not.";

/** The sentence that identifies the rung's shared head wherever it lands. */
const HEAD_MARKER = "Internal self-check";

/** The registry is populated by `definePrompt` at module load — the engine is imported by `scriptedEngine.ts` below. */
function shippedPrompt(id: string): PromptEntry {
  const entry = promptCatalog().find((p) => p.id === id);
  if (entry === undefined) {
    throw new Error(`no prompt "${id}" is registered — the engine's finishing module did not load`);
  }
  return entry;
}

function userTexts(messages: readonly Msg[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")));
}

/* ---- checklist 1–3 — pure, the shipped text --------------------------- */

abstract class ShippedTextTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

class TheTwoClosingsForbidOppositeThings extends ShippedTextTest {
  readonly id = "the-plain-closing-forbids-invented-rituals-and-the-code-closing-demands-the-evidence";
  readonly whyItExists =
    "one fixed closing served both turns: with the 'never invent verification rituals' wording it told a turn that had just rewritten three modules that a build was ceremony, and the self-check became the licence to skip verifying";

  override run(t: TestRun): void {
    const plain = shippedPrompt("finishing.self-verify.closing-plain").defaultText;
    const code = shippedPrompt("finishing.self-verify.closing-code").defaultText;

    t.assert.match(plain, /never invent verification rituals \(builds, tests\)/, "with nothing changed, a demanded build is pure waste");
    t.assert.match(plain, /Judge only against the query itself/);
    t.assert.equal(plain.includes("You changed code this turn"), false, "the plain closing does not speak about files");

    t.assert.match(code, /You changed code this turn \(\{\{files\}\}\)/, "the code closing names the turn's own work");
    t.assert.match(
      code,
      /not merely compiled, re-read, reasoned about, or agreed with by a stand-in you wrote yourself/,
      "and rules out each of the four things that look like evidence and are not",
    );
    t.assert.match(code, /"Fully handled" includes SETTLED/);
    t.assert.equal(code.includes("never invent verification rituals"), false, "the sentence that would excuse skipping it is absent here");

    t.assert.deepEqual([...(shippedPrompt("finishing.self-verify.closing-code").placeholders ?? [])], ["files"], "the code closing declares the slot it fills");
    t.assert.equal(shippedPrompt("finishing.self-verify.closing-plain").placeholders, undefined, "the plain one has nothing to fill");
  }
}

class OneHeadCarriesBothClosings extends ShippedTextTest {
  readonly id = "the-rung-is-one-prompt-with-a-closing-slot-so-the-sentinel-instructions-cannot-diverge";
  readonly whyItExists =
    "the two variants were two whole prompts, so the DONE instruction was written twice and drifted: one branch stopped saying 'exactly this literal ASCII word', a localizing model answered in its own language, and the turn never broke out of the round";

  override run(t: TestRun): void {
    const rung = shippedPrompt("finishing.self-verify");
    const text = rung.defaultText;

    t.assert.equal(rung.channel, "reminder", "it is injected into the conversation, not part of the system prompt");
    t.assert.deepEqual([...(rung.placeholders ?? [])], ["closing"], "exactly one slot — the closing is the only thing that varies");
    t.assert.equal(text.split("{{closing}}").length - 1, 1, "and it appears once, at the end");
    t.assert.equal(text.trimEnd().endsWith("{{closing}}</system-reminder>"), true, "the closing is the last thing the model reads");

    t.assert.match(text, /Internal self-check — this is NOT a new user message/, "the head says what the round is");
    t.assert.match(
      text,
      /output exactly this literal ASCII word and nothing else, never translated or localized[^:]*: DONE/,
      "and pins the sentinel the turn breaks on",
    );
    t.assert.match(text, /the DONE token never is/, "the sentinel is never shown to the user");
  }
}

/* ---- checklist 4 and 5 — fs, through a real Engine -------------------- */

abstract class RungTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A real Engine boots and runs one turn of up to three rounds in each of these. */
  override readonly timeoutMs: number = 90_000;

  #engine: ScriptedEngine | undefined;
  #workspace: string | undefined;

  protected get workspace(): string {
    if (this.#workspace === undefined) throw new Error("makeWorkspace() has not run yet");
    return this.#workspace;
  }

  /**
   * Not `FsTest.tempDir`: two of these run a real Bash call, whose shell holds
   * this directory as its cwd, and on Windows that handle outlives the child by
   * a moment while the kind's own teardown removes its directories with no
   * retries. Engine closed first, then a removal that forgives EPERM/EBUSY.
   */
  protected makeWorkspace(): string {
    this.redirectHome();
    this.#workspace = mkdtempSync(join(tmpdir(), "magentra-selfcheck-"));
    return this.#workspace;
  }

  protected async boot(turns: readonly FakeTurn[], overdrive: boolean): Promise<ScriptedEngine> {
    this.#engine = await startScriptedEngine({
      workspace: this.workspace,
      turns: [...turns],
      permissions: "allow_once",
    });
    if (overdrive) this.#engine.send({ type: "set_overdrive", enabled: true });
    return this.#engine;
  }

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
    const dir = this.#workspace;
    this.#workspace = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }

  protected abs(...parts: string[]): string {
    return join(this.workspace, ...parts);
  }

  /** Every self-verify message in a history — the rung is identified by its head, not by a closing. */
  protected selfChecks(messages: readonly Msg[]): string[] {
    return userTexts(messages).filter((text) => text.includes(HEAD_MARKER));
  }
}

class ATurnThatChangedSourceGetsTheCodeClosing extends RungTest {
  readonly id = "an-overdrive-turn-that-wrote-a-file-is-self-checked-with-the-closing-that-names-it";
  readonly whyItExists =
    "the rung asked a turn that had just rewritten a module whether it was 'fully handled' without ever saying that settled means observed, so DONE came back on code the turn had only compiled";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const target = this.abs("src", "a.ts");

    const engine = await this.boot(
      [
        {
          toolCalls: [
            { id: "w1", name: "Write", input: { file_path: target, content: "export const a = 1;\n" } },
            { id: "b1", name: "Bash", input: { command: "echo ran", description: "Prove the module loads" } },
          ],
        },
        { text: "written and checked", stopReason: "end_turn" },
        { text: "DONE", stopReason: "end_turn" },
      ],
      true,
    );

    const turn = await engine.runTurn("add the constant and check it");

    t.assert.deepEqual([...turn.errors], [], "no error frame — in particular the script was not one turn short");
    t.assert.equal(turn.stopReason, "end_turn");
    t.assert.equal(engine.provider.requests.length, 3, "three model calls: the batch, the attempt to end, and the self-check round");
    t.assert.equal(
      turn.notes.includes("⚡ overdrive: self-verifying against the original query"),
      true,
      "the user is told the extra round is happening",
    );

    const checks = this.selfChecks(engine.provider.requests[2]?.messages ?? []);
    t.assert.equal(checks.length, 1, "the rung fires once per turn");
    const text = checks[0] ?? "";
    t.assert.match(text, /Internal self-check — this is NOT a new user message/, "the shared head arrived with it");
    t.assert.match(text, /never translated or localized[^:]*: DONE/, "so did the sentinel instruction");
    t.assert.equal(text.includes(`You changed code this turn (${join("src", "a.ts")})`), true, "the code closing names the file this turn changed");
    t.assert.match(text, /not merely compiled, re-read, reasoned about, or agreed with by a stand-in you wrote yourself/);
    t.assert.match(text, /or you told the user plainly which parts you could not run/, "with the honest gap still allowed");
    t.assert.equal(text.includes("never invent verification rituals"), false, "and without the clause that would excuse skipping the check");
  }
}

class ATurnThatOnlyReadGetsThePlainClosing extends RungTest {
  readonly id = "an-overdrive-turn-whose-only-tool-call-was-a-read-is-self-checked-without-a-demand-for-evidence";
  readonly whyItExists =
    "the code closing was sent on any turn that made a tool call, so a turn that had only read a file was told to go and observe a change it never made, and it invented a build to satisfy the demand";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const existing = this.abs("src", "a.ts");
    this.writeFile(existing, "export const a = 1;\n");

    const engine = await this.boot(
      [
        { toolCalls: [{ id: "r1", name: "Read", input: { file_path: existing } }] },
        { text: "it holds one constant", stopReason: "end_turn" },
        { text: "DONE", stopReason: "end_turn" },
      ],
      true,
    );

    const turn = await engine.runTurn("what is in a.ts?");

    t.assert.deepEqual([...turn.errors], []);
    const read = turn.toolResults.find((e) => e.tool === "Read");
    t.assert.equal(read?.isError, false, "the Read really ran, so the turn did make a tool call");
    t.assert.equal(engine.provider.requests.length, 3, "the Read, the answer, and the self-check round");

    const checks = this.selfChecks(engine.provider.requests[2]?.messages ?? []);
    t.assert.equal(checks.length, 1, "a turn with a tool call is still self-checked");
    const text = checks[0] ?? "";
    t.assert.match(text, /Internal self-check — this is NOT a new user message/, "the same shared head as the code variant");
    t.assert.match(text, /never translated or localized[^:]*: DONE/);
    t.assert.match(text, /Judge only against the query itself — never invent verification rituals/, "the plain closing");
    t.assert.equal(text.includes("You changed code this turn"), false, "nothing was changed, so nothing is named");
    t.assert.equal(text.includes("Fully handled\" includes SETTLED"), false, "and no evidence is demanded about work that did not happen");
  }
}

class OutsideOverdriveTheRungNeverRuns extends RungTest {
  readonly id = "the-same-code-changing-turn-in-the-normal-stance-is-never-self-checked";
  readonly whyItExists =
    "the rung ran on every attended turn, charging the user a full extra round trip per turn for a second opinion they were already giving by reading the reply";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const target = this.abs("src", "a.ts");

    const engine = await this.boot(
      [
        {
          toolCalls: [
            { id: "w1", name: "Write", input: { file_path: target, content: "export const a = 1;\n" } },
            { id: "b1", name: "Bash", input: { command: "echo ran", description: "Prove the module loads" } },
          ],
        },
        { text: "written and checked", stopReason: "end_turn" },
      ],
      false,
    );

    const turn = await engine.runTurn("add the constant and check it");

    t.assert.deepEqual([...turn.errors], [], "the script was not short: no third call was ever asked for");
    t.assert.equal(turn.stopReason, "end_turn");
    t.assert.equal(engine.provider.requests.length, 2, "two model calls — the same turn that costs three in OVERDRIVE");
    t.assert.deepEqual(this.selfChecks(engine.provider.requests[1]?.messages ?? []), [], "no self-check was pushed");
    t.assert.equal(turn.notes.some((n) => n.includes("self-verifying")), false, "and nothing was announced");
  }
}

class WithNoToolCallsThereIsNothingToVerify extends RungTest {
  readonly id = "an-overdrive-turn-that-called-no-tool-at-all-ends-on-its-first-answer";
  readonly whyItExists =
    "a greeting in OVERDRIVE paid for a self-check round, which is latency on a turn that built nothing and could leave nothing behind — and every such round risks leaking the DONE sentinel into the reply";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();

    const engine = await this.boot([{ text: "Hello — what would you like to work on?", stopReason: "end_turn" }], true);

    const turn = await engine.runTurn("hi");

    t.assert.deepEqual([...turn.errors], []);
    t.assert.equal(turn.stopReason, "end_turn");
    t.assert.equal(turn.toolResults.length, 0, "no tool ran, so nothing was built and nothing can be left behind");
    t.assert.equal(engine.provider.requests.length, 1, "one model call: the greeting is the whole turn");
    t.assert.deepEqual(this.selfChecks(engine.provider.requests[0]?.messages ?? []), []);
  }
}

registerFeatureTests(
  new TheTwoClosingsForbidOppositeThings(),
  new OneHeadCarriesBothClosings(),
  new ATurnThatChangedSourceGetsTheCodeClosing(),
  new ATurnThatOnlyReadGetsThePlainClosing(),
  new OutsideOverdriveTheRungNeverRuns(),
  new WithNoToolCallsThereIsNothingToVerify(),
);
