/**
 * `endpoint-discovery`.
 *
 * "Base URL" is not a thing users know. They paste the host from a provider's
 * home page, or the URL their curl example posts to, and every provider hangs
 * its API somewhere different. The cost of being wrong used to be an error
 * blaming the API key — so TEST walks: the address as typed, then a
 * localhost→127.0.0.1 swap (`localhost` can resolve IPv6-first while the server
 * listens only on IPv4), then the stripped origin under every known path shape.
 * Whichever answers is returned as `baseUrl`, and that is what gets saved.
 *
 * `pure`, and the record said `proc`. The whole walk is reachable by calling
 * `candidateBaseUrls` and `testEndpoint` with a scripted fetch; nothing here
 * needs a process, so `proc` would have meant spawning something to reach a
 * function that was already reachable. Re-declared 2026-09-11, the same
 * correction as `a-404-on-models-is-disambiguated-not-assumed`.
 */

import { connectionModule, validatedFor, type EndpointResult } from "../lib/appConnection.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { fetchFailure, scriptedFetch, type ScriptedFetch } from "../lib/scriptedFetch.ts";

const FEATURE = "endpoint-discovery";

/** Verbatim from the record. */
const INVARIANT =
  "TEST walks the base URL as given, a localhost-to-127.0.0.1 swap, then every known OpenAI-compatible path shape for any host, and returns the URL that actually answered.";

/** The shapes the walk tries under the origin, in order. */
const SUFFIXES = ["/v1", "/v1/openai", "/inference/v1", "/openai/v1", "/api/v1"];

abstract class DiscoveryTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected async test(baseUrl: string, net: ScriptedFetch): Promise<EndpointResult> {
    return connectionModule().testEndpoint(validatedFor(baseUrl), baseUrl, {
      fetchImpl: net.fetchImpl,
      localTimeoutMs: 1_000,
      hostedTimeoutMs: 1_000,
    });
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class LocalhostGetsTheIpv4Swap extends DiscoveryTest {
  readonly id = "localhost-is-walked-as-given-then-as-127-0-0-1-then-by-shape";
  readonly whyItExists =
    "localhost resolves IPv6-first while Ollama and LM Studio listen only on IPv4, so a server that was running answered nothing and the wizard blamed the key";

  override run(t: TestRun): void {
    const candidates = connectionModule().candidateBaseUrls("http://localhost:1234");

    t.assert.deepEqual(candidates, [
      "http://localhost:1234",
      "http://127.0.0.1:1234",
      "http://localhost:1234/v1",
      "http://localhost:1234/v1/openai",
      "http://localhost:1234/inference/v1",
      "http://localhost:1234/openai/v1",
      "http://localhost:1234/api/v1",
    ]);
    // The properties behind that list, stated so a reordering that keeps them
    // reads as a deliberate change rather than a broken test.
    t.assert.equal(candidates[0], "http://localhost:1234", "the address as typed is always tried first");
    t.assert.equal(new Set(candidates).size, candidates.length, "no candidate is requested twice");
    t.assert.deepEqual(candidates.filter((c) => c.endsWith("/")), [], "no candidate carries a trailing slash");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheLongestSuffixIsStrippedFirst extends DiscoveryTest {
  readonly id = "the-longest-path-suffix-is-stripped-before-shapes-are-tried";
  readonly whyItExists =
    "stripping the shortest match first left the origin as .../v1/openai, so every candidate was built under a path that was already the API and none of them existed";

  override run(t: TestRun): void {
    const candidates = connectionModule().candidateBaseUrls("https://api.example.com/v1/openai");

    t.assert.equal(candidates[0], "https://api.example.com/v1/openai", "the address as typed is still first");
    for (const suffix of SUFFIXES) {
      t.assert.ok(
        candidates.includes(`https://api.example.com${suffix}`),
        `the shapes must be built from the stripped origin, missing https://api.example.com${suffix}`,
      );
    }
    t.assert.deepEqual(
      candidates.filter((c) => c.includes("/v1/openai/")),
      [],
      "nothing may be built under the suffix that was supposed to be stripped",
    );

    // The same for the single-segment suffix, and for a host with no suffix at all.
    t.assert.ok(connectionModule().candidateBaseUrls("https://api.example.com/v1").includes("https://api.example.com/api/v1"));
    t.assert.deepEqual(connectionModule().candidateBaseUrls("https://api.example.com/v1").filter((c) => c.includes("/v1/v1")), []);

    // THE CASES THAT ACTUALLY DISCRIMINATE. "/v1/openai" above does not: no
    // shorter suffix is a suffix of it, so any order strips it correctly. The
    // suffixes that END in "/v1" are the ones a shortest-first walk gets wrong
    // — it strips the bare "/v1" and leaves "openai" dangling in front of every
    // candidate, which is exactly what the code's comment describes. Found by a
    // mutation that survived the assertion above.
    for (const [typed, dangling] of [
      ["https://api.example.com/openai/v1", "https://api.example.com/openai"],
      ["https://api.example.com/api/v1", "https://api.example.com/api"],
      ["https://api.example.com/inference/v1", "https://api.example.com/inference"],
    ] as const) {
      const walked = connectionModule().candidateBaseUrls(typed);
      t.assert.ok(walked.includes("https://api.example.com/v1"), `${typed} must yield shapes under the bare origin`);
      t.assert.deepEqual(
        walked.filter((c) => c !== typed && c.startsWith(`${dangling}/`)),
        [],
        `${typed} was stripped to ${dangling}, leaving a directory dangling in front of every candidate`,
      );
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheWorkingCandidateIsReturned extends DiscoveryTest {
  readonly id = "the-candidate-that-answered-is-what-comes-back";
  readonly whyItExists =
    "echoing the typed URL back threw the discovery away, so the wizard saved an address that had just been proved not to work";

  override async run(t: TestRun): Promise<void> {
    const working = "https://host.example.test/openai/v1";
    const net = scriptedFetch((url) =>
      url === `${working}/models` ? { status: 200, body: { data: [{ id: "found-model" }] } } : { status: 404 },
    );
    const result = await this.test("https://host.example.test", net);

    t.assert.equal(result.ok, true);
    t.assert.equal(result.baseUrl, working, "the URL that answered is the one the caller persists");
    t.assert.deepEqual(result.models, ["found-model"]);

    // The walk really did try the earlier shapes before this one.
    const tried = net.modelCalls().map((c) => c.url);
    t.assert.ok(tried.indexOf("https://host.example.test/models") < tried.indexOf(`${working}/models`), "the typed address is tried before the shapes");
    t.assert.ok(tried.length >= 4, `the walk must have reached the working shape through the earlier ones, tried ${tried.length}`);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ACorrectAddressCostsOneRequest extends DiscoveryTest {
  readonly id = "an-address-that-works-costs-exactly-one-request";
  readonly whyItExists =
    "a rescue walk that runs even when the address is right turns one request into seven, and on a hosted endpoint that is six pointless authenticated calls";

  override async run(t: TestRun): Promise<void> {
    const net = scriptedFetch(() => ({ status: 200, body: { data: [{ id: "m" }] } }));
    const result = await this.test("https://api.example.test/v1", net);

    t.assert.equal(result.ok, true);
    t.assert.equal(result.baseUrl, "https://api.example.test/v1");
    t.assert.equal(net.modelCalls().length, 1, "only a failing address may walk the alternatives");
    t.assert.deepEqual(net.probes(), [], "and a 200 needs no chat-route probe");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AThrowingCandidateIsSkipped extends DiscoveryTest {
  readonly id = "a-candidate-that-cannot-be-reached-is-skipped-not-fatal";
  readonly whyItExists =
    "the IPv6-first rescue only works if the failure that triggered it does not abort the walk, which is the entire reason 127.0.0.1 is a second candidate";

  override async run(t: TestRun): Promise<void> {
    // The classic: localhost refuses, 127.0.0.1 answers.
    const rescued = scriptedFetch((url) =>
      url.startsWith("http://127.0.0.1:1234") ? { status: 200, body: { data: [{ id: "local" }] } } : fetchFailure("ECONNREFUSED", "::1", 1234),
    );
    const result = await this.test("http://localhost:1234", rescued);
    t.assert.equal(result.ok, true, "a refused localhost must not end the walk");
    t.assert.equal(result.baseUrl, "http://127.0.0.1:1234", "the IPv4 swap is the candidate that answered");

    // When every candidate throws, the last failure is what the user is told.
    const allDown = scriptedFetch(() => fetchFailure("ENOTFOUND", "nope.example.test", 443));
    const failed = await this.test("https://nope.example.test/v1", allDown);
    t.assert.equal(failed.ok, false);
    t.assert.match(String(failed.error), /ENOTFOUND/, "the reported error is the network cause, not a key complaint");
    t.assert.doesNotMatch(String(failed.error), /API key/);
    t.assert.equal(allDown.modelCalls().length, connectionModule().candidateBaseUrls("https://nope.example.test/v1").length, "every candidate was tried");
  }
}

registerFeatureTests(
  new LocalhostGetsTheIpv4Swap(),
  new TheLongestSuffixIsStrippedFirst(),
  new TheWorkingCandidateIsReturned(),
  new ACorrectAddressCostsOneRequest(),
  new AThrowingCandidateIsSkipped(),
);
