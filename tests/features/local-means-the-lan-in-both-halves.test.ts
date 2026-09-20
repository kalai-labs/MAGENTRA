/**
 * `local-means-the-lan-in-both-halves`.
 *
 * "May this connection run without an API key?" is answered twice — once in the
 * app, once in the engine — because the app cannot import the engine. When the
 * engine's copy only knew loopback, a keyless LAN endpoint the app accepted
 * made the engine refuse to boot with "No API key found": the two halves
 * disagreed, and the disagreement was invisible to `tsc`, which cannot compare
 * two functions in two languages in two build units.
 *
 * So the load-bearing test here is PARITY. Asserting each copy against a list
 * only proves each copy matches the list; running BOTH over the same hosts and
 * comparing the answers is what catches one of them drifting, which is the
 * failure that actually happened. BIG-PICTURE §16 calls this a mirrored pair,
 * and the inventory carries a record for it.
 *
 * THREE KINDS, because the feature is the agreement of three things:
 *   `pure` — the two predicates, over the same hosts;
 *   `fs`   — the engine really boots keyless for a LAN address
 *            (`bootstrapEngine` reads `.env` and the settings layers, so it is
 *            filesystem work, not a pure call);
 *   `ui`   — the app really starts an engine for such a workspace, which is
 *            `hasCredentials()` in `app/main.js`, unreachable without Electron.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { isLocalBaseUrl as engineIsLocal } from "@magentra/core";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "local-means-the-lan-in-both-halves";

/** Verbatim from the record. */
const INVARIANT =
  "The app and the engine agree on whether a keyless connection is complete: both cover loopback, .local, the private ranges and host.docker.internal.";

const requireFromHere = createRequire(import.meta.url);

/** The app's copy. CJS, and it loads in plain Node — it touches no Electron API at import. */
function appIsLocal(url: string): boolean {
  const config = requireFromHere(join(repoRoot(), "app", "main", "config.js")) as { isLocalBaseUrl(u: string): boolean };
  return config.isLocalBaseUrl(url);
}

/** Checklist 1 — every one of these may run without a key. */
const LOCAL = [
  "http://localhost:11434/v1",
  "http://127.0.0.1:1234",
  "http://192.168.1.20:1234/v1",
  "http://10.0.0.5/v1",
  "http://172.16.0.9/v1",
  "http://172.31.255.1/v1",
  "http://gpu-box.local:8080/v1",
  "http://host.docker.internal:11434/v1",
  "http://[::1]:8000",
  "http://0.0.0.0:8000",
];

/** Checklist 2 — none of these may. The 172 pair brackets the private range. */
const NOT_LOCAL = [
  "https://api.example.com/v1",
  "http://172.32.0.1/v1",
  "http://172.15.0.1/v1",
  "http://11.0.0.1",
  "http://mylocalhost.com",
];

/** Checklist 4 — the parity list. Deliberately wider than either list above, and it includes the edges. */
const PARITY_HOSTS = [
  ...LOCAL,
  ...NOT_LOCAL,
  "not a url",
  "",
  "http://LOCALHOST:1234",
  "http://api.localhost/v1",
  "http://box.LOCAL:8080",
  "http://127.1/v1",
  "http://127.255.255.255",
  "http://10.255.255.255",
  "http://192.168.0.0",
  "http://192.1680.1.1",
  "http://172.16.0.0",
  "http://172.31.0.0",
  "http://172.16.0.1:8000/openai/v1",
  "https://localhost:8443/v1",
  "http://[::2]:8000",
  "http://0.0.0.1:8000",
  "http://host.docker.internal.example.com/v1",
  "http://10.example.com/v1",
  "ftp://localhost/v1",
  "http://192.168.1.20",
];

/* ---- checklist 1, 2, 3 — pure ----------------------------------------- */

class BothHalvesKnowTheLan extends PureTest {
  readonly featureId = FEATURE;
  readonly id = "both-halves-know-the-lan-and-the-internet";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the engine's copy knew only loopback, so a keyless endpoint on the LAN was accepted by the app and then refused to boot with 'No API key found'";

  override run(t: TestRun): void {
    for (const url of LOCAL) {
      t.assert.equal(appIsLocal(url), true, `the app must treat ${url} as local`);
      t.assert.equal(engineIsLocal(url), true, `the engine must treat ${url} as local`);
    }
    for (const url of NOT_LOCAL) {
      t.assert.equal(appIsLocal(url), false, `the app must not treat ${url} as local`);
      t.assert.equal(engineIsLocal(url), false, `the engine must not treat ${url} as local`);
    }
    // Checklist 3: an unparseable address is not local, and is not a crash —
    // this is called on whatever the user typed.
    t.assert.equal(appIsLocal("not a url"), false);
    t.assert.equal(engineIsLocal("not a url"), false);
  }
}

/* ---- checklist 4 — the assertion the prose says is missing -------------- */

class TheTwoCopiesNeverDisagree extends PureTest {
  readonly featureId = FEATURE;
  readonly id = "the-two-copies-never-disagree";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "two copies of one rule in two build units cannot be compared by tsc, so the only thing that catches one of them drifting is running both over the same hosts";

  override run(t: TestRun): void {
    const disagreements: string[] = [];
    for (const url of PARITY_HOSTS) {
      const app = appIsLocal(url);
      const engine = engineIsLocal(url);
      if (app !== engine) disagreements.push(`${JSON.stringify(url)}: app=${app} engine=${engine}`);
    }
    t.assert.deepEqual(
      disagreements,
      [],
      `the app and the engine disagree about ${disagreements.length} of ${PARITY_HOSTS.length} hosts — ` +
        `one of app/main/config.js or engine/core/src/config/providerFactory.ts has drifted`,
    );
    // A parity check over a list both sides answer the same way by accident
    // (all true, or all false) would pass while proving nothing.
    const trues = PARITY_HOSTS.filter((u) => engineIsLocal(u)).length;
    t.assert.ok(trues > 5 && trues < PARITY_HOSTS.length - 5, `the parity list must exercise both answers, got ${trues} of ${PARITY_HOSTS.length} local`);
  }
}

/* ---- checklist 5, engine half — fs ------------------------------------- */

class AKeylessLanEndpointBoots extends FsTest {
  readonly featureId = FEATURE;
  readonly id = "a-keyless-lan-endpoint-boots-the-engine";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the engine threw MissingApiKeyError for a LAN endpoint that needs no key, so a workspace the app had just configured could not start";

  /** Loading addons, the registry and the MCP layer is slower than a pure call. */
  override readonly timeoutMs: number = 60_000;

  override async run(t: TestRun): Promise<void> {
    const { bootstrapEngine, MissingApiKeyError } = await import("@magentra/host");

    // No key anywhere: the developer's own exported key would make this vacuous.
    for (const name of ["MAGENTRA_API_KEY", "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"]) {
      this.setEnv(name, undefined);
    }
    this.redirectHome();

    const lan = this.tempDir("magentra-lan-");
    this.writeJson(join(lan, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: "http://192.168.1.20:1234/v1",
      model: "some-local-model",
    });

    const booted = await bootstrapEngine({ cwd: lan });
    t.assert.equal(typeof booted.engine, "object", "a LAN endpoint needs no key, so the engine must boot");

    // The control: the same settings with a HOSTED endpoint and no key must
    // still refuse, or the test above would pass for the wrong reason.
    const hosted = this.tempDir("magentra-hosted-");
    this.writeJson(join(hosted, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "some-hosted-model",
    });
    await t.assert.rejects(
      () => bootstrapEngine({ cwd: hosted }),
      (err: unknown) => err instanceof MissingApiKeyError,
      "a hosted endpoint with no key must still be refused",
    );
  }
}

/* ---- checklist 5, app half — ui ---------------------------------------- */

class TheAppStartsAKeylessLanWorkspace extends UiTest {
  readonly featureId = FEATURE;
  readonly id = "the-app-starts-an-engine-for-a-keyless-lan-workspace";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "hasCredentials() knowing only loopback meant a workspace pointed at a model box on the LAN showed the setup wizard instead of starting, with nothing left to configure";

  override async run(t: TestRun): Promise<void> {
    const built = join(repoRoot(), "engine", "host", "dist", "index.js");
    t.assert.equal(existsSync(built), true, "the app spawns the built engine — run `npm run build`");

    const home = this.removeAfterApp(this.makeTempDir("magentra-home-"));
    const workspace = this.makeTempDir("magentra-lanws-");
    // A LAN address, keyless — the exact shape that used to be refused.
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: "http://192.168.1.20:1234/v1",
      model: "some-local-model",
    });

    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);

    // The app's own log says whether it decided there was enough to start.
    const pid = await waitForSpawn(workspace);
    t.assert.equal(typeof pid, "number", "the app must consider a keyless LAN workspace configured and start its engine");
  }
}

registerFeatureTests(
  new BothHalvesKnowTheLan(),
  new TheTwoCopiesNeverDisagree(),
  new AKeylessLanEndpointBoots(),
  new TheAppStartsAKeylessLanWorkspace(),
);
