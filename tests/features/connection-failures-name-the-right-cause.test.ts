/**
 * `connection-failures-name-the-right-cause`.
 *
 * Gateways authenticate before they route, so a wrong URL and a wrong key both
 * come back 401. Blaming the key alone sent users to re-paste a key that was
 * fine. So TEST's failure messages are the feature: each one has to name the
 * thing that is actually likely wrong, and the walk has to know the difference
 * between "no endpoint answered" and "the endpoint answered and refused you".
 *
 * All of this is reachable by calling `testEndpoint` with a scripted
 * `opts.fetchImpl` — its own comment says that option exists for tests — so
 * these are `pure`: no socket, no file, no process.
 *
 * ONE PART OF CHECKLIST 5 IS NOT HERE. It also asks for
 * `describeTestFailure({status:404})` → "endpoint not found (404) — check the
 * base URL". That function lives in `app/renderer/modules/setup.js`, which this
 * record does not name as an entry file, so freshness does not track it and a
 * test here would assert on code the record does not cover. The renderer is
 * out of scope at this stage by the 2026-09-09 decision (SPEC §2.1); the half
 * that lives in `app/main/connection.js` — the self-signed hint — is below.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "connection-failures-name-the-right-cause";

/** Verbatim from the record. */
const INVARIANT =
  "A 401 says the base URL or the key may be wrong and points at TEST; a 404 says the model id may need qualifying.";

const BASE_URL = "https://api.example.test/v1";

/** What the walk tries under the origin, after the address as given. */
const WORKING_CANDIDATE = "https://api.example.test/openai/v1";

const requireFromHere = createRequire(import.meta.url);

interface TestResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly baseUrl?: string;
  readonly models?: string[];
  readonly error?: string;
}

interface ConnectionModule {
  validateCredentialPayload(payload: unknown): { ok: boolean; error?: string };
  testEndpoint(validated: unknown, defaultBaseUrl: string, opts?: Record<string, unknown>): Promise<TestResult>;
}

function connectionModule(): ConnectionModule {
  return requireFromHere(join(repoRoot(), "app", "main", "connection.js")) as ConnectionModule;
}

/** A network error shaped the way undici shapes one: the real cause hangs off `.cause`. */
function fetchFailure(code: string, address?: string, port?: number): Error {
  const err = new Error("fetch failed");
  (err as { cause?: unknown }).cause = { code, ...(address ? { address } : {}), ...(port ? { port } : {}) };
  return err;
}

/** What an aborted request throws — the shape `describeFetchError` keys off. */
function abortFailure(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

type Reply = { readonly status: number; readonly body?: unknown } | Error;

function network(answer: (url: string) => Reply): (url: string, init: Record<string, unknown>) => Promise<unknown> {
  return async (url: string): Promise<unknown> => {
    const reply = answer(url);
    if (reply instanceof Error) throw reply;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body ?? {} };
  };
}

abstract class FailureMessageTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected async test(fetchImpl: (url: string, init: Record<string, unknown>) => Promise<unknown>): Promise<TestResult> {
    const { validateCredentialPayload, testEndpoint } = connectionModule();
    const validated = validateCredentialPayload({
      apiKey: "sk-a-key-that-is-fine",
      model: "some-model",
      provider: "openai-compat",
      baseUrl: BASE_URL,
      insecureTls: false,
    });
    if (!validated.ok) throw new Error(`the payload this test builds is invalid: ${String(validated.error)}`);
    return testEndpoint(validated, BASE_URL, { fetchImpl, localTimeoutMs: 1_000, hostedTimeoutMs: 1_000 });
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ARefusalNamesTheEndpoint extends FailureMessageTest {
  readonly id = "a-refusal-everywhere-names-the-endpoint-and-the-key";
  readonly whyItExists =
    "a 401 from every candidate was reported as an unreachable address, so the user went to check a URL that was right instead of the key that was not";

  override async run(t: TestRun): Promise<void> {
    const result = await this.test(network(() => ({ status: 401 })));

    t.assert.equal(result.ok, false);
    t.assert.equal(result.status, 401);
    t.assert.equal(result.baseUrl, BASE_URL, "the first endpoint that refused is the one to name");
    t.assert.match(String(result.error), /rejected this API key/);
    t.assert.match(String(result.error), new RegExp(BASE_URL.replace(/\//g, "\\/")), "the message names WHICH endpoint refused");
    t.assert.match(String(result.error), /the URL is right, so check the key/);
    t.assert.match(String(result.error), /HTTP 401/);

    // 403 is the same verdict with its own status.
    const forbidden = await this.test(network(() => ({ status: 403 })));
    t.assert.equal(forbidden.status, 403, "the status reported is the one the endpoint actually sent");
    t.assert.match(String(forbidden.error), /HTTP 403/);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ARememberedRefusalIsNotReported extends FailureMessageTest {
  readonly id = "a-refusal-on-the-way-to-a-working-path-is-not-reported";
  readonly whyItExists =
    "the walk stopped at the first 401, so a gateway that authenticates before routing hid the working path one candidate further down";

  override async run(t: TestRun): Promise<void> {
    const result = await this.test(
      network((url) => (url.startsWith(WORKING_CANDIDATE) ? { status: 200, body: { data: [{ id: "a-model" }] } } : { status: 401 })),
    );

    t.assert.equal(result.ok, true, "a later candidate that works is the answer, whatever the earlier ones said");
    t.assert.equal(result.baseUrl, WORKING_CANDIDATE, "the candidate that WORKED is what the caller persists");
    t.assert.deepEqual(result.models, ["a-model"]);
    t.assert.equal(result.error, undefined, "a remembered auth failure must not be reported when something worked");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ANetworkErrorNamesTheAddress extends FailureMessageTest {
  readonly id = "a-refused-connection-names-the-code-and-address";
  readonly whyItExists =
    "'the server PC is off' and 'wrong port' both arrived as a bare 'fetch failed', which names nothing the user can go and check";

  override async run(t: TestRun): Promise<void> {
    const result = await this.test(network(() => fetchFailure("ECONNREFUSED", "127.0.0.1", 1234)));

    t.assert.equal(result.ok, false);
    t.assert.match(String(result.error), /ECONNREFUSED/);
    t.assert.match(String(result.error), /127\.0\.0\.1/);
    t.assert.match(String(result.error), /1234/);
    t.assert.doesNotMatch(String(result.error), /API key/, "nothing answered, so the key cannot be the complaint");
    t.assert.equal(result.status, undefined);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ATimeoutAsksIfTheServerIsRunning extends FailureMessageTest {
  readonly id = "a-timeout-says-how-long-it-waited";
  readonly whyItExists =
    "an aborted request surfaced as 'This operation was aborted', which reads as a bug in the app rather than as a server that never answered";

  override async run(t: TestRun): Promise<void> {
    const result = await this.test(network(() => abortFailure()));

    t.assert.equal(result.ok, false);
    t.assert.match(String(result.error), /timed out after 1s/, "the message states the budget that was exhausted");
    t.assert.match(String(result.error), /is the server running/);
    t.assert.doesNotMatch(String(result.error), /aborted/, "the internal wording must not reach the user");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ASelfSignedCertificateSaysSo extends FailureMessageTest {
  readonly id = "a-self-signed-certificate-points-at-the-opt-in";
  readonly whyItExists =
    "a home-lab gateway's self-signed certificate failed with a TLS error nobody could act on, while the setting that fixes it was one checkbox away";

  override async run(t: TestRun): Promise<void> {
    const result = await this.test(network(() => fetchFailure("SELF_SIGNED_CERT_IN_CHAIN", "10.0.0.5", 8443)));

    t.assert.equal(result.ok, false);
    t.assert.match(String(result.error), /SELF_SIGNED_CERT_IN_CHAIN/, "the real cause is still named");
    t.assert.match(String(result.error), /Allow self-signed certificate/, "and the message names the setting that fixes it");

    // The hint is for certificate failures only: an ordinary refusal must not
    // suggest turning off certificate verification.
    const ordinary = await this.test(network(() => fetchFailure("ECONNREFUSED", "10.0.0.5", 8443)));
    t.assert.doesNotMatch(String(ordinary.error), /self-signed/, "a refused connection is not a certificate problem");
  }
}

registerFeatureTests(
  new ARefusalNamesTheEndpoint(),
  new ARememberedRefusalIsNotReported(),
  new ANetworkErrorNamesTheAddress(),
  new ATimeoutAsksIfTheServerIsRunning(),
  new ASelfSignedCertificateSaysSo(),
);
