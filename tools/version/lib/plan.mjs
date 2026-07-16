// @ts-check
/**
 * Decide the next version from the commits since the last release.
 */

import { commitsSince, versionTags } from './git.mjs';
import { isGitGenerated, parseCommit } from './commits.mjs';
import * as version from './version.mjs';

/**
 * @typedef {object} Plan
 * @property {import('./version.mjs').Version} current The version now.
 * @property {import('./version.mjs').Version} next The version after the release.
 * @property {import('./version.mjs').Level | null} level The part of the version
 *   that increases. This is `null` for the first release.
 * @property {boolean} isFirstRelease True if no release exists yet.
 * @property {boolean} hasRelease True if the tool must make a release.
 * @property {string | null} fromTag The tag of the last release.
 * @property {import('./commits.mjs').ParsedCommit[]} commits The commits that
 *   the changelog includes.
 * @property {{ subject: string, shortHash: string }[]} ignored The commits that
 *   do not have the necessary form. The changelog does not include them.
 */

/**
 * Decide the next version.
 *
 * The first release does not increase the version. The first release uses the
 * version in the `VERSION` file exactly. Therefore the first release of this
 * repository is 0.1.0.0.
 *
 * After the first release, the largest bump of all commits decides the next
 * version. One `feat` commit and ten `docs` commits produce a MINOR bump,
 * because MINOR is larger than BUILD.
 *
 * The version must increase monotonically across releases. The `VERSION` file
 * can lag behind the tags: a release commit lives only on the remote until the
 * next pull, and a rebase can drop it entirely, while its tag stays. Bumping
 * from a stale file would then release a LOWER version than one that already
 * exists (this happened: v0.2.0.0 was the latest tag, a `fix` on a stale
 * checkout released v0.1.1.0). Therefore the base for the bump is the largest
 * of the `VERSION` file and the highest existing version tag.
 *
 * @param {string} root The repository root.
 * @param {import('./config.mjs').Config} config
 * @param {import('./version.mjs').Version} current
 * @returns {Plan}
 */
export function makePlan(root, config, current) {
  const lastTag = versionTags(root, config.tagPrefix)[0] ?? null;
  const fromTag = lastTag?.tag ?? null;
  if (lastTag && version.compare(lastTag.version, current) > 0) {
    current = lastTag.version;
  }
  const raw = commitsSince(root, fromTag);

  /** @type {import('./commits.mjs').ParsedCommit[]} */
  const commits = [];
  /** @type {{ subject: string, shortHash: string }[]} */
  const ignored = [];

  for (const commit of raw) {
    if (isGitGenerated(commit.subject)) continue;

    const parsed = parseCommit(commit);
    if (parsed && config.types[parsed.type]) {
      commits.push(parsed);
    } else {
      ignored.push({ subject: commit.subject, shortHash: commit.shortHash });
    }
  }

  if (!fromTag) {
    return {
      current,
      next: current,
      level: null,
      isFirstRelease: true,
      hasRelease: true,
      fromTag: null,
      commits,
      ignored,
    };
  }

  /** @type {import('./version.mjs').Level[]} */
  const levels = commits.map((commit) =>
    commit.breaking ? 'major' : /** @type {import('./config.mjs').TypeRule} */ (config.types[commit.type]).bump,
  );

  const level = version.largestLevel(levels);

  return {
    current,
    next: level ? version.bump(current, level) : current,
    level,
    isFirstRelease: false,
    hasRelease: level !== null,
    fromTag,
    commits,
    ignored,
  };
}
