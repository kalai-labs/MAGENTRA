/**
 * Folder trust for terminal sessions.
 *
 * `magentra` runs wherever the shell happens to be, so the first thing a
 * session must establish is whether this folder is one the user meant to hand
 * an autonomous agent. Two things hang off the answer:
 *
 *   1. Credentials. The profile picker writes an API key into `<ws>/.env` —
 *      that must never happen in a folder the user has not vouched for, so the
 *      trust gate runs BEFORE the picker, not after it.
 *   2. OVERDRIVE. Terminal sessions default to the autonomous stance, and that
 *      default is only defensible in a folder the user explicitly trusted.
 *
 * The record is GLOBAL — `~/.magentra/trusted-folders.json`, beside the
 * profile store. A marker file inside the workspace would be worthless: the
 * folder being judged could ship one, and cloning a repo would pre-trust it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

type TrustFile = { version: number; folders: Record<string, { trustedAt: string }> };

const VERSION = 1;

export function trustPath(): string {
  return join(homedir(), '.magentra', 'trusted-folders.json');
}

/** Windows paths are case-insensitive; a trailing separator is never meaningful. */
function normalize(dir: string): string {
  const abs = resolve(dir).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function read(): TrustFile {
  try {
    const parsed = JSON.parse(readFileSync(trustPath(), 'utf8')) as Partial<TrustFile>;
    if (parsed && typeof parsed === 'object' && parsed.folders && typeof parsed.folders === 'object') {
      return { version: VERSION, folders: parsed.folders as TrustFile['folders'] };
    }
  } catch {
    /* absent or mangled — an unreadable store means "nothing is trusted yet" */
  }
  return { version: VERSION, folders: {} };
}

/**
 * Is this folder trusted, directly or by an already-trusted ancestor?
 *
 * Ancestor inheritance is what keeps `magentra src/` from re-asking inside a
 * repository the user already vouched for. It matches on path SEGMENTS, so
 * `/home/me/work` never trusts `/home/me/workspace-of-someone-else`.
 */
export function isTrusted(ws: string): boolean {
  const target = normalize(ws);
  const folders = Object.keys(read().folders).map(normalize);
  return folders.some((f) => target === f || target.startsWith(f + sep));
}

/** Record trust for this exact folder. */
export function trustFolder(ws: string): void {
  const file = read();
  file.folders[resolve(ws).replace(/[\\/]+$/, '')] = { trustedAt: new Date().toISOString() };
  const dir = join(homedir(), '.magentra');
  mkdirSync(dir, { recursive: true });
  writeFileSync(trustPath(), JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

/** True when the store has never been written — used only for first-run copy. */
export function noTrustStoreYet(): boolean {
  return !existsSync(trustPath());
}
