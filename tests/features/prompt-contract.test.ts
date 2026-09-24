/**
 * `prompt-contract`.
 *
 * OVERDRIVE switches the permission engine off; the prompt has to say so. While
 * it is on, the system prompt carries an extra section — `# OVERDRIVE —
 * fully-autonomous mode` — telling the model the user is not watching, that
 * NOTHING asks, and that only a deny rule the user wrote and a kill by process
 * name can still stop a call.
 * The standing harness section points forward at it ("if an OVERDRIVE section
 * appears, not even on those"), the section is added when the switch goes on
 * and removed when it goes off, and the state change is announced once per real
 * change.
 *
 * `fs` + `pure`, and the record said `pure`. Re-declared 2026-09-20: items 1–4
 * are about the prompt a REQUEST carries and the event a frame produces, and
 * the only honest way to read either is to run the real Engine on a real
 * workspace (it loads settings and standards from it, and `loadSettings` merges
 * `~/.magentra/settings.json`, so HOME is redirected first) and read what the
 * scripted provider was actually sent. Item 5 is `buildSystemPrompt` itself — a
 * function of its argument, and pure.
 *
 * WHERE THE SECTION LIVES. The description names `engine/core/src/agent/
 * prompts.ts` for the harness line and `engine/core/src/runtime/session.ts` for
 * `OVERDRIVE_PROMPT_SECTION`; both still hold, but the section constant is
 * module-private (`definePrompt` output, not exported), so its text is asserted
 * by the two sentences the feature promises rather than by identity. The switch
 * is thrown over the protocol (`set_overdrive`), which is how the desktop app,
 * the TUI and `/overdrive` all reach `Session.setOverdrive`.
 */

import { SECTION_HARNESS, buildSystemPrompt, environmentBlock } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "prompt-contract";

/** Verbatim from the record. */
const INVARIANT = "The OVERDRIVE stance is stated in the prompt, so the model knows nothing will stop to ask.";

/** The section's own heading — what "present exactly while ON" is measured by. */
const HEADING = "# OVERDRIVE — fully-autonomous mode";

/** The standing forward reference in the harness section. */
const FORWARD_REFERENCE = "if an OVERDRIVE section appears, not even on those";

/** One scripted assistant turn that ends cleanly, runs no tool, and fires no rung. */
function reply(text: string): FakeTurn {
  return { text, stopReason: "end_turn" };
}

/** Occurrences of `needle` in `haystack`. */
function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

abstract class PromptContractTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A real Engine boots and runs turns. */
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  /** HOME first, then a workspace of this test's own, then the real engine on it. */
  protected async boot(turns: readonly FakeTurn[]): Promise<ScriptedEngine> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-overdrive-");
    this.#engine = await startScriptedEngine({ workspace, turns: [...turns] });
    return this.#engine;
  }

  /** Switch the stance the way every frontend does, once the engine is free. */
  protected async setOverdrive(engine: ScriptedEngine, enabled: boolean): Promise<void> {
    await engine.engine.idle();
    engine.send({ type: "set_overdrive", enabled });
  }

  /** The system prompt of the nth model call the real Session made. */
  protected systemOf(engine: ScriptedEngine, index: number): string {
    const request = engine.provider.requests[index];
    if (request === undefined) {
      throw new Error(`the Session made only ${engine.provider.requests.length} model calls; wanted #${index + 1}`);
    }
    return request.system;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheHarnessLinePointsAtASectionThatIsNotThere extends PromptContractTest {
  readonly id = "while-overdrive-is-off-the-section-is-absent-and-the-harness-line-still-points-at-it";
  readonly whyItExists =
    "the section was appended to the prompt once and never taken back out, so an ordinary attended session was told nothing would ask — and the model deleted files expecting no prompt, while the user was in fact being asked";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.boot([reply("done")]);
    const turn = await engine.runTurn("hello");
    t.assert.equal(turn.stopReason, "end_turn", "the turn ran, so there is a real request to read");

    const system = this.systemOf(engine, 0);
    t.assert.equal(system.includes(HEADING), false, "no OVERDRIVE section while the stance is off");
    t.assert.equal(system.includes("NOTHING asks"), false, "and none of its promises either");

    // The standing line is there in every prompt, pointing at a section that
    // only sometimes exists — that is what makes its absence meaningful.
    t.assert.equal(system.includes(FORWARD_REFERENCE), true, "the harness section forward-references the stance");
    t.assert.equal(
      SECTION_HARNESS.includes(FORWARD_REFERENCE),
      true,
      "and that sentence comes from SECTION_HARNESS, not from somewhere the section could drift away from",
    );
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class SwitchingItOnAddsTheSection extends PromptContractTest {
  readonly id = "switching-overdrive-on-puts-the-section-in-the-next-request-exactly-once";
  readonly whyItExists =
    "the permission engine stopped asking the moment the switch was thrown, but the prompt still promised a confirmation step, so the model paused to ask 'shall I?' in a run nobody was watching";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.boot([reply("first"), reply("second")]);
    await engine.runTurn("before");
    t.assert.equal(this.systemOf(engine, 0).includes(HEADING), false, "off for the first call");

    await this.setOverdrive(engine, true);
    await engine.runTurn("after");

    const system = this.systemOf(engine, 1);
    t.assert.equal(countOf(system, HEADING), 1, "the section is in the next request, once");
    t.assert.equal(countOf(system, "NOTHING asks"), 1, "and says so exactly once — a repeat would mean it was appended twice");
    t.assert.match(
      system,
      /Only two things can still stop a call: a deny rule the user wrote themselves, and a command that stops processes by name/,
      "the remaining refusals are named, so the model does not read a denial as a bug",
    );
    t.assert.equal(
      system.indexOf(FORWARD_REFERENCE) < system.indexOf(HEADING),
      true,
      "the standing line still comes first and now points at a section that is really there",
    );
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class SwitchingItOffRemovesTheSection extends PromptContractTest {
  readonly id = "switching-overdrive-off-takes-the-section-back-out-of-the-following-request";
  readonly whyItExists =
    "the section was only ever added: after one autonomous run every later turn in that session kept telling the model nothing asks, long after the confirmations had come back";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.boot([reply("one"), reply("two")]);

    await this.setOverdrive(engine, true);
    await engine.runTurn("autonomous");
    t.assert.equal(this.systemOf(engine, 0).includes(HEADING), true, "on for the first call");

    await this.setOverdrive(engine, false);
    await engine.runTurn("attended");

    const system = this.systemOf(engine, 1);
    t.assert.equal(system.includes(HEADING), false, "the section is gone again");
    t.assert.equal(system.includes("NOTHING asks"), false);
    t.assert.equal(system.includes(FORWARD_REFERENCE), true, "and the rest of the prompt is untouched");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheStanceIsAnnouncedOncePerRealChange extends PromptContractTest {
  readonly id = "overdrive-changed-is-emitted-once-per-real-change-and-not-for-a-repeat";
  readonly whyItExists =
    "every frontend keys its indicator off this event, so a second `set_overdrive true` that re-announced the same state made the desktop and the TUI flash a stance change that never happened";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.boot([]);

    engine.send({ type: "set_overdrive", enabled: true });
    const on = await engine.waitFor(
      (e): e is Extract<CoreEvent, { type: "overdrive_changed" }> => e.type === "overdrive_changed",
    );
    t.assert.equal(on.enabled, true, "switching it on announces itself");

    // The repeat, then a real change. The queue is FIFO, so the arrival of the
    // `false` event proves the repeat in between produced nothing.
    engine.send({ type: "set_overdrive", enabled: true });
    engine.send({ type: "set_overdrive", enabled: false });
    const off = await engine.waitFor(
      (e): e is Extract<CoreEvent, { type: "overdrive_changed" }> => e.type === "overdrive_changed",
    );
    t.assert.equal(off.enabled, false);

    const announced = engine.events
      .filter((e): e is Extract<CoreEvent, { type: "overdrive_changed" }> => e.type === "overdrive_changed")
      .map((e) => e.enabled);
    t.assert.deepEqual(announced, [true, false], "two real changes, two events — the repeat is not among them");
  }
}

/* ---- checklist 5 — pure ---------------------------------------------- */

class AnExtraSectionLandsAfterTheEnvironment extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "an-extra-section-is-appended-after-the-environment-block-where-the-overdrive-section-lands";
  readonly whyItExists =
    "the extra sections were spliced in ahead of the environment block, so the OVERDRIVE contract arrived before the model had been told the cwd, the platform or the date it was talking about";

  override run(t: TestRun): void {
    const env = {
      cwd: "/ws",
      isGitRepo: true,
      platform: "linux",
      model: "m",
      date: "2026-09-20",
    };
    const block = environmentBlock(env);

    // The checklist writes this section as `X`; a single letter occurs inside
    // the core prompt, so the marker is spelled out to be findable.
    const X = "EXTRA-SECTION-MARKER";
    const withExtra = buildSystemPrompt({ env, extraSections: [X] });
    t.assert.equal(withExtra.includes(block.trim()), true, "the environment block is rendered into the prompt");
    t.assert.equal(withExtra.includes(`\n\n${X}`), true, "the extra section is a paragraph of its own");
    t.assert.equal(
      withExtra.indexOf(X) > withExtra.indexOf(block.trim()),
      true,
      "and it comes after the environment block, never before it",
    );
    t.assert.equal(withExtra.trimEnd().endsWith(X), true, "with nothing of the core prompt after it");

    // Without one, the prompt simply ends at the environment block: the section
    // is appended, not substituted into a slot that is always there.
    const without = buildSystemPrompt({ env });
    t.assert.equal(without.includes(X), false);
    t.assert.equal(without.trimEnd().endsWith(block.trim()), true, "no extra section, no trailing paragraph");

    // Several sections keep their order — the OVERDRIVE section is one entry in
    // that list, and a set of standards is another.
    const two = buildSystemPrompt({ env, extraSections: ["FIRST-MARKER", "SECOND-MARKER"] });
    t.assert.equal(two.indexOf("FIRST-MARKER") < two.indexOf("SECOND-MARKER"), true);
    t.assert.equal(two.indexOf(block.trim()) < two.indexOf("FIRST-MARKER"), true);
  }
}

registerFeatureTests(
  new TheHarnessLinePointsAtASectionThatIsNotThere(),
  new SwitchingItOnAddsTheSection(),
  new SwitchingItOffRemovesTheSection(),
  new TheStanceIsAnnouncedOncePerRealChange(),
  new AnExtraSectionLandsAfterTheEnvironment(),
);
