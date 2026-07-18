"use strict";

// Connection testing for the setup wizard and the Settings → Connection card.
// Pure I/O over fetch — no Electron imports, so tests can drive it directly.
//
// Why this is not a single fetch, for local model servers specifically:
//   1. `localhost` can resolve IPv6-first while the server listens only on
//      IPv4 (llama.cpp, LM Studio, Ollama defaults) — so after a failed
//      attempt, `localhost` is retried once as 127.0.0.1. TEST-only defense;
//      it never changes what gets saved.
//   2. Some local servers have no GET /models catalog at all. A reachable
//      server that answers 404 there would still chat fine — so for local
//      endpoints that outcome is a pass with a note, not a failure.
//   3. Failures report the underlying cause (code, address, port) — "the
//      server PC is off" and "wrong port" should read differently.

const { isLocalBaseUrl } = require("./config.js");

const HOSTED_TIMEOUT_MS = 8000;
// Local servers can pause the HTTP loop while (un)loading a model.
const LOCAL_TIMEOUT_MS = 15000;

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
  return detail ? `${base} (${detail})` : base;
}

/** One GET with its own timeout. Returns the Response; throws on network failure. */
async function fetchWithTimeout(url, headers, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes an endpoint for the TEST button. `validated` is the output of
 * validateCredentialPayload. Returns:
 *   { ok: true, status, models, note? }   — reachable (note explains quirks)
 *   { ok: false, status?, error }         — unreachable or rejected
 * `opts` exists for tests: { fetchImpl, localTimeoutMs, hostedTimeoutMs }.
 */
async function testEndpoint(validated, defaultBaseUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const { apiKey, provider, baseUrl } = validated;

  if (provider === "anthropic") {
    const timeoutMs = opts.hostedTimeoutMs ?? HOSTED_TIMEOUT_MS;
    try {
      const res = await fetchWithTimeout(
        "https://api.anthropic.com/v1/models",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        timeoutMs,
        fetchImpl,
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
      res = await fetchWithTimeout(`${candidate}/models`, headers, timeoutMs, fetchImpl);
    } catch (err) {
      lastError = describeFetchError(err, timeoutMs);
      continue; // next candidate (e.g. 127.0.0.1 after a stalled localhost)
    }
    if (res.ok) {
      return { ok: true, status: res.status, models: await modelIds(res) };
    }
    // A local server without a /models catalog is still a working chat server.
    if (local && (res.status === 404 || res.status === 405)) {
      return {
        ok: true,
        status: res.status,
        models: [],
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

module.exports = { testEndpoint, candidateBaseUrls };
