/**
 * TUI configuration: where the MAGENTRA engine lives.
 *
 * One file, one key. `~/.magentra-tui.json` holds `engineHome` — the root of a
 * MAGENTRA checkout (or install) whose built host this TUI spawns. Everything
 * else — connections, keys, models, profiles — is MAGENTRA's own layered
 * settings, owned by the IDE; this file must never grow copies of them.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_PATH = join(homedir(), '.magentra-tui.json');

export type TuiConfig = { engineHome: string };

/** Everything needed to spawn the engine host process. */
export type EngineSpawn = { command: string; args: string[]; env: NodeJS.ProcessEnv };

const bundleDir = dirname(fileURLToPath(import.meta.url));
const packagedEngine = join(bundleDir, 'engine.cjs');

/**
 * True when running as the shipped `resources/engine/tui.mjs` — the bundled
 * engine is our sibling there, and only there. In a dev checkout this file
 * lives under tui/src (or tui/dist) where no engine.cjs ever sits.
 */
export function isPackagedRun(): boolean {
  return existsSync(packagedEngine);
}

/**
 * How to spawn the engine host for `workspace`.
 *
 * Packaged: the sibling engine.cjs through Electron's own Node — under
 * ELECTRON_RUN_AS_NODE `process.execPath` IS the shipped Electron binary,
 * which is the exact pattern app/main.js uses for the same bundle. No system
 * Node exists on an installed machine.
 *
 * Dev: the `~/.magentra-tui.json` checkout through system node, unchanged.
 */
export function resolveEngineSpawn(workspace: string): EngineSpawn {
  if (isPackagedRun()) {
    return {
      command: process.execPath,
      args: [packagedEngine, '--cwd', workspace],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  const { engineHome } = loadConfig();
  return {
    command: 'node',
    args: [hostEntry(engineHome), '--cwd', workspace],
    env: { ...process.env },
  };
}

/** The host entry inside an engine home. main.js self-executes and speaks NDJSON. */
export function hostEntry(engineHome: string): string {
  return join(engineHome, 'engine', 'host', 'dist', 'main.js');
}

/**
 * Best guess for a first run: this file lives at <repo>/tui/src (dev) — the
 * repo root two levels up IS the engine home.
 */
function guessEngineHome(): string {
  const tuiRoot = resolve(bundleDir, '..');
  return dirname(tuiRoot);
}

/**
 * Load the config, creating it with a best-guess engineHome on first run.
 * Throws with actionable text when the configured home has no built host —
 * a TUI that starts against nothing must say which file to fix.
 */
export function loadConfig(): TuiConfig {
  let config: TuiConfig;

  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<TuiConfig>;
      if (typeof raw.engineHome !== 'string' || raw.engineHome.length === 0) {
        throw new Error('missing "engineHome"');
      }
      config = { engineHome: raw.engineHome };
    } catch (err) {
      throw new Error(
        `could not read ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}\n` +
          `expected: { "engineHome": "C:/path/to/MAGENTRA" }`,
      );
    }
  } else {
    config = { engineHome: guessEngineHome() };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  if (!existsSync(hostEntry(config.engineHome))) {
    throw new Error(
      `no built MAGENTRA host at ${hostEntry(config.engineHome)}\n` +
        `set "engineHome" in ${CONFIG_PATH} to a MAGENTRA checkout,\n` +
        `and run "npm run build" there if engine/*/dist is missing.`,
    );
  }

  return config;
}
