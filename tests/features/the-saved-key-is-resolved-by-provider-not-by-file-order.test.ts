/**
 * `the-saved-key-is-resolved-by-provider-not-by-file-order`.
 *
 * A workspace switched between providers keeps both key lines in its `.env`.
 * Taking the first `*_API_KEY` line meant the other provider's key was sent to
 * this provider's URL — and the endpoint's refusal was reported as "key
 * rejected", about a key that was never the one the user had configured.
 *
 * So the question is asked by PROVIDER, in the engine's own order: the
 * `apiKeyEnv` pin, then the provider's standard names, across the merged
 * global+project settings.
 *
 * THREE KINDS, because "which key was sent" is only answerable at the far end
 * of a socket. `fs` covers the `.env` reader; `net` + `ui` drive the real app's
 * TEST button at a local server and read the `Authorization` header it
 * actually received. Asserting the app's return value instead would prove only
 * that it said it succeeded.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { openWorkspace } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { startLocalServer, type LocalServer } from "../lib/localServer.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "the-saved-key-is-resolved-by-provider-not-by-file-order";

/** Verbatim from the record. */
const INVARIANT =
  "hasCredentials resolves the saved key by PROVIDER in the engine's own order, across both settings layers, never by first matching line in .env.";

const requireFromHere = createRequire(import.meta.url);

interface ConnectionModule {
  readWorkspaceEnvKeys(workspace: string): Record<string, string>;
}

function connection(): ConnectionModule {
  return requireFromHere(join(repoRoot(), "app", "main", "connection.js")) as ConnectionModule;
}

/* ---- checklist 5 — the .env reader — fs -------------------------------- */

class TheEnvReaderTakesOnlyKeys extends FsTest {
  readonly featureId = FEATURE;
  readonly id = "only-api-key-lines-are-read-and-blank-ones-do-not-count";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "a .env holds more than keys, and a blank or quoted value taken literally becomes an Authorization header of empty string or one with quotes in it";

  override run(t: TestRun): void {
    const workspace = this.tempDir("magentra-env-");
    this.writeFile(
      join(workspace, ".env"),
      [
        "# a comment",
        "ANTHROPIC_API_KEY=anthropic-key",
        "MAGENTRA_API_KEY=magentra-key",
        'OPENAI_API_KEY="quoted-key"',
        "DEEPINFRA_API_KEY=",
        "BASE_URL=http://example.test/v1",
        "NOT_A_KEY=nope",
        "MY_PIN_API_KEY=pinned-key",
        "",
      ].join("\n"),
    );

    const keys = connection().readWorkspaceEnvKeys(workspace);

    t.assert.equal(keys["ANTHROPIC_API_KEY"], "anthropic-key");
    t.assert.equal(keys["MAGENTRA_API_KEY"], "magentra-key");
    t.assert.equal(keys["OPENAI_API_KEY"], "quoted-key", "a quoted value must arrive unquoted, or the quotes travel in the header");
    t.assert.equal(keys["MY_PIN_API_KEY"], "pinned-key", "a user's own *_API_KEY name is a key line too");
    t.assert.equal(keys["BASE_URL"], undefined, "a .env holds more than keys; only key names are read");
    t.assert.equal(keys["NOT_A_KEY"], undefined);
    t.assert.equal((keys["DEEPINFRA_API_KEY"] ?? "").trim(), "", "a blank value is not a key");

    // An absent .env is an empty answer, not a crash — every workspace starts that way.
    t.assert.deepEqual(connection().readWorkspaceEnvKeys(this.tempDir("magentra-empty-")), {});
  }
}

/* ---- checklist 1 and 4 — which key actually goes out — net + ui -------- */

/** Shared staging for the two socket-level tests. */
interface Staged {
  readonly workspace: string;
  readonly home: string;
}

class TheProviderDecidesWhichKeyIsSent extends UiTest {
  readonly featureId = FEATURE;
  readonly id = "the-provider-decides-which-saved-key-is-sent";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "a workspace that had used both providers kept both key lines, and the first one in the file was sent to the other provider's URL and reported as rejected";

  #server: LocalServer | undefined;

  override async tearDown(): Promise<void> {
    await this.#server?.close();
    this.#server = undefined;
  }

  /** A local endpoint that answers a catalog and records every request. */
  async #listen(): Promise<LocalServer> {
    const server = await startLocalServer(() => ({ json: { data: [{ id: "served-model" }] } }));
    this.#server = server;
    return server;
  }

  #stage(provider: "openai-compatible" | "anthropic", pin?: string): Staged {
    const home = this.makeTempDir("magentra-home-");
    const workspace = this.makeTempDir("magentra-ws-");
    // BOTH providers' keys, with the other provider's FIRST — the shape that
    // made file order decide.
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider,
      baseUrl: "http://127.0.0.1:1/v1",
      model: "model-one",
      ...(pin ? { apiKeyEnv: pin } : {}),
    });
    const lines = ["ANTHROPIC_API_KEY=anthropic-key", "MAGENTRA_API_KEY=magentra-key"];
    if (pin) lines.push(`${pin}=pinned-key`);
    this.writeJsonFile(join(workspace, "___placeholder.json"), {});
    const { writeFileSync } = requireFromHere("node:fs") as typeof import("node:fs");
    writeFileSync(join(workspace, ".env"), `${lines.join("\n")}\n`, "utf8");
    return { workspace, home };
  }

  /** The key the app actually put on the wire for a TEST of `provider`. */
  async #keySentFor(provider: "openai-compatible" | "anthropic", pin?: string): Promise<string> {
    const server = await this.#listen();
    const staged = this.#stage(provider, pin);
    const app = await this.launchApp({ HOME: staged.home, USERPROFILE: staged.home });
    await openWorkspace(app, staged.workspace);
    await app.evaluate(
      `window.magentra.testConnection({ useSavedKey: true, provider: "openai-compat", baseUrl: ${JSON.stringify(`${server.url}/v1`)}, model: "model-one", apiKey: "" })`,
    );
    const seen = await server.received((r) => r.url.includes("/models"));
    await server.close();
    this.#server = undefined;
    return (seen.headers["authorization"] ?? "").replace(/^Bearer\s*/i, "");
  }

  override async run(t: TestRun): Promise<void> {
    // An openai-compatible workspace must send the openai-compatible key, even
    // though the anthropic line comes first in the file.
    t.assert.equal(
      await this.#keySentFor("openai-compatible"),
      "magentra-key",
      "the key for the provider being tested must be the one sent, not the first line in .env",
    );

    // A pin names the variable to use, and it wins over the standard names.
    t.assert.equal(
      await this.#keySentFor("openai-compatible", "MY_PIN_API_KEY"),
      "pinned-key",
      "an apiKeyEnv pin is what the engine tries first, so TEST must match it",
    );
  }
}

/* ---- checklist 2 and 3 — whether the engine may boot at all — ui ------- */

class CredentialsAreJudgedByProvider extends UiTest {
  readonly featureId = FEATURE;
  readonly id = "the-other-providers-key-does-not-count-as-configured";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "a workspace holding only the other provider's key looked configured, so the engine was started and died on the first turn instead of the wizard being shown";

  override async run(t: TestRun): Promise<void> {
    // A hosted openai-compatible endpoint, with ONLY the anthropic key saved.
    const home = this.makeTempDir("magentra-home-");
    const workspace = this.makeTempDir("magentra-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      model: "model-one",
    });
    const { writeFileSync } = requireFromHere("node:fs") as typeof import("node:fs");
    writeFileSync(join(workspace, ".env"), "ANTHROPIC_API_KEY=anthropic-key\n", "utf8");

    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    // Give the app the time it would have needed to spawn, then assert it did not.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const { logLines } = await import("../lib/appDriver.ts");
    const spawns = logLines(workspace).filter((l) => l.data?.["ev"] === "spawn");
    t.assert.deepEqual(spawns, [], "an openai-compatible endpoint holding only the anthropic key is not configured");

    // The merged view is what decides: a provider set GLOBALLY, with the matching
    // key in the workspace, is configured — and does start.
    const home2 = this.makeTempDir("magentra-home2-");
    const workspace2 = this.makeTempDir("magentra-ws2-");
    this.writeJsonFile(join(home2, ".magentra", "settings.json"), { provider: "anthropic", model: "claude-x" });
    writeFileSync(join(workspace2, ".env"), "ANTHROPIC_API_KEY=anthropic-key\n", "utf8");

    const app2 = await this.launchApp({ HOME: home2, USERPROFILE: home2 });
    await openWorkspace(app2, workspace2);
    const { waitForSpawn } = await import("../lib/appDriver.ts");
    const pid = await waitForSpawn(workspace2);
    t.assert.equal(typeof pid, "number", "a provider set in the global layer counts — the merged view is what is read");
  }
}

registerFeatureTests(new TheEnvReaderTakesOnlyKeys(), new TheProviderDecidesWhichKeyIsSent(), new CredentialsAreJudgedByProvider());
