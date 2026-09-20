/**
 * `bootstrap`.
 *
 * `bootstrapEngine` is the ONE boot path: `.env` for the key, the two settings
 * layers, key and endpoint resolution, the tool registry with any MCP tools,
 * the addons — then an Engine, or a `MissingApiKeyError` for the caller to
 * report in-band. Without it the stdio host, tests and embedders would each
 * assemble the engine differently, and a missing key would kill the process
 * with nothing the desktop app could show.
 *
 * `fs`, and the record said `pure`: boot READS — `.env`, the workspace's
 * `.magentra/settings.json`, the addons directory — and the checklist is
 * written in terms of those files. Re-declared 2026-09-19.
 *
 * Every test clears the four key variables first and redirects HOME, so the
 * developer's own connection cannot make a "no key" case pass or fail for its
 * own reasons; the kind puts the environment back afterwards.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Engine } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "bootstrap";

/** Verbatim from the record. */
const INVARIANT = "The engine boots from the workspace: the key in .env, everything else in .magentra/settings.json.";

const KEY_VARS = ["MAGENTRA_API_KEY", "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"] as const;
const HOSTED = "https://api.example.com/v1";

abstract class BootstrapTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Assembling the registry, the MCP layer and the addons is slower than a pure call. */
  override readonly timeoutMs: number = 60_000;

  #engines: Engine[] = [];

  override async tearDown(): Promise<void> {
    for (const engine of this.#engines) {
      engine.stopBackgroundJobs();
      engine.events.close();
    }
    this.#engines = [];
  }

  /** A clean slate: no key in the environment, a home of our own. */
  protected isolate(): void {
    for (const name of KEY_VARS) this.setEnv(name, undefined);
    this.redirectHome();
  }

  /** A workspace with the given settings and, optionally, a `.env`. */
  protected workspace(settings: Record<string, unknown>, dotEnv?: string): string {
    const dir = this.tempDir("magentra-boot-");
    this.writeJson(join(dir, ".magentra", "settings.json"), settings);
    if (dotEnv !== undefined) writeFileSync(join(dir, ".env"), dotEnv, "utf8");
    return dir;
  }

  protected async boot(cwd: string) {
    const { bootstrapEngine } = await import("@magentra/host");
    const booted = await bootstrapEngine({ cwd });
    this.#engines.push(booted.engine);
    return booted;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheKeyComesFromDotEnv extends BootstrapTest {
  readonly id = "a-key-in-dot-env-is-loaded-into-the-environment-and-the-engine-boots";
  readonly whyItExists = "the app writes the key to .env and nothing else; a boot path that did not read it refused every workspace the app had just configured";

  override async run(t: TestRun): Promise<void> {
    this.isolate();
    const cwd = this.workspace({ provider: "openai-compatible", baseUrl: HOSTED, model: "m", contextWindow: 32000 }, "MAGENTRA_API_KEY=abc\n");
    const booted = await this.boot(cwd);
    t.assert.equal(typeof booted.engine, "object", "an Engine came back");
    t.assert.equal(process.env["MAGENTRA_API_KEY"], "abc", "the .env value was loaded into the environment");
    t.assert.deepEqual(booted.warnings, [], "a clean boot has no warnings");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AHostedEndpointWithNoKeyIsRefusedInBand extends BootstrapTest {
  readonly id = "no-key-and-a-hosted-endpoint-rejects-with-missingapikeyerror-naming-the-variable-and-nothing-exits";
  readonly whyItExists = "the old boot called process.exit on a missing key, so the app saw a dead child and no message — the user was left inferring the cause from an exit code";

  override async run(t: TestRun): Promise<void> {
    this.isolate();
    const { bootstrapEngine, MissingApiKeyError } = await import("@magentra/host");
    const cwd = this.workspace({ provider: "openai-compatible", baseUrl: HOSTED, model: "m" });
    let caught: unknown;
    try {
      await bootstrapEngine({ cwd });
    } catch (err) {
      caught = err;
    }
    t.assert.ok(caught instanceof MissingApiKeyError, `a MissingApiKeyError, got ${String(caught)}`);
    t.assert.match((caught as Error).message, /No API key found/);
    t.assert.match((caught as Error).message, /MAGENTRA_API_KEY/, "the message names the variable to set");
    t.assert.match((caught as Error).message, new RegExp(cwd.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")), "and the workspace the .env would go in");
    // Still here: the error was thrown, not exited on.
    t.assert.equal(typeof process.pid, "number");

    // An anthropic connection names its own variable.
    const anthropic = this.workspace({ provider: "anthropic", model: "claude" });
    await t.assert.rejects(() => bootstrapEngine({ cwd: anthropic }), (err: unknown) => err instanceof MissingApiKeyError && /ANTHROPIC_API_KEY/.test((err as Error).message));
    // And a pinned apiKeyEnv is the variable named when nothing else is set.
    const pinned = this.workspace({ provider: "openai-compatible", baseUrl: HOSTED, model: "m", apiKeyEnv: "MY_KEY" });
    await t.assert.rejects(() => bootstrapEngine({ cwd: pinned }), (err: unknown) => err instanceof MissingApiKeyError && /MY_KEY/.test((err as Error).message));
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ALocalEndpointNeedsNoKey extends BootstrapTest {
  readonly id = "no-key-and-a-local-endpoint-boots";
  readonly whyItExists = "Ollama and LM Studio take no key, and a boot that demanded one made every local setup impossible";

  override async run(t: TestRun): Promise<void> {
    this.isolate();
    const cwd = this.workspace({ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama", contextWindow: 8192 });
    const booted = await this.boot(cwd);
    t.assert.equal(typeof booted.engine, "object");
    t.assert.equal(process.env["MAGENTRA_API_KEY"], undefined, "and no key appeared from anywhere");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheEnvironmentWinsOverDotEnv extends BootstrapTest {
  readonly id = "a-variable-already-in-the-environment-wins-over-the-dot-env-file";
  readonly whyItExists = "a container that injected the key through its environment had it overwritten by a stale .env, so the wrong key was sent";

  override async run(t: TestRun): Promise<void> {
    this.isolate();
    this.setEnv("MAGENTRA_API_KEY", "env");
    const cwd = this.workspace({ provider: "openai-compatible", baseUrl: HOSTED, model: "m", contextWindow: 32000 }, "MAGENTRA_API_KEY=file\n");
    const booted = await this.boot(cwd);
    t.assert.equal(process.env["MAGENTRA_API_KEY"], "env", "the environment's value survives loading the .env");
    const { resolveApiKeySource } = await import("@magentra/core");
    const source = resolveApiKeySource(booted.engine.currentSession().settings);
    t.assert.equal(source.key, "env", "and it is the key the engine resolved");
    t.assert.equal(source.from, "MAGENTRA_API_KEY");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ADanglingPinIsWarnedAbout extends BootstrapTest {
  readonly id = "a-dangling-apikeyenv-pin-yields-a-settings-warning-and-the-engine-still-boots";
  readonly whyItExists = "a stale apiKeyEnv from a previous provider silently sent resolution past the real key; the boot now says so, and a boot that stopped instead would lock the user out";

  override async run(t: TestRun): Promise<void> {
    this.isolate();
    this.setEnv("MAGENTRA_API_KEY", "real");
    const cwd = this.workspace({ provider: "openai-compatible", baseUrl: HOSTED, model: "m", contextWindow: 32000, apiKeyEnv: "OLD_PROVIDER_KEY" });
    const booted = await this.boot(cwd);
    t.assert.equal(typeof booted.engine, "object", "the engine boots anyway");
    const warning = booted.warnings.find((w) => w.startsWith("[settings]"));
    t.assert.notEqual(warning, undefined, `a [settings] warning, got ${JSON.stringify(booted.warnings)}`);
    t.assert.match(warning ?? "", /OLD_PROVIDER_KEY/, "it names the dangling variable");
    t.assert.match(warning ?? "", /MAGENTRA_API_KEY/, "and where the key in use came from");
  }
}

/* ---- checklist 6 ----------------------------------------------------- */

class EverythingAssemblesAsOne extends BootstrapTest {
  readonly id = "one-boot-assembles-settings-key-provider-registry-and-addons-into-the-session-it-announces";
  readonly whyItExists = "each piece booting on its own was fine and the assembly was wrong: the announced model was the default while the provider ran the configured one, and the addon folder was read from the wrong tier";

  override async run(t: TestRun): Promise<void> {
    this.isolate();
    const cwd = this.workspace(
      { provider: "openai-compatible", baseUrl: HOSTED, model: "configured/model", contextWindow: 64000, reasoningEffort: "high" },
      "MAGENTRA_API_KEY=abc\n",
    );
    mkdirSync(join(cwd, ".magentra", "addons"), { recursive: true });
    writeFileSync(join(cwd, ".magentra", "addons", "local.md"), "---\nname: local\ndescription: a workspace addon\n---\nLocal.\n", "utf8");

    const booted = await this.boot(cwd);
    const events: CoreEvent[] = [];
    const drain = (async () => {
      for await (const event of booted.engine.events) events.push(event);
    })();
    booted.engine.start();
    // Everything start() announces is emitted synchronously into the queue.
    await new Promise((resolve) => setImmediate(resolve));
    booted.engine.events.close();
    await drain;

    const started = events.find((e): e is Extract<CoreEvent, { type: "session_started" }> => e.type === "session_started");
    t.assert.notEqual(started, undefined, "the booted engine announces a session");
    t.assert.equal(started?.cwd, cwd, "on this workspace");
    t.assert.equal(started?.model, "configured/model", "with the model from settings.json");
    t.assert.equal(started?.reasoningEffort, "high", "and its thinking depth");
    t.assert.equal(started?.addons?.some((a) => a.name === "local" && a.builtin === false), true, "the workspace addon is loaded");
    t.assert.equal(started?.addons?.some((a) => a.builtin === true), true, "alongside the built-ins");
    t.assert.equal(events.some((e) => e.type === "error"), false, `a fully configured connection boots without a warning frame: ${JSON.stringify(events.filter((e) => e.type === "error"))}`);

    const session = booted.engine.currentSession();
    t.assert.equal(session.settings.baseUrl, HOSTED, "the session runs on the configured endpoint");
    t.assert.equal(session.settings.contextWindow, 64000);
    const tools = session.toolSchemas().map((s) => s.name);
    for (const name of ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "TaskCreate", "Addon"]) {
      t.assert.ok(tools.includes(name), `the default registry offers ${name}`);
    }
    t.assert.equal(process.env["MAGENTRA_API_KEY"], "abc", "the key .env named is the one in force");
    t.assert.deepEqual(booted.warnings, []);
  }
}

registerFeatureTests(
  new TheKeyComesFromDotEnv(),
  new AHostedEndpointWithNoKeyIsRefusedInBand(),
  new ALocalEndpointNeedsNoKey(),
  new TheEnvironmentWinsOverDotEnv(),
  new ADanglingPinIsWarnedAbout(),
  new EverythingAssemblesAsOne(),
);
