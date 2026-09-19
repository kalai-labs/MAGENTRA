/**
 * `import-graph`.
 *
 * The import graph maps which source file imports which, from a conservative
 * regex scan rather than an AST. It is built the first time a query needs it,
 * persisted to `.magentra/graph.json`, and refreshed incrementally: an entry
 * whose mtime AND size are unchanged keeps its already-resolved edges. That
 * cache is exactly why `GraphData.version` has to be bumped whenever import
 * EXTRACTION changes — an untouched file otherwise keeps the edges the old
 * scanner found, and a scanner fix never reaches a workspace that already has
 * a graph.json.
 *
 * `fs`, as the record declares: the subject is a file on disk, when it is
 * written and when it is not. Real source files, the real scanner, the real
 * `.magentra/graph.json`.
 *
 * ONE THING THE CHECKLIST ASKS FOR THAT THE PACKAGE DOES NOT EXPORT.
 * `isValidGraph`, `graphsEqual` and `saveGraph` are module-private in
 * `engine/core/src/knowledge/graph.ts`; only `buildGraph`, `loadOrBuildGraph`,
 * `blastRadius`, `dependencies`, `normalizeToId` and the analytics are on
 * `@magentra/core`. Version rejection is therefore proven where it is
 * observable — a version-2 (or corrupt) file on disk is REPLACED by a
 * version-3 one carrying the right edges — which is also the behaviour that
 * matters to a user whose workspace already holds an old graph.
 *
 * MTIME IS ASSERTED AGAINST AN EXPLICIT EARLIER TIME. "The file was not
 * rewritten" is only meaningful if a rewrite would be visible, so the test
 * pushes graph.json's mtime back ten seconds with `utimesSync` before the
 * second call and requires it to still be ten seconds back afterwards.
 */

import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { blastRadius, buildGraph, dependencies, loadOrBuildGraph, type GraphData } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "import-graph";

/** Verbatim from the record. */
const INVARIANT =
  "The import graph is built and cached, and GraphData.version must be bumped on any extraction change or cached entries hide the fix.";

abstract class ImportGraphTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected dir = "";

  override setUp(): void {
    this.dir = this.tempDir("magentra-graph-");
  }

  protected write(rel: string, contents: string): void {
    const abs = join(this.dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
  }

  /** Where the graph is persisted, by the scanner's own convention. */
  protected graphFile(): string {
    return join(this.dir, ".magentra", "graph.json");
  }

  protected onDisk(): GraphData {
    return JSON.parse(readFileSync(this.graphFile(), "utf8")) as GraphData;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ImportersAndDependenciesAreWalkedBothWays extends ImportGraphTest {
  readonly id = "blast-radius-walks-importers-and-dependencies-walks-imports";
  readonly whyItExists =
    "blastRadius included the seed itself, so 'what breaks if I change a.ts' listed a.ts and the agent read the file it was already editing instead of the two that imported it";

  override run(t: TestRun): void {
    this.write("a.ts", "export const a = 1;\n");
    this.write("b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');
    this.write("c.ts", 'import { b } from "./b.js";\nexport const c = b;\n');

    const g = loadOrBuildGraph(this.dir);
    t.assert.deepEqual(Object.keys(g.files).sort(), ["a.ts", "b.ts", "c.ts"], "node ids are workspace-relative, forward slashes");

    const blast = blastRadius(g, ["a.ts"]);
    t.assert.deepEqual(
      blast,
      [
        { file: "b.ts", distance: 1 },
        { file: "c.ts", distance: 2 },
      ],
      "b imports a directly, c reaches it through b",
    );
    t.assert.equal(
      blast.some((h) => h.file === "a.ts"),
      false,
      "and the seed is never in its own blast radius",
    );

    t.assert.deepEqual(
      dependencies(g, "c.ts"),
      [
        { file: "b.ts", distance: 1 },
        { file: "a.ts", distance: 2 },
      ],
      "the forward closure is the same edges read the other way",
    );
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AnUnchangedWorkspaceIsNotRewritten extends ImportGraphTest {
  readonly id = "the-graph-is-written-on-the-first-load-and-left-alone-on-the-second";
  readonly whyItExists =
    "every query rewrote graph.json whether or not anything had changed, so a read-only question dirtied the state directory and an atomic write raced the next query on every single turn";

  override run(t: TestRun): void {
    this.write("a.ts", "export const a = 1;\n");
    this.write("b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');

    const first = loadOrBuildGraph(this.dir);
    t.assert.equal(statSync(this.graphFile()).isFile(), true, ".magentra/graph.json is created on the first call");
    t.assert.equal(this.onDisk().version, 3, "persisted at the current version");
    t.assert.deepEqual(this.onDisk().files["b.ts"]?.imports, ["a.ts"], "with the edges the scan found");

    // Push the file back so a rewrite would be unmistakable.
    const back = Date.now() / 1000 - 10;
    utimesSync(this.graphFile(), back, back);
    const before = statSync(this.graphFile()).mtimeMs;

    const second = loadOrBuildGraph(this.dir);
    t.assert.equal(statSync(this.graphFile()).mtimeMs, before, "nothing changed, so nothing was written");
    t.assert.deepEqual(second.files, first.files, "and the same graph came back");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class OnlyTheChangedFileIsRescanned extends ImportGraphTest {
  readonly id = "an-edited-file-is-re-extracted-while-an-untouched-entry-is-reused";
  readonly whyItExists =
    "the refresh compared mtime alone, so an edit landing in the same clock tick kept the old edges and a newly added import was invisible until something else touched the file";

  override run(t: TestRun): void {
    this.write("a.ts", "export const a = 1;\n");
    this.write("b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');
    this.write("d.ts", "export const d = 1;\n");

    loadOrBuildGraph(this.dir);
    const prev = this.onDisk();
    t.assert.deepEqual(prev.files["a.ts"]?.imports, [], "a.ts imports nothing yet");

    this.write("a.ts", 'import { d } from "./d.js";\nexport const a = d;\n');

    // `buildGraph(cwd, prev)` is where reuse is observable: an unchanged file's
    // already-resolved `imports` array is handed straight through, by identity.
    const refreshed = buildGraph(this.dir, prev);
    t.assert.deepEqual(refreshed.files["a.ts"]?.imports, ["d.ts"], "the edited file was re-extracted and the new edge appeared");
    t.assert.equal(
      refreshed.files["b.ts"]?.imports,
      prev.files["b.ts"]?.imports,
      "the untouched file's resolved imports are the very same array — not re-read",
    );
    t.assert.equal(refreshed.files["b.ts"]?.mtimeMs, prev.files["b.ts"]?.mtimeMs, "and its recorded mtime is unchanged");
    t.assert.notEqual(refreshed.files["a.ts"]?.mtimeMs, prev.files["a.ts"]?.mtimeMs, "while the edited one's moved");

    // And through the public entry point, the new edge is persisted.
    const g = loadOrBuildGraph(this.dir);
    t.assert.deepEqual(g.files["a.ts"]?.imports, ["d.ts"]);
    t.assert.deepEqual(this.onDisk().files["a.ts"]?.imports, ["d.ts"], "the change was written back");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnOldOrCorruptGraphIsRebuilt extends ImportGraphTest {
  readonly id = "a-version-2-or-corrupt-graph-json-is-discarded-and-rebuilt-at-version-3";
  readonly whyItExists =
    "a workspace that already held a version-2 graph.json kept every untouched file's stale edges after the multi-line-import fix shipped, so finishing.ts reported zero importers on a repo that imports it four times";

  override run(t: TestRun): void {
    this.write("a.ts", "export const a = 1;\n");
    this.write("b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');

    // A previous version, holding a node this workspace does not contain.
    mkdirSync(dirname(this.graphFile()), { recursive: true });
    writeFileSync(
      this.graphFile(),
      JSON.stringify({ version: 2, files: { "ghost.ts": { mtimeMs: 1, size: 1, imports: ["nowhere.ts"] } } }),
      "utf8",
    );

    const rebuilt = loadOrBuildGraph(this.dir);
    t.assert.equal(rebuilt.version, 3, "the old version was not accepted as prev");
    t.assert.equal(this.onDisk().version, 3, "and a version-3 file replaced it on disk");
    t.assert.deepEqual(Object.keys(this.onDisk().files).sort(), ["a.ts", "b.ts"], "the ghost entry is gone");
    t.assert.deepEqual(this.onDisk().files["b.ts"]?.imports, ["a.ts"], "with the edges a full rescan found");

    // Corrupt JSON takes the same path: no prev, full build.
    writeFileSync(this.graphFile(), "{ this is not json", "utf8");
    const afterCorrupt = loadOrBuildGraph(this.dir);
    t.assert.equal(afterCorrupt.version, 3);
    t.assert.equal(this.onDisk().version, 3, "a corrupt cache is a missing cache, not a crash");
    t.assert.deepEqual(this.onDisk().files["b.ts"]?.imports, ["a.ts"]);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class PackagesAreNodesButNeverBlastResults extends ImportGraphTest {
  readonly id = "package-imports-become-pkg-nodes-that-deps-lists-and-blast-never-returns";
  readonly whyItExists =
    "`pkg:` nodes leaked into the blast radius, so 'what breaks if I change this' answered with a library name the agent could not open and the real importers were pushed off the list";

  override run(t: TestRun): void {
    this.write("a.ts", 'import { z } from "zod";\nexport const a = z;\n');
    this.write("b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');

    const g = loadOrBuildGraph(this.dir);
    t.assert.deepEqual(g.files["a.ts"]?.imports, ["pkg:zod"], "an external specifier resolves to a synthetic pkg node");
    t.assert.equal("pkg:zod" in g.files, false, "which is an edge target only — it is never scanned as a file");

    t.assert.deepEqual(dependencies(g, "a.ts"), [{ file: "pkg:zod", distance: 1 }], "dependencies() lists it");

    // The package is reachable as a SEED, and its radius is files only.
    t.assert.deepEqual(
      blastRadius(g, ["pkg:zod"]),
      [
        { file: "a.ts", distance: 1 },
        { file: "b.ts", distance: 2 },
      ],
      "who depends on zod, transitively",
    );
    t.assert.equal(
      blastRadius(g, ["a.ts"]).some((h) => h.file.startsWith("pkg:")),
      false,
      "and no pkg node is ever a blast result",
    );
  }
}

registerFeatureTests(
  new ImportersAndDependenciesAreWalkedBothWays(),
  new AnUnchangedWorkspaceIsNotRewritten(),
  new OnlyTheChangedFileIsRescanned(),
  new AnOldOrCorruptGraphIsRebuilt(),
  new PackagesAreNodesButNeverBlastResults(),
);
