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

/** The base URLs to try, in order: as given, then a localhost→127.0.0.1 swap. */
function candidateBaseUrls(baseUrl) {
  const candidates = [baseUrl];
  try {
    const url = new URL(baseUrl);
    if (url.hostname.toLowerCase() === "localhost") {
      url.hostname = "127.0.0.1";
      candidates.push(url.toString().replace(/\/$/, ""));
    }
  } catch {
    // validation upstream guarantees a parseable URL; belt and braces
  }
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
async function fetchWithTimeout(url, headers, timeoutMs, fetchImpl, insecureTls) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (insecureTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    return await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
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
  for (const candidate of candidateBaseUrls(effectiveBaseUrl)) {
    let res;
    try {
      res = await fetchWithTimeout(`${candidate}/models`, headers, timeoutMs, fetchImpl, insecureTls);
    } catch (err) {
      lastError = describeFetchError(err, timeoutMs);
      continue; // next candidate (e.g. 127.0.0.1 after a stalled localhost)
    }
    if (res.ok) {
      return { ok: true, status: res.status, models: await modelIds(res), baseUrl: effectiveBaseUrl };
    }
    // A local/custom server without a /models catalog is still a working chat
    // server. Only an explicit base URL earns this tolerance — a 404 from the
    // default hosted endpoint stays a hard failure.
    if ((local || baseUrl) && (res.status === 404 || res.status === 405)) {
      return {
        ok: true,
        status: res.status,
        models: [],
        baseUrl: effectiveBaseUrl,
        note: "server reachable — it has no /models catalog, so type the model id manually",
      };
    }
    return { ok: false, status: res.status, models: [] };
  }
  return { ok: false, error: lastError || "no response" };
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
