// @ts-check
/**
 * Read `version.config.json` and `VERSION` from the repository root.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as version from './version.mjs';

/**
 * @typedef {object} TypeRule
 * @property {import('./version.mjs').Level} bump The part of the version to
 *   increase when a commit has this type.
 * @property {string} section The heading to use in the changelog.
 */

/**
 * @typedef {object} Target
 * @property {string} path A path from the repository root. A `*` is allowed in
 *   place of one directory name. For an example, see VERSIONING.md.
 * @property {'full' | 'semver'} format `full` writes `0.1.0.0`.
 *   `semver` writes `0.1.0`, for tools that accept only three parts.
 */

/**
 * @typedef {object} Config
 * @property {string} tagPrefix The text before the version in a git tag.
 * @property {string} releaseBranch The branch that produces releases.
 * @property {Target[]} targets The files that hold a copy of the version.
 * @property {Record<string, TypeRule>} types The allowed commit types.
 * @property {string[]} scopes The allowed commit scopes. An empty list allows
 *   every scope.
 * @property {number} subjectMaxLength The largest allowed length of a subject.
 */

/** @type {Config} */
const DEFAULTS = {
  tagPrefix: 'v',
  releaseBranch: 'main',
  targets: [],
  types: {},
  scopes: [],
  subjectMaxLength: 72,
};

/**
 * Read the configuration file.
 *
 * @param {string} root The repository root.
 * @returns {Config}
 */
export function loadConfig(root) {
  const path = join(root, 'version.config.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Cannot read the configuration file: ${path}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `The configuration file is not valid JSON: ${path}\n${String(error)}`,
    );
  }

  const config = { ...DEFAULTS, ...parsed };
  validateConfig(config, path);
  return config;
}

/**
 * Stop if the configuration is not usable.
 *
 * @param {Config} config
 * @param {string} path Used in error messages.
 */
function validateConfig(config, path) {
  /** @param {string} message */
  const fail = (message) => {
    throw new Error(`${path}: ${message}`);
  };

  if (Object.keys(config.types).length === 0) {
    fail('"types" must contain at least one commit type.');
  }

  for (const [name, rule] of Object.entries(config.types)) {
    if (!version.LEVELS.includes(rule.bump)) {
      fail(
        `type "${name}" has bump "${rule.bump}". ` +
          `Use one of: ${version.LEVELS.join(', ')}.`,
      );
    }
    if (!rule.section) {
      fail(`type "${name}" must have a "section".`);
    }
  }

  for (const target of config.targets) {
    if (target.format !== 'full' && target.format !== 'semver') {
      fail(
        `target "${target.path}" has format "${target.format}". ` +
          `Use "full" or "semver".`,
      );
    }
  }
}

/**
 * Read the current version from the `VERSION` file.
 *
 * @param {string} root The repository root.
 * @returns {import('./version.mjs').Version}
 */
export function readVersion(root) {
  const path = join(root, 'VERSION');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Cannot read the version file: ${path}`);
  }
  return version.parse(raw);
}

/**
 * Write the version to the `VERSION` file.
 *
 * @param {string} root The repository root.
 * @param {import('./version.mjs').Version} next
 */
export function writeVersion(root, next) {
  writeFileSync(join(root, 'VERSION'), `${version.format(next)}\n`, 'utf8');
}
