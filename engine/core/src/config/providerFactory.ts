import { AnthropicProvider, OpenAICompatProvider, type Provider } from "@magentra/providers";
import { DEFAULT_OPENAI_BASE_URL } from "./settings.js";

/**
 * Per-endpoint provider construction: the ONE place that turns resolved
 * settings into an inference endpoint and an endpoint into a concrete Provider.
 *
 * Boot (bootstrapEngine) and the live connection swap (set_connection) both go
 * through it, so a session that switched provider mid-conversation is
 * constructed exactly like one that booted on that provider.
 */

export type ProviderKind = "anthropic" | "openai-compatible";

/** A fully resolved inference endpoint, ready to construct a Provider from. */
export interface EndpointSpec {
  provider: ProviderKind;
  /** openai-compatible only; anthropic uses the SDK's own default host. */
  baseUrl?: string;
  /** Empty string for keyless local servers. */
  apiKey: string;
  /** Context window hint for local servers (num_ctx). */
  numCtx?: number;
}

/**
 * True for an endpoint served off this machine or the local network — Ollama,
 * LM Studio, llama.cpp, a model box on the LAN. Such a server needs no API key,
 * so this predicate decides whether a keyless connection is complete or a
 * misconfiguration.
 *
 * It covers the LAN, not just loopback. "The GPU box in the next room" is the
 * normal shape of a local setup, and a narrower test made the app and the engine
 * disagree: the app accepted a keyless `http://192.168.1.20:1234/v1`, wrote it,
 * and the engine then refused to boot with "No API key found".
 *
 * MIRRORED in app/main/config.js (same name, same rules). The app cannot import
 * from the engine — the engine ships as a bundled child process — so the two
 * copies are kept in step deliberately, and app/tests/connection.test.js plus
 * .claude/skills/bigboycoding/connection-check.mjs assert the parity.
 */
export function isLocalBaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "host.docker.internal") return true;
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const private172 = /^172\.(\d{1,3})\./.exec(host);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  return false;
}

/**
 * The connection-shaped fields of a settings layer. The top-level `Settings`
 * satisfies this structurally, and so does `settings.visionConnection` — which
 * is why the main endpoint and the vision endpoint are resolved by the SAME
 * function instead of a near-copy that would drift the first time one of them
 * learned something (a path quirk, a keyless-local rule).
 */
export interface ConnectionSettings {
  provider: ProviderKind;
  baseUrl?: string | undefined;
  contextWindow?: number | undefined;
}

/**
 * The ONE mapping from a resolved connection to an inference endpoint. Boot
 * (bootstrapEngine), the live connection swap (set_connection) and the vision
 * side-call all go through it, so a session that switched provider
 * mid-conversation is constructed exactly like one that booted on that provider.
 *
 * `baseUrl` is deliberately NOT passed to the Anthropic provider: for an
 * Anthropic session that key names an OpenAI-compatible host, not an Anthropic
 * gateway. Handing it to the Anthropic client would silently point chat at the
 * wrong server.
 */
export function endpointSpecFromSettings(settings: ConnectionSettings, apiKey: string | undefined): EndpointSpec {
  if (settings.provider === "anthropic") return { provider: "anthropic", apiKey: apiKey ?? "" };
  const baseUrl = settings.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  return {
    provider: "openai-compatible",
    baseUrl,
    apiKey: apiKey ?? "",
    // Tells a local server which context window to load the model with; hosted
    // providers have no such knob and ignore the field.
    ...(isLocalBaseUrl(baseUrl) && settings.contextWindow !== undefined
      ? { numCtx: settings.contextWindow }
      : {}),
  };
}

/** Constructs the concrete Provider for a resolved endpoint. */
export function createProviderForEndpoint(spec: EndpointSpec): Provider {
  if (spec.provider === "anthropic") return new AnthropicProvider({ apiKey: spec.apiKey });
  return new OpenAICompatProvider({
    apiKey: spec.apiKey,
    baseUrl: spec.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    ...(spec.numCtx !== undefined ? { numCtx: spec.numCtx } : {}),
  });
}
