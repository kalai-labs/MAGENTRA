// @ts-check
/**
 * The MAGENTRA version number.
 *
 * A version has four parts: MAJOR.MINOR.PATCH.BUILD
 *
 *   MAJOR  The public behaviour changed in a way that breaks users.
 *   MINOR  A new feature is available. Old behaviour still works.
 *   PATCH  A defect is repaired. No new feature.
 *   BUILD  Nothing that a user can observe changed.
 *
 * When you increase one part, all smaller parts go back to 0.
 */

/**
 * @typedef {object} Version
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {number} build
 */

/**
 * @typedef {'major' | 'minor' | 'patch' | 'build'} Level
 */

/** The four levels, from the largest to the smallest. */
export const LEVELS = /** @type {readonly Level[]} */ ([
  'major',
  'minor',
  'patch',
  'build',
]);

const PATTERN = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

/**
 * Read a version from text.
 *
 * @param {string} text For example `0.1.0.0`.
 * @returns {Version}
 * @throws {Error} If the text is not a valid version.
 */
export function parse(text) {
  const match = PATTERN.exec(String(text).trim());
  if (!match) {
    throw new Error(
      `Invalid version: "${text}". A version must have four numbers, ` +
        `for example 0.1.0.0`,
    );
  }
  const [, major, minor, patch, build] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    build: Number(build),
  };
}

/**
 * Write a version as text.
 *
 * @param {Version} version
 * @returns {string} For example `0.1.0.0`.
 */
export function format(version) {
  return `${version.major}.${version.minor}.${version.patch}.${version.build}`;
}

/**
 * Write a version as a three-part semantic version.
 *
 * Some tools accept only three parts. Those tools reject `0.1.0.0`.
 * For those tools, use this shorter form. The BUILD part is not included,
 * because a BUILD change does not change what the tool produces.
 *
 * @param {Version} version
 * @returns {string} For example `0.1.0`.
 */
export function toSemver(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
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
      return { major: version.major + 1, minor: 0, patch: 0, build: 0 };
    case 'minor':
      return { major: version.major, minor: version.minor + 1, patch: 0, build: 0 };
    case 'patch':
      return {
        major: version.major,
        minor: version.minor,
        patch: version.patch + 1,
        build: 0,
      };
    case 'build':
      return {
        major: version.major,
        minor: version.minor,
        patch: version.patch,
        build: version.build + 1,
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
  return (
    a.major - b.major || a.minor - b.minor || a.patch - b.patch || a.build - b.build
  );
}

/**
 * Find the largest of some levels.
 *
 * `major` is the largest level. `build` is the smallest level.
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
