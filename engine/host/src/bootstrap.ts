import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_OPENAI_BASE_URL,
  Engine,
  createMcpTools,
  createProviderForEndpoint,
  endpointSpecFromSettings,
  isLocalBaseUrl,
  loadSettings,
  loadSkills,
  resolveApiKeySource,
} from "@magentra/core";
import type { Provider } from "@magentra/providers";
import { createDefaultRegistry, resolveBashPath } from "@magentra/tools";
import { loadDotEnv } from "./env.js";

export interface BootstrapOptions {
  /** Workspace root the engine operates on. */
  cwd: string;
}

export interface BootstrapResult {
  engine: Engine;
  /** Non-fatal settings problems, for the caller to surface however it likes. */
  warnings: string[];
}

export class MissingApiKeyError extends Error {}

/**
 * Builds a ready-to-run Engine for `cwd`: loads `.env` and the layered settings,
 * resolves the API key and provider endpoint, assembles the tool registry
 * (including any configured MCP servers) and the skills.
 *
 * Deliberately free of any frontend concern — no argv, no prompts, no I/O to a
 * terminal. The stdio host calls it; so can a test, or an in-process embedder.
 * Throws {@link MissingApiKeyError} rather than exiting, so the caller decides
 * how to report it.
 */
export async function bootstrapEngine(opts: BootstrapOptions): Promise<BootstrapResult> {
  loadDotEnv(opts.cwd);

  const { settings, warnings } = loadSettings(opts.cwd);

  // The `verify=False` escape hatch for self-signed local/custom endpoints.
  // Node reads this per TLS connection, so setting it here covers every
  // provider fetch in this process. Deliberately loud: it disables MITM
  // protection, so it must never pass silently.
  if (settings.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    warnings.push({
      source: "settings",
      message:
        "allowInsecureTls is ON — TLS certificate verification is disabled for this engine. Only use with servers you own.",
    });
  }

  // The Bash tool needs a real bash. On Windows that means Git Bash; the bare
  // "bash" fallback commonly resolves to WSL's launcher (whose /mnt/c view
  // node cannot consume) or to nothing at all — warn at boot, before the first
  // Bash call fails cryptically mid-task.
  if (process.platform === "win32" && resolveBashPath() === "bash") {
    warnings.push({
      source: "environment",
      message:
        "Git Bash was not found — the Bash tool will not work reliably. " +
        "Install Git for Windows (https://git-scm.com/download/win), " +
        "or point MAGENTRA_BASH at a bash.exe.",
    });
  }

  const keySource = resolveApiKeySource(settings);
  const apiKey = keySource.key;
  // A settings file that pins `apiKeyEnv` to a variable which is not set is the
  // fingerprint of a stale connection: the pin outlived the provider it was
  // written for. Resolution now falls through to the standard names instead of
  // dropping to a stored key, but the user should still be told — a key coming
  // from somewhere other than where their settings say is worth one line.
  if (keySource.danglingKeyEnv) {
    warnings.push({
      source: "settings",
      message:
        `Settings name apiKeyEnv "${keySource.danglingKeyEnv}", but that variable is not set. ` +
        (keySource.from === undefined
          ? "No key was found anywhere else either."
          : `The key in use came from ${keySource.from === "settings" ? "the stored settings value" : keySource.from} instead.`) +
        " If you changed provider, clear apiKeyEnv so the stale name stops shadowing the real key.",
    });
  }
  const baseUrl = settings.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  // Local servers (Ollama, llama.cpp, LM Studio) need no key; hosted ones do.
  const isLocalEndpoint = settings.provider !== "anthropic" && isLocalBaseUrl(baseUrl);
  if (!apiKey && !isLocalEndpoint) {
    const envName =
      settings.apiKeyEnv ?? (settings.provider === "anthropic" ? "ANTHROPIC_API_KEY" : DEFAULT_API_KEY_ENV);
    throw new MissingApiKeyError(
      `No API key found. Set ${envName} in the environment or in a .env file in ${opts.cwd}, ` +
        "or configure it in the app's settings.",
    );
  }

  // One mapping from settings to an endpoint, shared with the live
  // set_connection swap — a switched session is built exactly like a booted one.
  const provider: Provider = createProviderForEndpoint(endpointSpecFromSettings(settings, apiKey));

  const registry = createDefaultRegistry();
  const mcp = await createMcpTools(settings.mcpServers);
  for (const tool of mcp.tools) {
    registry.register(tool);
  }
  // A typo'd MCP server must produce a visible warning, not silently vanish.
  for (const message of mcp.warnings) {
    warnings.push({ source: "mcp", message });
  }

  const engine = new Engine({
    cwd: opts.cwd,
    settings,
    provider,
    registry,
    skills: loadSkills(opts.cwd),
  });

  return { engine, warnings: warnings.map((w) => `[${w.source}] ${w.message}`) };
}
