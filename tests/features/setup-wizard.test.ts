/**
 * `setup-wizard`.
 *
 * Without a guided, validated first run, users hand-edit `.env` files and the
 * engine dies with "No API key found" or a wrong-URL 401. So the wizard tests
 * the endpoint before saving, saves the connection as a profile, applies it to
 * the workspace, and — the part that matters most — REFUSES an invalid payload
 * in the main process, before anything is written.
 *
 * THREE KINDS. Validation is a function of its input (`pure`). Testing an
 * endpoint and getting the working URL back is only observable at the far end
 * of a socket (`net`). Saving and applying is main-process work reached through
 * the real IPC (`ui`).
 *
 * The record declared `net` and `ui`; `pure` was added on 2026-09-11 because
 * checklist items 1 and 2 are a validator called with bad input, and spending a
 * socket or a window on them would buy nothing.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { connectionModule, validatedFor } from "../lib/appConnection.ts";
import { applyProfile, logLines, openWorkspace, saveProfile } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { startLocalServer, type LocalServer } from "../lib/localServer.ts";
import { NetTest } from "../lib/netTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "setup-wizard";

/** Verbatim from the record. */
const INVARIANT = "The setup wizard tests, saves and applies a connection, and refuses to save an invalid one.";

/* ---- checklist 1 and 2 — pure ------------------------------------------ */

class InvalidConnectionsAreRefused extends PureTest {
  readonly featureId = FEATURE;
  readonly id = "an-invalid-connection-is-refused-before-anything-is-written";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "a payload that reaches disk before it is judged leaves a workspace half-configured, and the engine then fails with a message about the wrong thing";

  override run(t: TestRun): void {
    const { validateCredentialPayload } = connectionModule();
    const base = { model: "m", provider: "openai-compat", baseUrl: "https://api.example.test/v1" };

    const refused: [string, Record<string, unknown>][] = [
      ["a key that is not a string", { ...base, apiKey: 123 }],
      ["a key with a newline in it", { ...base, apiKey: "sk-one\ntwo" }],
      ["anthropic with no key", { model: "m", provider: "anthropic", apiKey: "" }],
      ["no key and no base URL", { model: "m", provider: "openai-compat", apiKey: "" }],
      ["a base URL that is not http", { ...base, apiKey: "sk-x", baseUrl: "ftp://example.test/v1" }],
      ["a context window that is too small", { ...base, apiKey: "sk-x", contextWindow: 100 }],
      ["a reasoning effort nobody offers", { ...base, apiKey: "sk-x", reasoningEffort: "turbo" }],
    ];
    for (const [what, payload] of refused) {
      const result = validateCredentialPayload(payload);
      t.assert.equal(result.ok, false, `${what} must be refused`);
      t.assert.equal(typeof result.error, "string", `${what} must be refused with a reason`);
    }

    // A pasted key routinely arrives with a trailing newline, and a pasted URL
    // is usually the one the user's curl posts to.
    const trimmed = validateCredentialPayload({ ...base, apiKey: "sk-pasted\n" }) as { ok: boolean; apiKey?: string };
    t.assert.equal(trimmed.ok, true);
    t.assert.equal(trimmed.apiKey, "sk-pasted", "a trailing newline must not travel into the header");

    const normalized = validateCredentialPayload({
      model: "m",
      provider: "openai-compat",
      apiKey: "sk-x",
      baseUrl: "http://h.example.test:1234/v1/chat/completions",
    }) as { ok: boolean; baseUrl?: string };
    t.assert.equal(normalized.ok, true);
    t.assert.equal(normalized.baseUrl, "http://h.example.test:1234/v1", "the URL a user pastes is normalized to the base");

    // Checklist 2: a keyless LAN endpoint is a complete connection.
    const lan = validateCredentialPayload({ model: "m", provider: "openai-compat", apiKey: "", baseUrl: "http://192.168.1.20:1234/v1" });
    t.assert.equal(lan.ok, true, "a LAN endpoint needs no key, so an empty one must validate");
  }
}

/* ---- the real fetch, over a real socket — net -------------------------- */

class TheRealFetchPathWorks extends NetTest {
  readonly featureId = FEATURE;
  readonly id = "test-reaches-a-real-endpoint-with-the-real-fetch";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "every other test of this walk injects `opts.fetchImpl`, so nothing proved the DEFAULT path — the one the wizard actually uses — sends the key, honours the timeout, or reaches the socket at all";

  override async run(t: TestRun): Promise<void> {
    const server = await this.serve((request) =>
      request.url === "/v1/models" ? { json: { data: [{ id: "real-model" }] } } : { status: 404, text: "no" },
    );

    // No `fetchImpl`: this is the call main makes, through the global fetch.
    const { testEndpoint } = connectionModule();
    const result = await testEndpoint(validatedFor(`${server.url}/v1`), `${server.url}/v1`);

    t.assert.equal(result.ok, true, `the real fetch must reach a real endpoint: ${String(result.error)}`);
    t.assert.deepEqual(result.models, ["real-model"]);
    t.assert.equal(result.baseUrl, `${server.url}/v1`);

    const asked = await server.received((request) => request.url === "/v1/models");
    t.assert.equal(asked.headers["authorization"], "Bearer sk-a-key-that-is-fine", "the key must travel on the real request, not only on the scripted one");

    // And a real endpoint that is not there fails as a network error, naming
    // the cause rather than blaming the key.
    const dead = await testEndpoint(validatedFor("http://127.0.0.1:9/v1"), "http://127.0.0.1:9/v1", { hostedTimeoutMs: 2_000, localTimeoutMs: 2_000 });
    t.assert.equal(dead.ok, false);
    t.assert.doesNotMatch(String(dead.error), /API key/, "nothing answered, so the key cannot be the complaint");
  }
}

/* ---- checklist 3, 4 and 5 — ui (with a real endpoint for 5) ------------ */

abstract class WizardTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #server: LocalServer | undefined;

  override async tearDown(): Promise<void> {
    await this.#server?.close();
    this.#server = undefined;
  }

  /** An endpoint that only serves its catalog under a sub-path, like a real gateway. */
  protected async endpointUnder(path: string): Promise<LocalServer> {
    const server = await startLocalServer((request) =>
      request.url === `${path}/models` ? { json: { data: [{ id: "served-model" }] } } : { status: 404, text: "no" },
    );
    this.#server = server;
    return server;
  }
}

class SavingAndApplyingWritesBothHalves extends WizardTest {
  readonly id = "saving-and-applying-writes-the-key-and-the-settings";
  readonly whyItExists =
    "the key and the endpoint go to two different files for two different reasons — a secret that lands in the shareable settings file is a secret in a git repository";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home-");
    const workspace = this.makeTempDir("magentra-ws-");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);

    // An invalid profile must be refused, and must leave nothing behind.
    const refused = await app.evaluate<{ ok?: boolean; error?: string }>(
      `window.magentra.saveProfile({ name: "bad", provider: "openai-compat", baseUrl: "ftp://nope.test/v1", model: "m", apiKey: "sk-x" })`,
    );
    t.assert.equal(refused.ok, false, "an invalid connection must not be saved");
    t.assert.equal(typeof refused.error, "string", "and must say why");

    const id = await saveProfile(app, {
      name: "good",
      provider: "openai-compat",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "model-two",
      apiKey: "sk-secret-value",
      contextWindow: 32768,
    });
    const applied = await applyProfile(app, id);
    t.assert.equal(applied.ok, true, `applying must succeed: ${String(applied.error)}`);

    // The key goes to .env, and nowhere else.
    const env = readFileSync(join(workspace, ".env"), "utf8");
    t.assert.match(env, /MAGENTRA_API_KEY=sk-secret-value/, "the key belongs in .env, which is not shared");
    if (process.platform !== "win32") {
      t.assert.equal(statSync(join(workspace, ".env")).mode & 0o777, 0o600, "a file holding a key is readable by its owner only");
    }

    // The endpoint goes to settings.json, and the key does not.
    const settings = JSON.parse(readFileSync(join(workspace, ".magentra", "settings.json"), "utf8")) as Record<string, unknown>;
    t.assert.equal(settings["provider"], "openai-compatible");
    t.assert.equal(settings["model"], "model-two");
    t.assert.equal(settings["contextWindow"], 32768);
    t.assert.equal(JSON.stringify(settings).includes("sk-secret-value"), false, "the key must never reach the shareable settings file");
  }
}

class AWorkspaceWithNoKeyAsksForOne extends WizardTest {
  readonly id = "a-workspace-with-no-usable-key-opens-the-wizard";
  readonly whyItExists =
    "starting an engine that cannot authenticate spends the user's first minute on an error, when what they needed was the form that fixes it";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home2-");
    const workspace = this.makeTempDir("magentra-ws2-");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });

    // The renderer is told to open the wizard; that message is the observable.
    await app.evaluate(`window.__setup = []; window.magentra.onEvent(() => {}); true`);
    await app.evaluateInMain(`
      globalThis.__setupRequired = [];
      const { ipcMain } = require("electron");
      win.webContents.on("ipc-message", () => {});
      const realSend = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel, ...rest) => { globalThis.__setupRequired.push(channel); return realSend(channel, ...rest); };
      return true;
    `);

    await openWorkspace(app, workspace);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const channels = await app.evaluateInMain<string[]>("return globalThis.__setupRequired;");
    t.assert.ok(channels.includes("setup:required"), `the wizard must be asked for; the renderer was sent ${JSON.stringify(channels)}`);

    // And nothing was started that could only fail.
    t.assert.deepEqual(
      logLines(workspace).filter((l) => l.data?.["ev"] === "spawn"),
      [],
      "an engine with no key must not be spawned just to fail",
    );
  }
}

class TestReturnsTheUrlThatWorked extends WizardTest {
  readonly id = "test-hands-back-the-url-that-actually-answered";
  readonly whyItExists =
    "the wizard saves what TEST returns; echoing the typed URL back saved an address that had just been proved not to work";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home3-");
    const workspace = this.makeTempDir("magentra-ws3-");
    const server = await this.endpointUnder("/openai/v1");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);

    // The user types the bare host; only /openai/v1 actually serves the API.
    const result = await app.evaluate<{ ok?: boolean; baseUrl?: string; models?: string[] }>(
      `window.magentra.testConnection({ provider: "openai-compat", baseUrl: ${JSON.stringify(server.url)}, model: "served-model", apiKey: "sk-x" })`,
    );

    t.assert.equal(result.ok, true, "the endpoint answers under a known path, so TEST must find it");
    t.assert.equal(result.baseUrl, `${server.url}/openai/v1`, "TEST must hand back the URL that answered, which is what gets saved");
    t.assert.deepEqual(result.models, ["served-model"]);

    // The walk really happened at the socket: the typed address was tried first.
    const asked = server.requests.map((r) => r.url);
    t.assert.equal(asked[0], "/models", "the address as typed is tried before any rescue");
    t.assert.ok(asked.includes("/openai/v1/models"), `the working shape must have been reached; asked ${JSON.stringify(asked)}`);
  }
}

registerFeatureTests(
  new InvalidConnectionsAreRefused(),
  new TheRealFetchPathWorks(),
  new SavingAndApplyingWritesBothHalves(),
  new AWorkspaceWithNoKeyAsksForOne(),
  new TestReturnsTheUrlThatWorked(),
);
