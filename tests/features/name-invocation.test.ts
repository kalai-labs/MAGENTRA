/**
 * `name-invocation`.
 *
 * Typing `/<addon-name> [args]` runs a turn whose first user message is the
 * addon invocation header plus the addon body — `$ARGUMENTS` substituted, or
 * an `ARGUMENTS:` line appended. Only a name an installed addon owns is
 * treated that way; anything else is `Unknown command: /<name>. Try /help.`,
 * so a typo neither runs something nor disappears.
 *
 * `fs`, and the record said `pure`: the dispatch lives in a running Engine
 * whose roster the real loader reads from `.magentra/addons/`, and the claim
 * is about the request the model then receives — read off the scripted
 * provider's record of what the real Session sent it. Re-declared 2026-09-19.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAddons } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "name-invocation";

/** Verbatim from the record. */
const INVARIANT = "Typing an addon's name runs a turn with its instructions loaded; an unclaimed name stays an unknown command.";

abstract class NameInvocationTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  /** Two flat addons: `foo` with a placeholder, `bar` without. */
  protected async engine(turns: FakeTurn[]): Promise<ScriptedEngine> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-invoke-");
    const dir = join(workspace, ".magentra", "addons");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "foo.md"), "---\nname: foo\ndescription: the foo procedure\n---\nHandle $ARGUMENTS now.\n", "utf8");
    writeFileSync(join(dir, "bar.md"), "---\nname: bar\ndescription: the bar procedure\n---\nBar body.\n", "utf8");
    this.#engine = await startScriptedEngine({ workspace, turns, addons: loadAddons(workspace), permissions: "allow_once" });
    return this.#engine;
  }

  /**
   * Send a slash command and wait for the turn it starts to finish.
   *
   * `idle()` first: `turn_finished` is emitted a microtask BEFORE the engine
   * clears its busy flag, so a command sent the instant that frame arrives is
   * refused as busy — the very behaviour checklist item 5 pins.
   */
  protected async invoke(engine: ScriptedEngine, command: string, args?: string): Promise<void> {
    await engine.engine.idle();
    const before = engine.events.length;
    engine.send({ type: "slash_command", command, ...(args !== undefined ? { args } : {}) });
    await engine.waitFor((e) => e.type === "turn_finished");
    const loaded = engine.events.slice(before).find((e) => e.type === "command_output" && e.text.includes("loaded — following its instructions"));
    if (loaded === undefined) throw new Error(`no "loaded" notice for ${command}`);
  }

  /**
   * The addon text of the most recent model request: the FIRST text block of
   * its user message. The Session appends its own reminders as further text
   * blocks (the plan-first reminder, for one), and those are not the addon's.
   */
  protected lastUserText(engine: ScriptedEngine): string {
    const request = engine.provider.requests.at(-1);
    if (!request) throw new Error("the model was never called");
    // `messages` on a recorded request is the live session history, so the
    // invocation under test is the LAST user message in it, not the first.
    const user = request.messages.filter((m) => m.role === "user").at(-1);
    const first = user?.content.find((b) => b.type === "text");
    return first?.type === "text" ? first.text : "";
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ArgumentsAreSubstitutedIntoTheBody extends NameInvocationTest {
  readonly id = "slash-foo-with-args-starts-a-turn-whose-user-message-is-the-header-plus-the-substituted-body";
  readonly whyItExists = "the slash path and the Addon tool used to build the header separately, and the slash one drifted — the user typing /foo got a weaker version of what the model got";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine([{ text: "done" }]);
    await this.invoke(engine, "/foo", "do x");
    t.assert.equal(engine.provider.requests.length, 1, "one model call for the one turn");
    const text = this.lastUserText(engine);
    t.assert.ok(text.includes("<command-name>/foo</command-name>"), text);
    t.assert.ok(text.includes('The "foo" addon was invoked'), "the invocation header names the addon");
    t.assert.ok(text.includes("Handle do x now."), "the body with the args substituted");
    t.assert.equal(text.includes("$ARGUMENTS"), false);
    t.assert.equal(engine.events.some((e) => e.type === "command_output" && e.text === "🧩 foo loaded — following its instructions."), true);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ArgsWithoutAPlaceholderAreAppended extends NameInvocationTest {
  readonly id = "without-a-placeholder-args-become-a-trailing-arguments-line-and-empty-args-add-nothing";
  readonly whyItExists = "'/bar the auth module' dropped its argument on the floor because the body had nowhere to put it, and the procedure ran on nothing in particular";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine([{ text: "one" }, { text: "two" }]);
    await this.invoke(engine, "/bar", "do x");
    t.assert.ok(this.lastUserText(engine).endsWith("Bar body.\nARGUMENTS: do x"), this.lastUserText(engine));
    await this.invoke(engine, "/bar");
    const bare = this.lastUserText(engine);
    t.assert.ok(bare.endsWith("Bar body."), bare);
    t.assert.equal(bare.includes("ARGUMENTS"), false, "no ARGUMENTS line when none were given");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnUnclaimedNameIsAnUnknownCommand extends NameInvocationTest {
  readonly id = "slash-nope-prints-unknown-command-and-the-model-is-never-called";
  readonly whyItExists = "a typo that fell through to a turn ran the model on the literal text '/nope', which it then tried to explain";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine([]);
    engine.send({ type: "slash_command", command: "/nope" });
    const notice = await engine.waitFor((e): e is Extract<CoreEvent, { type: "command_output" }> => e.type === "command_output");
    t.assert.equal(notice.text, "Unknown command: /nope. Try /help.");
    t.assert.equal(engine.provider.requests.length, 0, "no request reached the model");
    t.assert.equal(engine.events.some((e) => e.type === "turn_started"), false, "and no turn started");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheNameIsMatchedCaseInsensitively extends NameInvocationTest {
  readonly id = "slash-foo-in-capitals-resolves-the-addon-named-foo";
  readonly whyItExists = "an auto-capitalised '/Foo' from a phone keyboard was an unknown command while '/foo' worked, which read as the addon being broken";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine([{ text: "done" }]);
    await this.invoke(engine, "/FOO", "shout");
    t.assert.ok(this.lastUserText(engine).includes("<command-name>/foo</command-name>"), "resolved to the lower-case addon");
    t.assert.ok(this.lastUserText(engine).includes("Handle shout now."));
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ABusyEngineRefusesASecondTurn extends NameInvocationTest {
  readonly id = "while-a-turn-is-running-slash-foo-is-refused-with-the-busy-notice-and-no-second-turn-starts";
  readonly whyItExists = "an addon turn spliced into a running one interleaved two conversations in one history, which the provider then rejected";

  override async run(t: TestRun): Promise<void> {
    // A turn that is genuinely in flight: the model asks the user a question
    // and the turn blocks until it is answered.
    const engine = await this.engine([
      { toolCalls: [{ name: "AskUserQuestion", input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] } }] },
      { text: "thanks" },
    ]);
    engine.send({ type: "user_message", text: "ask me something" });
    const question = await engine.waitFor((e): e is Extract<CoreEvent, { type: "question_request" }> => e.type === "question_request");

    engine.send({ type: "slash_command", command: "/foo", args: "now" });
    const refused = await engine.waitFor((e): e is Extract<CoreEvent, { type: "command_output" }> => e.type === "command_output" && e.text.startsWith("⏳ busy"));
    t.assert.equal(refused.text, "⏳ busy — wait for the current turn to finish before running /foo.");
    t.assert.equal(engine.events.filter((e) => e.type === "turn_started").length, 1, "no second turn started");

    engine.send({ type: "question_response", id: question.id, answers: { "q:0": ["A"] } });
    await engine.waitFor((e) => e.type === "turn_finished");
    t.assert.equal(engine.provider.requests.length, 2, "the running turn's two calls, and none for the refused /foo");
    t.assert.equal(engine.events.some((e) => e.type === "command_output" && e.text.includes("foo loaded")), false, "the addon was never loaded");
  }
}

registerFeatureTests(new ArgumentsAreSubstitutedIntoTheBody(), new ArgsWithoutAPlaceholderAreAppended(), new AnUnclaimedNameIsAnUnknownCommand(), new TheNameIsMatchedCaseInsensitively(), new ABusyEngineRefusesASecondTurn());
