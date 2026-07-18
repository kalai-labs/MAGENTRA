"use strict";

// Connection-test behavior against real local sockets: the /models happy path,
// the no-catalog local server, the black-hole timeout with 127.0.0.1 fallback,
// and the base-URL normalization that rescues pasted endpoint paths.

const assert = require("node:assert/strict");
const http = require("node:http");
const { testEndpoint, candidateBaseUrls, validateCredentialPayload } = require("../main/connection.js");
const { isLocalBaseUrl, normalizeBaseUrl } = require("../main/config.js");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function main() {
  // ── normalizeBaseUrl: pasted endpoint paths reduce to the real base ──────
  assert.equal(normalizeBaseUrl("http://192.168.1.20:1234/v1/chat/completions"), "http://192.168.1.20:1234/v1");
  assert.equal(normalizeBaseUrl("http://localhost:8080/v1/models"), "http://localhost:8080/v1");
  assert.equal(normalizeBaseUrl("  https://api.deepinfra.com/v1/openai/  "), "https://api.deepinfra.com/v1/openai");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1"), "http://localhost:11434/v1");

  // ── isLocalBaseUrl: LAN model boxes count as local (key-optional) ────────
  for (const url of [
    "http://localhost:1234/v1", "http://127.0.0.1:8080/v1", "http://192.168.1.20:1234/v1",
    "http://10.0.0.5:8000/v1", "http://172.20.0.2:8000/v1", "http://mybox.local:8080/v1",
  ]) {
    assert.equal(isLocalBaseUrl(url), true, `${url} should be local`);
  }
  assert.equal(isLocalBaseUrl("https://api.deepinfra.com/v1/openai"), false);
  assert.equal(isLocalBaseUrl("http://172.15.0.1/v1"), false, "172.15 is outside the private range");

  // ── candidates: localhost gets a 127.0.0.1 fallback, others do not ───────
  assert.deepEqual(candidateBaseUrls("http://localhost:9999/v1"), [
    "http://localhost:9999/v1",
    "http://127.0.0.1:9999/v1",
  ]);
  assert.deepEqual(candidateBaseUrls("http://192.168.1.20:9999/v1"), ["http://192.168.1.20:9999/v1"]);

  // ── happy path: an IPv4-only server with a /models catalog ───────────────
  const catalogServer = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "qwen3.6-35b-a3b" }, { id: "other-model" }] }));
    } else {
      res.writeHead(404).end();
    }
  });
  const catalogPort = await listen(catalogServer);
  // `localhost` in the URL exercises the candidate walk even where ::1 refuses.
  let result = await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: `http://localhost:${catalogPort}/v1` },
    "https://unused.example/v1",
  );
  assert.equal(result.ok, true, `catalog server should pass: ${result.error}`);
  assert.deepEqual(result.models, ["qwen3.6-35b-a3b", "other-model"]);
  catalogServer.close();

  // ── local server with no /models catalog: reachable, with a note ─────────
  const noCatalogServer = http.createServer((_req, res) => res.writeHead(404).end());
  const noCatalogPort = await listen(noCatalogServer);
  result = await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: `http://127.0.0.1:${noCatalogPort}/v1` },
    "https://unused.example/v1",
  );
  assert.equal(result.ok, true, "a 404 /models on a LOCAL server is still a working chat endpoint");
  assert.match(result.note, /no \/models catalog/);
  noCatalogServer.close();

  // ── black hole: accepts the socket, never answers → clear timeout text ───
  const blackHole = http.createServer(() => {
    /* never respond */
  });
  const blackHolePort = await listen(blackHole);
  const started = Date.now();
  result = await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: `http://localhost:${blackHolePort}/v1` },
    "https://unused.example/v1",
    { localTimeoutMs: 500, hostedTimeoutMs: 500 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/, `expected a timeout message, got: ${result.error}`);
  // Both candidates (localhost + 127.0.0.1) were tried within their budgets.
  assert.ok(Date.now() - started < 5000, "candidate walk must respect per-attempt timeouts");
  blackHole.close();

  // ── validation: custom endpoints are key-optional; defaults are not ──────
  const customKeyless = validateCredentialPayload({
    apiKey: "",
    baseUrl: "https://gw.example/coder/v1/chat/completions",
    model: "qwen3.6-35b-a3b",
    provider: "openai-compat",
    insecureTls: true,
  });
  assert.equal(customKeyless.ok, true, "a custom base URL must not demand a key");
  assert.equal(customKeyless.baseUrl, "https://gw.example/coder/v1", "pasted endpoint path normalizes");
  assert.equal(customKeyless.insecureTls, true);
  assert.equal(validateCredentialPayload({ apiKey: "", provider: "openai-compat" }).ok, false,
    "the default hosted endpoint still requires a key");
  assert.equal(validateCredentialPayload({ apiKey: "", provider: "anthropic" }).ok, false,
    "anthropic always requires a key");
  assert.equal(validateCredentialPayload({ apiKey: "k", baseUrl: "https://x.example/v1" }).insecureTls, false,
    "insecureTls defaults to false");

  // ── insecureTls: set only around the request, always restored ────────────
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  let seenDuringFetch = null;
  const envSpyFetch = async () => {
    seenDuringFetch = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) };
  };
  result = await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: "https://gw.example/coder/v1", insecureTls: true },
    "https://unused.example/v1",
    { fetchImpl: envSpyFetch },
  );
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, "https://gw.example/coder/v1", "the probed base is echoed back");
  assert.equal(seenDuringFetch, "0", "TLS verification disabled during the insecure test request");
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined, "and restored right after");
  seenDuringFetch = null;
  await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: "https://gw.example/coder/v1", insecureTls: false },
    "https://unused.example/v1",
    { fetchImpl: envSpyFetch },
  );
  assert.equal(seenDuringFetch, undefined, "secure tests never touch the TLS env");

  // ── custom (non-local) endpoint without /models: pass with a note ────────
  const custom404Fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  result = await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: "https://gw.example/coder/v1", insecureTls: false },
    "https://unused.example/v1",
    { fetchImpl: custom404Fetch },
  );
  assert.equal(result.ok, true, "an explicit base URL earns the no-catalog tolerance");
  assert.match(result.note, /no \/models catalog/);
  result = await testEndpoint(
    { apiKey: "k", provider: "openai-compat", baseUrl: "", insecureTls: false },
    "https://hosted.example/v1",
    { fetchImpl: custom404Fetch },
  );
  assert.equal(result.ok, false, "a 404 from the default hosted endpoint stays a failure");

  // ── connection refused: the real cause reaches the user ──────────────────
  result = await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" },
    "https://unused.example/v1",
    { localTimeoutMs: 2000, hostedTimeoutMs: 2000 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED|fetch failed|timed out/);

  process.stdout.write("✓ connection test walks localhost candidates, tolerates missing /models, and reports real causes\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
