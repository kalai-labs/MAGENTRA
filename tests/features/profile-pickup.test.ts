/**
 * `profile-pickup`.
 *
 * The engine never reads `~/.magentra/profiles.json`. It boots from the
 * workspace: the API key in `<ws>/.env`, the rest of the connection in
 * `<ws>/.magentra/settings.json`. So "use this saved profile here" is not a
 * setting the TUI holds — it is two writes, and they have to be byte-compatible
 * with the two writes `app/main.js applyValidatedConnection` makes, or a folder
 * connected from the terminal is not the same folder the IDE would have made.
 *
 * `fs`, as the record declares: every assertion here is about a file the
 * function wrote or refused to write, in a temp workspace, under a redirected
 * HOME (`profilesPath()` resolves under `os.homedir()`).
 *
 * `tui/src/profiles.ts` imports only node: built-ins, so it is imported
 * directly as source and Node strips its types like the rest of the suite.
 *
 * TWO NAMES THE DESCRIPTION USES ARE MODULE-PRIVATE. `keyVarFor` and
 * `CONNECTION_SETTINGS_KEYS` are not exported, so they are proven through the
 * exported surface: `keyVarFor` through the line `applyProfile` writes, and
 * `CONNECTION_SETTINGS_KEYS` through {@link CONNECTION_KEYS} below, which
 * mirrors the constant and is checked against what `clearWorkspaceConnection`
 * actually removes.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyProfile,
  clearWorkspaceConnection,
  profilesPath,
  readProfiles,
  readWorkspaceConnection,
  workspaceConnected,
  type Profile,
} from "../../tui/src/profiles.ts";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "profile-pickup";

/** Verbatim from the record. */
const INVARIANT = "A folder with no credentials picks up a saved profile by writing .env and .magentra/settings.json exactly as the IDE writes them.";

/** Mirrors the module-private `CONNECTION_SETTINGS_KEYS`; the clearing test is what holds the mirror true. */
const CONNECTION_KEYS = ["provider", "baseUrl", "model", "contextWindow", "reasoningEffort", "allowInsecureTls", "apiKeyEnv", "apiKey"] as const;

/** Every key-bearing variable the engine's boot consults, and the one the wizard's own test clears. */
const KEY_VARS = ["MAGENTRA_API_KEY", "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"] as const;

abstract class ProfileTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A workspace with no credentials of any kind: no .env, no settings, no key in the environment. */
  protected freshWorkspace(): string {
    this.redirectHome();
    for (const name of KEY_VARS) this.setEnv(name, undefined);
    return this.tempDir("magentra-profile-");
  }

  protected settingsOf(ws: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(ws, ".magentra", "settings.json"), "utf8")) as Record<string, unknown>;
  }
}

/* ---- checklist 1 ------------------------------------------------------ */

class AFreshFolderIsUnconnectedUntilAProfileIsApplied extends ProfileTest {
  readonly id = "an-empty-folder-reads-as-unconnected-and-applying-a-profile-connects-it";
  readonly whyItExists =
    "a folder with no .env and no settings still read as connected, so the TUI never offered the picker and the engine booted straight into a provider error the user could not act on";

  override run(t: TestRun): void {
    const ws = this.freshWorkspace();

    t.assert.equal(existsSync(join(ws, ".env")), false, "the fixture really has no .env");
    t.assert.equal(existsSync(join(ws, ".magentra", "settings.json")), false, "and no settings");
    t.assert.equal(workspaceConnected(ws), false, "nothing to boot from");

    applyProfile(ws, { id: "p1", name: "Local", provider: "openai-compat", apiKey: "k", model: "m", baseUrl: "http://h:1/v1" });

    t.assert.equal(workspaceConnected(ws), true, "after the profile is committed the engine can boot here");
    const connection = readWorkspaceConnection(ws);
    t.assert.deepEqual(connection, { provider: "openai-compatible", baseUrl: "http://h:1/v1", model: "m", hasKeyLine: true }, "and the folder can say what it is pointed at");
  }
}

/* ---- checklist 2 ------------------------------------------------------ */

class TheKeyGoesUnderTheNameThatProviderUses extends ProfileTest {
  readonly id = "the-env-carries-one-key-line-named-for-the-provider-and-retires-the-legacy-one";
  readonly whyItExists =
    "a leftover DEEPINFRA_API_KEY line outranked the key the user had just chosen, so the folder kept talking to the endpoint they had switched away from";

  override run(t: TestRun): void {
    const ws = this.freshWorkspace();
    this.writeFile(join(ws, ".env"), "DEEPINFRA_API_KEY=old\nUNRELATED=keep\n");

    applyProfile(ws, { id: "p1", name: "Compat", provider: "openai-compat", apiKey: "k", model: "m", baseUrl: "http://h:1/v1" });

    const env = readFileSync(join(ws, ".env"), "utf8");
    const keyLines = env.split("\n").filter((line) => /API_KEY\s*=/.test(line));
    t.assert.deepEqual(keyLines, ["MAGENTRA_API_KEY=k"], "exactly one key line, under the default name");
    t.assert.equal(env.includes("DEEPINFRA_API_KEY"), false, "the retired name is gone");
    t.assert.equal(env.includes("UNRELATED=keep"), true, "and nothing else in the file was touched");

    const anthropicWs = this.tempDir("magentra-profile-anthropic-");
    this.writeFile(join(anthropicWs, ".env"), "DEEPINFRA_API_KEY=old\n");
    applyProfile(anthropicWs, { id: "p2", name: "Claude", provider: "anthropic", apiKey: "k", model: "m" });

    const anthropicEnv = readFileSync(join(anthropicWs, ".env"), "utf8");
    t.assert.equal(anthropicEnv.includes("ANTHROPIC_API_KEY=k"), true, "an anthropic profile writes its own variable");
    t.assert.equal(anthropicEnv.includes("MAGENTRA_API_KEY"), false, "never the default one");
    t.assert.equal(anthropicEnv.includes("DEEPINFRA_API_KEY=old"), true, "and leaves the legacy line for the other provider alone");
  }
}

/* ---- checklist 3 ------------------------------------------------------ */

class SettingsAreSpelledTheWayTheEngineReadsThem extends ProfileTest {
  readonly id = "settings-json-spells-the-provider-openai-compatible-and-drops-any-apikeyenv-pin";
  readonly whyItExists =
    "the app's own vocabulary 'openai-compat' was written straight into settings.json, where the engine's schema does not know it, and a stale apiKeyEnv pin sent key resolution past the key that had just been saved";

  override run(t: TestRun): void {
    const ws = this.freshWorkspace();
    this.writeJson(join(ws, ".magentra", "settings.json"), { apiKeyEnv: "SOME_OLD_VAR", theme: "dark", maxIterationsPerTurn: 40 });

    applyProfile(ws, {
      id: "p1",
      name: "Compat",
      provider: "openai-compat",
      apiKey: "k",
      model: "glm-5",
      baseUrl: "http://h:1/v1",
      contextWindow: "128000",
      reasoningEffort: " high ",
      insecureTls: true,
    });

    const settings = this.settingsOf(ws);
    t.assert.equal(settings.provider, "openai-compatible", "the engine's spelling, never the app's");
    t.assert.equal(settings.model, "glm-5");
    t.assert.equal(settings.baseUrl, "http://h:1/v1");
    t.assert.equal(settings.contextWindow, 128_000, "a numeric context window, not the string the profile held");
    t.assert.equal(settings.reasoningEffort, "high", "trimmed");
    t.assert.equal(settings.allowInsecureTls, true, "an insecure compat endpoint says so");
    t.assert.equal("apiKeyEnv" in settings, false, "the stale pin is deleted");
    t.assert.equal(settings.theme, "dark", "unrelated settings survive");
    t.assert.equal(settings.maxIterationsPerTurn, 40, "all of them");

    const anthropicWs = this.tempDir("magentra-profile-tls-");
    applyProfile(anthropicWs, { id: "p2", name: "Claude", provider: "anthropic", apiKey: "k", model: "m", insecureTls: true });
    const anthropicSettings = this.settingsOf(anthropicWs);
    t.assert.equal(anthropicSettings.provider, "anthropic");
    t.assert.equal("allowInsecureTls" in anthropicSettings, false, "anthropic is never allowed to skip TLS verification");

    const plainWs = this.tempDir("magentra-profile-plain-");
    applyProfile(plainWs, { id: "p3", name: "Plain", provider: "openai-compat", apiKey: "k", model: "m", baseUrl: "http://h:1/v1" });
    const plainSettings = this.settingsOf(plainWs);
    t.assert.equal("allowInsecureTls" in plainSettings, false, "absent unless the profile asked for it");
    t.assert.equal("contextWindow" in plainSettings, false, "and absent unless the profile carried one");
    t.assert.equal("reasoningEffort" in plainSettings, false);
  }
}

/* ---- checklist 4 ------------------------------------------------------ */

class AKeylessProfileWritesNoEnvAtAll extends ProfileTest {
  readonly id = "a-keyless-endpoint-creates-no-env-file-and-still-counts-as-connected";
  readonly whyItExists =
    "a keyless local server got an empty MAGENTRA_API_KEY= line written for it, and a .env holding a blank key is a credential file the user now has to explain to every tool that reads one";

  override run(t: TestRun): void {
    const ws = this.freshWorkspace();

    applyProfile(ws, { id: "p1", name: "Ollama", provider: "openai-compat", model: "qwen3", baseUrl: "http://127.0.0.1:11434/v1" });

    t.assert.equal(existsSync(join(ws, ".env")), false, "no .env was created for a profile with no key");
    const settings = this.settingsOf(ws);
    t.assert.equal(settings.provider, "openai-compatible");
    t.assert.equal(settings.baseUrl, "http://127.0.0.1:11434/v1");
    t.assert.equal(settings.model, "qwen3");
    t.assert.equal(workspaceConnected(ws), true, "connected on the strength of settings.json alone");
    t.assert.equal(readWorkspaceConnection(ws)?.hasKeyLine, false, "and it says so: there is no key line");
  }
}

/* ---- checklist 5 ------------------------------------------------------ */

class AMangledStoreReadsEmptyAndClearingIsTheExactInverse extends ProfileTest {
  readonly id = "a-mangled-profile-store-reads-as-empty-and-clearing-undoes-only-what-applying-wrote";
  readonly whyItExists =
    "a hand-edited profiles.json crashed the picker instead of showing none, and disconnecting a workspace deleted .env and settings.json wholesale, taking the workspace's unrelated variables and its other twenty settings keys with it";

  override run(t: TestRun): void {
    const ws = this.freshWorkspace();

    t.assert.deepEqual(readProfiles(), [], "a missing store is an empty list, not a throw");
    this.writeFile(profilesPath(), '{"not":"an array"}');
    t.assert.deepEqual(readProfiles(), [], "neither is a store that is not an array");
    this.writeFile(profilesPath(), "not json at all");
    t.assert.deepEqual(readProfiles(), [], "nor an unparseable one");
    this.writeJson(profilesPath(), [{ id: 1, name: "numeric id" }, { name: "no id" }, { id: "x" }, { id: "ok", name: "Kept", provider: "anthropic" }]);
    t.assert.deepEqual(
      readProfiles().map((p) => p.id),
      ["ok"],
      "an entry without a string id and name is not a profile",
    );

    this.writeFile(join(ws, ".env"), "UNRELATED=keep\n");
    this.writeJson(join(ws, ".magentra", "settings.json"), { theme: "dark", apiKeyEnv: "OLD" });
    applyProfile(ws, {
      id: "ok",
      name: "Kept",
      provider: "openai-compat",
      apiKey: "k",
      model: "m",
      baseUrl: "http://h:1/v1",
      contextWindow: 8_000,
      reasoningEffort: "high",
      insecureTls: true,
    });
    const applied = this.settingsOf(ws);
    for (const key of ["provider", "baseUrl", "model", "contextWindow", "reasoningEffort", "allowInsecureTls"]) {
      t.assert.equal(key in applied, true, `applyProfile wrote ${key}`);
    }

    clearWorkspaceConnection(ws);

    const cleared = this.settingsOf(ws);
    for (const key of CONNECTION_KEYS) t.assert.equal(key in cleared, false, `clearWorkspaceConnection removed ${key}`);
    t.assert.deepEqual(cleared, { theme: "dark" }, "and left every unrelated key exactly as it was");
    t.assert.equal(readFileSync(join(ws, ".env"), "utf8"), "UNRELATED=keep\n", "the .env is back to the bytes it held before the profile");
    t.assert.equal(workspaceConnected(ws), false, "the folder is unconnected again");
  }
}

registerFeatureTests(
  new AFreshFolderIsUnconnectedUntilAProfileIsApplied(),
  new TheKeyGoesUnderTheNameThatProviderUses(),
  new SettingsAreSpelledTheWayTheEngineReadsThem(),
  new AKeylessProfileWritesNoEnvAtAll(),
  new AMangledStoreReadsEmptyAndClearingIsTheExactInverse(),
);
