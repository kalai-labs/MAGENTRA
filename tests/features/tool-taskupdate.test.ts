/**
 * `tool-taskupdate`.
 *
 * TaskUpdate changes ONE task, and only the fields the call names: a status
 * change must not reset the description or the owner, metadata merges (null
 * deletes a key), dependency edges are added on both sides, and `deleted`
 * removes the task and every edge that pointed at it. Moving to in_progress
 * adds advisories when blockers are open or another task is already running;
 * completing the last open task adds the verification reminder.
 *
 * `fs`, and the record said `pure`: the tool mutates a `TaskStore` that lives
 * on disk. Re-declared 2026-09-19. Real tool, real store, real validation path.
 */

import { join } from "node:path";

import { TaskStore, type ToolContext } from "@magentra/core";
import { taskCreateTool, taskUpdateTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "tool-taskupdate";

/** Verbatim from the record. */
const INVARIANT = "An update changes only the fields given and never marks completed work that is still partial.";

abstract class TaskUpdateTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #ctx: ToolContext | undefined;
  protected store!: TaskStore;

  protected ctx(): ToolContext {
    if (this.#ctx) return this.#ctx;
    const workspace = this.tempDir("magentra-taskupdate-");
    this.store = new TaskStore(join(workspace, ".magentra"), "s_update", () => {});
    this.#ctx = { cwd: workspace, session: strictServices({ tasks: this.store }) };
    return this.#ctx;
  }

  protected async create(subject: string, description = "d"): Promise<void> {
    await runTool(taskCreateTool, { subject, description }, this.ctx());
  }

  protected async update(taskId: string, patch: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = await runTool(taskUpdateTool, { taskId, ...patch }, this.ctx());
    return { text: resultText(result), isError: result.isError === true };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class OnlyTheGivenFieldsChange extends TaskUpdateTest {
  readonly id = "a-status-change-leaves-subject-description-and-owner-untouched";
  readonly whyItExists = "a patch that reset every unspecified field wiped the description and the owner on each status change, so a completed task had no record of what it had been";

  override async run(t: TestRun): Promise<void> {
    await this.create("A", "d");
    await this.update("1", { owner: "me" });
    const result = await this.update("1", { status: "in_progress" });
    t.assert.equal(result.isError, false, result.text);
    t.assert.equal(result.text, "Task #1 updated: [in_progress] A");
    const task = this.store.get("1");
    t.assert.equal(task?.status, "in_progress", "the one field named changed");
    t.assert.equal(task?.subject, "A");
    t.assert.equal(task?.description, "d");
    t.assert.equal(task?.owner, "me");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class MetadataMergesAndNullDeletes extends TaskUpdateTest {
  readonly id = "metadata-merges-key-by-key-and-a-null-value-deletes-the-key";
  readonly whyItExists = "metadata replaced wholesale on every update lost the PR number a workflow had attached, and there was no way to remove a key at all";

  override async run(t: TestRun): Promise<void> {
    await this.create("meta");
    await this.update("1", { metadata: { a: 1 } });
    t.assert.deepEqual(this.store.get("1")?.metadata, { a: 1 });
    await this.update("1", { metadata: { b: 2, a: null } });
    t.assert.deepEqual(this.store.get("1")?.metadata, { b: 2 }, "b merged in, a deleted by null");
    await this.update("1", { subject: "renamed" });
    t.assert.deepEqual(this.store.get("1")?.metadata, { b: 2 }, "an update that does not name metadata leaves it alone");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class InProgressCarriesAdvisories extends TaskUpdateTest {
  readonly id = "starting-a-blocked-task-or-a-second-task-adds-an-advisory";
  readonly whyItExists = "the agent started a blocked task and a second concurrent one with no pushback, and the list stopped reflecting what was actually being worked on";

  override async run(t: TestRun): Promise<void> {
    await this.create("one");
    await this.create("two");
    await this.update("2", { addBlockedBy: ["1"] });

    const blocked = await this.update("2", { status: "in_progress" });
    t.assert.equal(blocked.isError, false);
    t.assert.match(blocked.text, /advisory: this task is blocked by #1 one \[pending\]/, "starting a blocked task is allowed but flagged");
    t.assert.equal(this.store.get("2")?.status, "in_progress", "the status still changed — it is advice, not a refusal");

    const second = await this.update("1", { status: "in_progress" });
    t.assert.match(second.text, /advisory: task\(s\) #2 are also in_progress/, "a second running task names the other one");

    // A clean start carries no advisory at all.
    await this.create("three");
    await this.update("1", { status: "completed" });
    await this.update("2", { status: "completed" });
    const clean = await this.update("3", { status: "in_progress" });
    t.assert.equal(clean.text, "Task #3 updated: [in_progress] three", "no blockers, nothing else running: no advisory");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ReferencesResolveOrTheCallIsRefusedWhole extends TaskUpdateTest {
  readonly id = "echoed-reference-forms-resolve-and-an-unknown-edge-refuses-the-whole-update";
  readonly whyItExists = "an update that applied its status change and then failed on a bad edge left the task half-changed with an error the model read as 'nothing happened'";

  override async run(t: TestRun): Promise<void> {
    await this.create("one");
    await this.create("two");
    const resolved = await this.update("#2", { addBlockedBy: ["task-1"] });
    t.assert.equal(resolved.isError, false, resolved.text);
    t.assert.deepEqual(this.store.get("2")?.blockedBy, ["1"], "'#2' and 'task-1' both resolved to real ids");
    t.assert.deepEqual(this.store.get("1")?.blocks, ["2"]);

    const before = JSON.stringify(this.store.list());
    const refused = await this.update("1", { status: "in_progress", addBlockedBy: ["99"] });
    t.assert.equal(refused.isError, true, "an unknown edge target refuses the call");
    t.assert.match(refused.text, /No task matches "99"/);
    t.assert.match(refused.text, /#1 \[pending\] one/, "and lists the tasks that exist");
    t.assert.equal(JSON.stringify(this.store.list()), before, "nothing changed — not even the status that was also asked for");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheLastCompletionRemindsAndDeletionStripsEdges extends TaskUpdateTest {
  readonly id = "completing-the-last-open-task-appends-the-verification-note-and-deleted-strips-edges";
  readonly whyItExists = "the wrap-up claimed done with nothing run, and a deleted task left dangling ids in other tasks' blockedBy that kept them BLOCKED forever";

  override async run(t: TestRun): Promise<void> {
    await this.create("only");
    const done = await this.update("1", { status: "completed" });
    t.assert.match(done.text, /final task completed — your wrap-up must state the verification command you ran/, "the last completion carries the reminder");

    await this.create("two");
    await this.create("three");
    await this.update("3", { addBlockedBy: ["2"] });
    const notLast = await this.update("3", { status: "completed" });
    t.assert.doesNotMatch(notLast.text, /final task completed/, "with another task still open there is no 'final' note");

    const deleted = await this.update("2", { status: "deleted" });
    t.assert.equal(deleted.text, "Task #2 deleted.");
    t.assert.equal(this.store.get("2"), undefined, "the task is gone");
    t.assert.deepEqual(this.store.get("3")?.blockedBy, [], "and its id was stripped from the task it blocked");
    t.assert.deepEqual(this.store.list().map((x) => x.id), ["1", "3"]);
  }
}

registerFeatureTests(
  new OnlyTheGivenFieldsChange(),
  new MetadataMergesAndNullDeletes(),
  new InProgressCarriesAdvisories(),
  new ReferencesResolveOrTheCallIsRefusedWhole(),
  new TheLastCompletionRemindsAndDeletionStripsEdges(),
);
