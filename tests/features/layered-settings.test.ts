/**
 * `layered-settings`.
 *
 * Settings arrive in four layers — schema defaults, `~/.magentra/settings.json`,
 * `<cwd>/.magentra/settings.json`, and a short list of env vars — and the later
 * one deep-merges over the earlier. Without the layering a per-project model or
 * endpoint would have to be re-typed globally; without the ATTRIBUTION half a
 * user who set `model` in their project file and sees a different model has no
 * way to learn that a `MAGENTRA_MODEL` in their shell is answering instead.
 *
 * `fs`, as the record declares: every one of these five reads a real
 * `settings.json` off disk, in a real home directory and a real workspace, and
 * the global layer is resolved through `os.homedir()` — so `redirectHome()`
 * comes first in every class or the test reads the developer's own connection.
 *
 * The env vars `ENV_OVERRIDES` names are CLEARED at the top of every class
 * ({@link clearOverrideEnv}): a developer with `MAGENTRA_MODEL` exported would
 * otherwise see item 1 fail for a reason that is not about layering at all.
 *
 * Nothing here is stubbed: `loadSettings` and `describeSettings` are the
 * shipped functions, reading files this test wrote with the kind's own writer.
 */

import { join } from "node:path";

import { describeSettings, globalSettingsPath, loadSettings, projectSettingsPath, type EffectiveSetting } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "layered-settings";

/** Verbatim from the record. */
const INVARIANT = "Project settings merge OVER global, and the effective value reports its source.";

/**
 * Every variable `ENV_OVERRIDES` consults. The list is duplicated here on
 * purpose: importing the module's private constant is impossible, and a test
 * that silently stopped clearing a name the product started reading would go
 * green on a machine that happens not to export it.
 */
const OVERRIDE_ENV_VARS = [
  "MAGENTRA_PROVIDER",
  "MAGENTRA_MODEL",
  "MAGENTRA_SMALL_MODEL",
  "MAGENTRA_VISION",
  "MAGENTRA_BASE_URL",
  "MAGENTRA_API_KEY_ENV",
  "MAGENTRA_MAX_ITERATIONS",
  "MAGENTRA_MAX_TOKENS_PER_TURN",
] as const;

abstract class LayeredSettingsTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** The redirected home, so a test can assert WHERE the global layer landed. */
  protected home = "";

  /**
   * A redirected home, a workspace, and an environment holding none of the
   * override variables. Returns the workspace.
   */
  protected stage(): string {
    this.home = this.redirectHome();
    for (const name of OVERRIDE_ENV_VARS) this.setEnv(name, undefined);
    return this.tempDir("magentra-ws-");
  }

  /** The `EffectiveSetting` for one dot-path, or a failure naming what was there instead. */
  protected leaf(described: readonly EffectiveSetting[], key: string): EffectiveSetting {
    const found = described.find((e) => e.key === key);
    if (!found) throw new Error(`describeSettings reported no leaf "${key}"; it reported: ${described.map((e) => e.key).join(", ")}`);
    return found;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ProjectWinsOverGlobal extends LayeredSettingsTest {
  readonly id = "the-project-file-wins-over-the-global-one-and-says-so";
  readonly whyItExists =
    "a workspace that pinned its own model kept getting the globally configured one, and with no source column the user could not tell whether their project file had been read at all";

  override run(t: TestRun): void {
    const workspace = this.stage();
    this.writeJson(join(this.home, ".magentra", "settings.json"), { model: "g" });
    this.writeJson(join(workspace, ".magentra", "settings.json"), { model: "p" });

    // The two layers really are the documented files, not whatever the helper
    // decided to call them.
    t.assert.equal(globalSettingsPath(), join(this.home, ".magentra", "settings.json"));
    t.assert.equal(projectSettingsPath(workspace), join(workspace, ".magentra", "settings.json"));

    const loaded = loadSettings(workspace);
    t.assert.equal(loaded.settings.model, "p", "project merges OVER global");
    t.assert.deepEqual(loaded.warnings, [], "two well-formed layers warn about nothing");

    const model = this.leaf(describeSettings(workspace), "model");
    t.assert.equal(model.value, "p");
    t.assert.equal(model.source, "project", "the effective value names the layer it came from");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class NestedBlocksMergeLeafByLeaf extends LayeredSettingsTest {
  readonly id = "a-nested-block-merges-leaf-by-leaf-not-wholesale";
  readonly whyItExists =
    "a project file that switched web search off replaced the whole `search` block, so the Brave provider and its key name set globally vanished and search fell back to duckduckgo the moment anyone re-enabled it";

  override run(t: TestRun): void {
    const workspace = this.stage();
    this.writeJson(join(this.home, ".magentra", "settings.json"), { search: { provider: "brave" } });
    this.writeJson(join(workspace, ".magentra", "settings.json"), { search: { enabled: false } });

    const { settings } = loadSettings(workspace);
    t.assert.deepEqual(
      settings.search,
      { enabled: false, provider: "brave" },
      "the project's leaf lands without taking the global block's other leaves with it",
    );

    const described = describeSettings(workspace);
    t.assert.equal(this.leaf(described, "search.enabled").source, "project");
    t.assert.equal(this.leaf(described, "search.enabled").value, false);
    t.assert.equal(this.leaf(described, "search.provider").source, "global", "a leaf only the global layer set is attributed to it");
    t.assert.equal(this.leaf(described, "search.provider").value, "brave");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnUntouchedKeyIsTheSchemaDefault extends LayeredSettingsTest {
  readonly id = "a-key-set-in-neither-file-reports-the-schema-default";
  readonly whyItExists =
    "every key was reported as coming from a file, so a value nobody had ever set looked like a choice somebody had made and was debugged as one";

  override run(t: TestRun): void {
    const workspace = this.stage();
    // One layer exists and says nothing about compactionThreshold; the other
    // does not exist at all. Neither is allowed to claim the key.
    this.writeJson(join(workspace, ".magentra", "settings.json"), { model: "p" });

    const { settings } = loadSettings(workspace);
    t.assert.equal(settings.compactionThreshold, 0.8, "the schema default is what a key nobody set resolves to");

    const described = describeSettings(workspace);
    const threshold = this.leaf(described, "compactionThreshold");
    t.assert.equal(threshold.value, 0.8);
    t.assert.equal(threshold.source, "default");

    // And a key the schema defaults deeper down is reported the same way.
    const sessions = this.leaf(described, "retention.sessions");
    t.assert.equal(sessions.value, 100);
    t.assert.equal(sessions.source, "default");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnEnvVarBeatsBothFiles extends LayeredSettingsTest {
  readonly id = "an-env-var-beats-both-files-and-a-blank-one-does-not";
  readonly whyItExists =
    "an exported MAGENTRA_MODEL silently decided the model while /settings still showed the project file as the source, and an EMPTY one blanked the model entirely instead of being ignored";

  override run(t: TestRun): void {
    const workspace = this.stage();
    this.writeJson(join(this.home, ".magentra", "settings.json"), { model: "g" });
    this.writeJson(join(workspace, ".magentra", "settings.json"), { model: "p" });

    this.setEnv("MAGENTRA_MODEL", "e");
    t.assert.equal(loadSettings(workspace).settings.model, "e", "the environment overrides both files");
    const withEnv = this.leaf(describeSettings(workspace), "model");
    t.assert.equal(withEnv.value, "e");
    t.assert.equal(withEnv.source, "env", "and the source says the environment, not the project file");

    // A blank variable is not a setting. applyEnvOverrides skips `raw === ""`
    // and describeSettings filters on truthiness; this asserts the two AGREE,
    // because a mismatch reports a source for a value that was never applied.
    this.setEnv("MAGENTRA_MODEL", "");
    t.assert.equal(loadSettings(workspace).settings.model, "p", "a blank env var does not override the files");
    const blank = this.leaf(describeSettings(workspace), "model");
    t.assert.equal(blank.value, "p");
    t.assert.equal(blank.source, "project", "and nothing is attributed to an env var that did not override");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ABrokenLayerWarnsInsteadOfThrowing extends LayeredSettingsTest {
  readonly id = "an-unknown-key-and-a-broken-layer-warn-while-the-other-layer-still-loads";
  readonly whyItExists =
    "a stray comma in one settings file threw out of loadSettings, so the engine came up with NO configuration at all instead of with the layer that was still fine";

  override run(t: TestRun): void {
    const workspace = this.stage();
    this.writeJson(join(workspace, ".magentra", "settings.json"), { model: "p", nonsenseKey: 1 });

    const unknown = loadSettings(workspace);
    t.assert.equal(unknown.settings.model, "p", "an unknown key does not stop the known ones loading");
    t.assert.ok(
      unknown.warnings.some((w) => w.message.includes(`unknown key "nonsenseKey"`)),
      `an unknown key must be reported; warnings were ${JSON.stringify(unknown.warnings)}`,
    );

    // Now break the GLOBAL layer's JSON and leave the project layer intact.
    this.writeFile(join(this.home, ".magentra", "settings.json"), `{ "model": "g", }`);
    const broken = loadSettings(workspace);
    t.assert.equal(broken.settings.model, "p", "the layer that still parses is still loaded");
    const complaint = broken.warnings.find((w) => w.source === globalSettingsPath());
    t.assert.notEqual(complaint, undefined, `the broken layer must name itself; warnings were ${JSON.stringify(broken.warnings)}`);
    t.assert.ok(complaint!.message.startsWith("invalid JSON:"), complaint!.message);

    // describeSettings reads the same layers and must not throw either.
    t.assert.equal(this.leaf(describeSettings(workspace), "model").source, "project");
  }
}

registerFeatureTests(
  new ProjectWinsOverGlobal(),
  new NestedBlocksMergeLeafByLeaf(),
  new AnUntouchedKeyIsTheSchemaDefault(),
  new AnEnvVarBeatsBothFiles(),
  new ABrokenLayerWarnsInsteadOfThrowing(),
);
