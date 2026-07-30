// @ts-check
/**
 * The MAGENTRA version number.
 *
 * A version has three parts: MAJOR.MINOR.PATCH
 *
 *   MAJOR  The public behaviour changed in a way that breaks users.
 *   MINOR  A new feature is available. Old behaviour still works.
 *   PATCH  Everything else that ships.
 *
 * When you increase one part, all smaller parts go back to 0.
 *
 * This is semantic versioning, because the desktop updater compares versions
 * with semver and nothing else. See docs/adr/0008-the-version-is-semver.md.
 */

/**
 * @typedef {object} Version
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 */

/**
 * @typedef {'major' | 'minor' | 'patch'} Level
 */

/** The three levels, from the largest to the smallest. */
export const LEVELS = /** @type {readonly Level[]} */ ([
  'major',
  'minor',
  'patch',
]);

// The fourth group reads the BUILD part of a version from before the move to
// semver. Releases up to v0.13.0.0 carry a four-part tag, and those tags live in
// the repository forever, so the tag reader must keep understanding them. The
// part is read and dropped: `0.13.0.0` and `0.13.0` are the same version, which
// is exactly what the packaged app already reported for both.
const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/;

/**
 * Read a version from text.
 *
 * @param {string} text For example `0.1.0`. A legacy four-part version is also
 *   accepted, and its fourth part is dropped.
 * @returns {Version}
 * @throws {Error} If the text is not a valid version.
 */
export function parse(text) {
  const match = PATTERN.exec(String(text).trim());
  if (!match) {
    throw new Error(
      `Invalid version: "${text}". A version must have three numbers, ` +
        `for example 0.1.0`,
    );
  }
  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

/**
 * Write a version as text.
 *
 * @param {Version} version
 * @returns {string} For example `0.1.0`.
 */
export function format(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Read the dropped BUILD part of a legacy four-part version.
 *
 * Two legacy tags can carry the same semantic version: `v0.13.0.0` and
 * `v0.13.0.1` are both `0.13.0`. Ordering by version alone leaves those tied,
 * and picking the older one of a tie makes the next release read the commits of
 * the newer one again — they would appear in two changelogs. This orders a tie.
 *
 * @param {string} text
 * @returns {number} `0` when the version has three parts.
 */
export function legacyBuild(text) {
  const match = PATTERN.exec(String(text).trim());
  return match && match[4] !== undefined ? Number(match[4]) : 0;
}

/**
 * Increase one part of a version. All smaller parts go back to 0.
 *
 * @param {Version} version
 * @param {Level} level
 * @returns {Version} A new version. The given version does not change.
 */
export function bump(version, level) {
  switch (level) {
    case 'major':
      return { major: version.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: version.major, minor: version.minor + 1, patch: 0 };
    case 'patch':
      return {
        major: version.major,
        minor: version.minor,
        patch: version.patch + 1,
      };
    default:
      throw new Error(`Unknown level: "${level}"`);
  }
}

/**
 * Compare two versions.
 *
 * @param {Version} a
 * @param {Version} b
 * @returns {number} A negative number if `a` is older than `b`. Zero if they
 *   are equal. A positive number if `a` is newer than `b`.
 */
export function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Find the largest of some levels.
 *
 * `major` is the largest level. `patch` is the smallest level.
 *
 * @param {readonly Level[]} levels
 * @returns {Level | null} The largest level, or `null` if the list is empty.
 */
export function largestLevel(levels) {
  /** @type {Level | null} */
  let best = null;
  let bestRank = LEVELS.length;
  for (const level of levels) {
    const rank = LEVELS.indexOf(level);
    if (rank === -1) throw new Error(`Unknown level: "${level}"`);
    if (rank < bestRank) {
      bestRank = rank;
      best = level;
    }
  }
  return best;
}
