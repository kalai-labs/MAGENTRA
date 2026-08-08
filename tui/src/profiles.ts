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
 * Can the engine boot in this workspace as it stands? Mirrors the boot inputs:
 * a key in the environment, a key line in `<ws>/.env` (the host loads it), or
 * a `.magentra/settings.json` that names a connection (keyless local servers
 * have no key line at all — their config lives entirely in settings).
 */
export function workspaceConnected(ws: string): boolean {
  for (const name of ['MAGENTRA_API_KEY', 'ANTHROPIC_API_KEY', ...LEGACY_API_KEY_ENV_VARS]) {
    if ((process.env[name] ?? '').trim() !== '') return true;
  }

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
  if (profile.insecureTls === true && profile.provider !== 'anthropic') settings.allowInsecureTls = true;
  else delete settings.allowInsecureTls;
  // A pin left by a previous provider would send key resolution right past the
  // key this write just saved — the IDE deletes it here, so we do too.
  delete settings.apiKeyEnv;

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
