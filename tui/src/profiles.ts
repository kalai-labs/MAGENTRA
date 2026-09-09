/**
 * Read-only access to MAGENTRA's global profile store, plus the one write the
 * IDE would make: committing a chosen profile to a workspace.
 *
 * Profiles live in ~/.magentra/profiles.json (app-owned, keys inside, 0600).
 * The ENGINE never reads that file — what it boots from is the workspace:
 * the API key in `<ws>/.env`, everything else in `<ws>/.magentra/settings.json`.
 * So "use a profile here" means writing those two files, in exactly the format
 * app/main.js applyValidatedConnection writes them, so a folder connected by
 * the TUI is indistinguishable from one connected by the IDE.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Profile {
  id: string;
  name: string;
  /** App vocabulary: "anthropic" | "openai-compat". */
  provider: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  contextWindow?: number | string;
  /** One of the engine's reasoning-effort levels; absent = the endpoint's default. */
  reasoningEffort?: string;
  insecureTls?: boolean;
}

/** Mirrors app/main/config.js apiKeyEnvVarFor + the legacy names it retires. */
const DEFAULT_API_KEY_ENV = 'MAGENTRA_API_KEY';
const LEGACY_API_KEY_ENV_VARS = ['DEEPINFRA_API_KEY'];

function keyVarFor(provider: string): string {
  return provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : DEFAULT_API_KEY_ENV;
}

export function profilesPath(): string {
  return join(homedir(), '.magentra', 'profiles.json');
}

/** All saved profiles; a missing or mangled file reads as an empty list. */
export function readProfiles(): Profile[] {
  try {
    const parsed = JSON.parse(readFileSync(profilesPath(), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is Profile =>
        !!p && typeof p === 'object' && typeof (p as Profile).id === 'string' && typeof (p as Profile).name === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * The name of the API-key variable already set in the environment, if any.
 *
 * Exported because presence from the environment is the one form of presence no
 * write to this folder can clear: a caller offering to disconnect a workspace
 * has to be able to say so instead of appearing to fail.
 */
export function environmentKeyVar(): string | undefined {
  for (const name of ['MAGENTRA_API_KEY', 'ANTHROPIC_API_KEY', ...LEGACY_API_KEY_ENV_VARS]) {
    if ((process.env[name] ?? '').trim() !== '') return name;
  }
  return undefined;
}

/**
 * Can the engine boot in this workspace as it stands? Mirrors the boot inputs:
 * a key in the environment, a key line in `<ws>/.env` (the host loads it), or
 * a `.magentra/settings.json` that names a connection (keyless local servers
 * have no key line at all — their config lives entirely in settings).
 */
export function workspaceConnected(ws: string): boolean {
  if (environmentKeyVar() !== undefined) return true;

  try {
    const env = readFileSync(join(ws, '.env'), 'utf8');
    if (/^[A-Z0-9_]*API_KEY\s*=\s*\S/m.test(env)) return true;
  } catch {
    /* no .env */
  }

  try {
    const settings = JSON.parse(readFileSync(join(ws, '.magentra', 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (settings.baseUrl || settings.model || settings.provider || settings.apiKey) return true;
  } catch {
    /* no settings */
  }

  return false;
}

/** Upsert KEY=value into an .env body, dropping retired names, keeping the rest. */
function upsertEnvLine(body: string, name: string, value: string, alsoRemove: string[]): string {
  const drop = new Set([name, ...alsoRemove]);
  const lines = body
    .split(/\r?\n/)
    .filter((line) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !(m && drop.has(m[1]!));
    })
    .filter((line, i, all) => !(line === '' && i === all.length - 1));
  if (value) lines.push(`${name}=${value}`);
  return lines.join('\n').replace(/\n*$/, '\n');
}

/**
 * Commit a profile to a workspace — the same two writes the IDE makes:
 * the key into `.env`, the connection into `.magentra/settings.json`
 * (provider spelled "openai-compatible" there, exactly as the engine's
 * settings schema wants it).
 */
export function applyProfile(ws: string, profile: Profile): void {
  // 1. The key → .env (skipped entirely for keyless local endpoints).
  const keyVar = keyVarFor(profile.provider);
  const apiKey = (profile.apiKey ?? '').trim();
  let envBody = '';
  try {
    envBody = readFileSync(join(ws, '.env'), 'utf8');
  } catch {
    /* fresh file */
  }
  if (apiKey || envBody) {
    writeFileSync(
      join(ws, '.env'),
      upsertEnvLine(envBody, keyVar, apiKey, profile.provider === 'anthropic' ? [] : LEGACY_API_KEY_ENV_VARS),
      'utf8',
    );
  }

  // 2. The connection → .magentra/settings.json (merge over what exists).
  const dir = join(ws, '.magentra');
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh file */
  }

  settings.provider = profile.provider === 'anthropic' ? 'anthropic' : 'openai-compatible';
  if (profile.baseUrl) settings.baseUrl = profile.baseUrl;
  else delete settings.baseUrl;
  if (profile.model) settings.model = profile.model;
  const ctx = Number(profile.contextWindow);
  if (Number.isFinite(ctx) && ctx > 0) settings.contextWindow = ctx;
  else delete settings.contextWindow;
  // The IDE's validator vouched for the level when the profile was saved; the
  // engine's schema re-checks it on load.
  const effort = typeof profile.reasoningEffort === 'string' ? profile.reasoningEffort.trim() : '';
  if (effort) settings.reasoningEffort = effort;
  else delete settings.reasoningEffort;
  if (profile.insecureTls === true && profile.provider !== 'anthropic') settings.allowInsecureTls = true;
  else delete settings.allowInsecureTls;
  // A pin left by a previous provider would send key resolution right past the
  // key this write just saved — the IDE deletes it here, so we do too.
  delete settings.apiKeyEnv;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/** The connection-bearing part of `<ws>/.magentra/settings.json`, as applyProfile leaves it. */
export interface WorkspaceConnection {
  provider?: string;
  baseUrl?: string;
  model?: string;
  contextWindow?: number;
  reasoningEffort?: string;
  allowInsecureTls?: boolean;
  /** Whether `<ws>/.env` carries an API-key line. Never the key itself. */
  hasKeyLine: boolean;
}

/**
 * What this workspace is currently pointed at, or undefined if it names no
 * connection. The counterpart to `workspaceConnected`, which answers only
 * yes/no: a caller offering to CHANGE a connection has to be able to show what
 * it is changing from.
 *
 * Never returns the key — only whether a key line exists.
 */
export function readWorkspaceConnection(ws: string): WorkspaceConnection | undefined {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(ws, '.magentra', 'settings.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!settings.baseUrl && !settings.model && !settings.provider && !settings.apiKey) return undefined;

  let hasKeyLine = false;
  try {
    hasKeyLine = /^[A-Z0-9_]*API_KEY\s*=\s*\S/m.test(readFileSync(join(ws, '.env'), 'utf8'));
  } catch {
    /* no .env */
  }

  const ctx = Number(settings.contextWindow);
  return {
    ...(typeof settings.provider === 'string' ? { provider: settings.provider } : {}),
    ...(typeof settings.baseUrl === 'string' ? { baseUrl: settings.baseUrl } : {}),
    ...(typeof settings.model === 'string' ? { model: settings.model } : {}),
    ...(Number.isFinite(ctx) && ctx > 0 ? { contextWindow: ctx } : {}),
    ...(typeof settings.reasoningEffort === 'string' ? { reasoningEffort: settings.reasoningEffort } : {}),
    ...(settings.allowInsecureTls === true ? { allowInsecureTls: true } : {}),
    hasKeyLine,
  };
}

/** Every settings key applyProfile writes, so clearing is its exact inverse. */
const CONNECTION_SETTINGS_KEYS = [
  'provider',
  'baseUrl',
  'model',
  'contextWindow',
  'reasoningEffort',
  'allowInsecureTls',
  'apiKeyEnv',
  'apiKey',
] as const;

/**
 * Undo `applyProfile`: drop the key line from `<ws>/.env` and the connection
 * keys from `<ws>/.magentra/settings.json`, leaving both files and everything
 * else in them intact.
 *
 * Surgical rather than `rm`, because these two files are not the connection's
 * private property — `.env` carries whatever else the workspace needs, and
 * settings.json carries the other 20-odd keys of the settings schema. Deleting
 * either to clear an endpoint would take unrelated configuration with it.
 *
 * Cannot clear a key held in the ENVIRONMENT — see `environmentKeyVar`.
 */
export function clearWorkspaceConnection(ws: string): void {
  try {
    const body = readFileSync(join(ws, '.env'), 'utf8');
    writeFileSync(
      join(ws, '.env'),
      upsertEnvLine(body, DEFAULT_API_KEY_ENV, '', ['ANTHROPIC_API_KEY', ...LEGACY_API_KEY_ENV_VARS]),
      'utf8',
    );
  } catch {
    /* no .env to clear */
  }

  const settingsPath = join(ws, '.magentra', 'settings.json');
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return; // nothing committed here
  }
  for (const key of CONNECTION_SETTINGS_KEYS) delete settings[key];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/** What the picker shows: never the key, just enough to recognise the profile. */
export function describeProfile(p: Profile): string {
  const host = (() => {
    if (!p.baseUrl) return p.provider === 'anthropic' ? 'anthropic' : 'default endpoint';
    try {
      return new URL(p.baseUrl).host;
    } catch {
      return p.baseUrl;
    }
  })();
  return `${p.model ?? '(no model)'} · ${host}${(p.apiKey ?? '').trim() ? '' : ' · keyless'}`;
}

export function hasEnvFile(ws: string): boolean {
  return existsSync(join(ws, '.env'));
}
