/**
 * `mirror-local-endpoint`.
 *
 * "Is this endpoint on my machine or my network, so it needs no API key?" is
 * answered twice: in the engine (`isLocalBaseUrl`, providerFactory.ts), which
 * decides whether a keyless boot is complete, and in the app (config.js),
 * which decides whether the wizard accepts a keyless connection. The app
 * cannot import the engine, so the rule is written twice, and when the two
 * copies disagreed the app accepted `http://192.168.1.20:1234/v1` without a
 * key and the engine then refused to boot with "No API key found".
 *
 * `pure` + `fs`, and the record said `pure`. Checklist items 1–4 are two
 * predicates over strings. Item 5 is `bootstrapEngine`, which reads `.env` and
 * the two settings layers off disk — filesystem work by the definition
 * `fsTest.ts` gives, and the same judgement `local-means-the-lan-in-both-halves`
 * reached for its own item 5. Re-declared 2026-09-19.
 *
 * `app/main/config.js` loads in plain Node with no stub: its
 * `require("electron")` resolves to the binary path and `isLocalBaseUrl`
 * touches nothing else.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { isLocalBaseUrl as engineIsLocal } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "mirror-local-endpoint";

/** Verbatim from the record. */
const INVARIANT =
  "isLocalBaseUrl decides identically in both halves for loopback, .local, the private ranges and host.docker.internal.";

const requireFromHere = createRequire(import.meta.url);

function appIsLocal(url: string): boolean {
  const config = requireFromHere(join(repoRoot(), "app", "main", "config.js")) as { isLocalBaseUrl(u: string): boolean };
  return config.isLocalBaseUrl(url);
}

/** Checklist 1 — every one of these is local, on both sides. */
const LOCAL = [
  "http://localhost:11434/v1",
  "http://gpu.local/v1",
  "http://127.0.0.1/v1",
  "http://10.0.0.5/v1",
  "http://192.168.1.20:1234/v1",
  "http://172.16.0.1/v1",
  "http://172.31.255.1/v1",
  "http://[::1]:8080/v1",
  "http://0.0.0.0/v1",
  "http://host.docker.internal:1234/v1",
];

/** Checklist 2 — none of these is. The 172 pair brackets the private range; the last is a look-alike. */
const NOT_LOCAL = ["https://api.deepinfra.com/v1/openai", "http://172.32.0.1/v1", "http://172.15.0.1/v1", "http://8.8.8.8/v1", "http://mylocalhost.com"];

/** Checklist 3 — not URLs at all. */
const GARBAGE = ["not a url", ""];

/**
 * Checklist 4 — the parity list: about fifty addresses, mixed on purpose, with
 * the edges of every rule and a few look-alikes that a sloppy copy might match.
 */
const PARITY_HOSTS = [
  ...LOCAL,
  ...NOT_LOCAL,
  ...GARBAGE,
  "http://LOCALHOST:1234",
  "http://api.localhost/v1",
  "http://sub.api.localhost",
  "http://box.LOCAL:8080",
  "http://local/v1",
  "http://notlocal.example/v1",
  "http://127.1/v1",
  "http://127.255.255.255",
  "http://1270.0.0.1",
  "http://10.255.255.255",
  "http://100.10.0.1",
  "http://192.168.0.0",
  "http://192.1680.1.1",
  "http://192.169.0.1",
  "http://172.16.0.0",
  "http://172.31.0.0",
  "http://172.160.0.1",
  "http://172.16.0.1:8000/openai/v1",
  "https://localhost:8443/v1",
  "http://[::2]:8000",
  "http://[::1]",
  "http://[fe80::1]:8000",
  "http://0.0.0.1:8000",
  "http://host.docker.internal",
  "http://host.docker.internal.example.com/v1",
  "http://myhost.docker.internal/v1",
  "http://10.example.com/v1",
  "ftp://localhost/v1",
  "http://192.168.1.20",
  "localhost:11434",
  "//localhost:11434/v1",
  "http://user:pw@localhost:11434/v1",
  "http://localhost.:11434",
  "http://[::ffff:127.0.0.1]:8000",
  "http://api.openai.com/v1",
  "http://ollama.internal:11434/v1",
  "http://lan.home.arpa:1234",
  "http://192.168.1.20:1234/v1/",
  "http://172.31.255.255:1/",
  "http://172.32.255.255",
];

abstract class LocalEndpointTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class EveryLocalAddressIsLocalOnBothSides extends LocalEndpointTest {
  readonly id = "loopback-lan-and-docker-addresses-are-local-on-both-sides";
  readonly whyItExists =
    "the engine's copy knew only loopback, so a LAN endpoint the app had accepted keyless was refused at boot with 'No API key found'";

  override run(t: TestRun): void {
    for (const url of LOCAL) {
      t.assert.equal(engineIsLocal(url), true, `engine must treat ${url} as local`);
      t.assert.equal(appIsLocal(url), true, `app must treat ${url} as local`);
    }
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class NoHostedAddressIsLocal extends LocalEndpointTest {
  readonly id = "hosted-and-out-of-range-addresses-are-not-local-on-either-side";
  readonly whyItExists =
    "a copy that matched '172.' without checking the second octet, or 'localhost' as a substring, would let a keyless hosted connection through to an auth failure";

  override run(t: TestRun): void {
    for (const url of NOT_LOCAL) {
      t.assert.equal(engineIsLocal(url), false, `engine must not treat ${url} as local`);
      t.assert.equal(appIsLocal(url), false, `app must not treat ${url} as local`);
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class GarbageIsNotLocalAndDoesNotThrow extends LocalEndpointTest {
  readonly id = "garbage-input-is-not-local-and-does-not-throw";
  readonly whyItExists =
    "this is called on whatever the user typed into the wizard, and a throw there is a wizard that cannot move past the URL field";

  override run(t: TestRun): void {
    for (const input of GARBAGE) {
      t.assert.doesNotThrow(() => engineIsLocal(input), `engine must not throw on ${JSON.stringify(input)}`);
      t.assert.doesNotThrow(() => appIsLocal(input), `app must not throw on ${JSON.stringify(input)}`);
      t.assert.equal(engineIsLocal(input), false);
      t.assert.equal(appIsLocal(input), false);
    }
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheTwoCopiesAgreeOnEveryAddress extends LocalEndpointTest {
  readonly id = "the-two-copies-agree-on-fifty-mixed-addresses";
  readonly whyItExists =
    "two copies of one rule in two languages cannot be compared by tsc; running both over the same addresses is the only thing that catches one of them drifting";

  override run(t: TestRun): void {
    t.assert.ok(PARITY_HOSTS.length >= 50, `the parity list must be about fifty addresses, it is ${PARITY_HOSTS.length}`);
    const disagreements: string[] = [];
    for (const url of PARITY_HOSTS) {
      const engine = engineIsLocal(url);
      const app = appIsLocal(url);
      if (engine !== app) disagreements.push(`${JSON.stringify(url)}: engine=${engine} app=${app}`);
    }
    t.assert.deepEqual(disagreements, [], `engine/core/src/config/providerFactory.ts and app/main/config.js disagree on ${disagreements.length} address(es)`);
    // Agreement over a list both sides answer the same way by accident (all
    // true or all false) proves nothing — both answers must be represented.
    const locals = PARITY_HOSTS.filter((u) => engineIsLocal(u)).length;
    t.assert.ok(locals >= 10 && locals <= PARITY_HOSTS.length - 10, `the list must exercise both answers, got ${locals} local of ${PARITY_HOSTS.length}`);
  }
}

/* ---- checklist 5 — fs ------------------------------------------------ */

class TheEngineBootsKeylessOnTheLan extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "bootstrapengine-boots-a-keyless-lan-endpoint";
  readonly whyItExists =
    "the engine honouring a narrower rule than the app is exactly the failure in the record's prose: the app wrote the connection and the engine threw MissingApiKeyError on it";

  /** Assembling the registry, the MCP layer and the addons is slower than a pure call. */
  override readonly timeoutMs: number = 60_000;

  override async run(t: TestRun): Promise<void> {
    const { bootstrapEngine, MissingApiKeyError } = await import("@magentra/host");

    // No key anywhere — the developer's own exported key would make this vacuous.
    for (const name of ["MAGENTRA_API_KEY", "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"]) this.setEnv(name, undefined);
    this.redirectHome();

    const lan = this.tempDir("magentra-lan-");
    this.writeJson(join(lan, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: "http://192.168.1.20:1234/v1",
      model: "a-local-model",
      contextWindow: 32000,
    });
    const booted = await bootstrapEngine({ cwd: lan });
    t.assert.equal(typeof booted.engine, "object", "a keyless LAN endpoint must boot");
    // The rule the app applies is the rule the engine applied: both say local.
    t.assert.equal(appIsLocal("http://192.168.1.20:1234/v1"), true);

    // Control: the same settings against a hosted endpoint must still refuse,
    // or the boot above passed for a reason that has nothing to do with the rule.
    const hosted = this.tempDir("magentra-hosted-");
    this.writeJson(join(hosted, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "a-hosted-model",
      contextWindow: 32000,
    });
    await t.assert.rejects(
      () => bootstrapEngine({ cwd: hosted }),
      (err: unknown) => err instanceof MissingApiKeyError,
      "a hosted endpoint with no key must be refused",
    );
  }
}

registerFeatureTests(
  new EveryLocalAddressIsLocalOnBothSides(),
  new NoHostedAddressIsLocal(),
  new GarbageIsNotLocalAndDoesNotThrow(),
  new TheTwoCopiesAgreeOnEveryAddress(),
  new TheEngineBootsKeylessOnTheLan(),
);
