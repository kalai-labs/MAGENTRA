// @ts-check
/**
 * Read and check a commit message.
 *
 * A commit message must have this form:
 *
 *     type(scope)!: subject
 *
 *     body
 *
 *     BREAKING CHANGE: description
 *
 * Only `type` and `subject` are necessary. The `(scope)` part and the `!` mark
 * are optional. The `!` mark and the `BREAKING CHANGE:` footer have the same
 * result: the MAJOR part of the version increases.
 */

/**
 * @typedef {object} ParsedCommit
 * @property {string} type For example `feat`.
 * @property {string | null} scope For example `cli`.
 * @property {boolean} breaking True if the commit breaks the public behaviour.
 * @property {string} subject The short description.
 * @property {string} body The rest of the message.
 * @property {string} hash The full commit hash.
 * @property {string} shortHash The short commit hash.
 */

/**
 * @typedef {object} Problem
 * @property {string} message What is wrong.
 * @property {string} [hint] How to repair it.
 */

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

// A revert commit that git itself writes. The tool accepts it without a check.
const GIT_REVERT = /^Revert ".*"$/;

/**
 * Report whether a message is a merge commit or a revert commit that git wrote.
 * The tool does not check these messages, because a user did not write them.
 *
 * @param {string} subject
 * @returns {boolean}
 */
export function isGitGenerated(subject) {
  return subject.startsWith('Merge ') || GIT_REVERT.test(subject);
}

/**
 * Read a commit message.
 *
 * @param {{ subject: string, body?: string, hash?: string, shortHash?: string }} commit
 * @returns {ParsedCommit | null} `null` if the subject does not have the
 *   necessary form.
 */
export function parseCommit(commit) {
  const match = HEADER.exec(commit.subject);
  if (!match?.groups) return null;

  const body = commit.body ?? '';
  const { type, scope, breaking, subject } = match.groups;

  return {
    type: /** @type {string} */ (type),
    scope: scope ?? null,
    breaking: Boolean(breaking) || hasBreakingFooter(body),
    subject: /** @type {string} */ (subject),
    body,
    hash: commit.hash ?? '',
    shortHash: commit.shortHash ?? '',
  };
}

/**
 * Report whether the body declares a break.
 *
 * @param {string} body
 * @returns {boolean}
 */
function hasBreakingFooter(body) {
  return body
    .split(/\r?\n/)
    .some((line) => /^BREAKING[ -]CHANGE:\s*\S/.test(line.trim()));
}

/**
 * Check a commit message against the configuration.
 *
 * @param {string} message The complete commit message.
 * @param {import('./config.mjs').Config} config
 * @returns {Problem[]} An empty list if the message is correct.
 */
export function checkMessage(message, config) {
  /** @type {Problem[]} */
  const problems = [];

  // Git puts comment lines in the message file. Remove them first.
  const lines = message
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'));

  const subject = (lines[0] ?? '').trim();
  const body = lines.slice(1).join('\n');

  if (!subject) {
    problems.push({ message: 'The commit message is empty.' });
    return problems;
  }

  if (isGitGenerated(subject)) return problems;

  const match = HEADER.exec(subject);
  if (!match?.groups) {
    problems.push({
      message: `The subject does not have the necessary form: "${subject}"`,
      hint:
        'Use "type(scope): subject", for example "fix(cli): stop the crash on exit".\n' +
        'A colon and one space must come after the type.',
    });
    return problems;
  }

  const type = /** @type {string} */ (match.groups.type);
  const scope = match.groups.scope ?? null;
  const text = /** @type {string} */ (match.groups.subject);

  const allowedTypes = Object.keys(config.types);
  if (!allowedTypes.includes(type)) {
    problems.push({
      message: `Unknown type: "${type}"`,
      hint: `Use one of: ${allowedTypes.join(', ')}`,
    });
  }

  if (scope !== null && config.scopes.length > 0 && !config.scopes.includes(scope)) {
    problems.push({
      message: `Unknown scope: "${scope}"`,
      hint: `Use one of: ${config.scopes.join(', ')}`,
    });
  }

  if (scope !== null && scope.trim() === '') {
    problems.push({ message: 'The scope is empty. Remove the brackets.' });
  }

  if (subject.length > config.subjectMaxLength) {
    problems.push({
      message:
        `The subject is ${subject.length} characters. ` +
        `The largest allowed length is ${config.subjectMaxLength}.`,
      hint: 'Write a shorter subject. Put the details in the body.',
    });
  }

  if (text.endsWith('.')) {
    problems.push({
      message: 'The subject ends with a full stop.',
      hint: 'Remove the full stop.',
    });
  }

  if (/^[A-Z][a-z]/.test(text)) {
    problems.push({
      message: 'The subject starts with a capital letter.',
      hint: 'Start with a small letter, for example "add", not "Add".',
    });
  }

  // The body must be separate from the subject. Git treats the second line as
  // part of the subject when it is not empty.
  if (lines.length > 1 && (lines[1] ?? '').trim() !== '') {
    problems.push({
      message: 'The line after the subject is not empty.',
      hint: 'Put one empty line between the subject and the body.',
    });
  }

  if (/^BREAKING[ -]CHANGE/m.test(body) && !/^BREAKING[ -]CHANGE:\s*\S/m.test(body)) {
    problems.push({
      message: 'The BREAKING CHANGE footer has no description.',
      hint: 'Write "BREAKING CHANGE: " and then tell the user what to do.',
    });
  }

  return problems;
}
