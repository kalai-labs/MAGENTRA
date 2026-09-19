/**
 * `prompt-registry`.
 *
 * Every piece of model-facing prose the engine sends is declared once with
 * `definePrompt`, which gives it a stable id, a group and an override file.
 * The override is a plain `<id>.txt` in `promptsDir()`, re-read live behind a
 * 250 ms cache — so tuning a prompt takes effect on the next turn rather than
 * on the next restart. An EMPTY override is not "no override": it switches the
 * prompt off, and anything that drives a model call must then cancel the call
 * rather than send it with the instructions removed.
 *
 * `fs`, as the record declares. Every class here writes real `.txt` files into
 * a real directory that `MAGENTRA_PROMPTS_DIR` points the registry at, and the
 * disabled-prompt class boots a real Engine on the scripted provider. The cache
 * is why nothing here sleeps a fixed time: {@link pollUntil} re-asks until the
 * registry reports the change, and FAILS at its deadline.
 *
 * ONE CHECKLIST ITEM IS NOT REGISTERED, and it is not an omission. Item 1 asks
 * that `promptCatalog()` hold "exactly 43 entries ... and 7 distinct groups".
 * With `@magentra/core`, `@magentra/tools` and `@magentra/protocol` imported the
 * catalog holds 46, in 6 groups; group 7 is the per-tool descriptions, which
 * register when `createDefaultRegistry()` runs and bring it to 73 in 7 groups.
 * The spec and the code disagree on a number, which is a record to reconcile
 * rather than an assertion to adjust, so that item is reported instead of
 * written. (2026-09-19.)
 *
 * TWO CORRECTIONS TO THE DESCRIPTION, followed rather than reinterpreted:
 * `Engine.send` does NOT route a `user_message` beginning with "/" to
 * `handleSlash` — only the scheduler's `enqueue` does (engine.ts ~194). The
 * frontend request for a command is `slash_command`, which is what the fourth
 * class sends. And the class that probes duplicate ids registers
 * `test.duplicate-probe` permanently in this process's registry; nothing in
 * this file counts the catalog, so it cannot move another class's answer.
 *
 * Each class owns a FRESH prompts directory and a DIFFERENT prompt id, because
 * the override cache is keyed by id alone: two classes tuning one id through
 * two directories would read each other's 250 ms window.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  definePrompt,
  isPromptDisabled,
  orphanedPromptFiles,
  promptCatalog,
  promptFile,
  promptText,
  promptTextIfEnabled,
  writePromptOverride,
} from "@magentra/protocol";
// Imported for their registrations: the prompts these tests tune are declared
// next to the code that sends them, in core.
import "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "prompt-registry";

/** Verbatim from the record. */
const INVARIANT =
  "All 43 registered prompts appear in the catalog, an override file is re-read live, and emptying a prompt cancels its inference round rather than sending a blank message.";

/**
 * Re-ask until the registry reflects the file, or fail at the deadline.
 *
 * `overrideText` trusts a resolved value for CACHE_TTL_MS (250 ms), so a write
 * is not visible immediately. A fixed sleep would be a guess in both
 * directions; this is the poll the cache actually requires, and its timeout is
 * a failure, never a shrug.
 */
async function pollUntil(ready: () => boolean, what: string, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`waited ${deadlineMs}ms for ${what}, and it never happened`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

abstract class PromptRegistryTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A directory of this test's own that the registry reads overrides from. */
  protected promptsDirectory(): string {
    this.redirectHome();
    const dir = this.tempDir("magentra-prompts-");
    this.setEnv("MAGENTRA_PROMPTS_DIR", dir);
    return dir;
  }

  /** The shipped text of a prompt, read from the catalog rather than retyped. */
  protected defaultTextOf(id: string): string {
    const entry = promptCatalog().find((e) => e.id === id);
    if (!entry) throw new Error(`no prompt "${id}" is registered; the catalog holds ${promptCatalog().length} entries`);
    return entry.defaultText;
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AnOverrideIsRereadLive extends PromptRegistryTest {
  readonly id = "an-override-file-is-picked-up-without-a-restart-and-deleting-it-restores-the-default";
  readonly whyItExists =
    "the override was resolved once at import time, so a tuned prompt did nothing until the engine was restarted and an operator iterating on wording was editing a file nobody re-read";

  /** A plain system section: long-lived, and not the one any other class here touches. */
  static readonly ID = "system.git";

  override async run(t: TestRun): Promise<void> {
    const dir = this.promptsDirectory();
    const id = AnOverrideIsRereadLive.ID;
    const shipped = this.defaultTextOf(id);
    t.assert.equal(promptText(id), shipped, "with no file present the shipped text is what is in force");
    t.assert.equal(promptFile(id), join(dir, `${id}.txt`), "the override file is <promptsDir>/<id>.txt");

    const tuned = "Never touch the index without saying so first.";
    this.writeFile(promptFile(id), tuned);
    await pollUntil(() => promptText(id) === tuned, `the override of ${id} to be re-read`);

    const overridden = promptCatalog().find((e) => e.id === id)!;
    t.assert.equal(overridden.currentText, tuned, "the catalog reports the text actually in use");
    t.assert.equal(overridden.overridden, true);
    t.assert.equal(overridden.disabled, false, "a non-blank override is a replacement, not a switch-off");
    t.assert.equal(overridden.defaultText, shipped, "and it still knows what was shipped");

    rmSync(promptFile(id));
    await pollUntil(() => promptText(id) === shipped, `${id} to fall back to its default after the file was removed`);
    t.assert.equal(promptCatalog().find((e) => e.id === id)!.overridden, false, "removing the file is how a prompt is reset");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnEmptyOverrideSwitchesAPromptOff extends PromptRegistryTest {
  readonly id = "an-empty-override-file-switches-the-prompt-off";
  readonly whyItExists =
    "an emptied override read as 'no override', so clearing the box in the editor silently restored the shipped text instead of switching the prompt off, and there was no way to remove a reminder at all";

  /** A reminder, so the disabled state is proven on a different channel from the section above. */
  static readonly ID = "reminder.wrapup-nudge";

  override async run(t: TestRun): Promise<void> {
    this.promptsDirectory();
    const id = AnEmptyOverrideSwitchesAPromptOff.ID;
    t.assert.equal(isPromptDisabled(id), false, "a prompt with no override file is on");

    this.writeFile(promptFile(id), "");
    await pollUntil(() => isPromptDisabled(id), `${id} to be seen as switched off`);

    t.assert.equal(promptTextIfEnabled(id), undefined, "the caller that drives a model call is told 'do not run'");
    t.assert.equal(promptText(id), "", "the raw text really is empty, not the default");
    const entry = promptCatalog().find((e) => e.id === id)!;
    t.assert.equal(entry.disabled, true, "and the catalog says disabled, so an editor can show it switched off");
    t.assert.equal(entry.overridden, true, "blank is an override, not the absence of one");

    // Whitespace counts as blank too — a box cleared to a newline is cleared.
    this.writeFile(promptFile(id), "   \n");
    await pollUntil(() => isPromptDisabled(id), `${id} to stay off for a whitespace-only override`);
    t.assert.equal(promptTextIfEnabled(id), undefined);

    rmSync(promptFile(id));
    await pollUntil(() => !isPromptDisabled(id), `${id} to come back on once the file is gone`);
    t.assert.equal(promptText(id), this.defaultTextOf(id));
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ADisabledPromptCancelsItsModelCall extends PromptRegistryTest {
  readonly id = "disabling-the-compaction-prompt-cancels-the-summariser-call-instead-of-blanking-it";
  readonly whyItExists =
    "an emptied compaction.system still ran the summarizer with no instructions, so a full model call was paid for and the whole conversation was replaced by whatever a model returns when asked nothing";

  /** The real id from session.ts, guarded there by `isPromptDisabled(COMPACTION_SYSTEM)`. */
  static readonly ID = "compaction.system";

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
    this.#engine = undefined;
  }

  override async run(t: TestRun): Promise<void> {
    this.promptsDirectory();
    const id = ADisabledPromptCancelsItsModelCall.ID;
    const workspace = this.tempDir("magentra-compact-ws-");

    // Three scripted calls: two ordinary turns, and ONE summarizer call — which
    // may only be consumed by the /compact that runs with the prompt enabled.
    const engine = await startScriptedEngine({
      workspace,
      turns: [{ text: "first reply" }, { text: "second reply" }, { text: "THE SUMMARY" }],
    });
    this.#engine = engine;

    // `idle()` after every turn: `busy` clears one microtask AFTER
    // `turn_finished`, so a request sent on the event alone is refused as busy.
    await engine.runTurn("hello");
    await engine.engine.idle();
    await engine.runTurn("again");
    await engine.engine.idle();
    t.assert.equal(engine.provider.requests.length, 2, "two turns are two model calls, and nothing else has been sent");

    // Switch compaction off and compact a history that is long enough to compact.
    this.writeFile(promptFile(id), "");
    await pollUntil(() => isPromptDisabled(id), `${id} to be seen as switched off`);
    await engine.engine.idle();

    engine.send({ type: "slash_command", command: "compact" });
    const refused = await engine.waitFor(
      (e) => e.type === "command_output" && e.text.includes("compaction is switched off (compaction.system is empty)"),
    );
    t.assert.equal(refused.type, "command_output", "the session says why it declined rather than compacting silently");
    await engine.waitFor((e) => e.type === "command_output" && e.text === "Nothing to compact yet.");
    t.assert.equal(engine.provider.requests.length, 2, "the summarizer call was CANCELLED, not sent with an empty system prompt");
    t.assert.deepEqual(
      engine.events.filter((e) => e.type === "error").map((e) => (e.type === "error" ? e.message : "")),
      [],
      "and nothing failed on the way",
    );

    // Switch it back on: the same history, the same command, and now the call
    // really does happen — which is what makes the assertion above mean
    // "cancelled" rather than "there was nothing to do".
    rmSync(promptFile(id));
    await pollUntil(() => !isPromptDisabled(id), `${id} to come back on`);
    await engine.engine.idle();

    engine.send({ type: "slash_command", command: "compact" });
    await engine.waitFor((e) => e.type === "command_output" && e.text === "Conversation compacted.");
    t.assert.equal(engine.provider.requests.length, 3, "with the prompt in force the summarizer IS called");
    t.assert.equal(engine.provider.requests[2]!.system, this.defaultTextOf(id), "and it is called with the prompt's text");
    t.assert.deepEqual(
      engine.events.filter((e) => e.type === "error").map((e) => (e.type === "error" ? e.message : "")),
      [],
      "the script was never exhausted",
    );
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class OrphansResetsAndDuplicates extends PromptRegistryTest {
  readonly id = "orphan-files-are-listed-a-reset-deletes-the-file-and-a-duplicate-id-throws";
  readonly whyItExists =
    "an override for a prompt that had been renamed away sat in the directory doing nothing and was invisible, while two prompts sharing an id made the editor lie about which one a file was tuning";

  /** A third id, so this class's override cannot collide with the two above. */
  static readonly ID = "system.code-style";

  override async run(t: TestRun): Promise<void> {
    const dir = this.promptsDirectory();
    const id = OrphansResetsAndDuplicates.ID;
    const shipped = this.defaultTextOf(id);

    // A live override, an override for an id that no longer exists, and a file
    // that is not an override at all.
    writePromptOverride(id, "Prefer three-space indentation, obviously.");
    t.assert.equal(existsSync(promptFile(id)), true, "writePromptOverride stores a genuine change");
    this.writeFile(join(dir, "no.such.prompt.txt"), "left over from an older build");
    this.writeFile(join(dir, "notes.md"), "not an override");

    t.assert.deepEqual(
      orphanedPromptFiles(),
      [join(dir, "no.such.prompt.txt")],
      "only the .txt whose id is not registered is an orphan — not the live override, not the other file",
    );

    // Writing the shipped text back is a RESET: the file goes away, so "edited
    // back to the original" and "never edited" are one state.
    writePromptOverride(id, shipped);
    t.assert.equal(existsSync(promptFile(id)), false, "a default-valued override is removed, never stored as a copy");
    await pollUntil(() => promptText(id) === shipped, `${id} to read as its default again`);
    t.assert.equal(promptCatalog().find((e) => e.id === id)!.overridden, false);

    // Two prompts cannot share an override file. The same id with the SAME text
    // is the idempotent re-registration a per-session registry depends on.
    const probe = { id: "test.duplicate-probe", group: "z · test", label: "probe", channel: "system" as const, where: "a test", text: "one" };
    t.assert.equal(definePrompt(probe), "test.duplicate-probe", "a first registration returns the id");
    t.assert.equal(definePrompt({ ...probe }), "test.duplicate-probe", "re-registering identical text is not a clash");
    t.assert.throws(
      () => definePrompt({ ...probe, text: "two" }),
      /duplicate prompt id: test\.duplicate-probe/,
      "a second prompt claiming the id with different text must throw",
    );

    rmSync(join(dir, "no.such.prompt.txt"));
    t.assert.deepEqual(orphanedPromptFiles(), [], "and removing the stale file clears the report");
  }
}

registerFeatureTests(
  new AnOverrideIsRereadLive(),
  new AnEmptyOverrideSwitchesAPromptOff(),
  new ADisabledPromptCancelsItsModelCall(),
  new OrphansResetsAndDuplicates(),
);
