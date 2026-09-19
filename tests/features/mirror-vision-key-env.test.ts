/**
 * `mirror-vision-key-env`.
 *
 * The vision model's API key lives in a workspace `.env` under one variable
 * name. The app WRITES that line (from the connection wizard) and the engine
 * READS it (`resolveVisionApiKey`). Both sides hard-code the name, because the
 * app cannot import the engine. A mismatch is silent at build time and loud at
 * the worst moment: image description fails with an auth error while the key
 * sits unused in `.env`.
 *
 * `pure`. Two constants, and a resolver that is a function of the environment
 * and a settings object. The one test that sets an environment variable puts
 * it back in a `finally`, and `PureTest` fails the test if it did not.
 *
 * `app/main/config.js` loads in plain Node with no stub: its
 * `require("electron")` resolves to the binary path, `app` is undefined, and
 * nothing read here calls it.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { DEFAULT_API_KEY_ENV, resolveVisionApiKey, settingsSchema, VISION_API_KEY_ENV } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "mirror-vision-key-env";

/** Verbatim from the record. */
const INVARIANT = "VISION_API_KEY_ENV names the same variable on both sides.";

const requireFromHere = createRequire(import.meta.url);

interface AppConfigModule {
  readonly VISION_API_KEY_ENV: string;
  readonly DEFAULT_API_KEY_ENV: string;
  readonly LEGACY_API_KEY_ENV_VARS: readonly string[];
}

function appConfig(): AppConfigModule {
  return requireFromHere(join(repoRoot(), "app", "main", "config.js")) as AppConfigModule;
}

/** A settings object built by the engine's own parser — defaults applied, not hand-shaped. */
function settingsWithStoredVisionKey(apiKey: string | undefined) {
  return settingsSchema.parse({
    visionConnection: { model: "vision-model", ...(apiKey !== undefined ? { apiKey } : {}) },
  });
}

/**
 * Run `body` with the vision variable set to `value` (or absent), then put the
 * environment back exactly as it was — the kind's snapshot check depends on it.
 */
function withVisionEnv<T>(value: string | undefined, body: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, VISION_API_KEY_ENV);
  const previous = process.env[VISION_API_KEY_ENV];
  if (value === undefined) delete process.env[VISION_API_KEY_ENV];
  else process.env[VISION_API_KEY_ENV] = value;
  try {
    return body();
  } finally {
    if (had) process.env[VISION_API_KEY_ENV] = previous;
    else delete process.env[VISION_API_KEY_ENV];
  }
}

abstract class VisionKeyEnvTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheNamesAgree extends VisionKeyEnvTest {
  readonly id = "the-app-writes-the-variable-the-engine-reads";
  readonly whyItExists =
    "the app wrote the vision key under one name and the engine looked for another, so every image description failed with an auth error while the key sat in .env";

  override run(t: TestRun): void {
    t.assert.equal(appConfig().VISION_API_KEY_ENV, VISION_API_KEY_ENV, "app/main/config.js and engine settings.ts disagree on the vision key's variable");
    t.assert.equal(VISION_API_KEY_ENV, "MAGENTRA_VISION_API_KEY");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class OneNameNeverServesTwoKeys extends VisionKeyEnvTest {
  readonly id = "the-vision-variable-is-not-the-main-connections-variable";
  readonly whyItExists =
    "the two endpoints are usually different services; one variable for both keys is how the vision key gets sent to the coding endpoint or vice versa";

  override run(t: TestRun): void {
    const app = appConfig();
    t.assert.notEqual(VISION_API_KEY_ENV, DEFAULT_API_KEY_ENV, "engine: the vision variable must differ from the main key's");
    t.assert.notEqual(app.VISION_API_KEY_ENV, app.DEFAULT_API_KEY_ENV, "app: the vision variable must differ from the main key's");
    t.assert.notEqual(VISION_API_KEY_ENV, "MAGENTRA_API_KEY");
    t.assert.equal(app.LEGACY_API_KEY_ENV_VARS.includes(app.VISION_API_KEY_ENV), false, "a legacy main-key name must never double as the vision variable");
    // And the two halves agree on the main name too — otherwise "differs from
    // the main one" would be checked against two different main names.
    t.assert.equal(app.DEFAULT_API_KEY_ENV, DEFAULT_API_KEY_ENV);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheEnvironmentWinsOverTheStoredKey extends VisionKeyEnvTest {
  readonly id = "the-environment-wins-and-the-stored-key-is-the-fallback";
  readonly whyItExists =
    "a container that overrides the vision key through its environment must not be ignored in favour of a key stored in a settings file it does not own";

  override run(t: TestRun): void {
    const settings = settingsWithStoredVisionKey("stored");
    t.assert.equal(
      withVisionEnv("vk", () => resolveVisionApiKey(settings)),
      "vk",
      `${VISION_API_KEY_ENV} in the environment must win over the stored key`,
    );
    t.assert.equal(
      withVisionEnv(undefined, () => resolveVisionApiKey(settings)),
      "stored",
      "with the variable unset the stored key is the answer",
    );
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class BlankIsNotAKey extends VisionKeyEnvTest {
  readonly id = "a-whitespace-variable-and-no-stored-key-resolve-to-nothing";
  readonly whyItExists =
    "a blank variable treated as set hands the vision endpoint an empty bearer token, which comes back as an authentication failure instead of the honest 'no key'";

  override run(t: TestRun): void {
    const noStoredKey = settingsWithStoredVisionKey(undefined);
    t.assert.equal(withVisionEnv("   ", () => resolveVisionApiKey(noStoredKey)), undefined, "whitespace is not a key");
    t.assert.equal(withVisionEnv("", () => resolveVisionApiKey(noStoredKey)), undefined, "an empty variable is not a key");
    // A blank STORED key is not one either — the same rule on the other side.
    t.assert.equal(withVisionEnv(undefined, () => resolveVisionApiKey(settingsWithStoredVisionKey("  "))), undefined);
    // Control: a blank variable falls through to a real stored key rather than
    // masking it, so the blank is ignored, not treated as "no key anywhere".
    t.assert.equal(withVisionEnv(" ", () => resolveVisionApiKey(settingsWithStoredVisionKey("stored"))), "stored");
  }
}

registerFeatureTests(new TheNamesAgree(), new OneNameNeverServesTwoKeys(), new TheEnvironmentWinsOverTheStoredKey(), new BlankIsNotAKey());
