import { AnthropicProvider, OpenAICompatProvider, type Provider } from "@magentra/providers";
import { DEFAULT_OPENAI_BASE_URL, resolveApiKey, type Settings } from "../config/settings.js";
import type { CrewAgent } from "./team.js";

/**
 * Per-endpoint provider construction: the seam that lets each crew member run
 * on its OWN inference API (a local Ollama coder, a hosted big-brain model, a
 * cheap fast one) while the orchestrator stays on the session provider.
 *
 * Team files declare an endpoint with shareable-safe frontmatter only —
 * provider kind, base URL, and the NAME of the env var holding the key. The
 * key itself never lives in a team file, so a team stays distributable.
 * Resolution fails soft: an endpoint that cannot be resolved (missing env
 * var, missing key) degrades to the session's default provider AND model with
 * a visible warning, never a silent 404 on the wrong host.
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

/** Local servers (Ollama, llama.cpp, LM Studio) need no API key. */
export function isLocalBaseUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}

/** Stable cache key so one Provider instance is shared per distinct endpoint. */
export function endpointKey(spec: EndpointSpec): string {
  return JSON.stringify([spec.provider, spec.baseUrl ?? "", spec.apiKey, spec.numCtx ?? 0]);
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

/** True when a team file declares any dedicated-endpoint key at all. */
export function agentDeclaresEndpoint(agent: CrewAgent): boolean {
  return agent.provider !== undefined || agent.baseUrl !== undefined || agent.apiKeyEnv !== undefined;
}

/**
 * Resolves a crew member's declared endpoint against the environment.
 *   undefined          — the member declares no endpoint; share the session provider.
 *   { spec }           — resolved; construct/cache a dedicated provider from it.
 *   { warning }        — declared but unresolvable (missing key); the caller must
 *                        fall back to the session provider AND default model,
 *                        surfacing the warning (the member's model most likely
 *                        does not exist on the fallback host).
 */
export function resolveCrewEndpoint(
  agent: CrewAgent,
  settings: Settings,
): { spec: EndpointSpec } | { warning: string } | undefined {
  if (!agentDeclaresEndpoint(agent)) return undefined;

  const kind: ProviderKind = agent.provider ?? "openai-compatible";
  const sessionBaseUrl = settings.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const baseUrl = kind === "openai-compatible" ? (agent.baseUrl ?? sessionBaseUrl) : undefined;
  const local = baseUrl !== undefined && isLocalBaseUrl(baseUrl);

  // The session's own key is valid wherever the session itself talks to: same
  // provider kind and (for openai-compatible) the same host. Declaring
  // apikeyenv: must never resolve WORSE than omitting it, so when the declared
  // env var is unset but the endpoint is session-shaped, the session key applies.
  const sessionKeyApplies =
    kind === "anthropic" ? settings.provider === "anthropic" : settings.provider !== "anthropic" && baseUrl === sessionBaseUrl;

  let apiKey: string | undefined;
  if (agent.apiKeyEnv !== undefined) {
    apiKey = process.env[agent.apiKeyEnv];
    if (!apiKey && sessionKeyApplies) apiKey = resolveApiKey(settings);
    if (!apiKey && !local) {
      return {
        warning: `crew member "${agent.id}": env var ${agent.apiKeyEnv} is not set — falling back to the session's default provider and model. Set ${agent.apiKeyEnv} (e.g. in .env) to run ${agent.name} on its own endpoint.`,
      };
    }
  } else if (kind === "anthropic") {
    apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey && sessionKeyApplies) apiKey = resolveApiKey(settings);
    if (!apiKey) {
      return {
        warning: `crew member "${agent.id}": provider anthropic needs ANTHROPIC_API_KEY (or an apikeyenv: key in its team file) — falling back to the session's default provider and model.`,
      };
    }
  } else if (agent.baseUrl === undefined || agent.baseUrl === sessionBaseUrl) {
    // Same host as the session: the session's own key applies.
    apiKey = resolveApiKey(settings);
    if (!apiKey && !local) {
      return {
        warning: `crew member "${agent.id}": no API key available for ${baseUrl} — falling back to the session's default provider and model.`,
      };
    }
  } else if (!local) {
    // A dedicated hosted URL without a declared key source is a config gap, not a guess.
    return {
      warning: `crew member "${agent.id}": baseurl ${baseUrl} needs an apikeyenv: key in its team file (the NAME of the env var holding that endpoint's API key) — falling back to the session's default provider and model.`,
    };
  }

  return {
    spec: {
      provider: kind,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      apiKey: apiKey ?? "",
      ...(local ? { numCtx: settings.contextWindow } : {}),
    },
  };
}
