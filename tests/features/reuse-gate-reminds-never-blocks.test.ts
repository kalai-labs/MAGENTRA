/**
 * `reuse-gate-reminds-never-blocks`.
 *
 * When the model Writes a brand-new source file, the engine asks — with no
 * model call — whether code by a similar name already exists and whether
 * anything related was searched or read this session. If it does and nothing
 * was, a reminder listing the closest matches rides along with the Write. The
 * Write itself always runs: the gate's result type has two shapes, `pass` and
 * `remind`, and neither of them is an error. A silent refusal was the root of
 * "it suddenly stops", so the signal survives and the refusal does not.
 *
 * `fs`, and the record said `pure`. Re-declared 2026-09-20: `evaluateReuseGate`
 * is documented as pure and is pure in its arithmetic, but step 5 of its own
 * decision table is `existsSync(abs)` and step 3 is a path judged against a
 * real workspace root — so "pass for an existing file", "pass under
 * node_modules" and "pass outside the cwd" are all claims about a directory
 * that has to be there. Every case below runs against a real temp workspace
 * whose files this test wrote, and the index they are judged against is built
 * by the shipped `buildSymbolIndex` over those same files. Item 2 boots the
 * real Engine on that workspace and lets the real Write tool land real bytes.
 *
 * TWO NAMES CHANGED FROM THE CHECKLIST, for a reason the code decides: the
 * checklist's `fooHelper` tokenizes to `["foo"]`, because `helper` is one of
 * `symbols.ts`'s STOPWORDS — the evidence in item 3 would then be a match on a
 * single three-letter token. The pair used here is `formatUser` against an
 * existing `src/userFormatter.ts`, which is the exact-name match the gate is
 * for.
 *
 * ONE CLAUSE IS NOT PROVEN HERE, and it is not skipped: item 5's second half
 * asks what `Session.evaluateWriteReuseGate` does with an input whose
 * `file_path`/`content` are not strings. That method is private, and the guard
 * is unreachable from the observable surface — `executeToolCalls` hands it
 * `parsed.data`, already through `writeTool.inputSchema`, so a non-string never
 * arrives. Asserting it would mean reaching inside the class, which proves the
 * shape of the code rather than the behaviour of the feature.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SearchLog,
  buildSymbolIndex,
  evaluateReuseGate,
  type ReuseGateResult,
  type Settings,
  type SymbolIndexData,
} from "@magentra/core";
import type { ContentBlock, Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "reuse-gate-reminds-never-blocks";

/** Verbatim from the record. */
const INVARIANT =
  "A would-be new-file Write becomes a reminder, never a block: the signal survives, the refusal does not.";

/** The shipped defaults, as `settings.ts` declares them. */
const CFG: Settings["reuseCheck"] = { mode: "remind", maxHits: 5, blockThreshold: 0.75, remindThreshold: 0.5 };

/** The file already in the workspace, and the one the model is about to write. */
const EXISTING = join("src", "userFormatter.ts");
const EXISTING_BODY = "export function formatUser(user: string): string {\n  return user.trim();\n}\n";
const NEW_BODY = "export function formatUser(user: string): string {\n  return user.toUpperCase();\n}\n";

abstract class ReuseGateTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #engine: ScriptedEngine | undefined;
  #workspace: string | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  protected get workspace(): string {
    if (this.#workspace === undefined) throw new Error("makeWorkspace() has not run yet");
    return this.#workspace;
  }

  /** A workspace holding one existing source file the gate can match against. */
  protected makeWorkspace(): string {
    this.redirectHome();
    this.#workspace = this.tempDir("magentra-reuse-");
    this.writeFile(join(this.#workspace, EXISTING), EXISTING_BODY);
    return this.#workspace;
  }

  /** The real symbol index over that workspace — no hand-built fixture. */
  protected index(): SymbolIndexData {
    return buildSymbolIndex(this.workspace);
  }

  /** The gate, with the collaborators the Session passes it. */
  protected evaluate(
    filePath: string,
    content: string,
    opts: {
      cfg?: Settings["reuseCheck"];
      searchLog?: SearchLog;
      wasRead?: (path: string) => boolean;
      loadIndex?: () => SymbolIndexData;
    } = {},
  ): ReuseGateResult {
    return evaluateReuseGate(
      this.workspace,
      filePath,
      content,
      opts.cfg ?? CFG,
      opts.searchLog ?? new SearchLog(),
      opts.wasRead ?? (() => false),
      opts.loadIndex ?? (() => this.index()),
    );
  }

  protected async boot(turns: readonly FakeTurn[]): Promise<ScriptedEngine> {
    this.#engine = await startScriptedEngine({ workspace: this.workspace, turns: [...turns] });
    return this.#engine;
  }

  /** A real Engine boots and runs a turn in two of these. */
  override readonly timeoutMs: number = 60_000;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheResultIsNeverAnError extends ReuseGateTest {
  readonly id = "a-near-duplicate-with-no-evidence-produces-a-remind-and-nothing-that-could-be-an-error";
  readonly whyItExists =
    "the gate used to answer with a third shape that the Session mapped onto an isError tool result, so a Write of a file that merely resembled an existing one came back to the model as a failure it could not explain and the turn stopped dead";

  override run(t: TestRun): void {
    this.makeWorkspace();
    const target = join("src", "formatUser.ts");

    const result = this.evaluate(target, NEW_BODY);
    t.assert.equal(result.kind, "remind", "similar code exists and nothing related was searched");
    const text = result.kind === "remind" ? result.text : "";
    t.assert.equal(text.startsWith("Reuse check:"), true, "the reminder announces itself as the reuse check");
    t.assert.match(text, /src\/userFormatter\.ts/, "and names the closest existing match, so the model can go and read it");

    // The result type has exactly two shapes, and neither carries anything a
    // caller could map onto a failure.
    t.assert.deepEqual(Object.keys(result).sort(), ["kind", "text"], "a remind is a kind and a text, nothing else");
    t.assert.equal("isError" in result, false);
    t.assert.equal("error" in result, false);
    t.assert.equal("blocked" in result, false);

    const passing = this.evaluate(join("src", "unrelatedThing.ts"), "export const unrelatedThing = 1;\n");
    t.assert.equal(passing.kind, "pass", "nothing similar enough, nothing to say");
    t.assert.deepEqual(Object.keys(passing), ["kind"], "a pass is a kind alone");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheWriteRunsAndTheReminderRidesAlong extends ReuseGateTest {
  readonly id = "the-write-lands-on-disk-and-the-same-user-message-carries-the-reuse-reminder";
  readonly whyItExists =
    "the reuse check refused the Write: the model got a tool error for a file it was asked to create, the file never appeared, and the user saw the agent stop with no reason given";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const target = join(this.workspace, "src", "formatUser.ts");

    // Three model calls: the Write, the reply that tries to end the turn, and
    // the one after the runtime-evidence rung (a code file changed, no command ran).
    const engine = await this.boot([
      { toolCalls: [{ id: "write_1", name: "Write", input: { file_path: target, content: NEW_BODY } }] },
      { text: "written", stopReason: "end_turn" },
      { text: "I could not run it here.", stopReason: "end_turn" },
    ]);

    const turn = await engine.runTurn("add a user formatter");
    t.assert.deepEqual(turn.errors, [], "the turn raised nothing");

    const write = turn.toolResults.find((e) => e.tool === "Write");
    t.assert.notEqual(write, undefined, "the Write ran");
    t.assert.equal(write?.isError, false, "and it did not come back as an error");

    t.assert.equal(existsSync(target), true, "the file is on disk");
    t.assert.equal(readFileSync(target, "utf8"), NEW_BODY, "with exactly what the model asked for");

    // `provider.requests[n].messages` is the LIVE history, so the reminder is
    // located by the message that carries THIS call's tool_result, not by
    // taking the tail after the turn has grown the array.
    const history = engine.provider.requests[1]?.messages;
    t.assert.notEqual(history, undefined, "the model was called again after the Write");
    const carrier = (history as Msg[]).find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result" && b.toolUseId === "write_1"),
    );
    t.assert.notEqual(carrier, undefined, "the Write's result went back to the model");

    const result = carrier?.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result" && b.toolUseId === "write_1",
    );
    t.assert.notEqual(result?.isError, true, "the result block the model reads is not an error either");

    const texts = (carrier?.content ?? []).filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : ""));
    const reminder = texts.find((text) => text.includes("Reuse check:"));
    t.assert.notEqual(reminder, undefined, "the same message carries the reuse reminder");
    t.assert.match(reminder ?? "", /<system-reminder>/, "wrapped as a harness injection, not as the user's own words");
    t.assert.match(reminder ?? "", /src\/userFormatter\.ts/, "naming the existing file to read");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class EvidenceOfASearchIsEnough extends ReuseGateTest {
  readonly id = "a-related-term-searched-this-session-turns-the-same-write-into-a-pass";
  readonly whyItExists =
    "the reminder fired on every new file regardless of what the agent had already looked at, so a turn that had just grepped for the very symbol was told to go and search for it";

  override run(t: TestRun): void {
    this.makeWorkspace();
    const target = join("src", "formatUser.ts");
    t.assert.equal(this.evaluate(target, NEW_BODY).kind, "remind", "without evidence it reminds");

    const searched = new SearchLog();
    searched.record(["formatUser"]);
    t.assert.equal(this.evaluate(target, NEW_BODY, { searchLog: searched }).kind, "pass", "the search is the evidence");

    // The overlap is on tokens, not on the literal term — a Grep for the
    // existing file's own name counts too.
    const other = new SearchLog();
    other.record(["userFormatter"]);
    t.assert.equal(this.evaluate(target, NEW_BODY, { searchLog: other }).kind, "pass", "the same tokens, either order");

    // And an unrelated search is not evidence, or the gate would never fire.
    const unrelated = new SearchLog();
    unrelated.record(["database connection pool"]);
    t.assert.equal(this.evaluate(target, NEW_BODY, { searchLog: unrelated }).kind, "remind");

    // Reading one of the matches is the other form of evidence (step 9).
    const read = join(this.workspace, EXISTING);
    t.assert.equal(this.evaluate(target, NEW_BODY, { wasRead: (p) => p === read }).kind, "pass", "already read it");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheCasesThatAreNoneOfItsBusiness extends ReuseGateTest {
  readonly id = "overwrites-tests-non-source-vendored-and-out-of-tree-paths-all-pass";
  readonly whyItExists =
    "the gate fired on a test file named after the module it tests, on a README, and on an overwrite of a file the agent had just read — every one of them a reminder to reuse code that was already the code being reused";

  override run(t: TestRun): void {
    const workspace = this.makeWorkspace();
    const outside = this.tempDir("magentra-outside-");

    // The control: the one path that must remind, so a blanket pass is visible.
    t.assert.equal(this.evaluate(join("src", "formatUser.ts"), NEW_BODY).kind, "remind");

    const passes: [string, string][] = [
      [join(workspace, EXISTING), "an existing file is an overwrite, not a new file"],
      [join("src", "formatUser.test.ts"), "a .test. file"],
      [join("tests", "formatUser.ts"), "anything under tests/"],
      [join("src", "formatUser.md"), "not a scanned source extension"],
      [join("src", "formatUser.json"), "nor is JSON"],
      [join("node_modules", "formatUser.ts"), "vendored code is nobody's to reuse"],
      [join(outside, "formatUser.ts"), "a path outside the workspace"],
    ];
    for (const [path, why] of passes) {
      t.assert.equal(this.evaluate(path, NEW_BODY).kind, "pass", why);
    }

    t.assert.equal(
      this.evaluate(join("src", "formatUser.ts"), NEW_BODY, { cfg: { ...CFG, mode: "off" } }).kind,
      "pass",
      "and the whole check is switchable off",
    );
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AThrowingIndexIsAPass extends ReuseGateTest {
  readonly id = "an-index-that-throws-is-a-pass-so-the-write-is-never-affected";
  readonly whyItExists =
    "an unreadable or half-written symbol index threw out of the gate and out of the tool call with it, turning a workspace-level indexing problem into a failed Write the model had no way to interpret";

  override run(t: TestRun): void {
    this.makeWorkspace();
    const target = join("src", "formatUser.ts");
    t.assert.equal(this.evaluate(target, NEW_BODY).kind, "remind", "the same call reminds when the index loads");

    const boom = (): SymbolIndexData => {
      throw new Error("EIO: the index could not be read");
    };
    const result = this.evaluate(target, NEW_BODY, { loadIndex: boom });
    t.assert.equal(result.kind, "pass", "a throwing index fails open");
    t.assert.deepEqual(Object.keys(result), ["kind"], "and fails open as a plain pass, carrying no error");

    // Uncertainty anywhere later resolves the same way: an index with no files
    // in it has nothing to match, and still never blocks.
    const empty = this.evaluate(target, NEW_BODY, { loadIndex: () => ({ version: 2, files: {} }) });
    t.assert.equal(empty.kind, "pass");
  }
}

registerFeatureTests(
  new TheResultIsNeverAnError(),
  new TheWriteRunsAndTheReminderRidesAlong(),
  new EvidenceOfASearchIsEnough(),
  new TheCasesThatAreNoneOfItsBusiness(),
  new AThrowingIndexIsAPass(),
);
