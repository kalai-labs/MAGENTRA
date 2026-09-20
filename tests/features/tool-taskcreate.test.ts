/**
 * `tool-taskcreate`.
 *
 * TaskCreate adds a task to the session's list: pending, with empty dependency
 * lists and a numeric string id. The store persists the list to
 * `.magentra/tasks/<sessionId>.json` and emits `task_list_updated` so the UI
 * follows along. Without it multi-step work is invisible to the user and the
 * agent has no list to track what is done and what is blocked.
 *
 * `fs`, and the record said `pure`. The tool's whole effect is a file the
 * store writes and an event it emits — the checklist reads that file — so this
 * is filesystem work by `fsTest.ts`'s definition. Re-declared 2026-09-19.
 *
 * The tool runs against a REAL `TaskStore` on a temp state directory, through
 * the same validate-then-execute path the Session uses (`tests/lib/directTool.ts`).
 * The store's `emit` is the test's own collector, standing where the Engine's
 * queue would.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TaskStore, type ToolContext } from "@magentra/core";
import type { CoreEvent, TaskItem } from "@magentra/protocol";
import { taskCreateTool, taskUpdateTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "tool-taskcreate";

/** Verbatim from the record. */
const INVARIANT = "A created task lands in the session list with its dependency edges intact.";

abstract class TaskCreateTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected events: CoreEvent[] = [];
  protected stateDir = "";
  protected readonly sessionId = "s_test";

  /** A real store on a state directory of this test's own. */
  protected store(): TaskStore {
    if (this.stateDir === "") this.stateDir = join(this.tempDir("magentra-tasks-"), ".magentra");
    return new TaskStore(this.stateDir, this.sessionId, (event) => this.events.push(event));
  }

  protected ctx(store: TaskStore): ToolContext {
    return { cwd: join(this.stateDir, ".."), session: strictServices({ tasks: store }) };
  }

  /** What the store persisted, read back off disk. */
  protected persisted(): { nextId: number; tasks: TaskItem[] } {
    const dir = join(this.stateDir, "tasks");
    const file = join(dir, `${this.sessionId}.json`);
    if (!existsSync(file)) throw new Error(`no task file at ${file}; the directory holds ${existsSync(dir) ? readdirSync(dir).join(", ") : "nothing"}`);
    return JSON.parse(readFileSync(file, "utf8")) as { nextId: number; tasks: TaskItem[] };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ACreatedTaskIsPendingWithNoEdges extends TaskCreateTest {
  readonly id = "a-created-task-is-pending-with-a-numeric-id-and-empty-edges";
  readonly whyItExists =
    "a task created with a status other than pending, or with dependency lists left undefined, crashed TaskList's blocker walk on the first plan the agent wrote";

  override async run(t: TestRun): Promise<void> {
    const store = this.store();
    const result = await runTool(taskCreateTool, { subject: "A", description: "d" }, this.ctx(store));
    t.assert.equal(result.isError, undefined, "creating a task is not an error");
    t.assert.equal(resultText(result), "Task #1 created: A");
    const [task] = store.list();
    t.assert.equal(task?.id, "1", "ids are numeric strings starting at 1");
    t.assert.equal(task?.status, "pending");
    t.assert.equal(task?.subject, "A");
    t.assert.equal(task?.description, "d");
    t.assert.deepEqual(task?.blocks, []);
    t.assert.deepEqual(task?.blockedBy, []);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class EdgesAreKeptOnBothSides extends TaskCreateTest {
  readonly id = "a-dependency-added-to-one-task-appears-on-the-other-side-too";
  readonly whyItExists =
    "an edge recorded only on the blocked task left the blocker's `blocks` list empty, so completing it never told anyone what it had unblocked";

  override async run(t: TestRun): Promise<void> {
    const store = this.store();
    await runTool(taskCreateTool, { subject: "first", description: "d1" }, this.ctx(store));
    await runTool(taskCreateTool, { subject: "second", description: "d2" }, this.ctx(store));
    const updated = await runTool(taskUpdateTool, { taskId: "2", addBlockedBy: ["1"] }, this.ctx(store));
    t.assert.equal(updated.isError, undefined, resultText(updated));
    t.assert.deepEqual(store.get("2")?.blockedBy, ["1"], "task 2 knows it is blocked by 1");
    t.assert.deepEqual(store.get("1")?.blocks, ["2"], "task 1 knows it blocks 2 — the same edge, from the other side");
    t.assert.deepEqual(store.get("1")?.blockedBy, [], "and nothing spurious was added");
    t.assert.deepEqual(store.get("2")?.blocks, []);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ACreateIsAnnouncedAndPersisted extends TaskCreateTest {
  readonly id = "a-create-emits-task-list-updated-and-lands-in-the-tasks-file";
  readonly whyItExists =
    "the UI's task panel renders from task_list_updated and /resume reloads from the file; a create that did either half silently showed a plan the next session had lost";

  override async run(t: TestRun): Promise<void> {
    const store = this.store();
    this.events = [];
    await runTool(taskCreateTool, { subject: "persist me", description: "on disk" }, this.ctx(store));

    const updates = this.events.filter((e) => e.type === "task_list_updated");
    t.assert.equal(updates.length, 1, "exactly one task_list_updated per create");
    const announced = updates[0]?.type === "task_list_updated" ? updates[0].tasks : [];
    t.assert.equal(announced.length, 1);
    t.assert.equal(announced[0]?.subject, "persist me");

    const onDisk = this.persisted();
    t.assert.equal(onDisk.tasks.length, 1, "the file under <stateDir>/tasks holds the task");
    t.assert.equal(onDisk.tasks[0]?.subject, "persist me");
    t.assert.equal(onDisk.tasks[0]?.description, "on disk");
    t.assert.equal(onDisk.nextId, 2, "the next id is persisted with the list");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class OptionalFieldsAreStoredOnlyWhenGiven extends TaskCreateTest {
  readonly id = "activeform-and-metadata-are-stored-when-given-and-absent-otherwise";
  readonly whyItExists =
    "an undefined activeForm written as a key made the spinner show 'undefined', and an empty metadata object on every task made the file grow for nothing";

  override async run(t: TestRun): Promise<void> {
    const store = this.store();
    await runTool(taskCreateTool, { subject: "rich", description: "d", activeForm: "Running tests", metadata: { pr: 42 } }, this.ctx(store));
    await runTool(taskCreateTool, { subject: "plain", description: "d" }, this.ctx(store));
    const rich = store.get("1");
    const plain = store.get("2");
    t.assert.equal(rich?.activeForm, "Running tests");
    t.assert.deepEqual(rich?.metadata, { pr: 42 });
    t.assert.equal("activeForm" in (plain ?? {}), false, "no activeForm key when none was given");
    t.assert.equal("metadata" in (plain ?? {}), false, "no metadata key when none was given");
    // And the same on disk, where a stray key would outlive the session.
    const onDisk = this.persisted().tasks;
    t.assert.equal("activeForm" in (onDisk[1] ?? {}), false);
    t.assert.equal(onDisk[0]?.activeForm, "Running tests");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheListSurvivesAReload extends TaskCreateTest {
  readonly id = "a-second-store-over-the-same-session-reloads-the-task-and-the-next-id";
  readonly whyItExists =
    "a reload that reset nextId to 1 handed a resumed session a duplicate id, so the new task silently overwrote the old one in the map";

  override async run(t: TestRun): Promise<void> {
    const first = this.store();
    await runTool(taskCreateTool, { subject: "survivor", description: "d" }, this.ctx(first));

    const second = new TaskStore(this.stateDir, this.sessionId, (event) => this.events.push(event));
    t.assert.equal(second.list().length, 1, "the task is there after a reload");
    t.assert.equal(second.get("1")?.subject, "survivor");
    const created = await runTool(taskCreateTool, { subject: "newcomer", description: "d" }, this.ctx(second));
    t.assert.equal(resultText(created), "Task #2 created: newcomer", "the next id continues from where the file left off");
    t.assert.equal(second.list().length, 2, "and the old task was not overwritten");

    // A different session id is a different list.
    const other = new TaskStore(this.stateDir, "s_other", () => {});
    t.assert.deepEqual(other.list(), [], "task lists are per session");
  }
}

registerFeatureTests(
  new ACreatedTaskIsPendingWithNoEdges(),
  new EdgesAreKeptOnBothSides(),
  new ACreateIsAnnouncedAndPersisted(),
  new OptionalFieldsAreStoredOnlyWhenGiven(),
  new TheListSurvivesAReload(),
);
