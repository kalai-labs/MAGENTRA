/**
 * `the-magentron-built-in`.
 *
 * `magentron` is compiled into the engine as a string constant, so it is
 * present in every install however the app is packaged — no directory on disk,
 * no state folder to lose. Its description says what it is for (map before you
 * write, reuse, delete superseded code) and states plainly that it COSTS EXTRA
 * TOKENS, because it front-loads a reconnaissance pass before the first edit.
 *
 * `fs`, as the record declares, and every item here is honestly that. The
 * claim is "present with NOTHING on disk", which is only observable by running
 * the real loader against an empty workspace and an empty, redirected HOME —
 * a file read and an `os.homedir()` redirect, which `fsTest.ts` owns. Item 5
 * then adds and removes a real workspace file.
 *
 * ITEM 1 IS PROVED THROUGH `loadAddons`, NOT THROUGH THE CONSTANT, and the
 * checklist's spelling of it cannot be run as written (2026-09-19):
 * `@magentra/core`'s package `exports` map has a single "." entry and
 * `engine/core/src/index.ts` re-exports `./agent/addons.js` but neither
 * `./agent/builtinAddons.js` nor `./config/frontmatter.js` — so `BUILTIN_ADDONS`
 * and `parseFrontmatter` are not reachable by package name, and the suite
 * imports engine packages by package name. What IS observable is the whole of
 * what the constant contributes: with both on-disk tiers empty the loaded
 * roster IS the built-in tier. The one residual gap is reported rather than
 * papered over — `fm.map.name` and the `builtin.name` fallback are both the
 * string "magentron", so which of the two produced the loaded name cannot be
 * told apart from outside. The frontmatter block is proved to have parsed by
 * the DESCRIPTION, which can only have come from `fm.map.description`.
 *
 * There is no double in this file: the real loader is called directly.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAddons, type Addon } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "the-magentron-built-in";

/** Verbatim from the record. */
const INVARIANT = "magentron ships present however the app is packaged, with its extra-token cost declared in the description.";

abstract class MagentronTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected workspace = "";

  /** An empty workspace and an empty HOME: nothing on disk can contribute an addon. */
  protected bareWorkspace(prefix: string): string {
    this.redirectHome();
    this.workspace = this.tempDir(prefix);
    return this.workspace;
  }

  protected magentron(addons: readonly Addon[]): Addon {
    const found = addons.find((a) => a.name === "magentron");
    if (!found) throw new Error(`no addon named "magentron" — the loader returned: ${addons.map((a) => a.name).join(", ") || "nothing"}`);
    return found;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheBuiltInTierIsExactlyOneAddon extends MagentronTest {
  readonly id = "with-nothing-on-disk-the-roster-is-exactly-one-built-in-addon-named-magentron";
  readonly whyItExists =
    "a second entry added to the built-in array, or one whose frontmatter stopped parsing so its name fell back to the array key, changed what every install ships with and nothing else would have noticed";

  override run(t: TestRun): void {
    const addons = loadAddons(this.bareWorkspace("magentra-magentron-only-"));
    t.assert.equal(addons.length, 1, `the built-in tier is one addon: ${addons.map((a) => `${a.name}/${a.source}`).join(", ")}`);
    t.assert.equal(addons[0]?.name, "magentron");
    t.assert.equal(addons[0]?.source, "builtin");
    // The description can only have come from the frontmatter map: the body's
    // first line, which is the fallback, is a different sentence entirely.
    t.assert.ok(addons[0]?.description.startsWith("Read before you write"), addons[0]?.description);
    t.assert.equal(
      addons[0]?.description.startsWith(addons[0].body.split("\n")[0] ?? ""),
      false,
      "the `---` block parsed as frontmatter — the description is not the body's first line",
    );
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ItIsPresentWithNoFileBehindIt extends MagentronTest {
  readonly id = "magentron-loads-from-an-empty-workspace-with-source-builtin-no-path-and-no-resources";
  readonly whyItExists =
    "a default shipped as a file under the state directory vanished when packaging dropped it or the directory had never been created, so a fresh install had no addons at all";

  override run(t: TestRun): void {
    const magentron = this.magentron(loadAddons(this.bareWorkspace("magentra-magentron-shape-")));
    t.assert.equal(magentron.source, "builtin", "not read from either on-disk tier");
    t.assert.equal(magentron.path, undefined, "there is no file behind it");
    t.assert.equal("path" in magentron, false, "and no `path` key at all, so `/addons` prints `(built-in)` rather than `(undefined)`");
    t.assert.deepEqual(magentron.resources, [], "a built-in has no directory, so it can bundle nothing");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheTokenCostIsDeclared extends MagentronTest {
  readonly id = "the-description-states-in-capitals-that-invoking-it-costs-extra-tokens";
  readonly whyItExists =
    "the description sold the procedure without its price, so the model reached for it on one-line edits and every such turn paid for a full reconnaissance pass first";

  override run(t: TestRun): void {
    const description = this.magentron(loadAddons(this.bareWorkspace("magentra-magentron-cost-"))).description;
    t.assert.ok(description.includes("COSTS EXTRA TOKENS"), `the cost is declared verbatim: ${description}`);
    t.assert.ok(description.includes("reconnaissance pass"), "and says what the extra tokens buy");
    // The description is what rides in the system prompt, so it must also say
    // when to reach for it — the cost alone is a warning with no rule attached.
    t.assert.ok(description.includes("refactors, renames, deletions"), description);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheBodyIsTheThreePhaseProcedure extends MagentronTest {
  readonly id = "the-body-is-non-empty-and-carries-all-three-phase-headings";
  readonly whyItExists =
    "a constant whose body was truncated to its frontmatter still loaded, listed and invoked — the model was handed an addon header with no procedure under it";

  override run(t: TestRun): void {
    const body = this.magentron(loadAddons(this.bareWorkspace("magentra-magentron-body-"))).body;
    t.assert.ok(body.length > 0, "the body is not empty");
    for (const phase of ["Phase 1", "Phase 2", "Phase 3"]) {
      t.assert.ok(body.includes(phase), `the body carries ${phase}: ${body.slice(0, 120)}…`);
    }
    t.assert.ok(body.indexOf("Phase 1") < body.indexOf("Phase 2"), "in order");
    t.assert.ok(body.indexOf("Phase 2") < body.indexOf("Phase 3"));
    t.assert.equal(body.startsWith("---"), false, "the frontmatter was stripped off the body, not left in it");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AWorkspaceCopyOverridesItAndRemovingItRestoresTheBuiltIn extends MagentronTest {
  readonly id = "a-workspace-magentron-md-takes-over-and-deleting-it-brings-the-built-in-back";
  readonly whyItExists =
    "an override that was cached rather than re-read left a deleted workspace file still in force, so a project could never get back to the shipped procedure without restarting the app";

  override run(t: TestRun): void {
    const workspace = this.bareWorkspace("magentra-magentron-override-");
    const dir = join(workspace, ".magentra", "addons");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "magentron.md");
    writeFileSync(file, "---\nname: magentron\ndescription: the project's magentron\n---\nProject procedure.\n", "utf8");

    const overridden = this.magentron(loadAddons(workspace));
    t.assert.equal(overridden.source, "workspace", "the workspace tier replaces the built-in");
    t.assert.equal(overridden.body, "Project procedure.");
    t.assert.equal(overridden.path, file);

    rmSync(file);
    const restored = this.magentron(loadAddons(workspace));
    t.assert.equal(restored.source, "builtin", "with the file gone the compiled-in addon is back");
    t.assert.equal(restored.path, undefined);
    t.assert.ok(restored.description.includes("COSTS EXTRA TOKENS"), "and it is the shipped one, not a remembered copy");
  }
}

registerFeatureTests(
  new TheBuiltInTierIsExactlyOneAddon(),
  new ItIsPresentWithNoFileBehindIt(),
  new TheTokenCostIsDeclared(),
  new TheBodyIsTheThreePhaseProcedure(),
  new AWorkspaceCopyOverridesItAndRemovingItRestoresTheBuiltIn(),
);
