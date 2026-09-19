/**
 * `file-freshness`.
 *
 * The engine remembers the size and mtime of every file the model Read this
 * session. Edit — and Write on a file that already exists — consults that
 * record first: a file never read, or one whose size or mtime moved since,
 * is refused with a message telling the model to Read it again. Without it
 * the model overwrites whatever the user or another process changed while it
 * was not looking, and the loss is silent.
 *
 * `fs`, as the record declares. The store's whole subject is real stat data
 * from real files, so every case here is a file on disk in this test's own
 * temp directory — appended to, re-stamped with `utimesSync`, or deleted.
 *
 * Items 1–4 exercise the REAL `FileState` from `@magentra/core` directly,
 * because it is the feature's entry file. Item 5 runs the real Edit and Write
 * tools through the same validate-then-execute path the Session uses
 * (`tests/lib/directTool.ts`), against that same real store; `emit` is this
 * test's own collector, standing where the Engine's queue would. Nothing is
 * stubbed.
 *
 * Item 5 deliberately overlaps `tool-edit` and `tool-write`: those files prove
 * the tools' own invariants, this one proves that the freshness rule is what
 * the callers actually enforce.
 */

import { appendFileSync, existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FileState, type ToolContext } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";
import { editTool, writeTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "file-freshness";

/** Verbatim from the record. */
const INVARIANT = "Writing or editing a file not Read this session, or changed on disk since, fails.";

abstract class FileFreshnessTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected events: CoreEvent[] = [];
  protected dir = "";

  /** The real store — the feature's entry file, never a stand-in. */
  protected readonly state = new FileState();

  protected workspace(): string {
    if (this.dir === "") this.dir = this.tempDir("magentra-freshness-");
    return this.dir;
  }

  /** A real file in this test's own directory. */
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
}

/* ---- checklist 1 ----------------------------------------------------- */

class AFileNeverReadIsRefused extends FileFreshnessTest {
  readonly id = "check-fresh-on-a-file-never-read-says-to-read-it-first";
  readonly whyItExists =
    "a store that answered 'fresh' for a path it had never seen let the model rewrite a file it had only guessed the contents of, and the guess landed on disk";

  override run(t: TestRun): void {
    const path = this.file("never-read.txt", "hello\n");
    const message = this.state.checkFresh(path);
    t.assert.equal(typeof message, "string", "an unread file is refused, not waved through");
    t.assert.equal(
      message?.includes("has not been read in this session"),
      true,
      `the refusal names the reason; it said ${JSON.stringify(message)}`,
    );
    t.assert.equal(message?.includes(path), true, "and it names the file the model has to Read");
    t.assert.equal(this.state.wasRead(path), false, "asking about a file is not reading it");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AChangedSizeMakesTheRecordStale extends FileFreshnessTest {
  readonly id = "a-recorded-read-goes-stale-when-the-file-grows-on-disk";
  readonly whyItExists =
    "a check that only asked 'was this read at some point' passed on a file another process had appended to, so the model's Write dropped the appended lines without a word";

  override run(t: TestRun): void {
    const path = this.file("grows.txt", "one\n");
    this.state.recordRead(path);
    t.assert.equal(this.state.wasRead(path), true, "the read was recorded");
    t.assert.equal(this.state.checkFresh(path), undefined, "a file just read is fresh");

    const sizeBefore = statSync(path).size;
    appendFileSync(path, "two\n");
    t.assert.equal(statSync(path).size, sizeBefore + 4, "the fixture really did change the file's size");

    const message = this.state.checkFresh(path);
    t.assert.equal(
      message?.includes("modified on disk since it was last read"),
      true,
      `the stale message names the reason; it said ${JSON.stringify(message)}`,
    );
    t.assert.equal(message?.includes("Re-Read"), true, "and it tells the model what to do about it");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AChangedMtimeAloneMakesTheRecordStale extends FileFreshnessTest {
  readonly id = "a-recorded-read-goes-stale-when-only-the-mtime-moves";
  readonly whyItExists =
    "a check on size alone called a file fresh after an edit that replaced one character with another, so a same-length change made elsewhere was silently overwritten";

  override run(t: TestRun): void {
    const path = this.file("retouched.txt", "same size\n");
    this.state.recordRead(path);
    t.assert.equal(this.state.checkFresh(path), undefined, "a file just read is fresh");

    // Five seconds back, so no filesystem's timestamp granularity can leave the
    // two stamps equal and make this test pass for the wrong reason.
    const before = statSync(path);
    utimesSync(path, before.atime, new Date(before.mtimeMs - 5_000));
    const after = statSync(path);
    t.assert.equal(after.size, before.size, "only the timestamp moved");
    t.assert.notEqual(after.mtimeMs, before.mtimeMs, "the fixture really did move the mtime");

    const message = this.state.checkFresh(path);
    t.assert.equal(
      message?.includes("modified on disk since it was last read"),
      true,
      `mtime alone is enough to go stale; checkFresh said ${JSON.stringify(message)}`,
    );
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ADeletedFileIsNotStale extends FileFreshnessTest {
  readonly id = "a-file-deleted-since-the-read-is-not-reported-stale";
  readonly whyItExists =
    "treating a missing file as 'modified on disk' blocked Write from recreating a file the agent had just deleted on purpose, and the only advice on offer was to Read a path that no longer existed";

  override run(t: TestRun): void {
    const path = this.file("gone.txt", "here for now\n");
    this.state.recordRead(path);
    t.assert.equal(this.state.checkFresh(path), undefined, "fresh while it exists");

    rmSync(path);
    t.assert.equal(existsSync(path), false, "the fixture really did delete it");
    t.assert.equal(this.state.checkFresh(path), undefined, "a deleted file is not stale — Write may recreate it");
    t.assert.equal(this.state.wasRead(path), true, "and the read is still remembered");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheToolsEnforceTheRecord extends FileFreshnessTest {
  readonly id = "edit-refuses-an-unread-file-while-write-creates-a-new-one-freely";
  readonly whyItExists =
    "a store nobody consulted is no protection: Edit reaching straight for writeFileSync clobbered a file the model had never read, while a freshness check applied to a path that does not exist yet would have made creating any new file impossible";

  override async run(t: TestRun): Promise<void> {
    const unread = this.file("unread.ts", "const a = 1;\n");
    const edit = await runTool(
      editTool,
      { file_path: unread, old_string: "const a = 1;", new_string: "const a = 2;" },
      this.ctx(),
    );
    t.assert.equal(edit.isError, true, "Edit on a file that was never Read is an error");
    t.assert.equal(
      resultText(edit).includes("has not been read in this session"),
      true,
      `Edit's refusal came from the freshness store; it said ${JSON.stringify(resultText(edit))}`,
    );
    t.assert.equal(readFileSync(unread, "utf8"), "const a = 1;\n", "and the file is exactly as it was");
    t.assert.equal(this.events.length, 0, "a refused edit announces nothing");

    const created = join(this.workspace(), "brand-new.txt");
    const write = await runTool(writeTool, { file_path: created, content: "created\n" }, this.ctx());
    t.assert.equal(write.isError, undefined, `a brand-new file needs no prior Read: ${resultText(write)}`);
    t.assert.equal(readFileSync(created, "utf8"), "created\n");
    t.assert.equal(this.state.wasRead(created), true, "and the write is recorded, so the next one is fresh");
    t.assert.equal(this.state.checkFresh(created), undefined);
  }
}

registerFeatureTests(
  new AFileNeverReadIsRefused(),
  new AChangedSizeMakesTheRecordStale(),
  new AChangedMtimeAloneMakesTheRecordStale(),
  new ADeletedFileIsNotStale(),
  new TheToolsEnforceTheRecord(),
);
