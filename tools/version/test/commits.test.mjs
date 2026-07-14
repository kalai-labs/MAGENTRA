// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkMessage, isGitGenerated, parseCommit } from '../lib/commits.mjs';

/** @type {import('../lib/config.mjs').Config} */
const config = {
  tagPrefix: 'v',
  releaseBranch: 'main',
  targets: [],
  types: {
    feat: { bump: 'minor', section: 'Features' },
    fix: { bump: 'patch', section: 'Bug fixes' },
    docs: { bump: 'build', section: 'Documentation' },
  },
  scopes: [],
  subjectMaxLength: 72,
};

/** @type {import('../lib/config.mjs').Config} */
const withScopes = { ...config, scopes: ['cli', 'core'] };

describe('parseCommit', () => {
  it('reads a type and a subject', () => {
    const commit = parseCommit({ subject: 'feat: add a retry policy' });
    assert.equal(commit?.type, 'feat');
    assert.equal(commit?.scope, null);
    assert.equal(commit?.subject, 'add a retry policy');
    assert.equal(commit?.breaking, false);
  });

  it('reads a scope', () => {
    const commit = parseCommit({ subject: 'fix(cli): stop the crash on exit' });
    assert.equal(commit?.scope, 'cli');
    assert.equal(commit?.subject, 'stop the crash on exit');
  });

  it('reads the ! mark as a break', () => {
    assert.equal(parseCommit({ subject: 'feat!: rename a flag' })?.breaking, true);
    assert.equal(parseCommit({ subject: 'feat(cli)!: rename a flag' })?.breaking, true);
  });

  it('reads the BREAKING CHANGE footer as a break', () => {
    const commit = parseCommit({
      subject: 'feat: rename a flag',
      body: 'Some text.\n\nBREAKING CHANGE: use --output, not --out.',
    });
    assert.equal(commit?.breaking, true);
  });

  it('accepts BREAKING-CHANGE with a hyphen', () => {
    const commit = parseCommit({
      subject: 'feat: rename a flag',
      body: 'BREAKING-CHANGE: use --output.',
    });
    assert.equal(commit?.breaking, true);
  });

  it('does not read an empty BREAKING CHANGE footer as a break', () => {
    const commit = parseCommit({ subject: 'feat: add a flag', body: 'BREAKING CHANGE:' });
    assert.equal(commit?.breaking, false);
  });

  it('gives null for a subject that has no type', () => {
    assert.equal(parseCommit({ subject: 'add a retry policy' }), null);
    assert.equal(parseCommit({ subject: 'feat add a retry policy' }), null);
    assert.equal(parseCommit({ subject: 'feat:no space after the colon' }), null);
  });
});

describe('isGitGenerated', () => {
  it('finds a merge commit and a revert commit', () => {
    assert.equal(isGitGenerated('Merge pull request #1 from a/b'), true);
    assert.equal(isGitGenerated('Merge branch "main"'), true);
    assert.equal(isGitGenerated('Revert "feat: add a flag"'), true);
  });

  it('does not find a normal commit', () => {
    assert.equal(isGitGenerated('feat: add a flag'), false);
  });
});

describe('checkMessage', () => {
  /** @param {string} message @param {import('../lib/config.mjs').Config} [c] */
  const problems = (message, c = config) =>
    checkMessage(message, c).map((problem) => problem.message);

  it('accepts a correct message', () => {
    assert.deepEqual(problems('feat(cli): add a retry policy'), []);
    assert.deepEqual(problems('fix: stop the crash on exit'), []);
    assert.deepEqual(problems('feat!: rename a flag'), []);
  });

  it('accepts a correct message that has a body', () => {
    assert.deepEqual(
      problems('feat: add a flag\n\nThis flag controls the retry count.'),
      [],
    );
  });

  it('rejects an empty message', () => {
    assert.match(problems('')[0] ?? '', /empty/);
  });

  it('rejects a subject that has no type', () => {
    assert.match(problems('add a retry policy')[0] ?? '', /necessary form/);
  });

  it('rejects an unknown type', () => {
    assert.match(problems('wip: something')[0] ?? '', /Unknown type/);
  });

  it('rejects a subject that is too long', () => {
    const long = `feat: ${'a'.repeat(80)}`;
    assert.ok(problems(long).some((message) => /largest allowed length/.test(message)));
  });

  it('rejects a subject that ends with a full stop', () => {
    assert.ok(problems('fix: repair the bug.').some((m) => /full stop/.test(m)));
  });

  it('rejects a subject that starts with a capital letter', () => {
    assert.ok(problems('fix: Repair the bug').some((m) => /capital letter/.test(m)));
  });

  it('rejects a body that has no empty line before it', () => {
    assert.ok(
      problems('feat: add a flag\nThis flag is new.').some((m) => /not empty/.test(m)),
    );
  });

  it('rejects a BREAKING CHANGE footer that has no description', () => {
    assert.ok(
      problems('feat: add a flag\n\nBREAKING CHANGE:').some((m) => /no description/.test(m)),
    );
  });

  it('ignores the comment lines that git adds', () => {
    assert.deepEqual(problems('fix: repair the bug\n# Please enter a message.'), []);
  });

  it('does not check a merge commit', () => {
    assert.deepEqual(problems('Merge pull request #1 from a/b'), []);
  });

  describe('when the configuration names the allowed scopes', () => {
    it('accepts an allowed scope', () => {
      assert.deepEqual(problems('feat(cli): add a flag', withScopes), []);
    });

    it('rejects an unknown scope', () => {
      assert.match(problems('feat(web): add a flag', withScopes)[0] ?? '', /Unknown scope/);
    });

    it('accepts a message that has no scope', () => {
      assert.deepEqual(problems('feat: add a flag', withScopes), []);
    });
  });
});
