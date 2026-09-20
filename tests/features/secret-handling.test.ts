/**
 * `secret-handling`.
 *
 * Two halves of one promise. WHICH key goes out: the `apiKeyEnv` pin, then the
 * provider's standard env names, then the key stored in settings — with a blank
 * variable counting as absent and a pin that names nothing reported rather than
 * swallowed. And WHERE a saved key is written: always the global
 * `~/.magentra/settings.json`, never the project file a workspace commits.
 *
 * `fs`, as the record declares, and honestly so: the settings these five
 * resolve are LOADED from real layers on disk through `loadSettings`, not
 * hand-built objects, and item 5's whole subject is which file the write landed
 * in. The env vars are set through `FsTest.setEnv`, which puts them back — the
 * tests in a file share one process, so a leaked key would decide the next
 * test's answer.
 *
 * DELIBERATELY NOT A COPY of the two phase-1 files that also touch this
 * resolver. `api-key-resolution-has-no-silent-shadow` proves the ORDER as a
 * function of its arguments (`pure`); `the-saved-key-is-resolved-by-provider-not-by-file-order`
 * proves what the desktop app puts on a socket. This one is the settings
 * FILE's account of the same rules: the layers that supply `apiKeyEnv` and
 * `apiKey`, and the file a secret is allowed to land in.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  describeSettings,
  globalSettingsPath,
  loadSettings,
  projectSettingsPath,
  resolveApiKeySource,
  setSetting,
  type Settings,
} from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "secret-handling";

/** Verbatim from the record. */
const INVARIANT =
  "Key resolution is pinned apiKeyEnv, then standard env names, then the stored key; blank env vars do not count and a dangling pin warns.";

/** Every variable resolution can consult, plus the env override that would rewrite the pin itself. */
const CLEARED = [
  "MAGENTRA_API_KEY",
  "OPENAI_API_KEY",
  "DEEPINFRA_API_KEY",
  "ANTHROPIC_API_KEY",
  "MAGENTRA_API_KEY_ENV",
  "MAGENTRA_PROVIDER",
] as const;

abstract class SecretTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected home = "";
  protected workspace = "";

  /** A redirected home, an empty workspace, and none of the key variables set. */
  protected stage(): void {
    this.home = this.redirectHome();
    this.workspace = this.tempDir("magentra-secret-");
    for (const name of CLEARED) this.setEnv(name, undefined);
  }

  /**
   * The settings the engine would really load, from a real project layer.
   *
   * Written and read back rather than hand-built: the pin and the stored key
   * live in a file, and a resolver that agreed with an object literal while
   * disagreeing with what `loadSettings` produces would prove nothing.
   */
  protected settingsFromFile(fields: Record<string, unknown>): Settings {
    this.writeJson(projectSettingsPath(this.workspace), fields);
    const { settings, warnings } = loadSettings(this.workspace);
    if (warnings.length > 0) throw new Error(`the fixture layer did not load cleanly: ${JSON.stringify(warnings)}`);
    return settings;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ThePinIsConsultedFirst extends SecretTest {
  readonly id = "the-pin-is-consulted-before-every-other-source";
  readonly whyItExists =
    "a user who named their own variable in apiKeyEnv still had MAGENTRA_API_KEY sent instead, so pinning a variable did nothing and the key they meant to use never left the machine";

  override run(t: TestRun): void {
    this.stage();
    this.setEnv("MY_KEY", "pinned");
    this.setEnv("MAGENTRA_API_KEY", "standard");

    const resolved = resolveApiKeySource(this.settingsFromFile({ apiKeyEnv: "MY_KEY", apiKey: "stored" }));

    t.assert.equal(resolved.key, "pinned", "the pinned variable answers before the standard names and the stored key");
    t.assert.equal(resolved.from, "MY_KEY", "and the result names the variable it came from");
    t.assert.equal(resolved.danglingKeyEnv, undefined, "a pin that answered is not dangling");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ADanglingPinIsReported extends SecretTest {
  readonly id = "a-pin-naming-an-absent-variable-is-reported-as-dangling";
  readonly whyItExists =
    "a pin left behind by a previous provider named a variable nobody exports any more; resolution moved on silently, so the user was never told the line in their settings file had stopped meaning anything";

  override run(t: TestRun): void {
    this.stage();
    this.setEnv("MISSING", undefined);
    this.setEnv("MAGENTRA_API_KEY", "envkey");

    const resolved = resolveApiKeySource(this.settingsFromFile({ apiKeyEnv: "MISSING", apiKey: "stored" }));

    t.assert.equal(resolved.key, "envkey", "an unset pin does not stop the search at the stored key");
    t.assert.equal(resolved.from, "MAGENTRA_API_KEY");
    t.assert.equal(resolved.danglingKeyEnv, "MISSING", "the pin that named nothing is handed back so the caller can warn");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class BlankVariablesFallThroughToTheStoredKey extends SecretTest {
  readonly id = "blank-env-vars-fall-through-to-the-stored-key";
  readonly whyItExists =
    "an exported but empty MAGENTRA_API_KEY counted as set, so an empty Bearer token went out while the perfectly good key in the settings file sat unread and the endpoint's refusal was blamed on the saved key";

  override run(t: TestRun): void {
    this.stage();
    this.setEnv("MAGENTRA_API_KEY", " ");
    this.setEnv("OPENAI_API_KEY", "");
    // DEEPINFRA_API_KEY stays unset — blank and absent must behave alike.

    const stored = resolveApiKeySource(this.settingsFromFile({ apiKey: "stored" }));
    t.assert.equal(stored.key, "stored", "whitespace and empty are both 'not set', so the stored key is what is left");
    t.assert.equal(stored.from, "settings", "the stored key is a named source like any other");
    t.assert.equal(stored.danglingKeyEnv, undefined, "no pin, nothing dangling");

    const nothing = resolveApiKeySource(this.settingsFromFile({}));
    t.assert.equal(nothing.key, undefined, "no key anywhere is an answer, not a guess");
    t.assert.equal(nothing.from, undefined);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnthropicReadsOnlyItsOwnVariable extends SecretTest {
  readonly id = "an-anthropic-connection-reads-only-the-anthropic-variable";
  readonly whyItExists =
    "an anthropic workspace borrowed whatever MAGENTRA_API_KEY held, so an OpenAI-compatible key was sent to Anthropic and the resulting 401 was reported as the saved Anthropic key being wrong";

  override run(t: TestRun): void {
    this.stage();
    this.setEnv("MAGENTRA_API_KEY", "openai-compat-key");

    const borrowed = resolveApiKeySource(this.settingsFromFile({ provider: "anthropic", apiKey: "stored" }));
    t.assert.equal(borrowed.key, "stored", "the other provider's variable is not consulted, so the stored key is next");
    t.assert.equal(borrowed.from, "settings");

    // The provider's own name IS consulted, and beats the stored key.
    this.setEnv("ANTHROPIC_API_KEY", "anthropic-key");
    const own = resolveApiKeySource(this.settingsFromFile({ provider: "anthropic", apiKey: "stored" }));
    t.assert.equal(own.key, "anthropic-key");
    t.assert.equal(own.from, "ANTHROPIC_API_KEY");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ASavedKeyNeverTouchesTheProjectFile extends SecretTest {
  readonly id = "a-saved-key-lands-in-the-global-file-and-prints-redacted";
  readonly whyItExists =
    "a key saved from inside a workspace went to .magentra/settings.json, which is the file a team commits — so the secret was pushed to the repository, and /settings printed it in full on the way";

  override run(t: TestRun): void {
    this.stage();
    // A workspace that HAS a .magentra/ directory: "auto" would choose the
    // project file for any ordinary key, which is exactly the trap.
    const projectFile = projectSettingsPath(this.workspace);
    this.writeJson(projectFile, { model: "project-model" });

    const ordinary = setSetting(this.workspace, "model", "changed");
    t.assert.equal(ordinary.file, projectFile, "an ordinary key in a workspace goes to the project file");
    // The bytes the project file is expected to still hold afterwards.
    const projectBefore = readFileSync(projectFile);

    const applied = setSetting(this.workspace, "apiKey", "sk-secret");
    t.assert.equal(applied.file, globalSettingsPath(), "a secret goes to the GLOBAL file, whatever the cwd is");
    t.assert.equal(applied.key, "apiKey");
    t.assert.equal(applied.value, "sk-secret");

    // The project file is byte-identical to what the ordinary write left, and
    // holds no trace of the secret.
    const projectAfter = readFileSync(projectFile);
    t.assert.equal(projectBefore.equals(projectAfter), true, "the secret write must not have touched the project file at all");
    t.assert.equal(projectAfter.includes("sk-secret"), false, "the shareable file must never carry the key");
    t.assert.equal(JSON.parse(projectAfter.toString("utf8")).model, "changed");
    t.assert.equal("apiKey" in JSON.parse(projectAfter.toString("utf8")), false);

    // The global file landed, with the key in it.
    const globalFile = globalSettingsPath();
    t.assert.equal(globalFile, join(this.home, ".magentra", "settings.json"));
    t.assert.equal(JSON.parse(readFileSync(globalFile, "utf8")).apiKey, "sk-secret");
    // File modes are a POSIX fact; Windows has none, so there the same claim is
    // that the write landed (tests/README, "Every test runs on ...").
    if (process.platform === "win32") {
      t.assert.ok(statSync(globalFile).isFile(), "the global settings file exists");
    } else {
      t.assert.equal(statSync(globalFile).mode & 0o777, 0o600, "a file that may hold a key is owner-only");
    }

    // And /settings shows it masked rather than printed.
    const apiKey = describeSettings(this.workspace).find((e) => e.key === "apiKey");
    t.assert.notEqual(apiKey, undefined, "the key is reported as a setting");
    t.assert.equal(apiKey!.value, "sk-…cret (redacted)", "first three and last four only");
    t.assert.equal(apiKey!.source, "global");

    // A value too short to mask safely collapses entirely.
    setSetting(this.workspace, "apiKey", "short");
    const short = describeSettings(this.workspace).find((e) => e.key === "apiKey");
    t.assert.equal(short!.value, "(set, redacted)", "nothing recoverable leaks from a short key either");
  }
}

registerFeatureTests(
  new ThePinIsConsultedFirst(),
  new ADanglingPinIsReported(),
  new BlankVariablesFallThroughToTheStoredKey(),
  new AnthropicReadsOnlyItsOwnVariable(),
  new ASavedKeyNeverTouchesTheProjectFile(),
);
