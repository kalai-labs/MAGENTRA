/**
 * `slash-registry-single-source`.
 *
 * Slash commands are listed once, in `SLASH_COMMANDS`. `/help` renders from
 * that list; `session_started.commands` ships it — plus every installed addon
 * as `/<name>` — to the frontend, and `addons_updated.commands` ships it again
 * after an install. A frontend that derived its palette itself would drift
 * from what the engine actually dispatches, and an addon installed mid-session
 * would be invocable but invisible.
 *
 * `fs`, and the record said `pure`: the registry is only observable through a
 * running Engine's frames and dispatch, in a workspace directory where
 * `install_addon` writes a file. The registry itself is not exported, so the
 * list the engine SENDS is the list under test — and the dispatch of every
 * entry in it is exercised, which is the claim. Re-declared 2026-09-19.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAddons } from "@magentra/core";
import type { CoreEvent, SlashCommandInfo } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "slash-registry-single-source";

/** Verbatim from the record. */
const INVARIANT = "/help and the frontend palette both render from one registry, and addons_updated re-ships it so a newly installed addon appears.";

type Started = Extract<CoreEvent, { type: "session_started" }>;
type Output = Extract<CoreEvent, { type: "command_output" }>;

abstract class RegistryTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 90_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  protected async engine(turns: FakeTurn[] = [], withReviewAddon = false): Promise<ScriptedEngine> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-registry-");
    mkdirSync(join(workspace, ".magentra"), { recursive: true });
    if (withReviewAddon) {
      mkdirSync(join(workspace, ".magentra", "addons"), { recursive: true });
      writeFileSync(join(workspace, ".magentra", "addons", "review.md"), "---\nname: review\ndescription: review the change\n---\nReview it.\n", "utf8");
    }
    this.#engine = await startScriptedEngine({ workspace, turns, addons: loadAddons(workspace) });
    await this.#engine.waitFor((e) => e.type === "session_started");
    return this.#engine;
  }

  protected started(engine: ScriptedEngine): Started[] {
    return engine.events.filter((e): e is Started => e.type === "session_started");
  }

  protected builtIns(engine: ScriptedEngine): SlashCommandInfo[] {
    return (this.started(engine)[0]?.commands ?? []).filter((c) => c.addon !== true);
  }

  /** Dispatch `cmd` and return every command_output the engine produced for it. */
  protected async dispatch(engine: ScriptedEngine, cmd: string): Promise<string[]> {
    const before = engine.events.length;
    engine.send({ type: "slash_command", command: cmd });
    // Every built-in answers with at least one frame of its own kind; /session
    // answers with a session_report and nothing else.
    await engine.waitFor((e) => ["command_output", "session_report"].includes(e.type) && engine.events.indexOf(e) >= before);
    await engine.engine.idle();
    return engine.events.slice(before).filter((e): e is Output => e.type === "command_output").map((e) => e.text);
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class EveryShippedCommandDispatches extends RegistryTest {
  readonly id = "every-built-in-command-shipped-in-session-started-is-dispatched-without-unknown-command";
  readonly whyItExists = "a command listed in the palette but missing from the dispatch switch answered 'Unknown command' to a user who had just picked it from a menu";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    const builtIns = this.builtIns(engine);
    t.assert.ok(builtIns.length >= 10, `${builtIns.length} built-in commands shipped`);
    for (const { cmd } of builtIns) {
      const outputs = await this.dispatch(engine, cmd);
      t.assert.equal(outputs.some((text) => text.startsWith("Unknown command")), false, `${cmd} is in the palette but the engine does not dispatch it: ${outputs.join(" | ")}`);
    }
    t.assert.equal(engine.provider.requests.length, 0, "none of the built-ins called the model");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class HelpRendersTheSameRegistry extends RegistryTest {
  readonly id = "help-lists-every-built-in-cmd-and-desc-and-nothing-that-is-not-in-the-registry";
  readonly whyItExists = "/help was a hand-written block that kept describing a command removed two releases earlier";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    const builtIns = this.builtIns(engine);
    const [help] = await this.dispatch(engine, "/help");
    t.assert.ok(help?.startsWith("Built-in commands:\n"), help);
    for (const { cmd, desc } of builtIns) {
      t.assert.ok(help?.includes(cmd), `/help must mention ${cmd}`);
      t.assert.ok(help?.includes(desc), `/help must carry the registry's description of ${cmd}`);
    }
    // The built-in section is exactly the registry: one line per entry, each
    // naming a shipped cmd, and no line naming anything else.
    const section = (help ?? "").split("\n").filter((line) => /^\s+\/[a-z]+/.test(line));
    t.assert.equal(section.length, builtIns.length, "one help line per registry entry");
    for (const line of section) {
      const cmd = line.trim().split(/\s+/)[0];
      t.assert.ok(builtIns.some((c) => c.cmd === cmd), `${cmd} is in /help but not in the shipped registry`);
    }
    t.assert.equal(help?.includes("addon"), true, "/addons is described, so addons are discoverable from /help too");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnInstalledAddonRidesTheRegistry extends RegistryTest {
  readonly id = "an-installed-addon-appears-as-slash-review-with-addon-true-and-dispatches";
  readonly whyItExists = "an addon the engine dispatched happily was invisible in the palette because the frontend derived its commands and knew nothing of addons";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine([{ text: "reviewed" }], true);
    const review = this.started(engine)[0]?.commands.find((c) => c.cmd === "/review");
    t.assert.deepEqual(review, { cmd: "/review", args: "[args]", desc: "review the change", addon: true });
    engine.send({ type: "slash_command", command: "review" });
    await engine.waitFor((e) => e.type === "turn_finished");
    const outputs = engine.events.filter((e): e is Output => e.type === "command_output").map((e) => e.text);
    t.assert.equal(outputs.some((o) => o.startsWith("Unknown command")), false, outputs.join(" | "));
    t.assert.equal(outputs.some((o) => o === "🧩 review loaded — following its instructions."), true, "the addon was dispatched as a command");
    t.assert.equal(engine.provider.requests.length, 1, "and ran a turn");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class InstallReshipsTheRegistry extends RegistryTest {
  readonly id = "install-addon-emits-addons-updated-with-a-commands-list-equal-to-the-next-clears-session-started";
  readonly whyItExists = "an addon installed mid-session appeared in the Addons view but not under `/` until restart, because the registry travelled only on session_started";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send({ type: "install_addon", filename: "triage.md", text: "---\nname: triage\ndescription: triage the bug\n---\nTriage.\n" });
    const updated = await engine.waitFor((e): e is Extract<CoreEvent, { type: "addons_updated" }> => e.type === "addons_updated");
    t.assert.ok(Array.isArray(updated.commands), "addons_updated carries the registry");
    const triage = updated.commands?.find((c) => c.cmd === "/triage");
    t.assert.deepEqual(triage, { cmd: "/triage", args: "[args]", desc: "triage the bug", addon: true });
    t.assert.equal(updated.addons.some((a) => a.name === "triage" && a.builtin === false), true, "the roster carries it too");

    engine.send({ type: "slash_command", command: "clear" });
    await engine.waitFor((e) => e.type === "command_output" && e.text === "Started a fresh session.");
    const [, afterClear] = this.started(engine);
    t.assert.deepEqual(updated.commands, afterClear?.commands, "the re-shipped registry IS the list the next session_started sends");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class EveryEntryIsWellFormed extends RegistryTest {
  readonly id = "every-built-in-entry-has-a-slash-prefixed-cmd-a-description-and-no-duplicate";
  readonly whyItExists = "a registry entry with an empty description rendered a blank help line, and a duplicated cmd made the palette show one command twice";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    const builtIns = this.builtIns(engine);
    for (const entry of builtIns) {
      t.assert.match(entry.cmd, /^\/[a-z]+$/, `${JSON.stringify(entry.cmd)} must be a lower-case slash command`);
      t.assert.ok(entry.desc.trim().length > 0, `${entry.cmd} needs a description`);
      t.assert.equal(typeof entry.args, "string", `${entry.cmd} declares its args (possibly empty)`);
    }
    t.assert.equal(new Set(builtIns.map((c) => c.cmd)).size, builtIns.length, "no duplicate cmd");
    for (const expected of ["/help", "/clear", "/compact", "/session", "/tasks", "/addons", "/overdrive", "/settings", "/resume", "/sessions"]) {
      t.assert.ok(builtIns.some((c) => c.cmd === expected), `${expected} is shipped`);
    }
  }
}

registerFeatureTests(new EveryShippedCommandDispatches(), new HelpRendersTheSameRegistry(), new AnInstalledAddonRidesTheRegistry(), new InstallReshipsTheRegistry(), new EveryEntryIsWellFormed());
