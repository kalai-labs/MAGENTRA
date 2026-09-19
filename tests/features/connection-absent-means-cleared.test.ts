/**
 * `connection-absent-means-cleared`.
 *
 * A `set_connection` frame is the WHOLE connection. A field it does not carry
 * is cleared, not kept: `baseUrl` already worked that way, and the `vision`
 * block follows the same rule, because leaving a previous vision model in
 * place kept describing images through an endpoint the user had just removed,
 * with the `vision` switch still on and nothing behind it.
 *
 * `fs`, and the record said `pure`. The rule is enforced inside
 * `Engine.handleSetConnection`, on the live settings object of a running
 * engine, and the engine runs in a workspace directory where its session writes
 * its transcript. So the fixture is a real Engine on a scripted provider
 * (`tests/lib/scriptedEngine.ts`), and what is asserted is the settings object
 * the engine actually mutates — handed to it at construction and read back
 * here. Re-declared 2026-09-19.
 *
 * `set_connection` also rebuilds the provider and re-fetches the model
 * catalog; the catalog fetch goes to the frame's `baseUrl`, so every URL below
 * points at 127.0.0.1 on a port nothing listens on, and the fetch fails fast
 * and is swallowed by the engine as designed.
 */

import type { ConnectionSpec } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "connection-absent-means-cleared";

/** Verbatim from the record. */
const INVARIANT = "A connection saved with no vision model leaves none behind, following the same rule as baseUrl.";

const ENDPOINT = "http://127.0.0.1:9/v1";
const VISION_ENDPOINT = "http://127.0.0.1:9/vision/v1";

abstract class ConnectionRuleTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  protected async engine(): Promise<ScriptedEngine> {
    if (this.#engine) return this.#engine;
    this.redirectHome();
    // The frame writes the key into the environment; none of these tests
    // send one, and the kind puts whatever was there back.
    for (const name of ["MAGENTRA_API_KEY", "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"]) this.setEnv(name, undefined);
    this.#engine = await startScriptedEngine({ workspace: this.tempDir("magentra-conn-rule-"), turns: [] });
    return this.#engine;
  }

  /** A complete connection to the same endpoint, with whatever the test adds. */
  protected connection(extra: Partial<ConnectionSpec> = {}): ConnectionSpec {
    return { provider: "openai-compat", baseUrl: ENDPOINT, apiKey: "", model: "model-one", ...extra };
  }

  protected vision(extra: Partial<ConnectionSpec["vision"] & object> = {}): NonNullable<ConnectionSpec["vision"]> {
    return { enabled: true, provider: "openai-compat", baseUrl: VISION_ENDPOINT, apiKey: "", model: "llava", ...extra };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class AnAbsentVisionBlockClears extends ConnectionRuleTest {
  readonly id = "a-connection-without-a-vision-block-removes-the-saved-vision-model";
  readonly whyItExists =
    "the previous vision model stayed in settings after the user removed it from the profile, so images kept going to an endpoint that no longer existed and the switch read ON";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send({ type: "set_connection", connection: this.connection({ vision: this.vision() }) });
    t.assert.equal(engine.settings.visionConnection?.model, "llava", "the vision model is saved first, so the clearing below is a clearing");
    t.assert.equal(engine.settings.vision, true);

    engine.send({ type: "set_connection", connection: this.connection() });
    t.assert.equal(engine.settings.visionConnection, undefined, "no vision block means the saved one is removed");
    t.assert.equal("visionConnection" in engine.settings, false, "deleted, not set to undefined — the key is gone from the settings object");
    t.assert.equal(engine.settings.vision, false, "and the switch is off, because there is nothing behind it");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class APresentVisionBlockIsStored extends ConnectionRuleTest {
  readonly id = "a-present-vision-block-is-stored-trimmed-with-the-switch-on";
  readonly whyItExists =
    "a model name with surrounding whitespace was stored as typed and then sent to the endpoint verbatim, which the endpoint rejected as an unknown model";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send({ type: "set_connection", connection: this.connection({ vision: this.vision({ model: "  llava  ", contextWindow: 8192 }) }) });
    const saved = engine.settings.visionConnection;
    t.assert.notEqual(saved, undefined);
    t.assert.equal(saved?.model, "llava", "the model is stored trimmed");
    t.assert.equal(saved?.provider, "openai-compatible", "the app's vocabulary is mapped to the engine's at the boundary");
    t.assert.equal(saved?.baseUrl, VISION_ENDPOINT);
    t.assert.equal(saved?.contextWindow, 8192);
    t.assert.equal(engine.settings.vision, true, "enabled:true switches vision on");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ABlankVisionModelIsAbsent extends ConnectionRuleTest {
  readonly id = "a-vision-block-whose-model-is-blank-counts-as-absent";
  readonly whyItExists =
    "a profile whose vision model field was cleared to spaces sent a block with a blank model, which was stored and then failed every image with 'model not found' instead of being treated as no model";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send({ type: "set_connection", connection: this.connection({ vision: this.vision() }) });
    t.assert.equal(engine.settings.visionConnection?.model, "llava");

    engine.send({ type: "set_connection", connection: this.connection({ vision: this.vision({ model: " " }) }) });
    t.assert.equal("visionConnection" in engine.settings, false, "a blank model is no model: the block is treated as absent and the saved one is cleared");
    t.assert.equal(engine.settings.vision, false);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ADisabledVisionBlockIsStoredButOff extends ConnectionRuleTest {
  readonly id = "a-vision-block-with-enabled-false-is-stored-with-the-switch-off";
  readonly whyItExists =
    "the switch and the endpoint are two things: a user who turns vision off must keep the model they chose, or turning it back on means re-running the wizard";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send({ type: "set_connection", connection: this.connection({ vision: this.vision({ enabled: false }) }) });
    t.assert.equal(engine.settings.visionConnection?.model, "llava", "the endpoint is kept");
    t.assert.equal(engine.settings.vision, false, "but the switch is off");

    // Turning it on later is a set_vision, and it succeeds because the endpoint is there.
    engine.send({ type: "set_vision", enabled: true });
    t.assert.equal(engine.settings.vision, true);
    const refused = engine.events.filter((e) => e.type === "error" && e.message.includes("Vision cannot be switched on"));
    t.assert.deepEqual(refused, [], "with an endpoint stored the switch is not refused");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class BaseUrlFollowsTheSameRule extends ConnectionRuleTest {
  readonly id = "a-connection-without-a-base-url-clears-the-saved-base-url-the-same-way";
  readonly whyItExists =
    "this is the rule the vision block was modelled on; if baseUrl ever stopped clearing, a hosted connection that omits it would keep pointing at the previous local server";

  override async run(t: TestRun): Promise<void> {
    const engine = await this.engine();
    engine.send({ type: "set_connection", connection: this.connection({ baseUrl: `${ENDPOINT}/` }) });
    t.assert.equal(engine.settings.baseUrl, ENDPOINT, "a base URL is saved, with its trailing slash stripped");

    const { baseUrl: _omitted, ...withoutBaseUrl } = this.connection();
    engine.send({ type: "set_connection", connection: withoutBaseUrl });
    t.assert.equal("baseUrl" in engine.settings, false, "no baseUrl in the frame means the saved one is deleted, not kept");

    // The two rules move together: absent baseUrl AND absent vision, both cleared in one frame.
    engine.send({ type: "set_connection", connection: this.connection({ vision: this.vision() }) });
    t.assert.equal(engine.settings.baseUrl, ENDPOINT);
    t.assert.equal(engine.settings.visionConnection?.model, "llava");
    engine.send({ type: "set_connection", connection: withoutBaseUrl });
    t.assert.equal("baseUrl" in engine.settings, false);
    t.assert.equal("visionConnection" in engine.settings, false);
    t.assert.equal(engine.settings.vision, false);
  }
}

registerFeatureTests(new AnAbsentVisionBlockClears(), new APresentVisionBlockIsStored(), new ABlankVisionModelIsAbsent(), new ADisabledVisionBlockIsStoredButOff(), new BaseUrlFollowsTheSameRule());
