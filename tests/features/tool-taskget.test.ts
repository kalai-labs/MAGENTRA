/**
 * `tool-taskget`.
 *
 * TaskGet returns one task as JSON with both dependency lists, so the agent
 * can check a task is unblocked before starting it. The id may arrive as "3",
 * "#3", "task-3" or the task's subject — models routinely echo the display
 * form — and an unknown reference is an error that lists the current tasks.
 *
 * `fs`, and the record said `pure`: the tool reads a `TaskStore`, which lives
 * in a `.magentra/tasks/<sessionId>.json` file on disk. Re-declared 2026-09-19.
 *
 * Real tool, real store, real validation path (`tests/lib/directTool.ts`).
 */

import { join } from "node:path";

import { TaskStore, type ToolContext } from "@magentra/core";
import type { TaskItem } from "@magentra/protocol";
import { taskCreateTool, taskGetTool, taskUpdateTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "tool-taskget";

/** Verbatim from the record. */
const INVARIANT = "TaskGet returns the full description and both dependency lists for one task.";

abstract class TaskGetTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #ctx: ToolContext | undefined;

  protected ctx(): ToolContext {
    if (this.#ctx) return this.#ctx;
    const workspace = this.tempDir("magentra-taskget-");
    const store = new TaskStore(join(workspace, ".magentra"), "s_get", () => {});
    this.#ctx = { cwd: workspace, session: strictServices({ tasks: store }) };
    return this.#ctx;
  }

  protected async create(subject: string, description = "d"): Promise<void> {
    await runTool(taskCreateTool, { subject, description }, this.ctx());
  }

  protected async get(taskId: string): Promise<{ text: string; isError: boolean; task?: TaskItem }> {
    const result = await runTool(taskGetTool, { taskId }, this.ctx());
    const text = resultText(result);
    return { text, isError: result.isError === true, ...(result.isError ? {} : { task: JSON.parse(text) as TaskItem }) };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class BothDependencyListsAreReturned extends TaskGetTest {
  readonly id = "taskget-returns-the-description-and-both-dependency-lists-as-json";
  readonly whyItExists =
    "a TaskGet that returned only the subject and status let the agent start a task whose blockedBy was non-empty, because there was nothing in the answer to check";

  override async run(t: TestRun): Promise<void> {
    await this.create("first", "the first thing");
    await this.create("second", "the second thing");
    await runTool(taskUpdateTool, { taskId: "2", addBlockedBy: ["1"] }, this.ctx());

    const got = await this.get("2");
    t.assert.equal(got.isError, false);
    t.assert.equal(got.task?.id, "2");
    t.assert.equal(got.task?.description, "the second thing");
    t.assert.deepEqual(got.task?.blocks, []);
    t.assert.deepEqual(got.task?.blockedBy, ["1"]);
    t.assert.equal(got.task?.status, "pending");
    // Pretty-printed, as the description promises — a model reads this.
    t.assert.match(got.text, /^\{\n {2}"id": "2"/);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class EveryEchoedFormResolves extends TaskGetTest {
  readonly id = "hash-task-dash-and-subject-forms-all-resolve-to-the-task";
  readonly whyItExists =
    "models echo '#3' and 'task-3' from the display form, and a strict id parser failed every one of those calls with 'no task' on a list that plainly had it";

  override async run(t: TestRun): Promise<void> {
    await this.create("Write the parser", "d");
    for (const ref of ["1", "#1", "task-1", "Task 1", "Task #1", " 1 "]) {
      const got = await this.get(ref);
      t.assert.equal(got.isError, false, `${JSON.stringify(ref)} must resolve: ${got.text}`);
      t.assert.equal(got.task?.id, "1", `${JSON.stringify(ref)} must be task 1`);
    }
    const bySubject = await this.get("Write the parser");
    t.assert.equal(bySubject.task?.id, "1", "the exact subject resolves too");
    const byCase = await this.get("write THE parser");
    t.assert.equal(byCase.task?.id, "1", "case-insensitively");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnUnknownReferenceListsTheTasks extends TaskGetTest {
  readonly id = "an-unknown-reference-is-an-error-that-lists-the-current-tasks";
  readonly whyItExists =
    "a bare 'not found' left the model inventing ids; listing what exists lets it recover in one step instead of guessing";

  override async run(t: TestRun): Promise<void> {
    const empty = await this.get("1");
    t.assert.equal(empty.isError, true);
    t.assert.match(empty.text, /the task list is empty/, "on an empty list the message says so");
    t.assert.match(empty.text, /TaskCreate/, "and says how to fill it");

    await this.create("alpha");
    await this.create("beta");
    const missing = await this.get("99");
    t.assert.equal(missing.isError, true);
    t.assert.match(missing.text, /No task matches "99"/);
    t.assert.match(missing.text, /#1 \[pending\] alpha/);
    t.assert.match(missing.text, /#2 \[pending\] beta/);
    t.assert.match(missing.text, /"3" or "#3"/, "it teaches the accepted forms");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnAmbiguousSubstringIsNotGuessed extends TaskGetTest {
  readonly id = "a-substring-matching-two-subjects-is-not-found-while-a-unique-one-is";
  readonly whyItExists =
    "resolving 'Fix' to the first of two 'Fix …' tasks would silently read the wrong task's blockers and start the wrong work";

  override async run(t: TestRun): Promise<void> {
    await this.create("Fix login");
    await this.create("Fix logout");
    const ambiguous = await this.get("Fix");
    t.assert.equal(ambiguous.isError, true, "'Fix' matches both and must not be guessed");
    t.assert.match(ambiguous.text, /No task matches "Fix"/);
    const unique = await this.get("login");
    t.assert.equal(unique.isError, false);
    t.assert.equal(unique.task?.id, "1", "'login' is unique to the first");
    const other = await this.get("logout");
    t.assert.equal(other.task?.id, "2");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class UpdatedFieldsShowInTheAnswer extends TaskGetTest {
  readonly id = "owner-and-status-set-by-taskupdate-are-reflected-by-taskget";
  readonly whyItExists =
    "a TaskGet served from a stale copy told the agent a task was still pending after it had marked it in_progress, so it started it twice";

  override async run(t: TestRun): Promise<void> {
    await this.create("owned");
    const updated = await runTool(taskUpdateTool, { taskId: "1", owner: "me", status: "in_progress", activeForm: "Owning it" }, this.ctx());
    t.assert.equal(updated.isError, undefined, resultText(updated));
    const got = await this.get("#1");
    t.assert.equal(got.task?.owner, "me");
    t.assert.equal(got.task?.status, "in_progress");
    t.assert.equal(got.task?.activeForm, "Owning it");
    t.assert.equal(got.task?.subject, "owned", "untouched fields are untouched");
  }
}

registerFeatureTests(
  new BothDependencyListsAreReturned(),
  new EveryEchoedFormResolves(),
  new AnUnknownReferenceListsTheTasks(),
  new AnAmbiguousSubstringIsNotGuessed(),
  new UpdatedFieldsShowInTheAnswer(),
);
