/**
 * `bundled-files`.
 *
 * A directory addon (`.magentra/addons/<name>/ADDON.md`) may ship sibling
 * notes and scripts. The loader records them in `Addon.resources` as paths
 * relative to the workspace — one level of nesting, capped at 24 — and the
 * `Addon` tool lists those paths under the body inside a `<system-reminder>`.
 * The contents are never copied in: the model spends a Read or a Bash call
 * only on the siblings the procedure points at.
 *
 * `fs`, as the record declares. Every item here is a real directory tree on
 * disk read by the real loader; item 2 is the same tree carried through a real
 * Engine turn, because the claim the product owner cares about is what the
 * model is SENT when the addon is invoked in a conversation.
 *
 * The scripted provider is the only double, and nothing asserts on what it
 * returned: the assertions are on the real `Addon` tool's `tool_call_finished`
 * event and on the `tool_result` block in the next request the real Session
 * sent. Paths are built with `path.join`, because `relative()` prints
 * backslashes on Windows and that is what the model is given here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAddons, type Addon } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "bundled-files";

/** Verbatim from the record. */
const INVARIANT = "A directory addon advertises sibling notes and scripts as paths, never inlining their contents.";

/** The one sentence that lives inside `notes/a.md`, so finding it anywhere means the file was inlined. */
const NOTE_SENTINEL = "the-marmot-files-its-quarterly-report-in-triplicate";

abstract class BundledFilesTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #engine: ScriptedEngine | undefined;
  protected workspace = "";

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  /** A workspace with an empty HOME, so only what this test wrote is on the roster. */
  protected freshWorkspace(prefix: string): string {
    this.redirectHome();
    this.workspace = this.tempDir(prefix);
    return this.workspace;
  }

  /** `<workspace>/.magentra/addons`, created. */
  protected addonsDir(): string {
    const dir = join(this.workspace, ".magentra", "addons");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * The `kit` directory addon: an ADDON.md, a reference note carrying
   * {@link NOTE_SENTINEL}, and a script.
   */
  protected writeKit(): void {
    const kit = join(this.addonsDir(), "kit");
    mkdirSync(join(kit, "notes"), { recursive: true });
    mkdirSync(join(kit, "scripts"), { recursive: true });
    writeFileSync(join(kit, "ADDON.md"), "---\nname: kit\ndescription: the kit procedure\n---\nRead notes/a.md, then run scripts/run.sh.\n", "utf8");
    writeFileSync(join(kit, "notes", "a.md"), `Reference note: ${NOTE_SENTINEL}.\n`, "utf8");
    writeFileSync(join(kit, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf8");
  }

  /** The two resources `kit` must advertise, in the order the walk produces them. */
  protected kitResources(): string[] {
    return [join(".magentra", "addons", "kit", "notes", "a.md"), join(".magentra", "addons", "kit", "scripts", "run.sh")];
  }

  protected named(addons: readonly Addon[], name: string): Addon {
    const found = addons.find((a) => a.name === name);
    if (!found) throw new Error(`the loader returned no addon named "${name}" — it returned: ${addons.map((a) => a.name).join(", ") || "nothing"}`);
    return found;
  }

  protected async engineOn(workspace: string, turns: FakeTurn[], addons: Addon[]): Promise<ScriptedEngine> {
    this.#engine = await startScriptedEngine({ workspace, turns, addons });
    return this.#engine;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class SiblingsAreRecordedAsWorkspaceRelativePaths extends BundledFilesTest {
  readonly id = "a-directory-addons-siblings-are-loaded-as-workspace-relative-paths-without-its-own-addon-md";
  readonly whyItExists =
    "absolute paths in `resources` leaked the developer's temp directory into the model's context, and listing ADDON.md among the siblings told the model to Read the body it had just been given";

  override run(t: TestRun): void {
    const workspace = this.freshWorkspace("magentra-bundled-");
    this.writeKit();
    const kit = this.named(loadAddons(workspace), "kit");
    t.assert.deepEqual(kit.resources, this.kitResources(), "both siblings, relative to the workspace, in walk order");
    t.assert.equal(
      kit.resources.some((r) => r.endsWith("ADDON.md")),
      false,
      "the addon's own entry file is not one of its resources",
    );
    t.assert.equal(
      kit.resources.some((r) => r.includes(workspace)),
      false,
      "no absolute path — the model is given paths it can pass straight to Read",
    );
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class InvokingListsThePathsAndNotTheContents extends BundledFilesTest {
  readonly id = "invoking-the-addon-in-a-turn-sends-the-model-a-dash-line-per-path-and-none-of-the-note-text";
  readonly whyItExists =
    "inlining every sibling made one invocation cost the tokens of the whole directory, and a script pasted as text is something the model reads instead of something it runs";

  override readonly timeoutMs: number = 60_000;

  override async run(t: TestRun): Promise<void> {
    const workspace = this.freshWorkspace("magentra-bundled-turn-");
    this.writeKit();
    // The negative below is only worth anything if the sentinel really is in
    // the file the addon bundles, so that is established first.
    t.assert.ok(
      readFileSync(join(workspace, ".magentra", "addons", "kit", "notes", "a.md"), "utf8").includes(NOTE_SENTINEL),
      "the bundled note on disk carries the sentinel",
    );
    const addons = loadAddons(workspace);
    const engine = await this.engineOn(workspace, [{ toolCalls: [{ name: "Addon", input: { addon: "kit" } }] }, { text: "following it" }], addons);

    const turn = await engine.runTurn("use the kit addon");
    t.assert.deepEqual(turn.errors, [], turn.errors.join(" | "));
    const invoked = turn.toolResults.find((r) => r.tool === "Addon");
    t.assert.equal(invoked?.isError, false, "the real Addon tool loaded the real directory addon");
    t.assert.ok(invoked?.resultPreview.includes('The "kit" addon was invoked'), invoked?.resultPreview);

    // What the model was actually sent: the tool_result block of the next request.
    const second = engine.provider.requests[1];
    t.assert.notEqual(second, undefined, "there was a second model call after the tool ran");
    const toolResults = JSON.stringify(second!.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result"));
    t.assert.ok(toolResults.includes("<system-reminder>Files bundled with this addon"), "the siblings arrive in their own reminder block");
    for (const resource of this.kitResources()) {
      t.assert.ok(toolResults.includes(JSON.stringify(`- ${resource}`).slice(1, -1)), `one dash line for ${resource}`);
    }
    t.assert.equal(toolResults.includes(NOTE_SENTINEL), false, "the note's TEXT is not in the tool result — only its path");
    t.assert.equal(JSON.stringify(second!.messages).includes(NOTE_SENTINEL), false, "and it is nowhere else in the conversation either");
    t.assert.equal(second!.system.includes(NOTE_SENTINEL), false, "nor in the standing prompt");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AFlatAddonAndTheBuiltInBundleNothing extends BundledFilesTest {
  readonly id = "a-flat-addon-and-the-built-in-magentron-both-load-with-an-empty-resources-list";
  readonly whyItExists =
    "`resources` left undefined for a flat addon threw in the Addon tool's `.length` check, and a built-in with resources would point the model at a directory that does not exist on disk";

  override run(t: TestRun): void {
    const workspace = this.freshWorkspace("magentra-bundled-flat-");
    writeFileSync(join(this.addonsDir(), "flat.md"), "---\nname: flat\ndescription: the flat procedure\n---\nJust do it.\n", "utf8");
    const addons = loadAddons(workspace);
    t.assert.deepEqual(this.named(addons, "flat").resources, [], "a flat <name>.md has no directory, so it bundles nothing");
    const builtin = this.named(addons, "magentron");
    t.assert.equal(builtin.source, "builtin", "magentron comes from the compiled-in tier");
    t.assert.deepEqual(builtin.resources, [], "a built-in has no directory on disk, so it bundles nothing");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheSiblingListIsCappedAtTwentyFour extends BundledFilesTest {
  readonly id = "an-addon-shipping-more-than-twenty-four-siblings-advertises-exactly-twenty-four";
  readonly whyItExists =
    "an addon shipping a whole vendored tree advertised every file, so one invocation spent hundreds of tokens on a listing the model never read";

  override run(t: TestRun): void {
    const workspace = this.freshWorkspace("magentra-bundled-cap-");
    const big = join(this.addonsDir(), "big");
    mkdirSync(big, { recursive: true });
    writeFileSync(join(big, "ADDON.md"), "---\nname: big\ndescription: a big kit\n---\nBig.\n", "utf8");
    for (let i = 0; i < 30; i++) writeFileSync(join(big, `f${String(i).padStart(2, "0")}.txt`), `file ${i}\n`, "utf8");

    const resources = this.named(loadAddons(workspace), "big").resources;
    t.assert.equal(resources.length, 24, "MAX_RESOURCES — the first slice, not the whole tree");
    t.assert.equal(new Set(resources).size, 24, "and no path is advertised twice");
    t.assert.equal(resources[0], join(".magentra", "addons", "big", "f00.txt"), "the slice starts at the first entry in sorted order");
    t.assert.equal(
      resources.some((r) => r.endsWith("ADDON.md")),
      false,
      "the entry file is still skipped when the cap is in play",
    );
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheWalkStopsOneLevelDown extends BundledFilesTest {
  readonly id = "a-sibling-one-folder-down-is-advertised-and-one-two-folders-down-is-not";
  readonly whyItExists =
    "an unbounded walk advertised every file under an addon that had vendored a node_modules, which is the listing MAX_RESOURCES alone could not keep useful";

  override run(t: TestRun): void {
    const workspace = this.freshWorkspace("magentra-bundled-depth-");
    const kit = join(this.addonsDir(), "deep");
    mkdirSync(join(kit, "sub", "deeper"), { recursive: true });
    writeFileSync(join(kit, "ADDON.md"), "---\nname: deep\ndescription: a nested kit\n---\nDeep.\n", "utf8");
    writeFileSync(join(kit, "top.md"), "top\n", "utf8");
    writeFileSync(join(kit, "sub", "one.md"), "one level\n", "utf8");
    writeFileSync(join(kit, "sub", "deeper", "two.md"), "two levels\n", "utf8");

    // The negative below means nothing unless the deep file is really there.
    t.assert.ok(existsSync(join(kit, "sub", "deeper", "two.md")), "the two-levels-down file exists on disk");
    const resources = this.named(loadAddons(workspace), "deep").resources;
    t.assert.deepEqual(
      resources,
      [join(".magentra", "addons", "deep", "sub", "one.md"), join(".magentra", "addons", "deep", "top.md")],
      "the addon's own files and one level of subfolder, and nothing below that",
    );
    t.assert.equal(
      resources.some((r) => r.includes("two.md")),
      false,
      "a file two folders down is not advertised",
    );
  }
}

registerFeatureTests(
  new SiblingsAreRecordedAsWorkspaceRelativePaths(),
  new InvokingListsThePathsAndNotTheContents(),
  new AFlatAddonAndTheBuiltInBundleNothing(),
  new TheSiblingListIsCappedAtTwentyFour(),
  new TheWalkStopsOneLevelDown(),
);
