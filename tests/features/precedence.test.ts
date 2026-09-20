/**
 * `precedence`.
 *
 * Addons load in three tiers, in this order: the built-ins compiled into the
 * app, then `~/.magentra/addons/`, then `<workspace>/.magentra/addons/`. They
 * are keyed by NAME, so a later tier's addon with a name already loaded
 * replaces it outright — which is how a project customizes a shipped procedure
 * without touching the app, and how a user's home addons apply everywhere. The
 * result is sorted by name.
 *
 * `fs`, as the record declares. Both of the overridable tiers are real
 * directories on disk: `HOME`/`USERPROFILE` are redirected to a temp directory
 * per test (`os.homedir()` reads one on each platform) and the workspace is
 * another, so the tier a name came from is decided by files this test wrote
 * and by nothing on the developer's machine.
 *
 * There is no double in this file: the real `loadAddons` is called directly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAddons, type Addon } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "precedence";

/** Verbatim from the record. */
const INVARIANT = "Precedence is builtin, then ~/.magentra/addons, then the workspace; a later tier replaces an earlier addon of the same name.";

abstract class PrecedenceTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected workspace = "";
  protected home = "";

  /** A redirected HOME and a fresh workspace, neither holding an addon yet. */
  protected tiers(prefix: string): void {
    this.home = this.redirectHome();
    this.workspace = this.tempDir(prefix);
  }

  /** Write `<name>.md` into the home tier. */
  protected writeGlobal(file: string, contents: string): string {
    const path = join(this.home, ".magentra", "addons", file);
    mkdirSync(join(this.home, ".magentra", "addons"), { recursive: true });
    writeFileSync(path, contents, "utf8");
    return path;
  }

  /** Write `<name>.md` into the workspace tier. */
  protected writeWorkspace(file: string, contents: string): string {
    const path = join(this.workspace, ".magentra", "addons", file);
    mkdirSync(join(this.workspace, ".magentra", "addons"), { recursive: true });
    writeFileSync(path, contents, "utf8");
    return path;
  }

  protected named(addons: readonly Addon[], name: string): Addon {
    const found = addons.find((a) => a.name === name);
    if (!found) throw new Error(`the loader returned no addon named "${name}" — it returned: ${addons.map((a) => a.name).join(", ") || "nothing"}`);
    return found;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class AWorkspaceFileReplacesTheBuiltIn extends PrecedenceTest {
  readonly id = "a-workspace-addon-named-for-a-built-in-replaces-it-rather-than-appearing-beside-it";
  readonly whyItExists =
    "a workspace override appended instead of replacing left two `magentron` entries on the roster, so the model saw the name twice and the Addon tool returned whichever the find hit first";

  override run(t: TestRun): void {
    this.tiers("magentra-precedence-builtin-");
    const path = this.writeWorkspace("magentron.md", "---\nname: magentron\ndescription: the project's own magentron\n---\ncustom\n");

    const addons = loadAddons(this.workspace);
    t.assert.equal(
      addons.filter((a) => a.name === "magentron").length,
      1,
      `exactly one magentron, never two: ${addons.map((a) => `${a.name}/${a.source}`).join(", ")}`,
    );
    const magentron = this.named(addons, "magentron");
    t.assert.equal(magentron.body, "custom", "the workspace body, not the compiled-in one");
    t.assert.equal(magentron.source, "workspace");
    t.assert.equal(magentron.path, path, "and it names the file a user can edit");
    t.assert.equal(addons.length, 1, "with an empty HOME the whole roster is this one addon");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AHomeAddonAppliesToEveryWorkspace extends PrecedenceTest {
  readonly id = "an-addon-in-the-home-tier-loads-into-a-workspace-that-has-none-marked-global";
  readonly whyItExists =
    "the home tier was read relative to the workspace rather than to `os.homedir()`, so an addon a user installed once was missing from every project but the one they installed it in";

  override run(t: TestRun): void {
    this.tiers("magentra-precedence-global-");
    const path = this.writeGlobal("foo.md", "---\nname: foo\ndescription: the home foo\n---\nfrom home\n");

    const foo = this.named(loadAddons(this.workspace), "foo");
    t.assert.equal(foo.source, "global", "the tier is recorded, so `/addons` can say where it came from");
    t.assert.equal(foo.body, "from home");
    t.assert.equal(foo.path, path, `the file under ${join(".magentra", "addons")} in the redirected home`);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheWorkspaceWinsOverHome extends PrecedenceTest {
  readonly id = "the-same-name-in-home-and-in-the-workspace-resolves-to-the-workspace-copy";
  readonly whyItExists =
    "the tiers were merged in the wrong order, so a user's personal addon shadowed the project's own version of the same procedure for everyone who cloned it";

  override run(t: TestRun): void {
    this.tiers("magentra-precedence-both-");
    this.writeGlobal("foo.md", "---\nname: foo\ndescription: the home foo\n---\nfrom home\n");
    const workspacePath = this.writeWorkspace("foo.md", "---\nname: foo\ndescription: the project foo\n---\nfrom the workspace\n");

    const addons = loadAddons(this.workspace);
    t.assert.equal(addons.filter((a) => a.name === "foo").length, 1, "one foo, not two");
    const foo = this.named(addons, "foo");
    t.assert.equal(foo.source, "workspace", "the later tier wins");
    t.assert.equal(foo.body, "from the workspace");
    t.assert.equal(foo.description, "the project foo", "the whole addon is replaced, not merged field by field");
    t.assert.equal(foo.path, workspacePath);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheRosterIsKeyedByNameNotByFile extends PrecedenceTest {
  readonly id = "two-files-declaring-the-same-frontmatter-name-collapse-to-one-addon-and-the-last-read-wins";
  readonly whyItExists =
    "the roster was keyed by file path, so two files declaring the same `name:` produced two entries with one name and `/<name>` invoked an arbitrary one of them";

  override run(t: TestRun): void {
    this.tiers("magentra-precedence-collapse-");
    this.writeGlobal("alpha.md", "---\nname: shared\ndescription: d\n---\nfrom home alpha\n");
    // Within one tier the files are read in sorted order, so gamma.md is read after beta.md.
    this.writeWorkspace("beta.md", "---\nname: shared\ndescription: d\n---\nfrom workspace beta\n");
    this.writeWorkspace("gamma.md", "---\nname: shared\ndescription: d\n---\nfrom workspace gamma\n");
    this.writeWorkspace("solo.md", "---\nname: solo\ndescription: d\n---\nsolo\n");

    const addons = loadAddons(this.workspace);
    const names = addons.map((a) => a.name);
    t.assert.equal(new Set(names).size, names.length, `no name appears twice: ${names.join(", ")}`);
    t.assert.equal(addons.length, 3, "magentron, shared and solo — one entry per distinct name, from four files plus the built-in");
    const shared = this.named(addons, "shared");
    t.assert.equal(shared.source, "workspace", "the later tier replaced the home file");
    t.assert.equal(shared.body, "from workspace gamma", "and within the tier the file read last is the one that stands");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheRosterIsSortedByName extends PrecedenceTest {
  readonly id = "the-returned-list-is-sorted-by-name-whatever-tier-and-filename-the-addons-came-from";
  readonly whyItExists =
    "the roster came out in tier-then-readdir order, so the `Available addons` block and `/addons` reshuffled whenever a file was renamed and the prompt cache was invalidated for nothing";

  override run(t: TestRun): void {
    this.tiers("magentra-precedence-sort-");
    // Names deliberately at odds with both the tier order and the filenames:
    // read order is magentron, zulu, alpha; sorted order is alpha, magentron, zulu.
    this.writeGlobal("a-file.md", "---\nname: zulu\ndescription: d\n---\nz\n");
    this.writeWorkspace("z-file.md", "---\nname: alpha\ndescription: d\n---\na\n");

    const names = loadAddons(this.workspace).map((a) => a.name);
    t.assert.deepEqual(names, ["alpha", "magentron", "zulu"], "sorted by name, not by tier and not by filename");
    t.assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "and that is localeCompare's order");
  }
}

registerFeatureTests(
  new AWorkspaceFileReplacesTheBuiltIn(),
  new AHomeAddonAppliesToEveryWorkspace(),
  new TheWorkspaceWinsOverHome(),
  new TheRosterIsKeyedByNameNotByFile(),
  new TheRosterIsSortedByName(),
);
