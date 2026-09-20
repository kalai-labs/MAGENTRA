/**
 * `changes-panel`.
 *
 * Every edit the agent makes arrives as a unified diff. Without somewhere to
 * collect them, a user cannot see what a session changed across a dozen files,
 * and cannot take any of it back without going to git. So the diffs are kept
 * per file for the session, counted, shown, and undoable in one step.
 *
 * The load-bearing rule is in checklist 4: the view may only forget a file's
 * edits when the DISK actually gave them up. A panel that clears a row on a
 * failed undo tells the user their change is gone while it is still in the
 * file — and they will not look again.
 *
 * `ui`: `events.js` and `workbench.js` are classic scripts in the page's shared
 * scope, and the undo goes through the real IPC to the real main process, which
 * really rewrites the file on disk.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "changes-panel";

/** Verbatim from the record. */
const INVARIANT = "Changed files are listed with counts, expandable diffs, and a transactional Undo.";

/** A unified diff that adds one line to `notes.txt`, as the engine emits one. */
function addLineDiff(): string {
  return [
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -1,1 +1,2 @@",
    " first line",
    "+second line",
    "",
  ].join("\n");
}

/** A second edit to the same file. */
function addAnotherDiff(): string {
  return [
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -1,2 +1,3 @@",
    " first line",
    " second line",
    "+third line",
    "",
  ].join("\n");
}

abstract class ChangesTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected async console(): Promise<{ app: AppHandle; workspace: string }> {
    const home = this.makeTempDir("magentra-chg-home-");
    const workspace = this.makeTempDir("magentra-chg-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "model-one",
    });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    return { app, workspace };
  }

  /**
   * Deliver an engine event and WAIT FOR IT TO LAND.
   *
   * A fixed pause was long enough alone and not under a full parallel run,
   * where several Electron instances share a machine — the count was read
   * before the second event had been handled. Polling for the collection to
   * reach the expected size is the same assertion without the race.
   */
  protected async deliver(app: AppHandle, event: Record<string, unknown>, expectFiles?: number): Promise<void> {
    await app.evaluate(`handleEngineEvent(${JSON.stringify(event)}); true`);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const size = await app.evaluate<number>(`sessionChanges.size`);
      if (expectFiles === undefined || size >= expectFiles) return;
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Wait until a file's collected edits reach `count`. */
  protected async editsFor(app: AppHandle, relPath: string, count: number): Promise<number> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const have = await app.evaluate<number>(`(sessionChanges.get(${JSON.stringify(relPath)}) || { diffs: [] }).diffs.length`);
      if (have >= count || Date.now() > deadline) return have;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/* ---- checklist 1, 2 and 3 ---------------------------------------------- */

class EditsAreCollectedPerFile extends ChangesTest {
  readonly id = "edits-to-one-file-are-collected-counted-and-listed-in-order";
  readonly whyItExists =
    "without a per-file collection the user cannot see what a session changed, and a file edited five times looks the same as one edited once";

  override async run(t: TestRun): Promise<void> {
    const { app } = await this.console();

    await this.deliver(app, { type: "file_edited", path: "notes.txt", diff: addLineDiff() }, 1);
    await this.deliver(app, { type: "file_edited", path: "notes.txt", diff: addAnotherDiff() }, 1);
    t.assert.equal(await this.editsFor(app, "notes.txt", 2), 2, "both edits must have been collected before they are counted");

    const collected = await app.evaluate<{ files: number; count: number; adds: number; dels: number }>(`
      (() => {
        const entry = sessionChanges.get("notes.txt");
        return {
          files: sessionChanges.size,
          count: entry ? entry.diffs.length : 0,
          adds: entry ? entry.adds : -1,
          dels: entry ? entry.dels : -1,
        };
      })()
    `);
    t.assert.equal(collected.files, 1, "two edits to one file are one row, not two");
    t.assert.equal(collected.count, 2, "and the row knows there were two of them");
    t.assert.equal(collected.adds, 2, "the added lines are summed across the edits");
    t.assert.equal(collected.dels, 0, "and nothing was removed, so nothing is counted as removed");

    // Checklist 2: the path comes from the diff, and the headers are not counted
    // as changed lines.
    const parsed = await app.evaluate<{ relPath: string; adds: number; dels: number }>(
      `parseDiff(${JSON.stringify(addLineDiff())}, "ignored-fallback.txt")`,
    );
    t.assert.equal(parsed.relPath, "notes.txt", "the file a diff touches is named in the diff itself");
    t.assert.equal(parsed.adds, 1, "'+++' is a header, not an added line");
    t.assert.equal(parsed.dels, 0, "'---' is a header, not a removed one");

    // Checklist 3: with no header to read, the event's own path is used.
    const headerless = await app.evaluate<string>(
      `parseDiff("@@ -1 +1 @@\\n-old\\n+new\\n", "from-the-event.txt").relPath`,
    );
    t.assert.equal(headerless, "from-the-event.txt", "a diff with no header still belongs to a file");
  }
}

/* ---- checklist 4 — the rule that matters ------------------------------- */

class AFailedUndoKeepsTheRow extends ChangesTest {
  readonly id = "a-failed-undo-leaves-the-change-where-it-is";
  readonly whyItExists =
    "clearing the row on a failed undo tells the user their change is gone while it is still in the file, and they have no reason to look again";

  override async run(t: TestRun): Promise<void> {
    const { app, workspace } = await this.console();

    // A real file, in the state the edit left it: the undo must really reverse.
    writeFileSync(join(workspace, "notes.txt"), "first line\nsecond line\n", "utf8");
    await this.deliver(app, { type: "file_edited", path: "notes.txt", diff: addLineDiff() });

    // A file the diff cannot be reversed against — it is not on disk at all.
    await this.deliver(app, { type: "file_edited", path: "missing.txt", diff: addLineDiff().replace(/notes\.txt/g, "missing.txt") }, 2);
    t.assert.equal(await app.evaluate<number>(`sessionChanges.size`), 2, "both edits must be collected before either is undone");

    // The failure first: the row stays, because the disk still has the change.
    const failed = await app.evaluate<{ ok: boolean; size: number; has: boolean }>(`
      (async () => {
        await undoFileChange("missing.txt");
        return { ok: false, size: sessionChanges.size, has: sessionChanges.has("missing.txt") };
      })()
    `);
    t.assert.equal(failed.has, true, "a file whose undo failed must still be listed — the change is still there");
    t.assert.equal(failed.size, 2, "and nothing else may be dropped with it");

    // The success: the row goes, and so does the line in the file.
    await app.evaluate(`undoFileChange("notes.txt")`);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // LINE ENDINGS ARE NOT WHAT THIS ASSERTS, and on Windows they are not the
    // test's to choose. The undo is `git apply --reverse` (app/main/changes.js:39),
    // and git rewrites what it writes according to `core.autocrlf` — true by
    // default on a Windows install — so the reversed file comes back
    // "first line\r\n" from a workspace that was written "first line\n". The
    // claim here is that the ADDED LINE IS GONE and the original content is
    // back; comparing the terminator as well would make this test pass or fail
    // on the developer's git configuration.
    t.assert.equal(
      readFileSync(join(workspace, "notes.txt"), "utf8").replace(/\r\n/g, "\n"),
      "first line\n",
      "a successful undo really reverses the edit on disk",
    );
    t.assert.equal(
      await app.evaluate<boolean>(`sessionChanges.has("notes.txt")`),
      false,
      "and only then is the row dropped",
    );
  }
}

/* ---- checklist 5 ------------------------------------------------------- */

class AFreshSessionHasNoChanges extends ChangesTest {
  readonly id = "a-fresh-session-starts-with-no-changes";
  readonly whyItExists =
    "carrying the previous session's edits into a cleared one offers an Undo for a change the new session never made";

  override async run(t: TestRun): Promise<void> {
    const { app } = await this.console();

    await this.deliver(app, { type: "file_edited", path: "notes.txt", diff: addLineDiff() });
    t.assert.equal(await app.evaluate<number>(`sessionChanges.size`), 1, "there must be a change to clear");

    await app.evaluate(`resetChanges(); true`);

    t.assert.equal(await app.evaluate<number>(`sessionChanges.size`), 0, "a new session starts with nothing to undo");
    const summary = await app.evaluate<string>(`
      (() => {
        renderChanges();
        const host = document.getElementById("changesView") || document.body;
        return (host.textContent || "").toLowerCase();
      })()
    `);
    t.assert.match(summary, /no (edits|changes)/, `the panel must say so; it said "${summary.slice(0, 120)}"`);
  }
}

registerFeatureTests(new EditsAreCollectedPerFile(), new AFailedUndoKeepsTheRow(), new AFreshSessionHasNoChanges());
