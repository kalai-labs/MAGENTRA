/**
 * `discoverable-in-the-palette`.
 *
 * When a session starts — boot, `/clear`, `/resume` — `session_started`
 * carries the addon roster and a `commands` list in which every addon rides as
 * `/<name>` next to the built-in slash commands. The frontend's palette is
 * built from that list and never derived, so an addon the engine did not send
 * is one no user can discover or tab-complete.
 *
 * `fs`, and the record said `pure`: `session_started` is emitted by a running
 * Engine in a workspace directory, and the roster comes from the real loader
 * reading `.magentra/addons/`. The fixture is the scripted-provider engine;
 * every assertion is about the frame the real Engine emitted. Re-declared
 * 2026-09-19.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAddons, type Addon } from "@magentra/core";
import type { CoreEvent, SlashCommandInfo } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "discoverable-in-the-palette";

/** Verbatim from the record. */
const INVARIANT = "session_started carries the addon roster and each addon rides the command registry as /<name>.";

type SessionStarted = Extract<CoreEvent, { type: "session_started" }>;

abstract class PaletteTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 60_000;

  #engines: ScriptedEngine[] = [];

  override async tearDown(): Promise<void> {
    for (const engine of this.#engines) await engine.close();
    this.#engines = [];
  }

  /** A workspace holding one flat addon `foo`, loaded by the real loader (built-ins included). */
  protected workspaceWithFoo(): { workspace: string; addons: Addon[] } {
    this.redirectHome();
    const workspace = this.tempDir("magentra-palette-");
    const dir = join(workspace, ".magentra", "addons");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "foo.md"), "---\nname: foo\ndescription: D\n---\nDo the foo thing.\n", "utf8");
    return { workspace, addons: loadAddons(workspace) };
  }

  protected async boot(workspace: string, addons: Addon[] | undefined): Promise<ScriptedEngine> {
    const engine = await startScriptedEngine({ workspace, turns: [], ...(addons !== undefined ? { addons } : {}) });
    this.#engines.push(engine);
    await engine.waitFor((e) => e.type === "session_started");
    return engine;
  }

  protected started(engine: ScriptedEngine): SessionStarted[] {
    return engine.events.filter((e): e is SessionStarted => e.type === "session_started");
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheRosterIsInSessionStarted extends PaletteTest {
  readonly id = "a-workspace-addon-appears-in-session-started-addons-with-builtin-false";
  readonly whyItExists = "the Addons view listed only what the frontend had seen at install time, so an addon dropped into the folder before boot never appeared";

  override async run(t: TestRun): Promise<void> {
    const { workspace, addons } = this.workspaceWithFoo();
    const engine = await this.boot(workspace, addons);
    const [started] = this.started(engine);
    const foo = started?.addons?.find((a) => a.name === "foo");
    t.assert.deepEqual(foo, { name: "foo", description: "D", builtin: false });
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheAddonRidesTheCommandRegistry extends PaletteTest {
  readonly id = "session-started-commands-carry-slash-foo-next-to-every-built-in";
  readonly whyItExists = "the palette showed the built-ins and nothing else, so an installed addon could only be invoked by a user who already knew its name";

  override async run(t: TestRun): Promise<void> {
    const { workspace, addons } = this.workspaceWithFoo();
    const engine = await this.boot(workspace, addons);
    const commands = this.started(engine)[0]?.commands ?? [];
    const foo = commands.find((c) => c.cmd === "/foo");
    t.assert.deepEqual(foo, { cmd: "/foo", args: "[args]", desc: "D", addon: true });
    for (const builtin of ["/help", "/addons", "/clear", "/settings"]) {
      const entry = commands.find((c) => c.cmd === builtin);
      t.assert.notEqual(entry, undefined, `${builtin} is still in the list`);
      t.assert.equal(entry?.addon, undefined, `${builtin} is not flagged as an addon`);
    }
    t.assert.equal(new Set(commands.map((c) => c.cmd)).size, commands.length, "no command is listed twice");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheBuiltInIsFlagged extends PaletteTest {
  readonly id = "the-built-in-magentron-addon-is-listed-with-builtin-true";
  readonly whyItExists = "a built-in shown as a workspace addon invited the user to look for a file that does not exist when they wanted to edit it";

  override async run(t: TestRun): Promise<void> {
    const { workspace, addons } = this.workspaceWithFoo();
    const engine = await this.boot(workspace, addons);
    const [started] = this.started(engine);
    const magentron = started?.addons?.find((a) => a.name === "magentron");
    t.assert.notEqual(magentron, undefined, "the built-in ships in the roster");
    t.assert.equal(magentron?.builtin, true);
    t.assert.ok((magentron?.description ?? "").length > 0);
    t.assert.equal(started?.commands.some((c) => c.cmd === "/magentron" && c.addon === true), true, "and rides the registry like any addon");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ClearReannouncesTheSameRoster extends PaletteTest {
  readonly id = "after-clear-the-new-session-started-carries-the-same-roster-and-slash-foo";
  readonly whyItExists = "a fresh session built without the roster lost every addon from the palette until the engine was restarted";

  override async run(t: TestRun): Promise<void> {
    const { workspace, addons } = this.workspaceWithFoo();
    const engine = await this.boot(workspace, addons);
    engine.send({ type: "slash_command", command: "clear" });
    await engine.waitFor((e) => e.type === "command_output" && e.text === "Started a fresh session.");
    const [first, second] = this.started(engine);
    t.assert.notEqual(second, undefined, "a second session_started was emitted");
    t.assert.notEqual(second?.sessionId, first?.sessionId, "for a NEW session");
    t.assert.deepEqual(second?.addons, first?.addons, "with the same roster");
    t.assert.deepEqual(second?.commands, first?.commands, "and the same command registry, /foo included");
    t.assert.equal(second?.commands.some((c) => c.cmd === "/foo"), true);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class NoAddonsMeansOnlyTheBuiltIns extends PaletteTest {
  readonly id = "with-no-addons-the-roster-is-empty-and-commands-are-exactly-the-built-in-list";
  readonly whyItExists = "an empty roster that still shipped a stale /foo entry offered a command the engine would answer with 'Unknown command'";

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const bare = await this.boot(this.tempDir("magentra-palette-bare-"), []);
    const [started] = this.started(bare);
    t.assert.deepEqual(started?.addons, [], "no addons");
    const commands = started?.commands ?? [];
    t.assert.equal(commands.some((c) => c.addon === true), false, "no addon entries at all");
    t.assert.ok(commands.length >= 10, `the built-in registry has ${commands.length} entries`);
    for (const c of commands) {
      t.assert.match(c.cmd, /^\/[a-z]+$/, `${c.cmd} is a built-in slash command`);
      t.assert.ok(c.desc.length > 0, `${c.cmd} has a description`);
    }

    // The built-in list is the same list an engine WITH addons sends, minus the addons.
    const { workspace, addons } = this.workspaceWithFoo();
    const withAddons = await this.boot(workspace, addons);
    const builtInsOnly: SlashCommandInfo[] = (this.started(withAddons)[0]?.commands ?? []).filter((c) => c.addon !== true);
    t.assert.deepEqual(commands, builtInsOnly, "exactly the built-in SLASH_COMMANDS list, in the same order");
  }
}

registerFeatureTests(new TheRosterIsInSessionStarted(), new TheAddonRidesTheCommandRegistry(), new TheBuiltInIsFlagged(), new ClearReannouncesTheSameRoster(), new NoAddonsMeansOnlyTheBuiltIns());
