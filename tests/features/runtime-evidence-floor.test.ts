/**
 * `runtime-evidence-floor`.
 *
 * A turn that rewrote runnable source and never executed a single command has
 * reasoned about its change and observed nothing. At the end of such a turn the
 * Session pushes ONE user-role reminder naming the changed files and asking for
 * a real run — fast gate, then the changed path and its callers, a throwaway
 * harness in the system temp directory, judged on exit codes and stdout. It
 * fires at most once per turn, and it reminds: the turn is free to end straight
 * after it. A command that ran and exited nonzero is an observation, so it
 * silences the floor; documentation and configuration are not runnable source,
 * so they never wake it.
 *
 * `pure` + `fs`, and the record said `pure`. Re-declared 2026-09-20.
 *
 * WHY NOT ALL PURE, WHICH IS WHAT THE CHECKLIST ASSUMES. The checklist calls
 * `codeFilesAmong()` and `runtimeEvidenceText()` directly. Neither is reachable:
 * `engine/core/src/runtime/finishing.ts` is not re-exported by
 * `engine/core/src/index.ts`, and `@magentra/core` ships a single `"."` export,
 * so the whole module is private to the package (`Object.keys` of the built
 * package holds `isSelfVerifyDone` and nothing else from it). Reaching into
 * `dist/runtime/finishing.js` by path would prove the shape of the build, not
 * the behaviour of the feature, so the two halves below prove it through the
 * two surfaces that ARE observable:
 *
 *   pure — the shipped PROMPT, through `promptCatalog()` in `@magentra/protocol`.
 *          `definePrompt` registers `finishing.runtime-evidence` and its two
 *          vision clauses when the engine module loads, and `defaultText` is the
 *          text as committed, unaffected by any override file this machine may
 *          hold. That is what checklist item 2 is about: what the reminder says.
 *   fs   — the rung firing, through a real Engine on a scripted provider. The
 *          suffix predicate (item 1), the rendering of `{{files}}` and the
 *          eight-file cut-off (item 2's tail), and items 3–5 are all claims
 *          about what the real Session pushes into the real history.
 *
 * WHAT THE SCRIPTS MUST COVER. Every turn below ends on a finishing rung that
 * costs another model call, and the count is asserted rather than assumed: the
 * evidence rung itself is one extra call, and a tool batch that contained a
 * failure spends one recovery nudge before the turn is allowed to end. A script
 * one turn short does not hang — `FakeProvider` throws, the turn ends with an
 * `error` event and `stopReason: "error"` — so `turn.errors` is asserted empty
 * everywhere.
 *
 * Nothing here asserts that the scripted provider returned what it was told to
 * return. Every assertion is about the reminder the real Session pushed, the
 * files the real Write tool landed, and the events the real Engine emitted.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promptCatalog, type PromptEntry } from "@magentra/protocol";
import type { Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "runtime-evidence-floor";

/** Verbatim from the record. */
const INVARIANT =
  "A turn that edited source and ran no command gets one reminder naming the files; it reminds, never blocks.";

/** The sentence only the runtime-evidence rung says — the self-verify closing also opens with "You changed code this turn". */
const EVIDENCE_MARKER = "did not run a single command";

/** What the Session prints to the user when the floor fires with nothing run. */
const EVIDENCE_NOTE = "↻ nothing was run — verifying the change for real";

/**
 * The prompt registry is populated by `definePrompt` at module load, so the
 * entry exists because the engine was imported — `scriptedEngine.ts` above
 * pulls in `@magentra/core`, which pulls in `runtime/finishing.js`.
 */
function shippedPrompt(id: string): PromptEntry {
  const entry = promptCatalog().find((p) => p.id === id);
  if (entry === undefined) {
    throw new Error(`no prompt "${id}" is registered — the engine's finishing module did not load`);
  }
  return entry;
}

/** Every text block of every user message in a history. */
function userTexts(messages: readonly Msg[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")));
}

/** The last USER message's text — the live array's tail is not it, because the assistant answers after. */
function lastUserText(messages: readonly Msg[]): string {
  const users = messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  return (last?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
}

/* ---- checklist 2 — pure, the shipped text ----------------------------- */

abstract class ShippedTextTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

class TheReminderAsksForARunAndCarriesItsThreeSlots extends ShippedTextTest {
  readonly id = "the-shipped-reminder-asks-for-a-real-run-in-five-steps-and-declares-its-three-slots";
  readonly whyItExists =
    "the numbered steps were trimmed to 'run something', so the agent ran the project's typecheck and reported the change verified — a gate that proves the code parses was accepted as proof that it behaves";

  override run(t: TestRun): void {
    const rung = shippedPrompt("finishing.runtime-evidence");
    const text = rung.defaultText;

    t.assert.equal(rung.channel, "reminder", "it is injected into the conversation, not part of the system prompt");
    t.assert.deepEqual(
      [...(rung.placeholders ?? [])].sort(),
      ["doubleNote", "files", "visionNote"],
      "the three slots the rung fills: the changed files, the vision clause, the stand-in clause",
    );
    for (const slot of ["{{files}}", "{{visionNote}}", "{{doubleNote}}"]) {
      t.assert.equal(text.includes(slot), true, `the text actually carries ${slot}, or the declared placeholder is a lie`);
    }

    t.assert.match(text, /did not run a single command/, "it states the fact that fired it");
    t.assert.match(text, /nothing you wrote has been observed working/);
    for (const step of [1, 2, 3, 4, 5]) {
      t.assert.match(text, new RegExp(`^${step}\\. `, "m"), `step ${step} of the list survives`);
    }
    t.assert.match(text, /^1\. Fast gate first.*passing it is NOT evidence/ms, "the fast gate is first AND is named as not being proof");
    t.assert.match(text, /^2\. Execute the path you changed, and the callers it reaches/m);
    t.assert.match(text, /^3\..*system temp directory, not in the repository.*DELETE it in this same turn/ms, "the throwaway harness is temp-dir'd and deleted in the same turn");
    t.assert.match(text, /^4\. Judge against something you can actually read: exit codes, stdout/m);
    t.assert.match(text, /^5\. Say in your wrap-up what you ran and what you observed/m);
    t.assert.match(text, /<system-reminder>/, "wrapped as a harness injection, not as words from the user");
  }
}

class TheTwoVisionClausesSayOppositeThings extends ShippedTextTest {
  readonly id = "the-vision-clause-substituted-into-the-rung-has-an-on-shape-and-an-off-shape";
  readonly whyItExists =
    "one fixed clause was substituted whatever the workspace could do, so on a vision-less workspace step 4 told the agent to go and look at a screenshot it had no way to read, and it reported having looked";

  override run(t: TestRun): void {
    const off = shippedPrompt("finishing.vision-off");
    const on = shippedPrompt("finishing.vision-on");

    t.assert.match(off.defaultText, /Vision is off for this workspace/);
    t.assert.match(off.defaultText, /Never claim you looked at a screenshot or a window/);
    t.assert.match(off.defaultText, /or say plainly that the appearance stays unverified/, "the off clause offers the honest gap as the way out");

    t.assert.match(on.defaultText, /capture a screenshot of the running app and Read it/);
    t.assert.match(on.defaultText, /never claim you looked at the screen yourself/i, "even with vision on, the observation belongs to the describing model");
    t.assert.equal(on.defaultText.includes("Vision is off"), false, "the two clauses are not the same sentence with a negation");
    t.assert.equal(off.defaultText.includes("capture a screenshot"), false);
  }
}

/* ---- checklist 1 and 3–5 — fs, through a real Engine ------------------ */

abstract class FloorTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A real Engine boots and runs one turn of several tool rounds in each of these. */
  override readonly timeoutMs: number = 90_000;

  #engine: ScriptedEngine | undefined;
  #workspace: string | undefined;

  /**
   * The workspace is made here rather than with `FsTest.tempDir`, because the
   * Bash tool spawns a real shell whose cwd is this directory: on Windows the
   * handle outlives the child by a moment, and the kind's own teardown removes
   * its directories with no retries. Closed engine first, then a removal that
   * forgives EPERM/EBUSY.
   */
  protected get workspace(): string {
    if (this.#workspace === undefined) throw new Error("makeWorkspace() has not run yet");
    return this.#workspace;
  }

  protected makeWorkspace(): string {
    this.redirectHome();
    this.#workspace = mkdtempSync(join(tmpdir(), "magentra-evidence-"));
    return this.#workspace;
  }

  protected async boot(turns: readonly FakeTurn[], permissions?: "allow_once"): Promise<ScriptedEngine> {
    this.#engine = await startScriptedEngine({
      workspace: this.workspace,
      turns: [...turns],
      ...(permissions !== undefined ? { permissions } : {}),
    });
    return this.#engine;
  }

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
    const dir = this.#workspace;
    this.#workspace = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }

  /** An absolute path inside the workspace, the way the model is told to spell one. */
  protected abs(...parts: string[]): string {
    return join(this.workspace, ...parts);
  }

  /** How many of the history's user messages carry the evidence reminder. */
  protected evidenceReminders(messages: readonly Msg[]): string[] {
    return userTexts(messages).filter((text) => text.includes(EVIDENCE_MARKER));
  }
}

class ATurnThatWroteCodeAndRanNothingIsRemindedOnce extends FloorTest {
  readonly id = "a-write-of-source-with-no-command-pushes-exactly-one-reminder-and-the-next-end-turn-is-allowed";
  readonly whyItExists =
    "the turn ended on 'the fix is in place' with nothing ever executed, and the rung that should have asked for a run either never fired or fired on every attempt to end the turn, which is a reminder loop the user pays for per round";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const target = this.abs("src", "a.ts");

    const engine = await this.boot([
      { toolCalls: [{ id: "write_1", name: "Write", input: { file_path: target, content: "export const a = 1;\n" } }] },
      { text: "done", stopReason: "end_turn" },
      { text: "I could not run it here — src/a.ts stays unverified.", stopReason: "end_turn" },
    ]);

    const turn = await engine.runTurn("add a constant");

    t.assert.deepEqual([...turn.errors], [], "no error frame — in particular the script was not one turn short");
    t.assert.equal(turn.stopReason, "end_turn", "the rung reminds; the turn still ends where the model ended it");
    t.assert.equal(turn.events.some((e) => e.type === "permission_request"), false, "nothing was put to the user");
    t.assert.equal(existsSync(target), true, "the Write really landed, so there is something to verify");

    t.assert.equal(turn.notes.includes(EVIDENCE_NOTE), true, `the user is told why the turn continued: ${EVIDENCE_NOTE}`);
    t.assert.equal(
      turn.notes.filter((n) => n === EVIDENCE_NOTE).length,
      1,
      "announced once, because the fuse is spent on the first firing",
    );

    t.assert.equal(engine.provider.requests.length, 3, "three model calls: the Write, the attempt to end, and the one the reminder bought");
    const history = engine.provider.requests[2]?.messages;
    t.assert.notEqual(history, undefined, "the model was called again after the rung fired");

    const reminders = this.evidenceReminders(history as Msg[]);
    t.assert.equal(reminders.length, 1, "exactly one evidence reminder in the whole history — never two");
    t.assert.match(reminders[0] ?? "", /You changed code this turn \(/, "it names the work it is about");
    t.assert.equal((reminders[0] ?? "").includes(join("src", "a.ts")), true, "and names the file that changed, spelled the way this platform spells a path");
    t.assert.match(reminders[0] ?? "", /Vision is off for this workspace/, "the vision slot was filled for a workspace with no vision model");

    // `provider.requests[n].messages` is the LIVE array, so this reads the
    // history as it stands after the turn: the reminder is the last thing the
    // model was asked, and the model's honest answer ended the turn.
    t.assert.equal(lastUserText(history as Msg[]).includes(EVIDENCE_MARKER), true, "the reminder is the last user message of the turn");
  }
}

class OnlyRunnableSuffixesWakeTheFloor extends FloorTest {
  readonly id = "documentation-and-configuration-written-beside-source-are-not-named-in-the-reminder";
  readonly whyItExists =
    "a turn that only edited a README was told to go and run it, which is the ceremony the prompts exist to prevent — and the same miscount named package.json as a file whose behaviour the agent should observe";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const ts = this.abs("src", "a.ts");
    const py = this.abs("src", "b.py");
    const md = this.abs("README.md");
    const json = this.abs("package.json");

    const engine = await this.boot([
      {
        toolCalls: [
          { id: "w1", name: "Write", input: { file_path: ts, content: "export const a = 1;\n" } },
          { id: "w2", name: "Write", input: { file_path: md, content: "# notes\n" } },
          { id: "w3", name: "Write", input: { file_path: json, content: '{ "name": "x" }\n' } },
          { id: "w4", name: "Write", input: { file_path: py, content: "A = 1\n" } },
        ],
      },
      { text: "all four written", stopReason: "end_turn" },
      { text: "nothing to run here.", stopReason: "end_turn" },
    ]);

    const turn = await engine.runTurn("write the four files");

    t.assert.deepEqual([...turn.errors], []);
    t.assert.equal(turn.toolResults.length, 4, "all four Writes ran");
    t.assert.deepEqual(turn.toolResults.map((e) => e.isError), [false, false, false, false], "and none of them failed");
    t.assert.equal(engine.provider.requests.length, 3, "the batch, the attempt to end, and the round the reminder bought");

    const reminders = this.evidenceReminders(engine.provider.requests[2]?.messages ?? []);
    t.assert.equal(reminders.length, 1, "the two source files fired the floor once");
    const text = reminders[0] ?? "";
    t.assert.equal(text.includes(join("src", "a.ts")), true, "the TypeScript file is named");
    t.assert.equal(text.includes(join("src", "b.py")), true, "so is the Python one");
    t.assert.equal(text.includes("README.md"), false, "documentation is not runnable source and is not named");
    t.assert.equal(text.includes("package.json"), false, "neither is configuration");
    t.assert.equal(existsSync(md), true, "though the README was really written — the floor judges the suffix, not whether the Write happened");
  }
}

class PastEightFilesTheRestAreCounted extends FloorTest {
  readonly id = "ten-changed-source-files-are-named-eight-at-a-time-and-the-rest-are-counted";
  readonly whyItExists =
    "a refactor touching forty files reprinted the whole diff's file list into the conversation on the way out, which teaches nothing and spends the context the turn still needs";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);

    const engine = await this.boot([
      {
        toolCalls: files.map((name, i) => ({
          id: `w${i}`,
          name: "Write",
          input: { file_path: this.abs("src", name), content: `export const f${i} = ${i};\n` },
        })),
      },
      { text: "written", stopReason: "end_turn" },
      // Long enough that the wrap-up rung (>=5 tool calls and a short final
      // text) has nothing to ask for, so this turn's model calls stay three.
      {
        text:
          "I could not execute these on this machine, so here is what stays unverified: none of the ten modules " +
          "were imported, and nothing was run against them. What I did confirm is that each file was written with " +
          "the contents requested.",
        stopReason: "end_turn",
      },
    ]);

    const turn = await engine.runTurn("write ten modules");

    t.assert.deepEqual([...turn.errors], []);
    t.assert.equal(turn.toolResults.length, 10, "all ten Writes ran");
    t.assert.equal(engine.provider.requests.length, 3, "three model calls — the wrap-up rung had a real summary and did not fire");

    const reminders = this.evidenceReminders(engine.provider.requests[2]?.messages ?? []);
    t.assert.equal(reminders.length, 1);
    const text = reminders[0] ?? "";
    const named = files.filter((name) => text.includes(join("src", name)));
    t.assert.equal(named.length, 8, "eight of the ten are named");
    t.assert.match(text, /and 2 more/, "and the remaining two are counted rather than listed");
  }
}

class ACommandThatFailedIsStillAnObservation extends FloorTest {
  readonly id = "a-bash-call-that-exited-nonzero-keeps-the-floor-quiet";
  readonly whyItExists =
    "the floor read the exit code, so a turn whose one real run FAILED was told it had run nothing and sent back to run something else — the agent's honest failing evidence was answered with a demand for evidence";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const target = this.abs("src", "a.ts");

    const engine = await this.boot(
      [
        {
          toolCalls: [
            { id: "w1", name: "Write", input: { file_path: target, content: "export const a = 1;\n" } },
            { id: "b1", name: "Bash", input: { command: "exit 1", description: "Run the check" } },
          ],
        },
        { text: "the check failed", stopReason: "end_turn" },
        // The batch held a failure, so the recovery rung buys one more round
        // before the turn may end. That is the rung above this one on the
        // ladder, and the script has to pay for it.
        { text: "reported; nothing further to do.", stopReason: "end_turn" },
      ],
      "allow_once",
    );

    const turn = await engine.runTurn("write it and check it");

    t.assert.deepEqual([...turn.errors], []);
    const bash = turn.toolResults.find((e) => e.tool === "Bash");
    t.assert.notEqual(bash, undefined, "the command really ran");
    t.assert.equal(bash?.isError, true, "and it really exited nonzero");
    t.assert.match(
      bash?.resultPreview ?? "",
      /exit code 1/,
      "the shell reported the exit code, so this is a command that RAN and failed — not one the schema turned away before it ever started",
    );
    t.assert.equal(existsSync(target), true, "with source changed in the same turn");

    t.assert.equal(engine.provider.requests.length, 3, "the batch, the attempt to end, and the recovery nudge's round — no evidence round");
    t.assert.deepEqual(this.evidenceReminders(engine.provider.requests[2]?.messages ?? []), [], "a failed run is a run: the floor stays quiet");
    t.assert.equal(turn.notes.includes(EVIDENCE_NOTE), false, "and nothing is announced to the user");
    t.assert.equal(turn.stopReason, "end_turn");
  }
}

class DocumentationAloneLeavesTheFloorQuiet extends FloorTest {
  readonly id = "a-turn-that-only-wrote-documentation-ends-with-no-extra-model-call";
  readonly whyItExists =
    "a turn that edited only a changelog paid a full extra round trip to be told to go and run the changelog, which is latency spent on nothing and the exact ritual the reminders are written to avoid";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const notes = this.abs("docs", "notes.md");

    const engine = await this.boot([
      { toolCalls: [{ id: "w1", name: "Write", input: { file_path: notes, content: "# notes\n\nsome prose.\n" } }] },
      { text: "documented", stopReason: "end_turn" },
    ]);

    const turn = await engine.runTurn("write the note");

    t.assert.deepEqual([...turn.errors], [], "the script was not short — no fourth call was ever asked for");
    t.assert.equal(existsSync(notes), true, "the note was written");
    t.assert.equal(engine.provider.requests.length, 2, "two model calls: the Write and the reply. The floor bought nothing");
    t.assert.deepEqual(this.evidenceReminders(engine.provider.requests[1]?.messages ?? []), []);
    t.assert.equal(turn.notes.includes(EVIDENCE_NOTE), false);
    t.assert.equal(turn.stopReason, "end_turn");
  }
}

class AWriteThatFailedChangedNothingToVerify extends FloorTest {
  readonly id = "a-write-refused-by-the-freshness-check-does-not-count-as-a-changed-file";
  readonly whyItExists =
    "a Write that came back as an error still marked its file as changed, so the turn was reminded to go and observe a change that had never been made and the agent went looking for behaviour that was not there";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const target = this.abs("src", "a.ts");
    const original = "export const a = 1;\n";
    this.writeFile(target, original);

    const engine = await this.boot([
      // Overwriting a file this session never Read is refused by the Write
      // tool's own freshness check.
      { toolCalls: [{ id: "w1", name: "Write", input: { file_path: target, content: "export const a = 2;\n" } }] },
      { text: "that did not work", stopReason: "end_turn" },
      { text: "I will leave it alone.", stopReason: "end_turn" },
    ]);

    const turn = await engine.runTurn("bump the constant");

    t.assert.deepEqual([...turn.errors], []);
    const write = turn.toolResults.find((e) => e.tool === "Write");
    t.assert.equal(write?.isError, true, "the Write was refused");
    t.assert.equal(readFileSync(target, "utf8"), original, "and the file on disk is untouched, so there is nothing to observe");

    t.assert.equal(engine.provider.requests.length, 3, "the Write, the attempt to end, and the failed-batch recovery nudge — no evidence round");
    t.assert.deepEqual(this.evidenceReminders(engine.provider.requests[2]?.messages ?? []), []);
    t.assert.equal(turn.notes.includes(EVIDENCE_NOTE), false);
  }
}

registerFeatureTests(
  new TheReminderAsksForARunAndCarriesItsThreeSlots(),
  new TheTwoVisionClausesSayOppositeThings(),
  new ATurnThatWroteCodeAndRanNothingIsRemindedOnce(),
  new OnlyRunnableSuffixesWakeTheFloor(),
  new PastEightFilesTheRestAreCounted(),
  new ACommandThatFailedIsStillAnObservation(),
  new DocumentationAloneLeavesTheFloorQuiet(),
  new AWriteThatFailedChangedNothingToVerify(),
);
