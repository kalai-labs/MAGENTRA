/**
 * `saving-a-connection-clears-the-stale-pin-in-both-layers`.
 *
 * The engine merges project settings OVER global ones. So a stale `apiKeyEnv`
 * pin left in `~/.magentra/settings.json` wins back the moment the project copy
 * is removed — the wizard looked like it had cleared the pin, and the next boot
 * resolved the key through a variable belonging to a provider the user had
 * moved off. Clearing one layer is not clearing the pin.
 *
 * TWO KINDS. The clearing happens inside `applyValidatedConnection` in
 * `app/main.js`, which destructures `electron` at line 3 and takes a
 * single-instance lock at line 48 — so the only honest way to trigger it is the
 * real app (`ui`). What it leaves behind is two files, read straight off disk.
 * The `fs` test covers the merge helper those files feed, which is reachable on
 * its own and is the reason a stale global pin was invisible.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { applyProfile, openWorkspace, saveProfile, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "saving-a-connection-clears-the-stale-pin-in-both-layers";

/** Verbatim from the record. */
const INVARIANT = "Saving a connection clears a stale apiKeyEnv pin in BOTH the project and global layers, through one helper.";

/** Keyless and local, so the app treats the workspace as configured and starts an engine. */
const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

const requireFromHere = createRequire(import.meta.url);

interface ConfigModule {
  readEffectiveWorkspaceSettings(workspace: string): Record<string, unknown>;
  readGlobalSettings(): Record<string, unknown>;
  globalSettingsPath(): string;
}

function appConfig(): ConfigModule {
  return requireFromHere(join(repoRoot(), "app", "main", "config.js")) as ConfigModule;
}

/* ---- the merge that made a stale global pin invisible — fs -------------- */

class TheMergedViewIsWhatDecides extends FsTest {
  readonly featureId = FEATURE;
  readonly id = "the-merged-view-is-what-a-stale-global-pin-survives-in";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "project settings are merged OVER global, so a pin deleted from the project file is re-supplied by the global one and the wizard's clearing looks done while nothing changed";

  override run(t: TestRun): void {
    const home = this.redirectHome();
    const workspace = this.tempDir("magentra-ws-");
    const { readEffectiveWorkspaceSettings, globalSettingsPath } = appConfig();

    t.assert.equal(globalSettingsPath(), join(home, ".magentra", "settings.json"), "the global layer must follow the home directory this test redirected");

    // A pin in the global layer only: the project layer is silent about it.
    this.writeJson(join(home, ".magentra", "settings.json"), { apiKeyEnv: "DEEPINFRA_API_KEY", permissions: { keep: true } });
    this.writeJson(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT });

    const merged = readEffectiveWorkspaceSettings(workspace);
    t.assert.equal(merged["apiKeyEnv"], "DEEPINFRA_API_KEY", "the global pin reaches the merged view — which is why clearing one layer is not enough");
    t.assert.equal(merged["baseUrl"], LOCAL_ENDPOINT, "and the project layer still wins where it speaks");

    // The project layer overrides, but only while it has a value to override with.
    this.writeJson(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, apiKeyEnv: "OLD" });
    t.assert.equal(readEffectiveWorkspaceSettings(workspace)["apiKeyEnv"], "OLD");
    this.writeJson(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT });
    t.assert.equal(
      readEffectiveWorkspaceSettings(workspace)["apiKeyEnv"],
      "DEEPINFRA_API_KEY",
      "removing the project pin hands the question back to the global one — the exact regression this feature fixes",
    );
  }
}

/* ---- saving really clears both layers — ui ----------------------------- */

class SavingClearsBothLayers extends UiTest {
  readonly featureId = FEATURE;
  readonly id = "saving-a-connection-leaves-no-pin-in-either-layer";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the wizard deleted the project pin and left the global one, so the endpoint the user had just saved resolved its key through a variable from the provider they had moved off";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home-");
    const workspace = this.makeTempDir("magentra-ws-");
    const globalSettings = join(home, ".magentra", "settings.json");

    // A pin in BOTH layers, plus unrelated keys that must survive untouched.
    this.writeJsonFile(globalSettings, {
      apiKeyEnv: "DEEPINFRA_API_KEY",
      contextWindow: 8192,
      reasoningEffort: "high",
      permissions: { allow: ["Bash"] },
      hooks: { SessionStart: [] },
    });
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: LOCAL_ENDPOINT,
      model: "model-one",
      apiKeyEnv: "OLD",
    });

    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);

    const id = await saveProfile(app, {
      name: "clean",
      provider: "openai-compat",
      baseUrl: LOCAL_ENDPOINT,
      model: "model-two",
      apiKey: "",
    });
    const result = await applyProfile(app, id);
    t.assert.equal(result.ok, true, `applying the profile failed: ${String(result.error)}`);

    const project = JSON.parse(readFileSync(join(workspace, ".magentra", "settings.json"), "utf8")) as Record<string, unknown>;
    const global = JSON.parse(readFileSync(globalSettings, "utf8")) as Record<string, unknown>;

    t.assert.equal("apiKeyEnv" in project, false, "the project pin must be gone");
    t.assert.equal("apiKeyEnv" in global, false, "and so must the global one — one layer is not the pin");

    // A connection with no context window or effort clears those globally too,
    // for the same reason: a leftover global value wins back.
    t.assert.equal("contextWindow" in global, false, "a global contextWindow must not outlive a connection that has none");
    t.assert.equal("reasoningEffort" in global, false, "nor a global reasoningEffort");

    // Everything else in that file is not this feature's business.
    t.assert.deepEqual(global["permissions"], { allow: ["Bash"] }, "unrelated global settings must survive byte for byte");
    t.assert.deepEqual(global["hooks"], { SessionStart: [] });

    if (process.platform !== "win32") {
      t.assert.equal(statSync(globalSettings).mode & 0o777, 0o600, "the global file can hold a stored key, so it is rewritten 0600");
    }

    // And the merged view — what the engine actually reads — is clean.
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    try {
      t.assert.equal("apiKeyEnv" in appConfig().readEffectiveWorkspaceSettings(workspace), false, "the merged view must have no pin left in it");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      delete process.env["USERPROFILE"];
    }

    t.assert.equal(existsSync(`${globalSettings}.tmp`), false, "the rewrite must leave no temp file behind");
  }
}

registerFeatureTests(new TheMergedViewIsWhatDecides(), new SavingClearsBothLayers());
