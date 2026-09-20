/**
 * `tool-registry-contract`.
 *
 * `createDefaultRegistry()` is the tool set the agent sees: 27 built-ins, each
 * with a name, a description, a real zod schema, a permission class from the
 * five and an `execute`. Registering a name twice throws. And "registered" is
 * never mistaken for "working": the read-only tools are actually RUN against a
 * temp workspace, because a tool that is advertised to the model and crashes
 * when called is worse than one that is absent.
 *
 * `pure` + `fs`, and the record said `pure`. Items 1–4 are the registry as a
 * value. Item 5 executes tools that read a workspace — a temp directory with a
 * file in it — through the same validate-then-execute path the Session uses
 * (`tests/lib/directTool.ts`), with the REAL services each tool reaches for:
 * a `FileState`, a `TaskStore` on the workspace's state directory, a
 * `CronScheduler` with an injected clock. Re-declared 2026-09-19.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CronScheduler, FileState, TaskStore, ToolRegistry, type AnyToolDefinition, type ToolContext } from "@magentra/core";
import { createDefaultRegistry, readTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "tool-registry-contract";

/** Verbatim from the record. */
const INVARIANT = "createDefaultRegistry registers exactly 27 tools, each with a name, description, real zod schema, valid permission class and execute.";

const EXPECTED_NAMES = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
  "AskUserQuestion", "Agent", "TaskStop", "TaskOutput",
  "WebFetch", "WebSearch", "Monitor", "EnterWorktree", "ExitWorktree",
  "PushNotification", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
  "Addon", "Workflow", "GraphQuery",
].sort();

const PERMISSION_CLASSES = ["read", "mutate", "execute", "network", "interact"];

abstract class RegistryTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class ExactlyTheTwentySevenTools extends RegistryTest {
  readonly id = "the-default-registry-holds-exactly-the-27-expected-tools";
  readonly whyItExists = "a tool dropped from the list silently vanished from every session, and one added twice under two names doubled the schema bill on every request";

  override run(t: TestRun): void {
    const tools = createDefaultRegistry().list();
    t.assert.equal(tools.length, 27, `${tools.length} tools registered`);
    t.assert.deepEqual(tools.map((x) => x.name).sort(), EXPECTED_NAMES);
    t.assert.equal(new Set(tools.map((x) => x.name)).size, 27, "every name is distinct");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class EveryToolHasACompleteContract extends RegistryTest {
  readonly id = "every-tool-has-a-name-a-description-a-zod-schema-a-permission-class-and-an-execute";
  readonly whyItExists = "a tool with a hand-written JSON schema instead of a zod one skipped input validation, so a malformed call reached execute and crashed the turn";

  override run(t: TestRun): void {
    for (const tool of createDefaultRegistry().list()) {
      t.assert.equal(typeof tool.name, "string");
      t.assert.ok(tool.name.length > 0);
      t.assert.equal(typeof tool.description, "string");
      t.assert.ok(tool.description.trim().length > 20, `${tool.name} has a real description`);
      t.assert.equal(typeof tool.inputSchema.safeParse, "function", `${tool.name} has a zod schema`);
      t.assert.equal(tool.inputSchema.safeParse(undefined).success, false, `${tool.name}'s schema refuses no input at all`);
      t.assert.ok(PERMISSION_CLASSES.includes(tool.permissionClass), `${tool.name} has permission class ${String(tool.permissionClass)}`);
      t.assert.equal(typeof tool.execute, "function", `${tool.name} has execute`);
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class EverySlotIsFilled extends RegistryTest {
  readonly id = "every-description-slot-has-a-matching-descriptionvars-key-and-no-tool-leaks-an-unfilled-one";
  readonly whyItExists = "a {{maxLines}} slot with no value reached the model verbatim, which then asked for 'the first {{maxLines}} lines'";

  override run(t: TestRun): void {
    let withVars = 0;
    for (const tool of createDefaultRegistry().list()) {
      const slots = [...tool.description.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
      const keys = Object.keys(tool.descriptionVars ?? {});
      if (tool.descriptionVars) {
        withVars += 1;
        for (const slot of slots) t.assert.ok(keys.includes(slot), `${tool.name}: slot {{${slot}}} has no descriptionVars value`);
        for (const key of keys) t.assert.ok(slots.includes(key), `${tool.name}: descriptionVars.${key} fills no slot`);
      } else {
        t.assert.deepEqual(slots, [], `${tool.name} has slots but no descriptionVars`);
      }
    }
    t.assert.ok(withVars >= 1, "at least one tool (Read) uses description slots, so this check is exercised");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class DuplicatesThrowAndSubsetsFilter extends RegistryTest {
  readonly id = "registering-a-name-twice-throws-duplicate-tool-and-subset-keeps-only-the-named-tools";
  readonly whyItExists = "a second registration silently replacing the first let an MCP server shadow the built-in Read with its own";

  override run(t: TestRun): void {
    const registry = createDefaultRegistry();
    t.assert.throws(() => registry.register(readTool), /duplicate tool/, "a second Read is refused");
    t.assert.equal(registry.list().length, 27, "and nothing changed");

    const subset = registry.subset(["Read", "Nope"]);
    t.assert.deepEqual(subset.list().map((x) => x.name), ["Read"], "an unknown name is skipped, not invented");
    t.assert.equal(subset.get("Write"), undefined, "the subset holds only what it was given");
    t.assert.equal(registry.get("Write")?.name, "Write", "the parent registry is untouched");
    t.assert.ok(new ToolRegistry().list().length === 0, "a fresh registry is empty");
  }
}

/* ---- checklist 5 — fs ------------------------------------------------ */

class TheReadOnlyToolsActuallyRun extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "read-glob-grep-tasklist-cronlist-and-graphquery-run-against-a-workspace-and-answer";
  readonly whyItExists = "the old check asserted that tools were registered and never ran one; a Grep whose ripgrep binary was missing from the package passed it and failed every user";

  /** Six real tools, one of which builds an import graph and one of which spawns ripgrep. */
  override readonly timeoutMs: number = 60_000;

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-registry-run-");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), 'import { helper } from "./helper.js";\nexport const answer = helper() + 1; // needle\n', "utf8");
    writeFileSync(join(workspace, "src", "helper.ts"), "export function helper(): number { return 41; }\n", "utf8");

    const stateDir = join(workspace, ".magentra");
    const events: unknown[] = [];
    const ctx: ToolContext = {
      cwd: workspace,
      session: strictServices({
        fileState: new FileState(),
        tasks: new TaskStore(stateDir, "s_registry", (e) => events.push(e)),
        cron: new CronScheduler({ stateDir, isIdle: () => true, enqueue: () => {}, now: () => new Date("2026-09-19T12:00:00Z"), jitter: false }),
        emit: (e) => events.push(e),
      }),
    };
    const registry = createDefaultRegistry();
    const tool = (name: string): AnyToolDefinition => {
      const found = registry.get(name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    };

    const read = await runTool(tool("Read"), { file_path: join(workspace, "src", "index.ts") }, ctx);
    t.assert.equal(read.isError, undefined, resultText(read));
    t.assert.match(resultText(read), /1\t.*import \{ helper \}/, "Read returns numbered lines of the real file");

    const glob = await runTool(tool("Glob"), { pattern: "src/*.ts" }, ctx);
    t.assert.equal(glob.isError, undefined, resultText(glob));
    t.assert.match(resultText(glob), /helper\.ts/);
    t.assert.match(resultText(glob), /index\.ts/);

    const grep = await runTool(tool("Grep"), { pattern: "needle" }, ctx);
    t.assert.equal(grep.isError, undefined, resultText(grep));
    t.assert.match(resultText(grep), /index\.ts/, "Grep found the file that holds the needle");
    t.assert.doesNotMatch(resultText(grep), /helper\.ts/, "and not the one that does not");

    const tasks = await runTool(tool("TaskList"), {}, ctx);
    t.assert.equal(tasks.isError, undefined);
    t.assert.equal(resultText(tasks), "The task list is empty.");

    const cron = await runTool(tool("CronList"), {}, ctx);
    t.assert.equal(cron.isError, undefined, resultText(cron));
    t.assert.equal(typeof resultText(cron), "string");
    t.assert.ok(resultText(cron).length > 0, "CronList answers with text on an empty schedule");

    const graph = await runTool(tool("GraphQuery"), { op: "structure" }, ctx);
    t.assert.equal(graph.isError, undefined, resultText(graph));
    t.assert.match(resultText(graph), /graph skeleton of 2 files/, "GraphQuery built the workspace's import graph");
    t.assert.match(resultText(graph), /src\/index\.ts|src\\index\.ts/);
  }
}

registerFeatureTests(new ExactlyTheTwentySevenTools(), new EveryToolHasACompleteContract(), new EverySlotIsFilled(), new DuplicatesThrowAndSubsetsFilter(), new TheReadOnlyToolsActuallyRun());
