"use strict";

// Connection-test behavior against real local sockets: the /models happy path,
// the no-catalog local server, the black-hole timeout with 127.0.0.1 fallback,
// and the base-URL normalization that rescues pasted endpoint paths.

const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  testEndpoint,
  candidateBaseUrls,
  validateCredentialPayload,
  readWorkspaceEnvKeys,
  writeWorkspaceEnvKeys,
  resolveVisionSelection,
  currentVisionConnection,
} = require("../main/connection.js");
const {
  DEFAULT_API_KEY_ENV,
  VISION_API_KEY_ENV,
  isLocalBaseUrl,
  normalizeBaseUrl,
  apiKeyEnvVarFor,
  writeJsonAtomic,
  readWorkspaceSettings,
  updateWorkspaceSettings,
} = require("../main/config.js");
const { upsertProfile, deleteProfile } = require("../main/profiles.js");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function main() {
  // ── normalizeBaseUrl: pasted endpoint paths reduce to the real base ──────
  assert.equal(normalizeBaseUrl("http://192.168.1.20:1234/v1/chat/completions"), "http://192.168.1.20:1234/v1");
  assert.equal(normalizeBaseUrl("http://localhost:8080/v1/models"), "http://localhost:8080/v1");
  assert.equal(normalizeBaseUrl("  https://api.example.com/v1/openai/  "), "https://api.example.com/v1/openai");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1"), "http://localhost:11434/v1");

  // ── isLocalBaseUrl: LAN model boxes count as local (key-optional) ────────
  for (const url of [
    "http://localhost:1234/v1", "http://127.0.0.1:8080/v1", "http://192.168.1.20:1234/v1",
    "http://10.0.0.5:8000/v1", "http://172.20.0.2:8000/v1", "http://mybox.local:8080/v1",
    "http://[::1]:8080/v1", "http://host.docker.internal:11434/v1",
  ]) {
    assert.equal(isLocalBaseUrl(url), true, `${url} should be local`);
  }
  assert.equal(isLocalBaseUrl("https://api.example.com/v1/openai"), false);
  assert.equal(isLocalBaseUrl("http://172.15.0.1/v1"), false, "172.15 is outside the private range");

  // ── candidates: as given, then 127.0.0.1, then every known API path ──────
  // Path shapes are walked for ANY host. A user's own server is as free to sit
  // at /openai/v1 as a hosted one, and the as-given URL is always tried first,
  // so a correct address still costs exactly one request.
  {
    const local = candidateBaseUrls("http://localhost:9999/v1");
    assert.equal(local[0], "http://localhost:9999/v1", "the URL as given is always tried first");
    assert.equal(local[1], "http://127.0.0.1:9999/v1", "localhost keeps its IPv4 fallback");
    assert.ok(local.includes("http://localhost:9999/inference/v1"), "local hosts get path shapes too");
    assert.equal(new Set(local).size, local.length, "no duplicate candidates");

    const hosted = candidateBaseUrls("https://api.example.com/v1");
    assert.equal(hosted[0], "https://api.example.com/v1");
    for (const suffix of ["/v1/openai", "/inference/v1", "/openai/v1", "/api/v1"]) {
      assert.ok(hosted.includes(`https://api.example.com${suffix}`), `missing candidate ${suffix}`);
    }
    // A wrong suffix must not compound into /v1/inference/v1.
    assert.ok(!hosted.some((u) => /\/v1\/inference/.test(u)), "the existing suffix is stripped, not stacked");

    // A bare host works the same way.
    assert.ok(candidateBaseUrls("https://api.example.com").includes("https://api.example.com/v1"));
  }

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

  // ── no /models catalog, but a real chat route: reachable, with a note ────
  // The fixture answers 404 on /models and 400 on /chat/completions, which is
  // what a catalog-less server actually does. A fixture that 404s EVERYTHING
  // (as this one used to) is indistinguishable from a wrong base URL — which
  // was precisely the bug: the test could not tell them apart either.
  const noCatalogServer = http.createServer((req, res) => {
    if (req.url && req.url.includes("/chat/completions")) return res.writeHead(400).end();
    return res.writeHead(404).end();
  });
  const noCatalogPort = await listen(noCatalogServer);
  result = await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: `http://127.0.0.1:${noCatalogPort}/v1` },
    "https://unused.example/v1",
  );
  assert.equal(result.ok, true, "a 404 /models with a live chat route is still a working endpoint");
  assert.match(result.note, /no \/models catalog/);
  noCatalogServer.close();

  // ── 404 on EVERYTHING is not an API, and must not pass as "no catalog" ───
  const notAnApi = http.createServer((_req, res) => res.writeHead(404).end());
  const notAnApiPort = await listen(notAnApi);
  result = await testEndpoint(
    { apiKey: "k", provider: "openai-compat", baseUrl: `http://127.0.0.1:${notAnApiPort}/v1` },
    "https://unused.example/v1",
  );
  assert.equal(result.ok, false, "a host with no chat route must fail, not report success");
  assert.match(result.error, /no OpenAI-compatible API found/);
  notAnApi.close();

  // ── the API is under a non-obvious path: discover it and report it back ──
  // Fireworks serves /inference/v1, DeepInfra /v1/openai, Groq /openai/v1. The
  // user pastes the host; the walk finds where the API actually lives.
  const oddPath = http.createServer((req, res) => {
    if (req.url === "/inference/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "some/model" }] }));
    }
    return res.writeHead(404).end();
  });
  const oddPort = await listen(oddPath);
  result = await testEndpoint(
    { apiKey: "k", provider: "openai-compat", baseUrl: `http://127.0.0.1:${oddPort}` },
    "https://unused.example/v1",
  );
  assert.equal(result.ok, true, "an API under an unusual path must still be found");
  assert.equal(result.baseUrl, `http://127.0.0.1:${oddPort}/inference/v1`, "the DISCOVERED base is returned, not the typed one");
  assert.deepEqual(result.models, ["some/model"]);
  oddPath.close();

  // ── a genuine key failure must say so, and name the endpoint that refused ─
  const refuses = http.createServer((_req, res) => res.writeHead(401).end());
  const refusesPort = await listen(refuses);
  result = await testEndpoint(
    { apiKey: "bad", provider: "openai-compat", baseUrl: `http://127.0.0.1:${refusesPort}/v1` },
    "https://unused.example/v1",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.error, /rejected this API key/, "a 401 must blame the key, not the URL");
  assert.match(result.error, /the URL is right/);
  refuses.close();

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
  // 404 on the catalog, 400 on the chat route — a catalog-less but working
  // server. The chat probe is what separates this from a wrong base URL.
  const custom404Fetch = async (url) => ({
    ok: false,
    status: String(url).includes("/chat/completions") ? 400 : 404,
    json: async () => ({}),
  });
  result = await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: "https://gw.example/coder/v1", insecureTls: false },
    "https://unused.example/v1",
    { fetchImpl: custom404Fetch },
  );
  assert.equal(result.ok, true, "an explicit base URL earns the no-catalog tolerance");
  assert.match(result.note, /no \/models catalog/);
  // The old rule was "only an EXPLICIT base URL earns the no-catalog
  // tolerance" — a heuristic standing in for evidence nobody had. The chat
  // probe supplies that evidence, so the rule is gone: a live chat route passes
  // wherever it is found, and a dead one fails wherever it is found.
  result = await testEndpoint(
    { apiKey: "k", provider: "openai-compat", baseUrl: "", insecureTls: false },
    "https://hosted.example/v1",
    { fetchImpl: custom404Fetch },
  );
  assert.equal(result.ok, true, "a live chat route passes even on the default endpoint");

  // ── a host that 404s everywhere is not an API, however it was configured ─
  const deadFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  result = await testEndpoint(
    { apiKey: "k", provider: "openai-compat", baseUrl: "https://gw.example/coder/v1", insecureTls: false },
    "https://unused.example/v1",
    { fetchImpl: deadFetch },
  );
  assert.equal(result.ok, false, "no chat route anywhere must not pass as a catalog-less server");
  assert.match(result.error, /no OpenAI-compatible API found/);

  // ── connection refused: the real cause reaches the user ──────────────────
  result = await testEndpoint(
    { apiKey: "", provider: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" },
    "https://unused.example/v1",
    { localTimeoutMs: 2000, hostedTimeoutMs: 2000 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED|fetch failed|timed out/);

  // ── the key env var is chosen by PROVIDER, never by file order ───────────
  // A workspace switched between providers keeps both key lines in its .env.
  // "The first *_API_KEY line" then revealed, tested and re-saved whichever key
  // sat higher in the file — one provider's key sent to the other's URL.
  assert.equal(apiKeyEnvVarFor("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(apiKeyEnvVarFor("openai-compat"), DEFAULT_API_KEY_ENV);
  assert.equal(apiKeyEnvVarFor(undefined), DEFAULT_API_KEY_ENV, "an unspecified provider is the compat one");

  // ── workspace settings: atomic writes, and no state left behind ──────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magentra-conn-"));
    assert.deepEqual(readWorkspaceSettings(dir), {}, "a workspace with no settings file reads as empty");

    assert.equal(updateWorkspaceSettings(dir, (s) => { s.model = "a/b"; }), null);
    assert.equal(readWorkspaceSettings(dir).model, "a/b");
    // A second update must not lose the first (read-modify-write, not overwrite).
    updateWorkspaceSettings(dir, (s) => { s.baseUrl = "http://127.0.0.1:1234/v1"; });
    const merged = readWorkspaceSettings(dir);
    assert.equal(merged.model, "a/b", "an unrelated key survives the next write");
    assert.equal(merged.baseUrl, "http://127.0.0.1:1234/v1");
    // The temp file is renamed, never left around: a stray settings.json.tmp is
    // how a half-written state file survives to confuse the next reader.
    const stateDir = path.join(dir, ".magentra");
    assert.deepEqual(
      fs.readdirSync(stateDir).filter((f) => f.endsWith(".tmp")),
      [],
      "no .tmp file is left behind",
    );

    // A malformed file reads as empty rather than throwing — the engine's own
    // defaults then apply, and the next write repairs it.
    fs.writeFileSync(path.join(stateDir, "settings.json"), "{ truncated");
    assert.deepEqual(readWorkspaceSettings(dir), {}, "unparseable settings read as empty");
    assert.equal(updateWorkspaceSettings(dir, (s) => { s.model = "c/d"; }), null);
    assert.equal(readWorkspaceSettings(dir).model, "c/d", "a corrupt file is replaced, not compounded");

    // 0600 on a file that may hold a key, applied on every write (not just create).
    const keyFile = path.join(dir, "keys.json");
    fs.writeFileSync(keyFile, "{}", { mode: 0o644 });
    writeJsonAtomic(keyFile, { apiKey: "secret" }, 0o600);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, "an existing looser file is tightened");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── the vision endpoint: chosen from a profile, kept, or cleared ─────────
  // The main model is never sent an image, so this second connection is what
  // decides whether images can be used at all. Each case below is one the app
  // gets wrong in a different, silent way: keeping a removed model, dropping a
  // working one, or leaving `vision` on with nothing behind it.
  {
    // $HOME points at a temp dir: profiles.json and the global settings layer
    // both live there, so this block cannot read (or write) the real ones.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "magentra-home-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "magentra-vision-ws-"));
    try {
      assert.deepEqual(
        currentVisionConnection(ws),
        { connection: null, enabled: false },
        "a workspace with no vision model has none",
      );

      const { id } = upsertProfile({
        name: "vision box",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "",
        model: "llava",
        provider: "openai-compat",
      });

      const chosen = resolveVisionSelection(ws, { profileId: id });
      assert.equal(chosen.connection.model, "llava");
      assert.equal(chosen.connection.baseUrl, "http://127.0.0.1:11434/v1");
      assert.equal(chosen.enabled, true, "choosing a vision model switches it on");
      // A local endpoint needs no key — the same rule the main connection uses.
      assert.equal(chosen.connection.apiKey, "");

      assert.equal(resolveVisionSelection(ws, { profileId: "" }).connection, null, '"None" clears the endpoint');
      assert.ok(
        resolveVisionSelection(ws, { profileId: "no-such-profile" }).error,
        "an unknown profile is an error, never a silent clear",
      );

      // What the app writes on save, as the engine will read it back.
      updateWorkspaceSettings(ws, (s) => {
        s.visionConnection = {
          provider: "openai-compatible",
          model: "llava",
          baseUrl: "http://127.0.0.1:11434/v1",
          profileId: id,
        };
        s.vision = true;
      });

      // Omitting the selection means "leave it alone" — this is the path an
      // applied profile takes, and it must not drop the vision model with it.
      const kept = resolveVisionSelection(ws, undefined);
      assert.equal(kept.connection.model, "llava", "a main-connection change keeps the vision model");
      assert.equal(kept.enabled, true);

      // The toggle works off what is SAVED, not off a profile lookup: deleting
      // the profile must not make the switch delete a working setup.
      deleteProfile(id);
      const toggledOff = resolveVisionSelection(ws, { keep: true, enabled: false });
      assert.equal(toggledOff.connection.model, "llava", "the endpoint survives its profile");
      assert.equal(toggledOff.enabled, false);
      assert.ok(
        resolveVisionSelection(ws, { profileId: id }).error,
        "re-selecting a deleted profile is refused rather than half-applied",
      );

      // ── .env: both keys in one rewrite ────────────────────────────────────
      writeWorkspaceEnvKeys(ws, [
        { name: DEFAULT_API_KEY_ENV, value: "main-key", alsoRemove: ["DEEPINFRA_API_KEY"] },
        { name: VISION_API_KEY_ENV, value: "vision-key", removeWhenEmpty: true },
      ]);
      let keys = readWorkspaceEnvKeys(ws);
      assert.equal(keys[DEFAULT_API_KEY_ENV], "main-key");
      assert.equal(keys[VISION_API_KEY_ENV], "vision-key", "the vision key has its OWN variable");

      // The saved key is what the live connection frame carries.
      assert.equal(currentVisionConnection(ws).connection.apiKey, "vision-key");

      writeWorkspaceEnvKeys(ws, [
        { name: DEFAULT_API_KEY_ENV, value: "" },
        { name: VISION_API_KEY_ENV, value: "", removeWhenEmpty: true },
      ]);
      keys = readWorkspaceEnvKeys(ws);
      assert.equal(keys[DEFAULT_API_KEY_ENV], "main-key", "a keyless save keeps the key it may switch back to");
      assert.equal(keys[VISION_API_KEY_ENV], undefined, "removing the vision model drops its key");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }

  process.stdout.write("✓ connection test walks localhost candidates, tolerates missing /models, and reports real causes\n");
  process.stdout.write("✓ provider-aware key vars, atomic workspace settings\n");
  process.stdout.write("✓ vision endpoint resolves from a profile, survives its deletion, and clears its own key\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
