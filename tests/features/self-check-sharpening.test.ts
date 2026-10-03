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
 * WHAT THE RUNG SAYS IS NOT ASSERTED HERE. Its wording lives in brain/ and the
 * owner rewords it freely (decided 2026-10-04: no test pins prompt prose). The
 * pure half holds the rung's SHAPE — one head, one `{{closing}}` slot, the
 * closings' own slots — and the fs half tells the head and the two closings
 * apart by stretches of their own shipped templates (`promptDefault`), so a
 * rewording moves the locators with it. One coupling is held on purpose: the
 * head must name a word the engine's own `isSelfVerifyDone` accepts, because
 * that is the only way the round can end. The word is the engine's, not this
 * file's.
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
 *          this machine holds. Items 1–3 are held as the shape of those.
 *   fs   — WHICH closing a real turn gets, and whether the round happens at
 *          all: items 4 and 5, read off the message the real Session pushed
 *          into the real history.
 *
 * ITEM 3 IS PROVEN ON BOTH SIDES, deliberately. That the two variants "keep the
 * shared head" is structural in the prompt (one text with a `{{closing}}` slot),
 * so the pure test asserts the slot is the only thing that varies — and the two fs tests then assert the head really did
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

import { isSelfVerifyDone } from "@magentra/core";
import { promptCatalog, promptDefault, type PromptEntry } from "@magentra/protocol";
import type { Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "self-check-sharpening";

/** Verbatim from the record. */
const INVARIANT =
  "The self-check's closing clause flips on whether the turn changed code: demand evidence if it did, forbid invented rituals if it did not.";

/** The longest slot-free stretch of a prompt's shipped text: present verbatim in every render of it. */
function shippedMarker(id: string): string {
  return promptDefault(id)
    .split(/\{\{\w+\}\}/)
    .map((part) => part.trim())
    .reduce((a, b) => (b.length > a.length ? b : a), "");
}

/** Identifies the rung's shared head wherever it lands. */
const HEAD_MARKER = shippedMarker("finishing.self-verify");
/** Identifies each closing in a rendered self-check. */
const CODE_CLOSING = shippedMarker("finishing.self-verify.closing-code");
const PLAIN_CLOSING = shippedMarker("finishing.self-verify.closing-plain");

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

/* ---- checklist 1–3 — pure, the shipped rung's shape ------------------- */

abstract class ShippedTextTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

class TheTwoClosingsDifferInTheirSlot extends ShippedTextTest {
  readonly id = "the-code-closing-declares-the-files-slot-and-the-plain-closing-has-none";
  readonly whyItExists =
    "one fixed closing served both turns, so a turn that had just rewritten three modules was judged by the same words as a turn that changed nothing — the closing that is about the turn's own files has to be able to name them, and the other has nothing to name";

  override run(t: TestRun): void {
    const plain = shippedPrompt("finishing.self-verify.closing-plain");
    const code = shippedPrompt("finishing.self-verify.closing-code");

    t.assert.deepEqual([...(code.placeholders ?? [])], ["files"], "the code closing declares the slot it fills");
    t.assert.equal(code.defaultText.includes("{{files}}"), true, "and carries it");
    t.assert.equal(plain.placeholders, undefined, "the plain one has nothing to fill");
    t.assert.equal(plain.defaultText.includes("{{files}}"), false, "and names no files");
    t.assert.notEqual(plain.defaultText.trim(), code.defaultText.replace("{{files}}", "").trim(), "they are two closings, not one");
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
    t.assert.match(
      text.slice(text.indexOf("{{closing}}") + "{{closing}}".length),
      /^\s*(<\/[\w-]+>)?\s*$/,
      "the closing is the last thing the model reads — nothing but a closing tag follows the slot",
    );

    // The coupling the round depends on: the head must tell the model a word
    // the engine's own sentinel check accepts, or no answer can end the round.
    const words = text.split(/[\s:;,"'`()]+/).filter((w) => w !== "");
    t.assert.equal(words.some((w) => isSelfVerifyDone(w)), true, "the head names a word isSelfVerifyDone accepts");
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
    t.assert.equal(text.includes(CODE_CLOSING), true, "it carries the code closing");
    t.assert.equal(text.includes(join("src", "a.ts")), true, "which names the file this turn changed");
    t.assert.equal(text.includes(PLAIN_CLOSING), false, "and not the plain closing that would excuse skipping the check");
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
    t.assert.equal(text.includes(PLAIN_CLOSING), true, "the plain closing, under the same shared head as the code variant");
    t.assert.equal(text.includes(CODE_CLOSING), false, "and no evidence is demanded about work that did not happen");
    t.assert.equal(text.includes(join("src", "a.ts")), false, "nothing was changed, so nothing is named");
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
  new TheTwoClosingsDifferInTheirSlot(),
  new OneHeadCarriesBothClosings(),
  new ATurnThatChangedSourceGetsTheCodeClosing(),
  new ATurnThatOnlyReadGetsThePlainClosing(),
  new OutsideOverdriveTheRungNeverRuns(),
  new WithNoToolCallsThereIsNothingToVerify(),
);
