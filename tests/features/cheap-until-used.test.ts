/**
 * `cheap-until-used`.
 *
 * The standing system prompt lists installed addons as `- name: description`
 * lines and nothing more. An addon's BODY — the procedure — enters the
 * conversation only when the Addon tool or `/<name>` invokes it. Every request
 * re-sends the system prompt, so a body riding in it would be paid on every
 * turn of every session whether or not the addon was ever used.
 *
 * `pure` + `fs`, and the record said `pure`. Items 1, 2 and 5 are the prompt
 * builder as a function of its arguments. Items 3 and 4 are the claim that
 * matters — what the model is actually SENT — and that is read off the
 * requests a real Engine on a scripted provider makes, with a real addon
 * loaded from a workspace directory by the real loader. Re-declared 2026-09-19.
 *
 * The scripted provider is the only double here, and nothing asserts on what
 * it returned: the assertions are about `requests[n].system` and the tool
 * result the real Addon tool produced.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { addonsBlock, buildSystemPrompt, loadAddons, type PromptEnvironment } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "cheap-until-used";

/** Verbatim from the record. */
const INVARIANT = "Only names and descriptions enter the standing system prompt; no addon body ever rides in it.";

const ENV: PromptEnvironment = { cwd: "/w", isGitRepo: false, platform: "linux", model: "m", date: "2026-09-19" };

/** A sentence that appears nowhere else, so its presence anywhere is unambiguous. */
const SENTINEL = "the-quokka-recites-the-seventeenth-stanza-backwards";

abstract class PromptBuilderTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class NoAddonsMeansNoHeader extends PromptBuilderTest {
  readonly id = "with-no-addons-there-is-no-available-addons-header";
  readonly whyItExists = "an 'Available addons' header over an empty list sent the model looking for procedures that did not exist";

  override run(t: TestRun): void {
    t.assert.equal(addonsBlock([]), undefined);
    const prompt = buildSystemPrompt({ env: ENV });
    t.assert.equal(prompt.includes("Available addons"), false);
    t.assert.equal(buildSystemPrompt({ env: ENV, addons: [] }).includes("Available addons"), false);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheRosterLineIsNameColonDescription extends PromptBuilderTest {
  readonly id = "an-addon-renders-as-a-single-name-colon-description-line";
  readonly whyItExists = "a roster that rendered the description on its own line made the model read it as a standing instruction rather than as the condition for loading the addon";

  override run(t: TestRun): void {
    const prompt = buildSystemPrompt({ env: ENV, addons: [{ name: "x", description: "d" }] });
    t.assert.ok(prompt.includes("\n- x: d"), "exactly `- x: d`, on its own line");
    t.assert.ok(prompt.includes("Available addons"), "under the header");
    const two = addonsBlock([
      { name: "a", description: "first" },
      { name: "b", description: "second" },
    ]);
    t.assert.ok(two?.endsWith("- a: first\n- b: second"), "one line per addon, in order, and nothing after the list");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class UndefinedAndEmptyAreTheSamePrompt extends PromptBuilderTest {
  readonly id = "no-addons-argument-and-an-empty-roster-build-the-identical-prompt";
  readonly whyItExists = "an embedder that never loads addons and a workspace with none must send the same prompt, or the two configurations behave differently for no reason anyone chose";

  override run(t: TestRun): void {
    t.assert.equal(buildSystemPrompt({ env: ENV }), buildSystemPrompt({ env: ENV, addons: [] }));
  }
}

/* ---- checklist 3 and 4 — fs ------------------------------------------ */

abstract class LiveAddonTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  /** A workspace with one flat addon whose body carries the sentinel, loaded by the real loader. */
  protected async engineWithProbe(turns: Parameters<typeof startScriptedEngine>[0]["turns"]): Promise<ScriptedEngine> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-cheap-");
    const dir = join(workspace, ".magentra", "addons");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "probe.md"), `---\nname: probe\ndescription: a probe for the prompt\n---\nWhen invoked, ${SENTINEL}.\n`, "utf8");
    const addons = loadAddons(workspace);
    if (!addons.some((a) => a.name === "probe" && a.body.includes(SENTINEL))) throw new Error(`the loader did not pick up the probe addon: ${addons.map((a) => a.name).join(", ")}`);
    this.#engine = await startScriptedEngine({ workspace, turns, addons });
    return this.#engine;
  }
}

class TheBodyIsNotInTheStandingPrompt extends LiveAddonTest {
  readonly id = "the-first-request-names-and-describes-the-addon-but-never-carries-its-body";
  readonly whyItExists = "an addon body in the system prompt was billed on every request of every session, and a long procedure crowded out the context it was meant to save";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engineWithProbe([{ text: "hello" }]);
    await engine.runTurn("hi");
    const first = engine.provider.requests[0];
    t.assert.notEqual(first, undefined, "the model was called");
    t.assert.ok(first!.system.includes("- probe: a probe for the prompt"), "the name and description are in the standing prompt");
    t.assert.equal(first!.system.includes(SENTINEL), false, "the body is NOT");
    t.assert.equal(JSON.stringify(first!.messages).includes(SENTINEL), false, "and it is not smuggled into the messages either");
  }
}

class InvokingPaysForTheBodyOnce extends LiveAddonTest {
  readonly id = "the-addon-tool-result-carries-the-body-while-the-next-system-prompt-still-does-not";
  readonly whyItExists = "the body must enter the conversation as a TOOL RESULT the transcript can show, never by leaking into the standing prompt after the first use";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engineWithProbe([{ toolCalls: [{ name: "Addon", input: { addon: "probe" } }] }, { text: "following it" }]);
    const turn = await engine.runTurn("use the probe");
    t.assert.deepEqual(turn.errors, [], turn.errors.join(" | "));
    const invoked = turn.toolResults.find((r) => r.tool === "Addon");
    t.assert.equal(invoked?.isError, false, "the real Addon tool loaded the real addon");
    t.assert.ok(invoked?.resultPreview.includes("probe"), invoked?.resultPreview);

    const second = engine.provider.requests[1];
    t.assert.notEqual(second, undefined, "there was a second model call after the tool ran");
    const toolResults = second!.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
    t.assert.ok(JSON.stringify(toolResults).includes(SENTINEL), "the body reached the model as the tool result");
    t.assert.equal(second!.system.includes(SENTINEL), false, "and the standing prompt STILL does not carry it");
    t.assert.ok(second!.system.includes("- probe: a probe for the prompt"), "the roster line is unchanged");
  }
}

registerFeatureTests(new NoAddonsMeansNoHeader(), new TheRosterLineIsNameColonDescription(), new TheBodyIsNotInTheStandingPrompt(), new InvokingPaysForTheBodyOnce(), new UndefinedAndEmptyAreTheSamePrompt());
