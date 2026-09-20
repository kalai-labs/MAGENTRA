/**
 * `discovery`.
 *
 * The addon loader scans `.magentra/addons/` and accepts two layouts: a flat
 * `<name>.md`, and a `<name>/` folder holding an `ADDON.md`. A folder without
 * an `ADDON.md` is ignored outright, because guessing would load a README as a
 * procedure. The name comes from the frontmatter `name:` key, else the file
 * stem or the folder name.
 *
 * `fs`, as the record declares: every item is a real directory tree on disk,
 * read by the real `loadAddons`. There is no double at all in this file — the
 * loader is called directly and the fixture is the layout it walks.
 *
 * `HOME`/`USERPROFILE` are redirected at the top of every test, because
 * `loadAddons` also reads `~/.magentra/addons` and the built-in tier; the
 * assertions therefore name the addons this test wrote rather than counting a
 * list that always holds `magentron` too.
 *
 * "A file that cannot be read" is built on 2026-09-19 as a DIRECTORY named
 * `ADDON.md` inside an addon folder: the candidate passes `existsSync`, and
 * `readFileSync` then throws `EISDIR` on Windows exactly as it does on POSIX,
 * so `readAddon`'s own catch is the code under test. Removing a file's read
 * permission was the alternative and is not portable here — Windows has no
 * mode bits, and an ACL deny would have to be undone before the temp directory
 * could be removed.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAddons, type Addon } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "discovery";

/** Verbatim from the record. */
const INVARIANT = "Both layouts load — flat <name>.md and <name>/ADDON.md — and a directory without ADDON.md is skipped.";

abstract class DiscoveryTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected workspace = "";

  /** A workspace with an empty HOME and an empty `.magentra/addons`, handed back. */
  protected addonsDir(prefix: string): string {
    this.redirectHome();
    this.workspace = this.tempDir(prefix);
    const dir = join(this.workspace, ".magentra", "addons");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  protected named(addons: readonly Addon[], name: string): Addon {
    const found = addons.find((a) => a.name === name);
    if (!found) throw new Error(`the loader returned no addon named "${name}" — it returned: ${addons.map((a) => a.name).join(", ") || "nothing"}`);
    return found;
  }

  protected names(addons: readonly Addon[]): string[] {
    return addons.map((a) => a.name);
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class AFlatFileIsNamedForItsStem extends DiscoveryTest {
  readonly id = "a-flat-name-md-without-a-frontmatter-name-loads-under-its-file-stem";
  readonly whyItExists =
    "an addon whose frontmatter omitted `name:` was loaded under an empty name, so it appeared in the roster as `- : description` and `/` could never invoke it";

  override run(t: TestRun): void {
    const dir = this.addonsDir("magentra-discovery-flat-");
    writeFileSync(join(dir, "flat.md"), "---\ndescription: the flat procedure\n---\nFlat body.\n", "utf8");

    const flat = this.named(loadAddons(this.workspace), "flat");
    t.assert.equal(flat.name, "flat", "the stem of the file, since the frontmatter names nothing");
    t.assert.equal(flat.path, join(dir, "flat.md"), "the path is the file the body came from");
    t.assert.equal(flat.source, "workspace");
    t.assert.equal(flat.body, "Flat body.", "the body is what follows the frontmatter, trimmed");
    t.assert.deepEqual(flat.resources, [], "a flat addon owns no directory, so it bundles nothing");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ADirectoryWithAnEntryFileLoads extends DiscoveryTest {
  readonly id = "a-folder-holding-an-addon-md-loads-under-the-folder-name";
  readonly whyItExists =
    "supporting only the flat layout meant an addon could never ship the scripts and notes its own instructions told the model to run";

  override run(t: TestRun): void {
    const dir = this.addonsDir("magentra-discovery-dir-");
    mkdirSync(join(dir, "kit"), { recursive: true });
    writeFileSync(join(dir, "kit", "ADDON.md"), "---\ndescription: the kit procedure\n---\nKit body.\n", "utf8");

    const kit = this.named(loadAddons(this.workspace), "kit");
    t.assert.equal(kit.name, "kit", "the folder name, since the frontmatter names nothing");
    t.assert.equal(kit.path, join(dir, "kit", "ADDON.md"), "the path is the entry file, not the folder");
    t.assert.equal(kit.body, "Kit body.");
    t.assert.equal(kit.source, "workspace");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AFolderWithoutAnEntryFileIsSkipped extends DiscoveryTest {
  readonly id = "a-folder-with-no-addon-md-contributes-nothing-not-even-its-readme";
  readonly whyItExists =
    "a folder of notes dropped next to the addons was loaded as an addon, so a README's prose entered the roster and could be invoked as a procedure";

  override run(t: TestRun): void {
    const dir = this.addonsDir("magentra-discovery-skip-");
    mkdirSync(join(dir, "empty-dir"), { recursive: true });
    writeFileSync(join(dir, "empty-dir", "README.md"), "---\nname: README\n---\nJust notes.\n", "utf8");
    writeFileSync(join(dir, "real.md"), "---\nname: real\ndescription: d\n---\nReal.\n", "utf8");

    const names = this.names(loadAddons(this.workspace));
    t.assert.equal(names.includes("empty-dir"), false, `the folder is not an addon: ${names.join(", ")}`);
    t.assert.equal(names.includes("README"), false, "and neither is the file inside it — only ADDON.md marks a folder");
    t.assert.ok(names.includes("real"), "the addon beside it still loads");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class OnlyMarkdownLoadsAndTheExtensionIsCaseInsensitive extends DiscoveryTest {
  readonly id = "a-non-md-file-at-the-top-level-is-not-an-addon-while-an-uppercase-md-is";
  readonly whyItExists =
    "a `notes.txt` left beside the addons was loaded as one, and an addon saved as `.MD` by an editor on a case-preserving filesystem silently disappeared from the roster";

  override run(t: TestRun): void {
    const dir = this.addonsDir("magentra-discovery-ext-");
    writeFileSync(join(dir, "notes.txt"), "---\nname: notes\n---\nNot an addon.\n", "utf8");
    writeFileSync(join(dir, "upper.MD"), "---\ndescription: the upper procedure\n---\nUpper body.\n", "utf8");

    const addons = loadAddons(this.workspace);
    const names = this.names(addons);
    t.assert.equal(names.includes("notes"), false, `a .txt is not a candidate: ${names.join(", ")}`);
    const upper = this.named(addons, "upper");
    t.assert.equal(upper.path, join(dir, "upper.MD"), "the uppercase extension is accepted");
    t.assert.equal(upper.name, "upper", "and the stem drops the extension whatever its case");
    t.assert.equal(upper.body, "Upper body.");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AnEmptyOrUnreadableCandidateIsSkipped extends DiscoveryTest {
  readonly id = "an-empty-body-and-an-unreadable-entry-file-are-skipped-and-the-rest-of-the-roster-still-loads";
  readonly whyItExists =
    "one malformed addon threw out of `loadAddons`, so a stray empty file under `.magentra/addons` stopped the session from starting at all";

  override run(t: TestRun): void {
    const dir = this.addonsDir("magentra-discovery-bad-");
    // Nothing but whitespace after the frontmatter: there is no procedure here.
    writeFileSync(join(dir, "blank.md"), "---\nname: blank\ndescription: d\n---\n\n   \n", "utf8");
    // An ADDON.md that is a DIRECTORY: the candidate exists, and reading it throws EISDIR.
    mkdirSync(join(dir, "unreadable", "ADDON.md"), { recursive: true });
    writeFileSync(join(dir, "survivor.md"), "---\nname: survivor\ndescription: d\n---\nStill here.\n", "utf8");

    // Both negatives below are only worth something if the candidates really
    // are candidates: an ADDON.md that is present and is a directory, so the
    // loader gets as far as trying to read it.
    t.assert.ok(existsSync(join(dir, "unreadable", "ADDON.md")), "the entry file the loader will try to read is present");
    t.assert.ok(statSync(join(dir, "unreadable", "ADDON.md")).isDirectory(), "and it is a directory, so reading it throws EISDIR");

    const addons = loadAddons(this.workspace);
    const names = this.names(addons);
    t.assert.equal(names.includes("blank"), false, `an empty body is not a procedure: ${names.join(", ")}`);
    t.assert.equal(names.includes("unreadable"), false, "an entry file that cannot be read is skipped, not fatal");
    t.assert.equal(this.named(addons, "survivor").body, "Still here.", "the addons that ARE readable still load");
    t.assert.ok(names.includes("magentron"), "and the built-in tier is untouched by a malformed workspace file");
  }
}

registerFeatureTests(
  new AFlatFileIsNamedForItsStem(),
  new ADirectoryWithAnEntryFileLoads(),
  new AFolderWithoutAnEntryFileIsSkipped(),
  new OnlyMarkdownLoadsAndTheExtensionIsCaseInsensitive(),
  new AnEmptyOrUnreadableCandidateIsSkipped(),
);
