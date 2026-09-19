/**
 * `symbol-index`.
 *
 * The symbol index records, per scanned source file, the top-level exported
 * symbol names and the 1-based line each is declared on, from a regex scan. It
 * is persisted to `.magentra/symbols.json`; each load rebuilds only the files
 * whose mtime OR size changed, and there is no explicit rebuild command. It
 * answers the reuse gate's "does code by this name already exist?" through
 * `findSimilarSymbols`, and the stored lines are what would let a file be
 * summarized as a skeleton instead of opened whole.
 *
 * `fs`, as the record declares: real source files in a temp workspace, the
 * real scanner, the real `.magentra/symbols.json`.
 *
 * THREE THINGS MEASURED AGAINST THE CODE BEFORE THEY WERE ASSERTED:
 *
 *  - FILE KEYS are workspace-relative with FORWARD slashes on every platform
 *    (`toNodeId` does `relative(cwd, abs).split(sep).join("/")`), so `src/a.ts`
 *    is the key on Windows too. Asserted as the code stores it.
 *
 *  - `isValidIndex`, `indexesEqual` and `saveSymbolIndex` are module-private;
 *    `@magentra/core` exports `buildSymbolIndex`, `loadOrBuildSymbolIndex`,
 *    `extractSymbolSites`, `extractSymbols`, `tokensOf` and
 *    `findSimilarSymbols`. Version rejection is therefore proven where it is
 *    observable — a version-1 (or corrupt) file on disk is REPLACED by a
 *    version-2 one carrying the right symbols.
 *
 *  - THE CHECKLIST'S SECOND SCORING CLAUSE IS NOT ASSERTED, because the code
 *    does not produce it and the rule is to stop rather than reinterpret.
 *    "a candidate 'userFormatter' against symbol 'formatUser' scores above 0.5
 *    via shared tokens" — measured, `scoreNames` returns 0.3333333333333333.
 *    `tokensOf("userFormatter")` is `["user","formatter"]` and
 *    `tokensOf("formatUser")` is `["format","user"]`: one token in common out
 *    of three, Jaccard 1/3, and neither the first-token (+0.15) nor the
 *    last-token (+0.1) nudge fires because the order is reversed. The exact
 *    match half of the item IS asserted below. Reported 2026-09-19, unchanged.
 *
 * THE FIRST TEST FOUND A DEFECT IN THE PRODUCT when it was written, on
 * 2026-09-19, and was red until the fix landed on 2026-09-20 — see the comment
 * on {@link DeclarationLinesAreIndexed}.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildSymbolIndex,
  findSimilarSymbols,
  loadOrBuildSymbolIndex,
  type SymbolIndexData,
} from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "symbol-index";

/** Verbatim from the record. */
const INVARIANT = "The symbol index locates definitions and finds similar symbols across the workspace.";

abstract class SymbolIndexTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected dir = "";

  override setUp(): void {
    this.dir = this.tempDir("magentra-symbols-");
  }

  protected write(rel: string, contents: string): void {
    const abs = join(this.dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
  }

  /** Where the index is persisted, by the scanner's own convention. */
  protected indexFile(): string {
    return join(this.dir, ".magentra", "symbols.json");
  }

  protected onDisk(): SymbolIndexData {
    return JSON.parse(readFileSync(this.indexFile(), "utf8")) as SymbolIndexData;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

/**
 * This test was RED when written, for a real off-by-one in `extractTsSymbols`.
 *
 * `RE_TS_EXPORT_DECL` was `/^\s*export\s+…/gm` and the line is taken from
 * `m.index` — the start of the match, which `\s*` let begin at the start of a
 * PRECEDING blank line. For the ordinary shape of a TypeScript file, one blank
 * line between declarations, every symbol was therefore recorded one line too
 * early: this fixture declares `alpha` on line 3 and `beta` on line 5 and the
 * index stored `lines: [2, 4]`. Fixed on 2026-09-20 by anchoring the leading
 * whitespace to the declaration's own line (`^[^\S\n]*`), in
 * `engine/core/src/knowledge/symbols.ts`; the record was re-stamped with it.
 *
 * The fixture is deliberately the natural one. A file with comment filler
 * instead of blank lines records [3, 5] and passed against the defect, which
 * is precisely the ticked box with nothing behind it that this suite exists
 * to remove.
 */
class DeclarationLinesAreIndexed extends SymbolIndexTest {
  readonly id = "a-files-exported-names-and-their-declaration-lines-are-indexed-and-persisted";
  readonly whyItExists =
    "the stored line pointed at the blank line above a declaration, so a skeleton built from the index sent the reader to an empty line and a read-by-range opened the wrong window of the file";

  override run(t: TestRun): void {
    // Lines: 1 comment, 2 blank, 3 alpha, 4 blank, 5 beta.
    this.write("src/a.ts", "// the module under test\n\nexport function alpha() {}\n\nexport const beta = 1;\n");

    const index = loadOrBuildSymbolIndex(this.dir);
    const entry = index.files["src/a.ts"];
    t.assert.ok(entry !== undefined, `the key is workspace-relative with forward slashes; got ${JSON.stringify(Object.keys(index.files))}`);
    t.assert.deepEqual(entry?.symbols, ["alpha", "beta"], "both exported names, in declaration order");
    t.assert.deepEqual(entry?.lines, [3, 5], "and the 1-based line each is declared on");

    t.assert.equal(statSync(this.indexFile()).isFile(), true, ".magentra/symbols.json is created");
    t.assert.equal(this.onDisk().version, 2, "persisted at the current version");
    t.assert.deepEqual(this.onDisk().files["src/a.ts"]?.symbols, ["alpha", "beta"], "with the same symbols on disk");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AnUnchangedIndexIsNotRewrittenAndAnEditIsPickedUp extends SymbolIndexTest {
  readonly id = "an-unchanged-workspace-is-not-rewritten-and-an-appended-export-is-rescanned";
  readonly whyItExists =
    "the reuse check rescanned the whole tree on every question because the index was rewritten and re-read each time, and a symbol added to an existing file never appeared because the refresh only noticed NEW files";

  override run(t: TestRun): void {
    this.write("src/a.ts", "// a\n// b\nexport function alpha() {}\n// c\nexport const beta = 1;\n");
    this.write("src/other.ts", "export const untouched = 1;\n");

    const first = loadOrBuildSymbolIndex(this.dir);
    t.assert.deepEqual(first.files["src/a.ts"]?.symbols, ["alpha", "beta"]);

    // Push the file back so a rewrite would be unmistakable.
    const back = Date.now() / 1000 - 10;
    utimesSync(this.indexFile(), back, back);
    const before = statSync(this.indexFile()).mtimeMs;

    const second = loadOrBuildSymbolIndex(this.dir);
    t.assert.equal(statSync(this.indexFile()).mtimeMs, before, "nothing changed, so nothing was written");
    t.assert.deepEqual(second.files, first.files, "and the same index came back");

    appendFileSync(join(this.dir, "src", "a.ts"), "// d\nexport function gamma() {}\n", "utf8");

    // `buildSymbolIndex(cwd, prev)` is where reuse is observable: an unchanged
    // file's already-extracted `symbols` array is handed through by identity.
    const prev = this.onDisk();
    const refreshed = buildSymbolIndex(this.dir, prev);
    t.assert.deepEqual(refreshed.files["src/a.ts"]?.symbols, ["alpha", "beta", "gamma"], "the edited file was rescanned");
    t.assert.equal(
      refreshed.files["src/other.ts"]?.symbols,
      prev.files["src/other.ts"]?.symbols,
      "the untouched file's symbols are the very same array — not re-read",
    );

    const third = loadOrBuildSymbolIndex(this.dir);
    t.assert.deepEqual(third.files["src/a.ts"]?.symbols, ["alpha", "beta", "gamma"], "and no rebuild command was needed");
    t.assert.notEqual(statSync(this.indexFile()).mtimeMs, before, "the change was written back");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnExactNameIsAPerfectHit extends SymbolIndexTest {
  readonly id = "an-exact-name-match-scores-one-and-the-excluded-file-is-never-its-own-hit";
  readonly whyItExists =
    "the reuse check matched a not-yet-written file against ITSELF and reported score 1, so every new file looked like a duplicate of one that did not exist yet";

  override run(t: TestRun): void {
    this.write("src/a.ts", "// a\nexport function alpha() {}\n// b\nexport const beta = 1;\n");
    // The candidate's own target, declaring the very name being checked: it is
    // the file `excludeFile` exists to keep out.
    this.write("src/new.ts", "export function alpha() {}\n");

    const index = loadOrBuildSymbolIndex(this.dir);
    const hits = findSimilarSymbols(index, ["alpha"], { excludeFile: "src/new.ts" });

    t.assert.equal(hits.length, 1, `only the other file is a hit; got ${JSON.stringify(hits)}`);
    t.assert.equal(hits[0]?.file, "src/a.ts", "the hit names the file, workspace-relative");
    t.assert.equal(hits[0]?.symbol, "alpha", "and the symbol it matched");
    t.assert.equal(hits[0]?.score, 1, "an exact normalized-name match is 1");

    // The exclusion is the whole point: without it the candidate's own target
    // scores 1 against itself.
    const unexcluded = findSimilarSymbols(index, ["alpha"], {});
    t.assert.equal(
      unexcluded.some((h) => h.file === "src/new.ts" && h.score === 1),
      true,
      "src/new.ts only stays out because excludeFile put it out",
    );
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnOldOrCorruptIndexIsRebuilt extends SymbolIndexTest {
  readonly id = "a-version-1-or-corrupt-symbols-json-is-discarded-and-rebuilt-at-version-2";
  readonly whyItExists =
    "a workspace holding a version-1 symbols.json kept entries that carried no line numbers at all, so every skeleton read from it pointed at line undefined";

  override run(t: TestRun): void {
    this.write("src/a.ts", "export function alpha() {}\n");

    mkdirSync(dirname(this.indexFile()), { recursive: true });
    writeFileSync(
      this.indexFile(),
      JSON.stringify({ version: 1, files: { "ghost.ts": { mtimeMs: 1, size: 1, symbols: ["ghost"], lines: [1] } } }),
      "utf8",
    );

    const rebuilt = loadOrBuildSymbolIndex(this.dir);
    t.assert.equal(rebuilt.version, 2, "the old version was not accepted as prev");
    t.assert.equal(this.onDisk().version, 2, "and a version-2 file replaced it on disk");
    t.assert.deepEqual(Object.keys(this.onDisk().files), ["src/a.ts"], "the ghost entry is gone");
    t.assert.deepEqual(this.onDisk().files["src/a.ts"]?.symbols, ["alpha"], "with what a full rescan found");

    writeFileSync(this.indexFile(), "{ this is not json", "utf8");
    const afterCorrupt = loadOrBuildSymbolIndex(this.dir);
    t.assert.equal(afterCorrupt.version, 2);
    t.assert.equal(this.onDisk().version, 2, "a corrupt cache is a missing cache, not a crash");
    t.assert.deepEqual(this.onDisk().files["src/a.ts"]?.symbols, ["alpha"]);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class WhatTheScanRefusesToIndex extends SymbolIndexTest {
  readonly id = "build-output-oversized-files-and-non-source-extensions-are-absent-while-python-is-indexed";
  readonly whyItExists =
    "a minified bundle under dist/ was scanned, and its thousands of mangled one-letter names poisoned the reuse check into reporting a duplicate for every new symbol";

  override run(t: TestRun): void {
    this.write("src/keep.ts", "export const keep = 1;\n");
    this.write("node_modules/dep/m.ts", "export const fromNodeModules = 1;\n");
    this.write("dist/bundle.ts", "export const fromDist = 1;\n");
    this.write("notes.md", "# not source\n");
    this.write("app.py", "def snake_case_fn():\n    pass\n\n\nclass PyThing:\n    pass\n");
    // Just over the 1 MB cap the graph and symbol scanners share.
    this.write("huge.ts", `export const huge = 1;\n// ${"x".repeat(1024 * 1024)}`);

    t.assert.ok(statSync(join(this.dir, "huge.ts")).size > 1024 * 1024, "the oversized fixture really is over the cap");

    const index = loadOrBuildSymbolIndex(this.dir);
    const keys = Object.keys(index.files).sort();
    t.assert.deepEqual(keys, ["app.py", "src/keep.ts"], `only the scannable source files; got ${JSON.stringify(keys)}`);

    t.assert.equal("node_modules/dep/m.ts" in index.files, false, "node_modules is not first-party source");
    t.assert.equal("dist/bundle.ts" in index.files, false, "nor is build output");
    t.assert.equal("notes.md" in index.files, false, "a non-source extension is not scanned");
    t.assert.equal("huge.ts" in index.files, false, "and a file over 1 MB is skipped entirely");

    t.assert.deepEqual(index.files["app.py"]?.symbols, ["snake_case_fn", "PyThing"], "a Python file's top-level def and class");
    t.assert.deepEqual(index.files["app.py"]?.lines, [1, 5], "with the line each is declared on");
  }
}

registerFeatureTests(
  new DeclarationLinesAreIndexed(),
  new AnUnchangedIndexIsNotRewrittenAndAnEditIsPickedUp(),
  new AnExactNameIsAPerfectHit(),
  new AnOldOrCorruptIndexIsRebuilt(),
  new WhatTheScanRefusesToIndex(),
);
