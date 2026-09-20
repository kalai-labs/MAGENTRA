/**
 * `addons-listing`.
 *
 * `/addons` prints every installed addon as a `/<name>` line with its
 * description, then a line naming the file it was loaded from — a
 * workspace-relative path, or `built-in` — and, for a directory addon, how
 * many sibling files it bundles. Without the path a user who wants to edit or
 * remove an addon has to guess which tier it came from; without the count
 * they cannot tell a flat addon from one that ships scripts.
 *
 * `fs`, and the record said `pure`: the listing is rendered by a running
 * Engine from a roster the real loader read off `.magentra/addons/`, and the
 * origin line is a path relative to the workspace. Re-declared 2026-09-19.
 *
 * Paths are asserted in the platform's own separator, because that is what
 * `path.relative` produces and what the user can open on this machine.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAddons, type Addon } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "addons-listing";

/** Verbatim from the record. */
const INVARIANT = "/addons names each addon, the file it came from, and how many files it bundles.";

abstract class ListingTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;
  protected workspace = "";

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  /** A workspace with a flat `foo`, a directory `bar` with two siblings, and whatever ships built in. */
  protected async fullRoster(): Promise<{ engine: ScriptedEngine; addons: Addon[] }> {
    this.redirectHome();
    this.workspace = this.tempDir("magentra-listing-");
    const dir = join(this.workspace, ".magentra", "addons");
    mkdirSync(join(dir, "bar", "notes"), { recursive: true });
    writeFileSync(join(dir, "foo.md"), "---\nname: foo\ndescription: the foo procedure\n---\nFoo.\n", "utf8");
    writeFileSync(join(dir, "bar", "ADDON.md"), "---\nname: bar\ndescription: the bar procedure\n---\nBar.\n", "utf8");
    writeFileSync(join(dir, "bar", "run.sh"), "#!/bin/sh\necho hi\n", "utf8");
    writeFileSync(join(dir, "bar", "notes", "readme.md"), "notes\n", "utf8");
    const addons = loadAddons(this.workspace);
    this.#engine = await startScriptedEngine({ workspace: this.workspace, turns: [], addons });
    return { engine: this.#engine, addons };
  }

  protected async emptyRoster(): Promise<ScriptedEngine> {
    this.redirectHome();
    this.workspace = this.tempDir("magentra-listing-empty-");
    this.#engine = await startScriptedEngine({ workspace: this.workspace, turns: [], addons: [] });
    return this.#engine;
  }

  protected async listing(engine: ScriptedEngine): Promise<string> {
    engine.send({ type: "slash_command", command: "addons" });
    const out = await engine.waitFor((e): e is Extract<CoreEvent, { type: "command_output" }> => e.type === "command_output");
    return out.text;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class NoAddonsSaysWhereToPutOne extends ListingTest {
  readonly id = "with-no-addons-the-listing-says-none-are-installed-and-where-one-goes";
  readonly whyItExists = "an empty listing with no hint left the user unable to find out how an addon is installed at all";

  override async run(t: TestRun): Promise<void> {
    const text = await this.listing(await this.emptyRoster());
    t.assert.ok(text.startsWith("No addons installed"), text);
    t.assert.ok(text.includes(".magentra/addons/"), "names the folder");
    t.assert.ok(text.includes("ADDON.md"), "and the directory-addon entry file");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AFlatAddonNamesItsFile extends ListingTest {
  readonly id = "a-flat-addon-is-listed-as-slash-name-with-its-description-and-its-file-path-and-no-bundle-count";
  readonly whyItExists = "the listing named only the tier, so a user editing 'the workspace addon' had to hunt for the file among several";

  override async run(t: TestRun): Promise<void> {
    const { engine } = await this.fullRoster();
    const lines = (await this.listing(engine)).split("\n");
    const at = lines.findIndex((l) => l.trim().startsWith("/foo"));
    t.assert.ok(at > 0, `no /foo line in:\n${lines.join("\n")}`);
    t.assert.match(lines[at] ?? "", /^\s+\/foo\s+the foo procedure$/);
    const origin = lines[at + 1] ?? "";
    t.assert.ok(origin.includes(`(${join(".magentra", "addons", "foo.md")})`), `the next line names the file: ${origin}`);
    t.assert.equal(origin.includes("bundled"), false, "a flat addon has no bundle count");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ADirectoryAddonCountsItsSiblings extends ListingTest {
  readonly id = "a-directory-addon-names-its-addon-md-and-how-many-files-it-bundles";
  readonly whyItExists = "a directory addon looked identical to a flat one, so its scripts and notes went unnoticed and unused";

  override async run(t: TestRun): Promise<void> {
    const { engine, addons } = await this.fullRoster();
    const bar = addons.find((a) => a.name === "bar");
    t.assert.equal(bar?.resources.length, 2, `the loader sees two siblings: ${bar?.resources.join(", ")}`);
    const lines = (await this.listing(engine)).split("\n");
    const at = lines.findIndex((l) => l.trim().startsWith("/bar"));
    t.assert.ok(at > 0);
    t.assert.ok((lines[at + 1] ?? "").includes(`(${join(".magentra", "addons", "bar", "ADDON.md")}, 2 bundled file(s))`), lines[at + 1]);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheBuiltInIsMarkedBuiltIn extends ListingTest {
  readonly id = "the-built-in-magentron-shows-built-in-as-its-origin-and-no-bundle-count";
  readonly whyItExists = "a built-in shown with a path sent the user looking for a file to edit that does not exist on disk";

  override async run(t: TestRun): Promise<void> {
    const { engine } = await this.fullRoster();
    const lines = (await this.listing(engine)).split("\n");
    const at = lines.findIndex((l) => l.trim().startsWith("/magentron"));
    t.assert.ok(at > 0, "the built-in is listed");
    const origin = lines[at + 1] ?? "";
    t.assert.ok(origin.trim() === "(built-in)", `origin line: ${origin}`);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheCountIsTheRosterSize extends ListingTest {
  readonly id = "the-final-line-reports-addons-installed-equal-to-the-roster-size";
  readonly whyItExists = "a count that excluded built-ins disagreed with the listing above it, and the user could not tell which number to believe";

  override async run(t: TestRun): Promise<void> {
    const { engine, addons } = await this.fullRoster();
    const text = await this.listing(engine);
    t.assert.ok(addons.length >= 3, "foo, bar and the built-ins");
    t.assert.match(text.trimEnd(), new RegExp(`Addons installed:\\s+${addons.length}$`));
    // One /name line per addon, exactly.
    const named = text.split("\n").filter((l) => /^\s+\/[a-z0-9_-]+\s/.test(l)).length;
    t.assert.equal(named, addons.length, "every addon has its line");
  }
}

registerFeatureTests(new NoAddonsSaysWhereToPutOne(), new AFlatAddonNamesItsFile(), new ADirectoryAddonCountsItsSiblings(), new TheBuiltInIsMarkedBuiltIn(), new TheCountIsTheRosterSize());
