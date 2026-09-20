/**
 * `a-404-on-models-is-disambiguated-not-assumed`.
 *
 * A server with no `/models` catalog and a wrong base URL answer identically:
 * 404. Reading that as "reachable" made TEST report success on a URL that could
 * never chat, and sent the user off to check an API key that was fine. So the
 * chat route is asked directly, with a deliberately invalid POST — the question
 * is whether the ROUTE is there, not whether the request is good:
 *
 *   400 / 422 / 200  the route parsed our nonsense, or liked it — it exists
 *   401 / 403        it exists and refused the key
 *   404 / 405        no such route — this base URL is not the API
 *
 * WHY THIS IS A `pure` TEST AND THE RECORD SAID `proc`. `testEndpoint` takes
 * `opts.fetchImpl`, which its own comment says exists for tests, and it touches
 * no file and no process — so every branch below is reachable by calling it
 * with a scripted fetch. The record was re-declared `pure` on 2026-09-11 for
 * that reason: `proc` would have meant spawning something to reach a function
 * that was already reachable, and a kind is a claim about what proving a
 * feature actually requires.
 *
 * `app/main/connection.js` is CJS and deliberately imports no Electron, "so
 * tests can drive everything directly" — its own words. It is loaded here
 * through `createRequire`, unchanged and unmocked; only the network is scripted.
 *
 * The base URL is HOSTED on purpose. `discoverContextLimit` returns
 * immediately for a non-local address, so the fake fetch sees only the requests
 * these tests are about, rather than the four local-server context probes.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "a-404-on-models-is-disambiguated-not-assumed";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT =
  "A 404 on /models is disambiguated by probing the chat route: 400/422/200 proves it exists, 401/403 proves it refused the key, 404/405 means this is not the API.";

/** Hosted, so the context-limit probes stay out of the way. Nothing is ever dialled. */
const BASE_URL = "https://api.example.test/v1";

/** `candidateBaseUrls` tries the address as given, then these shapes under its origin. */
const API_PATH_SUFFIXES = ["/v1", "/v1/openai", "/inference/v1", "/openai/v1", "/api/v1"];

const requireFromHere = createRequire(import.meta.url);

interface Validated {
  readonly ok: boolean;
  readonly error?: string;
}

interface TestResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly models?: string[];
  readonly baseUrl?: string;
  readonly note?: string;
  readonly error?: string;
}

interface ConnectionModule {
  validateCredentialPayload(payload: unknown): Validated;
  testEndpoint(validated: Validated, defaultBaseUrl: string, opts?: Record<string, unknown>): Promise<TestResult>;
  candidateBaseUrls(baseUrl: string): string[];
}

/** The product module, as the Electron main process loads it. */
function connectionModule(): ConnectionModule {
  return requireFromHere(join(repoRoot(), "app", "main", "connection.js")) as ConnectionModule;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** What a scripted endpoint answers: a status (with an optional JSON body), or a thrown failure. */
type Reply = { readonly status: number; readonly body?: unknown } | Error;

interface FakeNetwork {
  readonly fetchImpl: (url: string, init: Record<string, unknown>) => Promise<unknown>;
  readonly calls: Call[];
  /** Every request to a `/models` route, in order. */
  modelCalls(): Call[];
  /** Every chat-route probe, in order. */
  probes(): Call[];
}

/**
 * A network that answers from a script and records what it was asked.
 *
 * It is the only thing faked in this file, and it asserts nothing — a double
 * that checked its own inputs would be a test of the double.
 */
function fakeNetwork(answer: (url: string, method: string) => Reply): FakeNetwork {
  const calls: Call[] = [];
  return {
    calls,
    modelCalls: () => calls.filter((c) => c.url.endsWith("/models")),
    probes: () => calls.filter((c) => c.url.endsWith("/chat/completions")),
    fetchImpl: async (url: string, init: Record<string, unknown>): Promise<unknown> => {
      const method = typeof init["method"] === "string" ? init["method"] : "GET";
      const headers = (init["headers"] ?? {}) as Record<string, string>;
      calls.push({ url, method, headers: { ...headers }, body: typeof init["body"] === "string" ? init["body"] : undefined });
      const reply = answer(url, method);
      if (reply instanceof Error) throw reply;
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: async () => reply.body ?? {},
      };
    },
  };
}

const isModels = (url: string): boolean => url.endsWith("/models");
const isProbe = (url: string): boolean => url.endsWith("/chat/completions");

abstract class EndpointTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A complete openai-compatible connection, validated by the product's own validator. */
  protected validated(): Validated {
    const { validateCredentialPayload } = connectionModule();
    const validated = validateCredentialPayload({
      apiKey: "sk-a-key-that-is-fine",
      model: "some-model",
      provider: "openai-compat",
      baseUrl: BASE_URL,
      insecureTls: false,
    });
    if (!validated.ok) throw new Error(`the payload this test builds is invalid: ${String(validated.error)}`);
    return validated;
  }

  protected async test(network: FakeNetwork): Promise<TestResult> {
    const { testEndpoint } = connectionModule();
    // Short timeouts: nothing here waits on a real socket, and a hung test is
    // indistinguishable from a suite nobody ran.
    return testEndpoint(this.validated(), BASE_URL, {
      fetchImpl: network.fetchImpl,
      localTimeoutMs: 1_000,
      hostedTimeoutMs: 1_000,
    });
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class CatalogLessServerPasses extends EndpointTest {
  readonly id = "a-catalog-less-server-passes-with-a-note";
  readonly whyItExists =
    "a local server with no /models catalog was reported unreachable, so a connection that would have chatted fine failed the TEST button";

  override async run(t: TestRun): Promise<void> {
    const network = fakeNetwork((url) => (isModels(url) ? { status: 404 } : { status: 400 }));
    const result = await this.test(network);

    t.assert.equal(result.ok, true, "a 400 from the chat route proves the route is there");
    t.assert.deepEqual(result.models, [], "there is no catalog to report");
    t.assert.equal(result.status, 404, "the /models status is reported as it was, even on a pass");
    t.assert.equal(result.baseUrl, BASE_URL, "the candidate that answered is what the caller persists");
    t.assert.match(String(result.note), /no \/models catalog/, "the note must say why the model list is empty");

    // The first candidate answered, so the walk stopped there.
    t.assert.equal(network.modelCalls().length, 1);
    t.assert.equal(network.probes().length, 1);
    t.assert.equal(network.probes()[0]?.url, `${BASE_URL}/chat/completions`);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AnyNonRefusalCountsAsExisting extends EndpointTest {
  readonly id = "any-non-404-chat-answer-counts-as-the-route-existing";
  readonly whyItExists =
    "only 400 was treated as proof of the route, so a server answering 422 or even 200 to the invalid probe was written off as not being the API";

  override async run(t: TestRun): Promise<void> {
    // 422 — a stricter validator rejecting the same nonsense.
    const strict = fakeNetwork((url) => (isModels(url) ? { status: 404 } : { status: 422 }));
    const strictResult = await this.test(strict);
    t.assert.equal(strictResult.ok, true, "422 is the route rejecting our nonsense, which proves it exists");
    t.assert.equal(strictResult.baseUrl, BASE_URL);

    // 200 — a server that was somehow happy with an empty model and no messages.
    const happy = fakeNetwork((url) => (isModels(url) ? { status: 404 } : { status: 200 }));
    const happyResult = await this.test(happy);
    t.assert.equal(happyResult.ok, true, "200 is not a failure to prove a route exists");
    t.assert.match(String(happyResult.note), /no \/models catalog/);

    // 500 — the route is there and broken. Still the route.
    const broken = fakeNetwork((url) => (isModels(url) ? { status: 404 } : { status: 500 }));
    t.assert.equal((await this.test(broken)).ok, true, "every answer except not-found proves the route is there");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class RefusedKeyIsNamedAsTheKey extends EndpointTest {
  readonly id = "a-refused-key-is-named-as-the-key-not-the-url";
  readonly whyItExists =
    "a chat route that answered 401 was indistinguishable from one that was not there, so the user was told to check the base URL when the URL was right and the key was not";

  override async run(t: TestRun): Promise<void> {
    const network = fakeNetwork((url) => (isModels(url) ? { status: 404 } : { status: 401 }));
    const result = await this.test(network);

    t.assert.equal(result.ok, false);
    t.assert.equal(result.status, 401, "the refusal is the status the caller sees");
    t.assert.match(String(result.error), /rejected this API key/, "the error must blame the key");
    t.assert.match(String(result.error), /the URL is right/, "and must say the address was not the problem");
    t.assert.equal(result.baseUrl, BASE_URL, "the endpoint that refused is the first one that did");

    // A 403 is the same verdict — "it exists and refused the key" — and is
    // reported as 401, which is what the code records.
    const forbidden = fakeNetwork((url) => (isModels(url) ? { status: 404 } : { status: 403 }));
    const forbiddenResult = await this.test(forbidden);
    t.assert.equal(forbiddenResult.ok, false);
    t.assert.match(String(forbiddenResult.error), /rejected this API key/);

    // Walking continued past the refusal: a later candidate might have been the
    // real endpoint, so every shape was still tried.
    t.assert.equal(network.modelCalls().length, candidateCount(), "the walk must not stop at the first refusal");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class NoRouteBlamesTheAddress extends EndpointTest {
  readonly id = "no-chat-route-anywhere-blames-the-address-not-the-key";
  readonly whyItExists =
    "a base URL that was not the API at all reported an API-key problem, which is the wrong thing to go and check and the reason this disambiguation exists";

  override async run(t: TestRun): Promise<void> {
    for (const status of [404, 405]) {
      const network = fakeNetwork(() => ({ status }));
      const result = await this.test(network);

      t.assert.equal(result.ok, false);
      t.assert.match(String(result.error), /no OpenAI-compatible API found at that address/);
      t.assert.doesNotMatch(String(result.error), /API key/, `a ${status} everywhere is not the key's fault`);
      t.assert.equal(result.status, undefined, "there is no endpoint to report a status for");

      // The error names what was tried, so the user can compare it with the docs.
      for (const suffix of API_PATH_SUFFIXES) t.assert.match(String(result.error), new RegExp(suffix.replace(/\//g, "\\/")));

      // Every candidate was asked, and each 404 on /models was followed by a probe.
      t.assert.equal(network.modelCalls().length, candidateCount());
      t.assert.equal(network.probes().length, candidateCount());
    }
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheProbeIsAnInvalidPost extends EndpointTest {
  readonly id = "the-probe-is-an-invalid-post-and-a-throw-means-missing";
  readonly whyItExists =
    "a probe sent as a GET, or without a JSON content type, is answered by 404/405 on servers whose chat route exists — which reads as 'not the API' and fails a working connection";

  override async run(t: TestRun): Promise<void> {
    const network = fakeNetwork((url) => (isModels(url) ? { status: 404 } : { status: 400 }));
    await this.test(network);

    const probe = network.probes()[0];
    t.assert.equal(probe?.method, "POST", "the chat route is asked with a POST, as a real call would be");
    t.assert.equal(probe?.headers["Content-Type"], "application/json");
    t.assert.equal(probe?.body, JSON.stringify({ model: "", messages: [] }), "deliberately invalid: the question is whether the route is there");
    t.assert.match(String(probe?.headers["Authorization"]), /^Bearer sk-/, "the key travels, so a 401 can be told from a 404");

    // A probe that cannot connect is 'missing', not fatal: the walk goes on to
    // the next candidate shape.
    const throwing = fakeNetwork((url) => (isProbe(url) ? new Error("ECONNREFUSED") : { status: 404 }));
    const result = await this.test(throwing);
    t.assert.equal(result.ok, false);
    t.assert.match(String(result.error), /no OpenAI-compatible API found at that address/, "a throwing probe must not be reported as an auth failure");
    t.assert.equal(throwing.probes().length, candidateCount(), "every candidate was still tried after the first probe threw");

    // One throwing probe, then a candidate whose route answers: the walk
    // recovers rather than stopping at the failure.
    let seen = 0;
    const recovering = fakeNetwork((url) => {
      if (!isProbe(url)) return { status: 404 };
      seen += 1;
      return seen === 1 ? new Error("ECONNREFUSED") : { status: 400 };
    });
    const recovered = await this.test(recovering);
    t.assert.equal(recovered.ok, true, "a later candidate must still be able to succeed");
    t.assert.notEqual(recovered.baseUrl, BASE_URL, "and the candidate it succeeded on is the one reported");
  }
}

/** How many base URLs the product's own walk will try for {@link BASE_URL}. */
function candidateCount(): number {
  return connectionModule().candidateBaseUrls(BASE_URL).length;
}

registerFeatureTests(
  new CatalogLessServerPasses(),
  new AnyNonRefusalCountsAsExisting(),
  new RefusedKeyIsNamedAsTheKey(),
  new NoRouteBlamesTheAddress(),
  new TheProbeIsAnInvalidPost(),
);
