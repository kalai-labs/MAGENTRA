/**
 * `setting-timing`.
 *
 * After `/settings <key> <value>` persists a setting, the engine mirrors it
 * into the live settings and prints the one note that tells the user whether
 * the change took: applied now, next turn, after restart, or after `/clear`.
 * `SETTING_TIMING` is typed over every key of the settings schema, so a key
 * added without a timing fails to compile — and this suite checks the same at
 * run time, because a compile-time guarantee is only as good as the build.
 *
 * `pure` + `fs`, and the record said `pure`. Item 1 is the map against the
 * schema. Items 2–5 are `/settings` on a running Engine, which writes the
 * workspace's settings file and, for a connection key, rebuilds the provider
 * — observable because the next request goes to the NEW provider and not to
 * the scripted one. Re-declared 2026-09-19.
 *
 * ABOUT ITEM 3. The description names `/settings permissions.allow …` as the
 * example of a `/clear`-timed key. That key is an array in the schema, and
 * `/settings` sets one scalar at a dot path, so no value spells a valid
 * `permissions.allow` — the command is refused before any note is printed,
 * and this test asserts that refusal. The claim the item makes (timing
 * resolves by TOP-LEVEL key) is proven on `worktree.baseRef` and
 * `reuseCheck.mode`, both `/clear`, and on `mcpServers.<name>`, `restart`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SETTING_TIMING, settingsSchema } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "setting-timing";

/** Verbatim from the record. */
const INVARIANT = "Every one of the 24 settings keys declares when it takes effect, and the note printed is the only thing telling the user whether the change took.";

const NOTES = {
  session: "Applied to the current session.",
  nextTurn: "Takes effect on the next turn.",
  restart: "Takes effect after restarting magentra.",
  clear: "Takes effect after /clear (new session).",
} as const;

type Output = Extract<CoreEvent, { type: "command_output" }>;

/* ---- checklist 1 — pure ---------------------------------------------- */

class EveryKeyHasATiming extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "setting-timing-covers-exactly-the-24-schema-keys-with-one-of-the-four-timings";
  readonly whyItExists = "the old divorced live/restart sets rotted silently: a new key fell through to the wrong default and its note lied about when the change took";

  override run(t: TestRun): void {
    const schemaKeys = Object.keys(settingsSchema.shape).sort();
    const timingKeys = Object.keys(SETTING_TIMING).sort();
    t.assert.equal(schemaKeys.length, 24, `the schema has ${schemaKeys.length} keys: ${schemaKeys.join(", ")}`);
    t.assert.deepEqual(timingKeys, schemaKeys, "SETTING_TIMING and settingsSchema.shape name exactly the same keys");
    for (const [key, timing] of Object.entries(SETTING_TIMING)) {
      t.assert.ok(timing in NOTES, `${key} has an unknown timing "${String(timing)}"`);
    }
    // The five connection keys are live, because the provider is rebuilt on the spot.
    for (const key of ["provider", "baseUrl", "apiKey", "apiKeyEnv", "allowInsecureTls"] as const) {
      t.assert.equal(SETTING_TIMING[key], "session", `${key} names where inference happens and must be "session"`);
    }
    t.assert.equal(SETTING_TIMING.model, "nextTurn");
  }
}

/* ---- checklist 2–5 — fs ---------------------------------------------- */

abstract class LiveSettingsTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;
  protected workspace = "";

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  /** A workspace that IS a workspace (`.magentra/` exists), so `/settings` writes the project file. */
  protected async engine(turns: Parameters<typeof startScriptedEngine>[0]["turns"] = []): Promise<ScriptedEngine> {
    this.redirectHome();
    this.workspace = this.tempDir("magentra-timing-");
    mkdirSync(join(this.workspace, ".magentra"), { recursive: true });
    this.#engine = await startScriptedEngine({ workspace: this.workspace, turns });
    return this.#engine;
  }

  protected settingsFile(): string {
    return join(this.workspace, ".magentra", "settings.json");
  }

  /** `/settings <args>` and the command_output it produced. */
  protected async settings(engine: ScriptedEngine, args: string): Promise<string> {
    const before = engine.events.length;
    engine.send({ type: "slash_command", command: "settings", args });
    const out = await engine.waitFor((e): e is Output => e.type === "command_output" && engine.events.indexOf(e) >= before);
    return out.text;
  }
}

class TheModelNoteAndTheNextRequest extends LiveSettingsTest {
  readonly id = "settings-model-prints-set-wrote-and-next-turn-and-the-next-request-uses-the-model";
  readonly whyItExists = "the note said the model change needed a restart while the next turn already used it, so users restarted for nothing";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine([{ text: "hello" }]);
    const text = await this.settings(engine, "model x");
    t.assert.ok(text.includes('Set model = "x"'), text);
    t.assert.ok(text.includes(`Wrote ${this.settingsFile()}`), "the note names the file it wrote");
    t.assert.ok(text.includes(NOTES.nextTurn), "model is a next-turn key");
    t.assert.equal(JSON.parse(readFileSync(this.settingsFile(), "utf8")).model, "x", "and the file really holds it");

    await engine.runTurn("hi");
    t.assert.equal(engine.provider.requests[0]?.model, "x", "the next request carries the new model");
  }
}

class TimingResolvesByTopLevelKey extends LiveSettingsTest {
  readonly id = "a-dotted-key-takes-the-timing-of-its-top-level-key";
  readonly whyItExists = "a nested key looked up whole ('search.enabled') matched nothing and fell to the /clear default, so a live-ish change was reported as needing a new session";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    t.assert.ok((await this.settings(engine, "search.enabled false")).includes(NOTES.nextTurn), "search.* is next-turn");
    t.assert.ok((await this.settings(engine, "worktree.baseRef head")).includes(NOTES.clear), "worktree.* is /clear");
    t.assert.ok((await this.settings(engine, "reuseCheck.mode off")).includes(NOTES.clear), "reuseCheck.* is /clear");
    t.assert.ok((await this.settings(engine, "mcpServers.probe x")).includes(NOTES.restart), "mcpServers.* is restart");
    // The description's own example cannot be set this way: permissions.allow
    // is an array and /settings writes a scalar, so it is refused, not mis-timed.
    const refused = await this.settings(engine, "permissions.allow Bash");
    t.assert.ok(refused.startsWith('Invalid value for "permissions.allow"'), refused);
    t.assert.equal(Object.values(NOTES).some((note) => refused.includes(note)), false, "a refused setting prints no timing note");
  }
}

class AConnectionKeyRebuildsTheProvider extends LiveSettingsTest {
  readonly id = "settings-baseurl-prints-applied-now-and-the-next-request-goes-to-the-rebuilt-provider";
  readonly whyItExists = "SETTING_TIMING said the connection keys needed a restart while the code applied them live, and the note is the only thing telling the user which is true";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine([{ text: "never sent" }]);
    const text = await this.settings(engine, "baseUrl http://127.0.0.1:1/v1");
    t.assert.ok(text.includes(NOTES.session), `baseUrl is applied to the session: ${text}`);
    t.assert.equal(engine.settings.baseUrl, "http://127.0.0.1:1/v1", "the live settings carry it");

    // The provider was rebuilt from the new endpoint: the scripted provider is
    // no longer the one the session talks to, so the next turn never reaches it
    // and fails at the (unreachable) real endpoint instead.
    const turn = await engine.runTurn("hi");
    t.assert.equal(engine.provider.requests.length, 0, "the scripted provider was never asked — a real one was built in its place");
    t.assert.equal(turn.stopReason, "error", "the turn went to 127.0.0.1:1 and failed there");
    t.assert.ok(turn.errors.length > 0, "and the failure was reported to the user");
  }
}

class AnUnknownKeyIsRefusedWithTheList extends LiveSettingsTest {
  readonly id = "an-unknown-key-prints-the-valid-keys-no-timing-note-and-writes-nothing";
  readonly whyItExists = "a typo'd key was written into the settings file as a passthrough and reported as 'applied', then silently ignored forever";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    const before = existsSync(this.settingsFile()) ? readFileSync(this.settingsFile(), "utf8") : undefined;
    const text = await this.settings(engine, "nope 1");
    t.assert.ok(text.startsWith('Unknown setting "nope"'), text);
    t.assert.ok(text.includes("Valid keys:"), "the valid keys are listed");
    t.assert.ok(text.includes("model") && text.includes("baseUrl"), "including the real ones");
    t.assert.equal(Object.values(NOTES).some((note) => text.includes(note)), false, "no timing note for a refused key");
    const after = existsSync(this.settingsFile()) ? readFileSync(this.settingsFile(), "utf8") : undefined;
    t.assert.equal(after, before, "the settings file is unchanged");
    t.assert.equal("nope" in engine.settings, false, "and the live settings did not grow a key");
  }
}

registerFeatureTests(new EveryKeyHasATiming(), new TheModelNoteAndTheNextRequest(), new TimingResolvesByTopLevelKey(), new AConnectionKeyRebuildsTheProvider(), new AnUnknownKeyIsRefusedWithTheList());
