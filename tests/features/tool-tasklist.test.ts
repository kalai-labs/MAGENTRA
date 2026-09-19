/**
 * `tool-tasklist`.
 *
 * TaskList prints one line per task, and for a pending task it COMPUTES the
 * tag: `pending READY` when every blocker is completed, `pending BLOCKED by
 * #ids` naming only the blockers still open. Without the computed tag the
 * agent picks tasks in creation order and starts work whose prerequisites are
 * unfinished.
 *
 * `fs`, and the record said `pure`: the list comes from a `TaskStore` on disk.
 * Re-declared 2026-09-19. Real tool, real store, real validation path.
 */

import { join } from "node:path";

import { TaskStore, type ToolContext } from "@magentra/core";
import { taskCreateTool, taskListTool, taskUpdateTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "tool-tasklist";

/** Verbatim from the record. */
const INVARIANT = "Pending tasks are tagged READY or BLOCKED by resolving blockedBy against completion, not by declaration order.";

abstract class TaskListTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #ctx: ToolContext | undefined;

  protected ctx(): ToolContext {
    if (this.#ctx) return this.#ctx;
    const workspace = this.tempDir("magentra-tasklist-");
    const store = new TaskStore(join(workspace, ".magentra"), "s_list", () => {});
    this.#ctx = { cwd: workspace, session: strictServices({ tasks: store }) };
    return this.#ctx;
  }

  protected async create(subject: string): Promise<void> {
    await runTool(taskCreateTool, { subject, description: "d" }, this.ctx());
  }

  protected async update(taskId: string, patch: Record<string, unknown>): Promise<void> {
    const result = await runTool(taskUpdateTool, { taskId, ...patch }, this.ctx());
    if (result.isError) throw new Error(`TaskUpdate refused: ${resultText(result)}`);
  }

  /** The listing, one entry per line. */
  protected async lines(): Promise<string[]> {
    const result = await runTool(taskListTool, {}, this.ctx());
    if (result.isError) throw new Error(resultText(result));
    return resultText(result).split("\n");
  }

  protected line(lines: string[], id: string): string {
    const found = lines.find((l) => l.startsWith(`#${id} `));
    if (found === undefined) throw new Error(`no line for #${id} in:\n${lines.join("\n")}`);
    return found;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class AnEmptyListSaysSo extends TaskListTest {
  readonly id = "an-empty-store-lists-as-the-task-list-is-empty";
  readonly whyItExists = "an empty string back from TaskList read to the model as a tool that had failed, and it retried the call in a loop";

  override async run(t: TestRun): Promise<void> {
    const result = await runTool(taskListTool, {}, this.ctx());
    t.assert.equal(result.isError, undefined);
    t.assert.equal(resultText(result), "The task list is empty.");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class BlockedNamesEveryOpenBlocker extends TaskListTest {
  readonly id = "a-task-blocked-by-two-open-tasks-is-tagged-blocked-by-both-and-they-are-ready";
  readonly whyItExists = "a tag that named only the first blocker let the agent finish it and start the blocked task while the second blocker was still open";

  override async run(t: TestRun): Promise<void> {
    await this.create("one");
    await this.create("two");
    await this.create("three");
    await this.update("3", { addBlockedBy: ["1", "2"] });
    const lines = await this.lines();
    t.assert.equal(lines.length, 3, "one line per task");
    t.assert.match(this.line(lines, "3"), /^#3 \[pending BLOCKED by #1, #2\] three \(blocked by: 1, 2\)$/);
    t.assert.match(this.line(lines, "1"), /^#1 \[pending READY\] one$/);
    t.assert.match(this.line(lines, "2"), /^#2 \[pending READY\] two$/);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ReadinessFollowsCompletion extends TaskListTest {
  readonly id = "completing-blockers-moves-a-task-from-blocked-to-ready-regardless-of-creation-order";
  readonly whyItExists = "readiness computed once at creation never changed, so a task stayed BLOCKED after every blocker was completed";

  override async run(t: TestRun): Promise<void> {
    await this.create("one");
    await this.create("two");
    await this.create("three");
    await this.update("3", { addBlockedBy: ["1", "2"] });

    await this.update("1", { status: "completed" });
    let lines = await this.lines();
    t.assert.match(this.line(lines, "3"), /\[pending BLOCKED by #2\]/, "only the blocker still open is named");
    t.assert.doesNotMatch(this.line(lines, "3"), /#1,|by #1/, "the completed blocker is no longer named in the tag");
    t.assert.match(this.line(lines, "1"), /^#1 \[completed\]/);

    await this.update("2", { status: "completed" });
    lines = await this.lines();
    t.assert.match(this.line(lines, "3"), /^#3 \[pending READY\] three \(blocked by: 1, 2\)$/, "READY once every blocker is done, though it was created last; the raw edge list is still shown");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class DeclarationOrderDoesNotDecideReadiness extends TaskListTest {
  readonly id = "a-later-task-that-blocks-an-earlier-one-makes-the-earlier-one-blocked";
  readonly whyItExists = "an agent that trusted id order started task 1 because it came first, while task 2 — created later — was its prerequisite";

  override async run(t: TestRun): Promise<void> {
    await this.create("earlier");
    await this.create("later");
    await this.update("2", { addBlocks: ["1"] });
    const lines = await this.lines();
    t.assert.match(this.line(lines, "1"), /^#1 \[pending BLOCKED by #2\] earlier \(blocked by: 2\)$/);
    t.assert.match(this.line(lines, "2"), /^#2 \[pending READY\] later$/);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class OwnerAndEdgesAreShown extends TaskListTest {
  readonly id = "the-line-shows-the-owner-and-mirrors-blockedby-in-the-trailing-list";
  readonly whyItExists = "two agents sharing a list could not tell whose task was whose, and the tag alone hid completed blockers the description still needed";

  override async run(t: TestRun): Promise<void> {
    await this.create("one");
    await this.create("two");
    await this.update("2", { owner: "bob", addBlockedBy: ["1"] });
    await this.update("1", { status: "in_progress", owner: "ann" });
    const lines = await this.lines();
    t.assert.equal(this.line(lines, "2"), "#2 [pending BLOCKED by #1] (owner: bob) two (blocked by: 1)");
    t.assert.equal(this.line(lines, "1"), "#1 [in_progress] (owner: ann) one", "a non-pending task keeps its plain status and shows its owner");
  }
}

registerFeatureTests(new AnEmptyListSaysSo(), new BlockedNamesEveryOpenBlocker(), new ReadinessFollowsCompletion(), new DeclarationOrderDoesNotDecideReadiness(), new OwnerAndEdgesAreShown());
