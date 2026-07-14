// @ts-check
/**
 * A small wrapper around the `git` command.
 *
 * Every function uses `execFileSync`. Arguments go to git directly. They do not
 * go through a shell. Therefore a branch name or a message cannot run a command.
 */

import { execFileSync } from 'node:child_process';

import { compare as compareVersions, parse as parseVersion } from './version.mjs';

/**
 * Run git and return what it prints.
 *
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {string} The output, without the spaces at the ends.
 */
export function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * Find the root of the repository.
 *
 * @param {string} [from] The directory to start from.
 * @returns {string} An absolute path.
 * @throws {Error} If the directory is not in a git repository.
 */
export function repositoryRoot(from = process.cwd()) {
  try {
    return git(['rev-parse', '--show-toplevel'], { cwd: from });
  } catch {
    throw new Error('This directory is not in a git repository.');
  }
}

/**
 * List every tag that holds a version, newest first.
 *
 * The list uses the version number, and not the date of the tag. A date is not
 * reliable: two tags can have the same date, and a person can make a tag later
 * than the release. A version number always increases. Therefore it gives one
 * correct order.
 *
 * @param {string} root
 * @param {string} tagPrefix
 * @returns {{ tag: string, version: import('./version.mjs').Version }[]}
 */
export function versionTags(root, tagPrefix) {
  const pattern = `${tagPrefix}[0-9]*.[0-9]*.[0-9]*.[0-9]*`;
  const output = git(['tag', '--list', pattern], { cwd: root });
  if (!output) return [];

  /** @type {{ tag: string, version: import('./version.mjs').Version }[]} */
  const tags = [];

  for (const tag of output.split('\n').filter(Boolean)) {
    try {
      tags.push({ tag, version: parseVersion(tag.slice(tagPrefix.length)) });
    } catch {
      // The tag looks like a version tag, but it is not one. Ignore it.
    }
  }

  return tags.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Find the tag of the last release.
 *
 * @param {string} root
 * @param {string} tagPrefix
 * @returns {string | null} `null` if no release exists.
 */
export function lastVersionTag(root, tagPrefix) {
  return versionTags(root, tagPrefix)[0]?.tag ?? null;
}

/**
 * @typedef {object} RawCommit
 * @property {string} hash The full commit hash.
 * @property {string} shortHash The short commit hash.
 * @property {string} subject The first line of the message.
 * @property {string} body The rest of the message.
 */

// Git writes these separators between the fields and between the records.
// A commit message cannot contain them.
const FIELD = '\x1f';
const RECORD = '\x1e';

/**
 * Read the commits in a range.
 *
 * @param {string} root
 * @param {string | null} fromTag Read the commits after this tag. Use `null` to
 *   read every commit in the history.
 * @returns {RawCommit[]} Oldest first.
 */
export function commitsSince(root, fromTag) {
  const range = fromTag ? `${fromTag}..HEAD` : 'HEAD';
  let output;
  try {
    output = git(
      ['log', '--reverse', '--no-merges', `--format=%H${FIELD}%h${FIELD}%s${FIELD}%b${RECORD}`, range],
      { cwd: root },
    );
  } catch {
    // A repository with no commits makes `git log` fail.
    return [];
  }

  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', shortHash = '', subject = '', body = ''] = record.split(FIELD);
      return { hash, shortHash, subject, body: body.trim() };
    });
}

/**
 * Read the address of the `origin` remote.
 *
 * @param {string} root
 * @returns {string | null} `null` if there is no `origin` remote.
 */
export function originUrl(root) {
  try {
    return git(['remote', 'get-url', 'origin'], { cwd: root });
  } catch {
    return null;
  }
}

/**
 * Change a git remote address into an `https://github.com/owner/name` address.
 *
 * @param {string | null} url
 * @returns {string | null} `null` if the address is not a GitHub address.
 */
export function githubHttpsUrl(url) {
  if (!url) return null;
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}`;
}

/**
 * Report whether any file changed but is not committed.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function hasUncommittedChanges(root) {
  return git(['status', '--porcelain'], { cwd: root }).length > 0;
}
