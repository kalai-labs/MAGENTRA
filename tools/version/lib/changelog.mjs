// @ts-check
/**
 * Write the changelog.
 *
 * The tool adds a new section to the top of `CHANGELOG.md`. The tool does not
 * change the sections that are already there.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as version from './version.mjs';

const HEADER = [
  '# Changelog',
  '',
  'This file lists every release. The version tool writes it. Do not edit it by hand.',
  '',
  'The version has four parts: MAJOR.MINOR.PATCH.BUILD. To learn what the parts',
  'mean, read [VERSIONING.md](VERSIONING.md).',
  '',
].join('\n');

const MARKER = '<!-- new-release -->';

/**
 * Make the text of one release section.
 *
 * @param {import('./plan.mjs').Plan} plan
 * @param {import('./config.mjs').Config} config
 * @param {object} options
 * @param {string} options.date The release date, as `YYYY-MM-DD`.
 * @param {string | null} options.repositoryUrl The GitHub address, or `null`.
 * @returns {string}
 */
export function renderRelease(plan, config, options) {
  const next = version.format(plan.next);
  const lines = [`## ${next} — ${options.date}`, ''];

  if (plan.isFirstRelease) {
    lines.push('The first release.', '');
  }

  const breaking = plan.commits.filter((commit) => commit.breaking);
  if (breaking.length > 0) {
    lines.push('### Breaking changes', '');
    for (const commit of breaking) {
      lines.push(bullet(commit, options.repositoryUrl));
      for (const note of breakingNotes(commit.body)) {
        lines.push(`  ${note}`);
      }
    }
    lines.push('');
  }

  // Keep the order of the sections the same as the order of the types in the
  // configuration. Therefore the changelog always looks the same.
  /** @type {Map<string, import('./commits.mjs').ParsedCommit[]>} */
  const sections = new Map();
  for (const type of Object.keys(config.types)) {
    const section = /** @type {import('./config.mjs').TypeRule} */ (config.types[type]).section;
    if (!sections.has(section)) sections.set(section, []);
  }

  for (const commit of plan.commits) {
    const rule = config.types[commit.type];
    if (!rule) continue;
    /** @type {import('./commits.mjs').ParsedCommit[]} */ (sections.get(rule.section)).push(commit);
  }

  for (const [section, commits] of sections) {
    if (commits.length === 0) continue;
    lines.push(`### ${section}`, '');
    for (const commit of commits) {
      lines.push(bullet(commit, options.repositoryUrl));
    }
    lines.push('');
  }

  if (options.repositoryUrl && plan.fromTag) {
    const tag = `${config.tagPrefix}${next}`;
    lines.push(
      `[Compare with ${plan.fromTag}](${options.repositoryUrl}/compare/${plan.fromTag}...${tag})`,
      '',
    );
  }

  return lines.join('\n');
}

/**
 * Make one line of a list.
 *
 * @param {import('./commits.mjs').ParsedCommit} commit
 * @param {string | null} repositoryUrl
 * @returns {string}
 */
function bullet(commit, repositoryUrl) {
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  const link =
    repositoryUrl && commit.shortHash
      ? ` ([${commit.shortHash}](${repositoryUrl}/commit/${commit.hash}))`
      : '';
  return `- ${scope}${commit.subject}${link}`;
}

/**
 * Read the description of every break in a commit body.
 *
 * @param {string} body
 * @returns {string[]}
 */
function breakingNotes(body) {
  /** @type {string[]} */
  const notes = [];
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^BREAKING[ -]CHANGE:\s*(.+)$/.exec((lines[index] ?? '').trim());
    if (!match) continue;

    const note = [match[1]];
    // A description can continue on the lines that come after it.
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = (lines[next] ?? '').trim();
      if (!line || /^[A-Za-z-]+:/.test(line)) break;
      note.push(line);
    }
    notes.push(note.join(' '));
  }
  return notes;
}

/**
 * Add a release section to the top of `CHANGELOG.md`.
 *
 * @param {string} root The repository root.
 * @param {string} release The text of the release section.
 */
export function prependRelease(root, release) {
  const path = join(root, 'CHANGELOG.md');

  if (!existsSync(path)) {
    writeFileSync(path, `${HEADER}${MARKER}\n\n${release}`, 'utf8');
    return;
  }

  const current = readFileSync(path, 'utf8');

  if (current.includes(MARKER)) {
    writeFileSync(path, current.replace(MARKER, `${MARKER}\n\n${release.trimEnd()}`), 'utf8');
    return;
  }

  // The file has no marker. Put the new section after the first heading.
  const end = current.indexOf('\n## ');
  if (end === -1) {
    writeFileSync(path, `${current.trimEnd()}\n\n${release}`, 'utf8');
    return;
  }
  writeFileSync(
    path,
    `${current.slice(0, end + 1)}\n${release.trimEnd()}\n${current.slice(end)}`,
    'utf8',
  );
}
