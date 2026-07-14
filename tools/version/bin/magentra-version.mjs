#!/usr/bin/env node
// @ts-check
/**
 * The MAGENTRA version tool.
 *
 * This tool has no dependencies. It uses only Node.js and git. Therefore it
 * runs immediately after a clone. A build is not necessary.
 *
 * Commands:
 *
 *   current   Print the version now.
 *   plan      Show the next version. Change nothing.
 *   apply     Make the release: write the files, commit, and tag.
 *   check     Check one commit message, or every commit in a range.
 *   commit    Write a correct commit message with questions and answers.
 *
 * To learn more, read VERSIONING.md.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { loadConfig, readVersion, writeVersion } from '../lib/config.mjs';
import { checkMessage, isGitGenerated } from '../lib/commits.mjs';
import { prependRelease, renderRelease } from '../lib/changelog.mjs';
import { makePlan } from '../lib/plan.mjs';
import { syncTargets } from '../lib/sync.mjs';
import * as git from '../lib/git.mjs';
import * as ui from '../lib/ui.mjs';
import * as version from '../lib/version.mjs';

const USAGE = `
${ui.bold('magentra-version')} — the MAGENTRA version tool

${ui.bold('Usage')}
  npm run version:current      Print the version now
  npm run version:plan         Show the next version. Change nothing
  npm run version:apply        Make the release. The release job uses this
  npm run version:check        Check the commits of your branch
  npm run commit               Write a correct commit message

${ui.bold('Options')}
  apply  --dry-run             Show every change. Write nothing
         --no-git              Write the files. Do not commit. Do not tag
  check  --message-file <path> Check the message in a file
         --range <range>       Check every commit in a git range,
                               for example origin/main..HEAD

To learn how the version works, read VERSIONING.md.
`.trim();

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'current':
      return commandCurrent();
    case 'plan':
      return commandPlan();
    case 'apply':
      return commandApply(rest);
    case 'check':
      return commandCheck(rest);
    case 'commit':
      return commandCommit();
    case undefined:
    case '-h':
    case '--help':
      ui.info(USAGE);
      return;
    default:
      ui.error(`Unknown command: "${command}"`);
      ui.info(`\n${USAGE}`);
      process.exitCode = 2;
  }
}

/** Load everything that most commands need. */
function context() {
  const root = git.repositoryRoot();
  const config = loadConfig(root);
  const current = readVersion(root);
  return { root, config, current };
}

// --- current ----------------------------------------------------------------

function commandCurrent() {
  const { current } = context();
  ui.info(version.format(current));
}

// --- plan -------------------------------------------------------------------

function commandPlan() {
  const { root, config, current } = context();
  const plan = makePlan(root, config, current);
  reportPlan(plan, config, root);
}

/**
 * @param {import('../lib/plan.mjs').Plan} plan
 * @param {import('../lib/config.mjs').Config} config
 * @param {string} root
 */
function reportPlan(plan, config, root) {
  const from = version.format(plan.current);
  const to = version.format(plan.next);

  if (plan.isFirstRelease) {
    ui.heading('The first release');
    ui.info(`  Version: ${ui.green(to)}`);
    ui.info(ui.dim('  The first release uses the VERSION file. It does not bump.'));
  } else if (!plan.hasRelease) {
    ui.heading('No release');
    ui.info(`  The version stays ${ui.bold(from)}.`);
    ui.info(ui.dim(`  No commit after ${plan.fromTag} changes the version.`));
    reportIgnored(plan);
    return;
  } else {
    ui.heading('Next release');
    ui.info(`  ${ui.dim(from)} ${ui.dim('→')} ${ui.green(to)}   ${ui.cyan(`(${plan.level})`)}`);
    ui.info(ui.dim(`  ${plan.commits.length} commit(s) after ${plan.fromTag}`));
  }

  const breaking = plan.commits.filter((commit) => commit.breaking);
  if (breaking.length > 0) {
    ui.heading('Breaking changes');
    for (const commit of breaking) {
      ui.info(`  ${ui.red('!')} ${commit.scope ? `${commit.scope}: ` : ''}${commit.subject}`);
    }
  }

  ui.heading('Changelog');
  const release = renderRelease(plan, config, {
    date: today(),
    repositoryUrl: git.githubHttpsUrl(git.originUrl(root)),
  });
  ui.info(
    release
      .split('\n')
      .map((line) => `  ${ui.dim(line)}`)
      .join('\n'),
  );

  ui.heading('Files');
  const results = syncTargets(root, config, plan.next, { dryRun: true });
  if (results.length === 0) {
    ui.info(ui.dim('  No target file exists yet. See "targets" in version.config.json.'));
  }
  for (const result of results) {
    const mark = result.changed ? ui.green('~') : ui.dim('=');
    ui.info(`  ${mark} ${result.path}  ${ui.dim(`${result.from} → ${result.to}`)}`);
  }

  reportIgnored(plan);
}

/** @param {import('../lib/plan.mjs').Plan} plan */
function reportIgnored(plan) {
  if (plan.ignored.length === 0) return;
  ui.heading('Ignored commits');
  ui.info(ui.dim('  These commits do not have the necessary form. The changelog'));
  ui.info(ui.dim('  does not include them, and they do not change the version.'));
  ui.info('');
  for (const commit of plan.ignored) {
    ui.info(`  ${ui.yellow('?')} ${ui.dim(commit.shortHash)} ${commit.subject}`);
  }
}

// --- apply ------------------------------------------------------------------

/** @param {string[]} args */
function commandApply(args) {
  const dryRun = args.includes('--dry-run');
  const noGit = args.includes('--no-git');
  const { root, config, current } = context();

  const plan = makePlan(root, config, current);

  if (!plan.hasRelease) {
    ui.info('No release. No commit changes the version.');
    return;
  }

  if (dryRun) {
    reportPlan(plan, config, root);
    ui.info('');
    ui.warn('This is a dry run. The tool wrote nothing.');
    return;
  }

  if (!noGit && git.hasUncommittedChanges(root)) {
    throw new Error(
      'Some changes are not committed. Commit them, or remove them, and try again.',
    );
  }

  const next = version.format(plan.next);
  const tag = `${config.tagPrefix}${next}`;

  const release = renderRelease(plan, config, {
    date: today(),
    repositoryUrl: git.githubHttpsUrl(git.originUrl(root)),
  });

  writeVersion(root, plan.next);
  const results = syncTargets(root, config, plan.next);
  prependRelease(root, release);

  ui.success(`VERSION → ${ui.green(next)}`);
  for (const result of results.filter((item) => item.changed)) {
    ui.success(`${result.path} → ${result.to}`);
  }
  ui.success('CHANGELOG.md');

  if (noGit) {
    ui.warn('The tool did not commit and did not tag, because of --no-git.');
    return;
  }

  // `[skip ci]` stops GitHub Actions from starting the release job again for
  // this commit. Without it, the release job would run without an end.
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'inherit' });
  execFileSync(
    'git',
    ['commit', '-m', `chore(release): ${tag} [skip ci]`],
    { cwd: root, stdio: 'inherit' },
  );
  execFileSync('git', ['tag', '-a', tag, '-m', `${tag}\n\n${release}`], {
    cwd: root,
    stdio: 'inherit',
  });

  ui.success(`Commit and tag ${ui.green(tag)}`);
  ui.info(ui.dim(`\nTo publish the release, push the commit and the tag:`));
  ui.info(ui.dim(`  git push --follow-tags origin ${config.releaseBranch}`));

  // The release job reads these values.
  writeGithubOutput({ released: 'true', version: next, tag });
}

// --- check ------------------------------------------------------------------

/** @param {string[]} args */
function commandCheck(args) {
  const { root, config } = context();

  const fileIndex = args.indexOf('--message-file');
  const rangeIndex = args.indexOf('--range');

  if (fileIndex !== -1) {
    const path = args[fileIndex + 1];
    if (!path) throw new Error('--message-file needs a path.');
    const message = readFileSync(path, 'utf8');
    const problems = checkMessage(message, config);
    if (problems.length === 0) {
      ui.success('The commit message is correct.');
      return;
    }
    reportProblems(message.split('\n')[0] ?? '', problems, config);
    process.exitCode = 1;
    return;
  }

  const range = rangeIndex !== -1 ? args[rangeIndex + 1] : null;
  if (rangeIndex !== -1 && !range) throw new Error('--range needs a range.');

  const commits = range
    ? git
        .git(['log', '--reverse', '--no-merges', '--format=%h\x1f%s', range], { cwd: root })
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [shortHash = '', subject = ''] = line.split('\x1f');
          return { shortHash, subject };
        })
    : commitsOfBranch(root, config);

  const toCheck = commits.filter((commit) => !isGitGenerated(commit.subject));

  if (toCheck.length === 0) {
    ui.success('No commit to check.');
    return;
  }

  let bad = 0;
  for (const commit of toCheck) {
    const problems = checkMessage(commit.subject, config);
    if (problems.length === 0) {
      ui.success(`${ui.dim(commit.shortHash)} ${commit.subject}`);
      continue;
    }
    bad += 1;
    ui.error(`${ui.dim(commit.shortHash)} ${commit.subject}`);
    reportProblems(commit.subject, problems, config, '    ');
  }

  ui.info('');
  if (bad > 0) {
    ui.error(`${bad} of ${toCheck.length} commit message(s) are not correct.`);
    ui.info(ui.dim('To repair the last commit: git commit --amend'));
    ui.info(ui.dim('To write a correct message: npm run commit'));
    process.exitCode = 1;
  } else {
    ui.success(`All ${toCheck.length} commit message(s) are correct.`);
  }
}

/**
 * Read the commits of this branch that the release branch does not have.
 *
 * @param {string} root
 * @param {import('../lib/config.mjs').Config} config
 */
function commitsOfBranch(root, config) {
  const candidates = [
    `origin/${config.releaseBranch}..HEAD`,
    `${config.releaseBranch}..HEAD`,
  ];

  for (const range of candidates) {
    try {
      const output = git.git(
        ['log', '--reverse', '--no-merges', '--format=%h\x1f%s', range],
        { cwd: root },
      );
      return output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [shortHash = '', subject = ''] = line.split('\x1f');
          return { shortHash, subject };
        });
    } catch {
      continue;
    }
  }

  ui.warn(
    `Cannot find the branch "${config.releaseBranch}". The tool checks only the last commit.`,
  );
  const output = git.git(['log', '-1', '--format=%h\x1f%s'], { cwd: root });
  const [shortHash = '', subject = ''] = output.split('\x1f');
  return [{ shortHash, subject }];
}

/**
 * @param {string} subject
 * @param {import('../lib/commits.mjs').Problem[]} problems
 * @param {import('../lib/config.mjs').Config} config
 * @param {string} [indent]
 */
function reportProblems(subject, problems, config, indent = '  ') {
  ui.info('');
  for (const problem of problems) {
    ui.info(`${indent}${ui.red('✗')} ${problem.message}`);
    if (problem.hint) {
      for (const line of problem.hint.split('\n')) {
        ui.info(`${indent}  ${ui.dim(line)}`);
      }
    }
  }
  ui.info('');
  ui.info(`${indent}${ui.dim('Allowed types:')}`);
  for (const [type, rule] of Object.entries(config.types)) {
    ui.info(
      `${indent}  ${ui.cyan(type.padEnd(9))} ${ui.dim(`${rule.bump.padEnd(6)} ${rule.section}`)}`,
    );
  }
  ui.info('');
}

// --- commit -----------------------------------------------------------------

async function commandCommit() {
  const { root, config } = context();

  const staged = git.git(['diff', '--cached', '--name-only'], { cwd: root });
  if (!staged) {
    ui.error('No file is staged.');
    ui.info(ui.dim('  Add your changes first, for example: git add -A'));
    process.exitCode = 1;
    return;
  }

  ui.heading('Staged files');
  for (const file of staged.split('\n')) ui.info(`  ${ui.dim(file)}`);

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const types = Object.entries(config.types);

    ui.heading('1. What is the type of this change?');
    types.forEach(([type, rule], index) => {
      ui.info(
        `  ${ui.bold(String(index + 1).padStart(2))}. ${ui.cyan(type.padEnd(9))} ` +
          `${ui.dim(`${rule.bump.padEnd(6)} ${rule.section}`)}`,
      );
    });

    const type = await ask(rl, types, 'Type');

    ui.heading('2. What part of the code changed? (optional)');
    if (config.scopes.length > 0) {
      ui.info(`  ${ui.dim(config.scopes.join(', '))}`);
    } else {
      ui.info(ui.dim('  For example: cli, core, docs. Press Enter to skip.'));
    }
    const scope = (await rl.question(`${ui.bold('Scope')} > `)).trim();

    if (scope && config.scopes.length > 0 && !config.scopes.includes(scope)) {
      throw new Error(`Unknown scope: "${scope}". Use one of: ${config.scopes.join(', ')}`);
    }

    ui.heading('3. Describe the change in one line.');
    ui.info(ui.dim('  Start with a small letter. Do not end with a full stop.'));
    ui.info(ui.dim('  For example: stop the crash on exit'));
    const subject = (await rl.question(`${ui.bold('Subject')} > `)).trim();

    ui.heading('4. Does this change break the behaviour of a user?');
    ui.info(ui.dim('  Answer yes only if a user must change something. This'));
    ui.info(ui.dim('  increases the MAJOR part of the version.'));
    const breaking = /^y(es)?$/i.test((await rl.question(`${ui.bold('Breaking')} (y/N) > `)).trim());

    let note = '';
    if (breaking) {
      ui.heading('5. Tell the user what to do.');
      note = (await rl.question(`${ui.bold('Migration')} > `)).trim();
    }

    const header = `${type}${scope ? `(${scope})` : ''}${breaking ? '!' : ''}: ${subject}`;
    const message = breaking && note ? `${header}\n\nBREAKING CHANGE: ${note}` : header;

    const problems = checkMessage(message, config);
    if (problems.length > 0) {
      ui.heading('The message is not correct');
      reportProblems(header, problems, config);
      process.exitCode = 1;
      return;
    }

    ui.heading('Commit message');
    for (const line of message.split('\n')) ui.info(`  ${ui.green(line || ' ')}`);

    const confirm = (await rl.question(`\n${ui.bold('Commit?')} (Y/n) > `)).trim();
    if (/^n(o)?$/i.test(confirm)) {
      ui.warn('Nothing happened.');
      return;
    }

    rl.close();
    execFileSync('git', ['commit', '-m', message], { cwd: root, stdio: 'inherit' });
    ui.success('The commit is ready.');
  } finally {
    rl.close();
  }
}

/**
 * Ask the user to choose a type from the list.
 *
 * @param {import('node:readline/promises').Interface} rl
 * @param {[string, import('../lib/config.mjs').TypeRule][]} types
 * @param {string} label
 * @returns {Promise<string>}
 */
async function ask(rl, types, label) {
  for (;;) {
    const answer = (await rl.question(`${ui.bold(label)} > `)).trim();

    const byNumber = Number(answer);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= types.length) {
      return /** @type {[string, unknown]} */ (types[byNumber - 1])[0];
    }
    if (types.some(([type]) => type === answer)) return answer;

    ui.error(`Give a number from 1 to ${types.length}, or the name of a type.`);
  }
}

// --- helpers ----------------------------------------------------------------

/**
 * The date now, as `YYYY-MM-DD`, in UTC.
 *
 * @returns {string}
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Give values to the next step of a GitHub Actions job.
 *
 * @param {Record<string, string>} values
 */
function writeGithubOutput(values) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`);
  appendFileSync(path, lines.join(''), 'utf8');
}

main().catch((error) => {
  ui.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
