// @ts-check
/**
 * Copy the version into the target files.
 *
 * The `VERSION` file always holds the true version. The target files hold a
 * copy. A copy is necessary because other tools, for example npm, read the
 * version from `package.json`.
 *
 * A target has one of two formats:
 *
 *   full    The complete version, for example `0.1.0.0`.
 *   semver  Only the first three parts, for example `0.1.0`.
 *
 * Use `semver` for a tool that accepts only three parts. Two examples are
 * electron-builder and vsce. These tools reject `0.1.0.0`. The BUILD part is
 * safe to remove, because a BUILD change does not change the behaviour.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as version from './version.mjs';

/**
 * @typedef {object} SyncResult
 * @property {string} path The path of the file, from the repository root.
 * @property {string} from The version before the change.
 * @property {string} to The version after the change.
 * @property {boolean} changed True if the tool wrote the file.
 */

/**
 * Write the version into every target file.
 *
 * A target that matches no file is not an error. The repository can grow later,
 * and the configuration can name a directory that does not exist yet.
 *
 * @param {string} root The repository root.
 * @param {import('./config.mjs').Config} config
 * @param {import('./version.mjs').Version} next
 * @param {{ dryRun?: boolean }} [options]
 * @returns {SyncResult[]}
 */
export function syncTargets(root, config, next, options = {}) {
  /** @type {SyncResult[]} */
  const results = [];

  for (const target of config.targets) {
    const text =
      target.format === 'semver' ? version.toSemver(next) : version.format(next);

    for (const relative of expand(root, target.path)) {
      const result = writeJsonVersion(root, relative, text, options.dryRun ?? false);
      if (result) results.push(result);
    }
  }

  return results;
}

/**
 * Write the `version` field of a JSON file.
 *
 * The tool keeps the order of the fields and the style of the file. The tool
 * replaces only the value of the `version` field.
 *
 * @param {string} root
 * @param {string} relative
 * @param {string} text The new version.
 * @param {boolean} dryRun
 * @returns {SyncResult | null} `null` if the file has no `version` field.
 */
function writeJsonVersion(root, relative, text, dryRun) {
  const path = join(root, relative);
  const current = readFileSync(path, 'utf8');

  /** @type {{ version?: unknown }} */
  let parsed;
  try {
    parsed = JSON.parse(current);
  } catch (error) {
    throw new Error(`${relative} is not valid JSON.\n${String(error)}`);
  }

  if (typeof parsed.version !== 'string') return null;

  const from = parsed.version;
  if (from === text) {
    return { path: relative, from, to: text, changed: false };
  }

  // Replace only the first `"version": "..."` pair. A rewrite of the complete
  // JSON would lose the indentation and the order of the fields.
  const pattern = /("version"\s*:\s*")[^"]*(")/;
  if (!pattern.test(current)) {
    throw new Error(`Cannot find the "version" field in ${relative}.`);
  }
  const updated = current.replace(pattern, `$1${text}$2`);

  if (!dryRun) writeFileSync(path, updated, 'utf8');

  return { path: relative, from, to: text, changed: true };
}

/**
 * Find the files that a target path names.
 *
 * A `*` stands for one directory name. `packages/{star}/package.json` finds
 * `package.json` in every directory in `packages`.
 *
 * @param {string} root
 * @param {string} pattern
 * @returns {string[]} Paths from the repository root. The list is sorted.
 */
function expand(root, pattern) {
  const parts = pattern.split('/');
  /** @type {string[]} */
  let found = [''];

  for (const part of parts) {
    /** @type {string[]} */
    const next = [];

    for (const prefix of found) {
      if (part === '*') {
        const directory = join(root, prefix);
        if (!existsSync(directory)) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            next.push(prefix ? `${prefix}/${entry.name}` : entry.name);
          }
        }
      } else {
        next.push(prefix ? `${prefix}/${part}` : part);
      }
    }

    found = next;
  }

  return found.filter((relative) => existsSync(join(root, relative))).sort();
}
