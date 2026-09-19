/**
 * `tool-write`.
 *
 * Write creates a file or replaces one entirely. If the path already exists it
 * must have been Read this session and must not have moved on disk since
 * (`FileState.checkFresh`), or the call fails instead of clobbering work the
 * model never saw. Parent directories are created on the way. Every success
 * records the new state and emits a `file_edited` event carrying a unified
 * diff, and an overwrite adds a note pointing at Edit for incremental changes.
 *
 * `fs`, as the record declares: the tool's whole effect is a real file on disk
 * and an event about it.
 *
 * The tool runs against a REAL `FileState` from `@magentra/core`, through the
 * same validate-then-execute path the Session uses (`tests/lib/directTool.ts`).
 * `emit` is this test's own collector, standing where the Engine's queue would,
 * exactly as `tool-taskcreate.test.ts` does with the task store's. Nothing the
 * tool does is stubbed, and `strictServices` makes any other service the tool
 * reaches for a named failure.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FileState, type ToolContext } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";
import { writeTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "tool-write";

/** Verbatim from the record. */
const INVARIANT =
  "Write refuses to overwrite a file not Read this session or changed on disk since, creates parent directories, and emits a file_edited diff.";

abstract class WriteTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected events: CoreEvent[] = [];
  protected dir = "";

  /** The real freshness store the Session hands every tool. */
  protected readonly state = new FileState();

  protected workspace(): string {
    if (this.dir === "") this.dir = this.tempDir("magentra-write-");
    return this.dir;
  }

  protected file(name: string, contents: string): string {
    const path = join(this.workspace(), name);
    writeFileSync(path, contents);
    return path;
  }

  protected ctx(): ToolContext {
    return {
      cwd: this.workspace(),
      session: strictServices({
        fileState: this.state,
        emit: (event: CoreEvent) => {
          this.events.push(event);
        },
      }),
    };
  }

  /** The diffs announced so far, in order. */
  protected diffs(): string[] {
    return this.events.flatMap((event) => (event.type === "file_edited" ? [event.diff] : []));
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ANewFileBringsItsDirectoriesWithIt extends WriteTest {
  readonly id = "writing-into-a-directory-that-does-not-exist-creates-it-and-announces-the-diff";
  readonly whyItExists =
    "without the recursive mkdir the first file of a new package failed with ENOENT and the model spent a turn running mkdir through Bash; without the file_edited event the diff view showed nothing for a file that had just appeared";

  override async run(t: TestRun): Promise<void> {
    const path = join(this.workspace(), "a", "b", "c.txt");
    t.assert.equal(existsSync(join(this.workspace(), "a")), false, "the parent really is absent to begin with");

    const result = await runTool(writeTool, { file_path: path, content: "hello\n" }, this.ctx());
    t.assert.equal(result.isError, undefined, resultText(result));
    t.assert.equal(readFileSync(path, "utf8"), "hello\n", "the file landed, directories and all");
    t.assert.equal(resultText(result).startsWith(`File written: ${path}`), true, resultText(result));
    t.assert.equal(resultText(result).includes("replaced entirely"), false, "a create is not an overwrite");

    const diffs = this.diffs();
    t.assert.equal(diffs.length, 1, "exactly one file_edited per write");
    t.assert.equal(diffs[0]?.startsWith(`--- a/${join("a", "b", "c.txt")}`), true, diffs[0] ?? "(no diff)");
    t.assert.equal(diffs[0]?.includes("+hello"), true, "the diff shows the added line");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AnUnreadFileIsNotOverwritten extends WriteTest {
  readonly id = "overwriting-a-file-never-read-this-session-fails-and-leaves-it-alone";
  readonly whyItExists =
    "a Write that skipped the freshness check replaced a config file the model had only guessed at, destroying every line it had not thought to reproduce";

  override async run(t: TestRun): Promise<void> {
    const path = this.file("existing.txt", "the user's work\n");
    t.assert.equal(this.state.wasRead(path), false, "nothing has Read it");

    const result = await runTool(writeTool, { file_path: path, content: "the model's guess\n" }, this.ctx());
    t.assert.equal(result.isError, true, "an unread overwrite is an error");
    t.assert.equal(
      resultText(result).includes("has not been read in this session"),
      true,
      `it says why; it said ${JSON.stringify(resultText(result))}`,
    );
    t.assert.equal(readFileSync(path, "utf8"), "the user's work\n", "and the file is untouched");
    t.assert.equal(this.diffs().length, 0, "a refused write announces nothing");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AFileChangedOnDiskIsNotOverwritten extends WriteTest {
  readonly id = "overwriting-a-file-that-moved-on-disk-since-the-read-fails-and-keeps-the-newer-bytes";
  readonly whyItExists =
    "a check that only asked whether the file had ever been read let a Write land on top of the edits the user made while the turn was running, and the user's version was gone with no diff to recover it";

  override async run(t: TestRun): Promise<void> {
    const path = this.file("shared.txt", "as the model read it\n");
    this.state.recordRead(path);
    appendFileSync(path, "the user's later line\n");

    const result = await runTool(writeTool, { file_path: path, content: "the model's version\n" }, this.ctx());
    t.assert.equal(result.isError, true, "a stale overwrite is an error");
    t.assert.equal(
      resultText(result).includes("modified on disk since it was last read"),
      true,
      `it says why; it said ${JSON.stringify(resultText(result))}`,
    );
    t.assert.equal(
      readFileSync(path, "utf8"),
      "as the model read it\nthe user's later line\n",
      "the externally modified content survived intact",
    );
    t.assert.equal(this.diffs().length, 0, "a refused write announces nothing");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AFreshOverwriteReplacesAndRestamps extends WriteTest {
  readonly id = "an-overwrite-of-a-read-file-replaces-it-notes-so-and-leaves-the-record-fresh";
  readonly whyItExists =
    "a Write that wrote the file but forgot to re-record it made the very next Write on the same file fail as 'modified on disk' — by its own hand — and the missing note let the model keep rewriting whole files instead of reaching for Edit";

  override async run(t: TestRun): Promise<void> {
    const path = this.file("notes.txt", "old line\n");
    this.state.recordRead(path);

    const result = await runTool(writeTool, { file_path: path, content: "new line\n" }, this.ctx());
    t.assert.equal(result.isError, undefined, resultText(result));
    t.assert.equal(readFileSync(path, "utf8"), "new line\n", "the file was replaced entirely");
    t.assert.equal(
      resultText(result).includes("existing file replaced entirely"),
      true,
      `an overwrite says so; it said ${JSON.stringify(resultText(result))}`,
    );

    const diff = this.diffs()[0] ?? "(no diff)";
    t.assert.equal(diff.includes("-old line"), true, diff);
    t.assert.equal(diff.includes("+new line"), true, diff);

    // The write re-stamped the record, so the next one does not have to re-Read.
    const again = await runTool(writeTool, { file_path: path, content: "newer line\n" }, this.ctx());
    t.assert.equal(again.isError, undefined, `a second write straight after the first: ${resultText(again)}`);
    t.assert.equal(readFileSync(path, "utf8"), "newer line\n");
    t.assert.equal(this.diffs().length, 2, "and it announced its own diff too");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class OnlyAbsolutePathsAndOnlyExistingFilesNeedARead extends WriteTest {
  readonly id = "a-relative-path-is-refused-and-a-brand-new-file-needs-no-prior-read";
  readonly whyItExists =
    "a relative path was resolved against whatever cwd the engine happened to hold, so the file appeared somewhere nobody was looking; and a freshness check applied before the existence check would have made creating any new file impossible";

  override async run(t: TestRun): Promise<void> {
    const relative = await runTool(writeTool, { file_path: join("sub", "rel.txt"), content: "nope\n" }, this.ctx());
    t.assert.equal(relative.isError, true, "a relative path is an error");
    t.assert.equal(
      resultText(relative).includes("must be absolute"),
      true,
      `it says why; it said ${JSON.stringify(resultText(relative))}`,
    );
    t.assert.equal(existsSync(join(this.workspace(), "sub", "rel.txt")), false, "and nothing was written anywhere");
    t.assert.equal(this.diffs().length, 0);

    mkdirSync(join(this.workspace(), "sub"), { recursive: true });
    const fresh = join(this.workspace(), "sub", "new.txt");
    const created = await runTool(writeTool, { file_path: fresh, content: "made\n" }, this.ctx());
    t.assert.equal(created.isError, undefined, `a file that does not exist yet needs no Read: ${resultText(created)}`);
    t.assert.equal(readFileSync(fresh, "utf8"), "made\n");
    t.assert.equal(this.diffs().length, 1, "and the create was announced");
  }
}

registerFeatureTests(
  new ANewFileBringsItsDirectoriesWithIt(),
  new AnUnreadFileIsNotOverwritten(),
  new AFileChangedOnDiskIsNotOverwritten(),
  new AFreshOverwriteReplacesAndRestamps(),
  new OnlyAbsolutePathsAndOnlyExistingFilesNeedARead(),
);
