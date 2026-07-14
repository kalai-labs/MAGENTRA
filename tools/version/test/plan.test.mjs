// @ts-check
/**
 * These tests make a real git repository in a temporary directory. Therefore
 * they prove that the tool reads git correctly, and not only that the rules are
 * correct.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { makePlan } from '../lib/plan.mjs';
import { syncTargets } from '../lib/sync.mjs';
import { format, parse } from '../lib/version.mjs';

/** @type {import('../lib/config.mjs').Config} */
const config = {
  tagPrefix: 'v',
  releaseBranch: 'main',
  targets: [
    { path: 'package.json', format: 'full' },
    { path: 'apps/*/package.json', format: 'semver' },
  ],
  types: {
    feat: { bump: 'minor', section: 'Features' },
    fix: { bump: 'patch', section: 'Bug fixes' },
    docs: { bump: 'build', section: 'Documentation' },
  },
  scopes: [],
  subjectMaxLength: 72,
};

/** @type {string} */
let root;

/** @param {string[]} args */
const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

/** @param {string} subject @param {string} [body] */
function commit(subject, body) {
  writeFileSync(join(root, 'work.txt'), String(Math.random()), 'utf8');
  run(['add', '-A']);
  const args = ['commit', '--no-verify', '-m', subject];
  if (body) args.push('-m', body);
  run(args);
}

/** @param {string} tag */
const tag = (tag) => run(['tag', '-a', tag, '-m', tag]);

before(() => {
  root = mkdtempSync(join(tmpdir(), 'magentra-version-'));
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('makePlan', () => {
  it('makes the first release from the VERSION file, and does not bump', () => {
    commit('feat: add the version tool');
    commit('feat!: break something');

    const plan = makePlan(root, config, parse('0.1.0.0'));

    assert.equal(plan.isFirstRelease, true);
    assert.equal(plan.hasRelease, true);
    assert.equal(plan.level, null);
    // The first release uses 0.1.0.0 exactly, also after a breaking commit.
    assert.equal(format(plan.next), '0.1.0.0');
    assert.equal(plan.commits.length, 2);
  });

  it('makes no release when no commit comes after the tag', () => {
    tag('v0.1.0.0');

    const plan = makePlan(root, config, parse('0.1.0.0'));

    assert.equal(plan.hasRelease, false);
    assert.equal(plan.level, null);
    assert.equal(format(plan.next), '0.1.0.0');
  });

  it('increases BUILD for a docs commit', () => {
    commit('docs: repair a typo');

    const plan = makePlan(root, config, parse('0.1.0.0'));

    assert.equal(plan.level, 'build');
    assert.equal(format(plan.next), '0.1.0.1');
  });

  it('increases PATCH for a fix commit, and clears BUILD', () => {
    commit('fix: stop the crash on exit');

    const plan = makePlan(root, config, parse('0.1.0.1'));

    assert.equal(plan.level, 'patch');
    assert.equal(format(plan.next), '0.1.1.0');
  });

  it('takes the largest bump when the commits have different types', () => {
    // The history after v0.1.0.0 now holds: docs, fix. The fix wins.
    const plan = makePlan(root, config, parse('0.1.0.0'));

    assert.equal(plan.level, 'patch');
    assert.equal(plan.commits.length, 2);
  });

  it('increases MINOR for a feature, and MAJOR for a break', () => {
    tag('v0.1.1.0');
    commit('feat: add a retry policy');

    let plan = makePlan(root, config, parse('0.1.1.0'));
    assert.equal(plan.level, 'minor');
    assert.equal(format(plan.next), '0.2.0.0');

    commit('feat(cli)!: rename a flag');

    plan = makePlan(root, config, parse('0.1.1.0'));
    assert.equal(plan.level, 'major');
    assert.equal(format(plan.next), '1.0.0.0');
  });

  it('reads a break from the BREAKING CHANGE footer', () => {
    tag('v1.0.0.0');
    commit('fix: repair a defect', 'BREAKING CHANGE: the --out flag is now --output.');

    const plan = makePlan(root, config, parse('1.0.0.0'));

    assert.equal(plan.level, 'major');
    assert.equal(format(plan.next), '2.0.0.0');
    assert.equal(plan.commits[0]?.breaking, true);
  });

  it('ignores a commit that does not have the necessary form', () => {
    tag('v2.0.0.0');
    commit('a message with no type');
    commit('docs: repair a typo');

    const plan = makePlan(root, config, parse('2.0.0.0'));

    assert.equal(plan.level, 'build');
    assert.equal(plan.commits.length, 1);
    assert.equal(plan.ignored.length, 1);
    assert.equal(plan.ignored[0]?.subject, 'a message with no type');
  });

  it('makes no release when every commit after the tag is ignored', () => {
    tag('v2.0.0.1');
    commit('a message with no type');

    const plan = makePlan(root, config, parse('2.0.0.1'));

    assert.equal(plan.hasRelease, false);
    assert.equal(plan.ignored.length, 1);
  });
});

describe('syncTargets', () => {
  it('writes the full version, and the short version where it is necessary', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', version: '0.0.0.0' }, null, 2),
      'utf8',
    );
    execFileSync('mkdir', ['-p', join(root, 'apps', 'desktop')]);
    writeFileSync(
      join(root, 'apps', 'desktop', 'package.json'),
      JSON.stringify({ name: 'desktop', version: '0.0.0' }, null, 2),
      'utf8',
    );

    const results = syncTargets(root, config, parse('1.2.3.4'));

    const byPath = new Map(results.map((result) => [result.path, result.to]));
    assert.equal(byPath.get('package.json'), '1.2.3.4');
    // electron-builder and vsce reject a version that has four parts.
    assert.equal(byPath.get('apps/desktop/package.json'), '1.2.3');
  });

  it('does not fail when a target matches no file', () => {
    const results = syncTargets(
      root,
      { ...config, targets: [{ path: 'nothing/*/package.json', format: 'full' }] },
      parse('1.2.3.4'),
    );

    assert.deepEqual(results, []);
  });
});
