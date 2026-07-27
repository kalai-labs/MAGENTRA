"use strict";

// Credential validation + connection testing for the setup wizard and the
// Settings → Connection card. Pure I/O over fetch — no Electron imports, so
// tests can drive everything directly.
//
// Why the test is not a single fetch, for local/custom model servers:
//   1. `localhost` can resolve IPv6-first while the server listens only on
//      IPv4 (llama.cpp, LM Studio, Ollama defaults) — so after a failed
//      attempt, `localhost` is retried once as 127.0.0.1. TEST-only defense;
//      it never changes what gets saved.
//   2. Some local servers have no GET /models catalog at all. A reachable
//      server that answers 404 there would still chat fine — so for local
//      endpoints that outcome is a pass with a note, not a failure.
//   3. Failures report the underlying cause (code, address, port) — "the
//      server PC is off" and "wrong port" should read differently.
//   4. Self-signed HTTPS (a home-lab gateway) works via the explicit
//      insecureTls opt-in — the equivalent of `verify=False` in a script.

const { DEFAULT_MODEL, isLocalBaseUrl, normalizeBaseUrl } = require("./config.js");

const HOSTED_TIMEOUT_MS = 8000;
// Local servers can pause the HTTP loop while (un)loading a model.
const LOCAL_TIMEOUT_MS = 15000;

/**
 * Shared validation for the wizard/settings writeEnv + testConnection
 * payloads. Never echoes the apiKey back in error messages or logs.
 *
 * The API key is required only where it cannot possibly work without one:
 * Anthropic, or the default hosted endpoint. Any explicit base URL — local
 * box, LAN machine, or a custom gateway — is key-optional: the provider
 * simply omits the Authorization header when the key is empty, and a server
 * that does require a key rejects the TEST with a 401 the user can read.
 */
function validateCredentialPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid payload" };
  }

  const { apiKey, model, provider, baseUrl, contextWindow, insecureTls } = payload;

  if (typeof apiKey !== "string") {
    return { ok: false, error: "apiKey is required" };
  }
  // Pasted keys routinely arrive with a trailing newline/space; trimming here
  // keeps TEST, .env, and the engine all seeing the exact same string.
  const trimmedKey = apiKey.trim();
  if (trimmedKey.length > 4096) {
    return { ok: false, error: "apiKey is too long" };
  }
  if (/[\r\n]/.test(trimmedKey)) {
    return { ok: false, error: "apiKey must not contain newlines" };
  }

  let resolvedProvider = "openai-compat";
  if (provider !== undefined && provider !== null && provider !== "") {
    if (provider !== "anthropic" && provider !== "openai-compat") {
      return { ok: false, error: "invalid provider" };
    }
    resolvedProvider = provider;
  }

  let resolvedBaseUrl = "";
  if (baseUrl !== undefined && baseUrl !== null && baseUrl !== "") {
    if (typeof baseUrl !== "string") {
      return { ok: false, error: "invalid baseUrl" };
    }
    // Users paste the URL their script calls (".../v1/chat/completions") into
    // the base-URL field; normalize so TEST, .env, and the engine all see the
    // real base.
    const normalized = normalizeBaseUrl(baseUrl);
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      return { ok: false, error: "invalid baseUrl" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "invalid baseUrl" };
    }
    resolvedBaseUrl = normalized;
  }

  if (trimmedKey.length === 0 && resolvedProvider === "anthropic") {
    return { ok: false, error: "apiKey is required" };
  }
  if (trimmedKey.length === 0 && resolvedBaseUrl === "") {
    return { ok: false, error: "apiKey is required for the default hosted endpoint" };
  }

  let resolvedContextWindow;
  if (contextWindow !== undefined && contextWindow !== null && contextWindow !== "") {
    const n = Number(contextWindow);
    if (!Number.isInteger(n) || n < 256 || n > 10_000_000) {
      return { ok: false, error: "invalid context size" };
    }
    resolvedContextWindow = n;
  }

  let resolvedModel = DEFAULT_MODEL;
  if (model !== undefined && model !== null && model !== "") {
    if (typeof model !== "string" || model.length > 200) {
      return { ok: false, error: "invalid model" };
    }
    resolvedModel = model;
  }

  return {
    ok: true,
    apiKey: trimmedKey,
    model: resolvedModel,
    provider: resolvedProvider,
    baseUrl: resolvedBaseUrl,
    contextWindow: resolvedContextWindow,
    insecureTls: insecureTls === true,
  };
}

/**
 * Path shapes an OpenAI-compatible API is served under, in the order worth
 * trying. There is no convention here — every provider picked its own, and the
 * user is expected to know which:
 *
 *   OpenAI, Together, Mistral, DeepSeek   /v1
 *   DeepInfra                             /v1/openai
 *   Fireworks                             /inference/v1
 *   Groq                                  /openai/v1
 *   OpenRouter                            /api/v1
 *
 * Trying them is cheaper than asking a person to know them, and getting it
 * wrong looks — see testEndpoint — exactly like a bad API key.
 */
const API_PATH_SUFFIXES = ["/v1", "/v1/openai", "/inference/v1", "/openai/v1", "/api/v1"];

/**
 * Strip any of the known suffixes to get at the bare origin the user meant.
 * Longest first, so "/v1/openai" is not mistaken for a bare "/v1" with an
 * "openai" directory left dangling in front of the candidates.
 */
const SUFFIXES_LONGEST_FIRST = [...API_PATH_SUFFIXES].sort((a, b) => b.length - a.length);

function stripApiSuffix(baseUrl) {
  const lower = baseUrl.toLowerCase();
  for (const suffix of SUFFIXES_LONGEST_FIRST) {
    if (lower.endsWith(suffix)) return baseUrl.slice(0, -suffix.length);
  }
  return baseUrl;
}

/**
 * The base URLs to try, in order: exactly as given first, then a
 * localhost→127.0.0.1 swap, then the same origin under each known API path.
 *
 * The path candidates exist because "base URL" is not a thing users know. They
 * paste the host from the provider's home page, or the URL their curl example
 * posts to, and each provider hangs its API somewhere different. The cost of
 * being wrong used to be an error blaming the API key.
 */
function candidateBaseUrls(baseUrl) {
  const candidates = [baseUrl];
  const add = (url) => {
    const clean = url.replace(/\/$/, "");
    if (clean && !candidates.includes(clean)) candidates.push(clean);
  };
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return candidates; // validation upstream guarantees a parseable URL
  }
  const localhost = url.hostname.toLowerCase() === "localhost";
  if (localhost) {
    const swapped = new URL(baseUrl);
    swapped.hostname = "127.0.0.1";
    add(swapped.toString());
  }
  // Path shapes are tried for EVERY host, local included. A user's own server
  // is as free to sit at /openai/v1 as a hosted one, and there is no reason the
  // rescue should work for api.example.com but not for their own box. The
  // as-given URL is always tried first, so a correct address still costs one
  // request; only a failing one walks the alternatives.
  const origin = stripApiSuffix(baseUrl.replace(/\/$/, ""));
  for (const suffix of API_PATH_SUFFIXES) add(`${origin}${suffix}`);
  return candidates;
}

/** A human-actionable line for a fetch failure, surfacing the real cause. */
function describeFetchError(err, timeoutMs) {
  if (err && err.name === "AbortError") {
    return `timed out after ${Math.round(timeoutMs / 1000)}s — no response (is the server running and listening on this address?)`;
  }
  const causes = [];
  let cause = err && err.cause;
  if (cause && Array.isArray(cause.errors)) causes.push(...cause.errors);
  else if (cause) causes.push(cause);
  const detail = causes
    .map((c) => [c.code, c.address, c.port].filter((v) => v !== undefined).join(" "))
    .filter(Boolean)
    .join("; ");
  const base = err && err.message ? err.message : String(err);
  const line = detail ? `${base} (${detail})` : base;
  return /SELF_SIGNED|UNABLE_TO_VERIFY|CERT_/.test(line)
    ? `${line} — a self-signed certificate? Enable "Allow self-signed certificate" and test again.`
    : line;
}

/**
 * One GET with its own timeout. `insecureTls` maps to Node's per-connection
 * NODE_TLS_REJECT_UNAUTHORIZED check — set for the duration of this request
 * and always restored (the wizard runs one test at a time, so the temporary
 * process-wide flag cannot leak into an unrelated connection).
 */
async function fetchWithTimeout(url, headers, timeoutMs, fetchImpl, insecureTls, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (insecureTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    return await fetchImpl(url, { method: "GET", ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (insecureTls) {
      if (prevReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevReject;
    }
  }
}

/**
 * Probes an endpoint for the TEST button. `validated` is the output of
 * {@link validateCredentialPayload}. Returns:
 *   { ok: true, status, models, baseUrl, note? } — reachable (note explains quirks;
 *                                                  baseUrl is the normalized base actually probed)
 *   { ok: false, status?, error }                — unreachable or rejected
 * `opts` exists for tests: { fetchImpl, localTimeoutMs, hostedTimeoutMs }.
 */
async function testEndpoint(validated, defaultBaseUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const { apiKey, provider, baseUrl, insecureTls } = validated;

  if (provider === "anthropic") {
    const timeoutMs = opts.hostedTimeoutMs ?? HOSTED_TIMEOUT_MS;
    try {
      const res = await fetchWithTimeout(
        "https://api.anthropic.com/v1/models",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        timeoutMs,
        fetchImpl,
        false,
      );
      return { ok: res.ok, status: res.status, models: await modelIds(res) };
    } catch (err) {
      return { ok: false, error: describeFetchError(err, timeoutMs) };
    }
  }

  const effectiveBaseUrl = (baseUrl || defaultBaseUrl).replace(/\/$/, "");
  const local = isLocalBaseUrl(effectiveBaseUrl);
  const timeoutMs = opts.localTimeoutMs !== undefined || opts.hostedTimeoutMs !== undefined
    ? (local ? opts.localTimeoutMs : opts.hostedTimeoutMs) ?? HOSTED_TIMEOUT_MS
    : local
      ? LOCAL_TIMEOUT_MS
      : HOSTED_TIMEOUT_MS;
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  let lastError = null;
  let authFailure = null;
  for (const candidate of candidateBaseUrls(effectiveBaseUrl)) {
    let res;
    try {
      res = await fetchWithTimeout(`${candidate}/models`, headers, timeoutMs, fetchImpl, insecureTls);
    } catch (err) {
      lastError = describeFetchError(err, timeoutMs);
      continue; // next candidate (e.g. 127.0.0.1 after a stalled localhost)
    }
    if (res.ok) {
      // Report the candidate that WORKED, not the one that was typed — the
      // caller persists this, and echoing the input threw the discovery away.
      return { ok: true, status: res.status, models: await modelIds(res), baseUrl: candidate };
    }
    // 401/403 is the most informative answer there is: the route exists and
    // answered, it just refused this key. Remember it, but keep walking — a
    // later candidate may be the real endpoint.
    if (res.status === 401 || res.status === 403) {
      authFailure = authFailure ?? { status: res.status, baseUrl: candidate };
      continue;
    }
    // A 404 on /models is AMBIGUOUS, and assuming the benign reading is what
    // made a wrong base URL indistinguishable from a bad API key: a server with
    // no catalog and a URL with no such route both answer exactly this. Ask the
    // chat route itself, which is the endpoint that actually matters.
    if (res.status === 404 || res.status === 405) {
      const verdict = await probeChatRoute(candidate, headers, timeoutMs, fetchImpl, insecureTls);
      if (verdict === "exists") {
        return {
          ok: true,
          status: res.status,
          models: [],
          baseUrl: candidate,
          note: "server reachable — it has no /models catalog, so type the model id manually",
        };
      }
      if (verdict === "unauthorized") {
        authFailure = authFailure ?? { status: 401, baseUrl: candidate };
      }
      continue; // "missing" — this is not the API's base; try the next shape
    }
    return { ok: false, status: res.status, models: [] };
  }
  // Every candidate answered, none served the API. If one refused the key, that
  // is the endpoint — and the key really is the problem.
  if (authFailure) {
    return {
      ok: false,
      status: authFailure.status,
      models: [],
      baseUrl: authFailure.baseUrl,
      error: `the endpoint at ${authFailure.baseUrl} rejected this API key (HTTP ${authFailure.status}) — the URL is right, so check the key`,
    };
  }
  if (lastError) return { ok: false, error: lastError };
  return {
    ok: false,
    error:
      "no OpenAI-compatible API found at that address — the host answered, but not at any known API path " +
      `(tried ${API_PATH_SUFFIXES.join(", ")}). Check the base URL in the provider's documentation.`,
  };
}

/**
 * Does a chat route live at this base URL? The question `/models` cannot answer.
 *
 * A deliberately invalid request: we are asking whether the ROUTE is there, not
 * whether it works. Every answer except "not found" proves it is:
 *   - 400/422  the route parsed our nonsense and rejected it — it exists;
 *   - 401/403  it exists and refused the key;
 *   - 200      it exists and was somehow happy;
 *   - 404/405  no such route — this base URL is not the API.
 */
async function probeChatRoute(baseUrl, headers, timeoutMs, fetchImpl, insecureTls) {
  let res;
  try {
    res = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      { ...headers, "Content-Type": "application/json" },
      timeoutMs,
      fetchImpl,
      insecureTls,
      { method: "POST", body: JSON.stringify({ model: "", messages: [] }) },
    );
  } catch {
    return "missing"; // unreachable counts as absent; the caller keeps walking
  }
  if (res.status === 401 || res.status === 403) return "unauthorized";
  if (res.status === 404 || res.status === 405) return "missing";
  return "exists";
}

/** Both API shapes list models as data[].id; a missing catalog is not an error. */
async function modelIds(res) {
  if (!res.ok) return [];
  try {
    const body = await res.json();
    if (body && Array.isArray(body.data)) {
      return body.data.map((m) => m && m.id).filter((id) => typeof id === "string");
    }
  } catch {
    // a catalog is a bonus; the reachability result stands on its own
  }
  return [];
}

module.exports = { validateCredentialPayload, testEndpoint, candidateBaseUrls };
