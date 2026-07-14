// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bump,
  compare,
  format,
  largestLevel,
  parse,
  toSemver,
} from '../lib/version.mjs';

describe('parse', () => {
  it('reads a version with four parts', () => {
    assert.deepEqual(parse('0.1.0.0'), { major: 0, minor: 1, patch: 0, build: 0 });
    assert.deepEqual(parse('12.34.56.78'), {
      major: 12,
      minor: 34,
      patch: 56,
      build: 78,
    });
  });

  it('ignores the spaces at the ends', () => {
    assert.deepEqual(parse('  1.2.3.4\n'), { major: 1, minor: 2, patch: 3, build: 4 });
  });

  it('rejects a version that does not have four parts', () => {
    for (const bad of ['1.2.3', '1.2.3.4.5', '1.2.3.x', 'v1.2.3.4', '', 'abc']) {
      assert.throws(() => parse(bad), /Invalid version/, `must reject "${bad}"`);
    }
  });
});

describe('format', () => {
  it('writes the four parts', () => {
    assert.equal(format({ major: 0, minor: 1, patch: 0, build: 0 }), '0.1.0.0');
  });

  it('is the opposite of parse', () => {
    assert.equal(format(parse('3.2.1.0')), '3.2.1.0');
  });
});

describe('toSemver', () => {
  it('removes the BUILD part', () => {
    assert.equal(toSemver(parse('1.2.3.4')), '1.2.3');
  });
});

describe('bump', () => {
  const start = parse('1.2.3.4');

  it('increases MAJOR and clears the smaller parts', () => {
    assert.equal(format(bump(start, 'major')), '2.0.0.0');
  });

  it('increases MINOR and clears PATCH and BUILD', () => {
    assert.equal(format(bump(start, 'minor')), '1.3.0.0');
  });

  it('increases PATCH and clears BUILD', () => {
    assert.equal(format(bump(start, 'patch')), '1.2.4.0');
  });

  it('increases BUILD only', () => {
    assert.equal(format(bump(start, 'build')), '1.2.3.5');
  });

  it('does not change the given version', () => {
    bump(start, 'major');
    assert.equal(format(start), '1.2.3.4');
  });

  it('follows the rules that VERSIONING.md gives', () => {
    // This is the example in VERSIONING.md. It must stay correct.
    let current = parse('0.1.0.0');
    current = bump(current, 'build');
    assert.equal(format(current), '0.1.0.1'); // docs: fix a typo
    current = bump(current, 'build');
    assert.equal(format(current), '0.1.0.2'); // refactor: split a module
    current = bump(current, 'patch');
    assert.equal(format(current), '0.1.1.0'); // fix: repair a defect
    current = bump(current, 'minor');
    assert.equal(format(current), '0.2.0.0'); // feat: add a feature
    current = bump(current, 'major');
    assert.equal(format(current), '1.0.0.0'); // feat!: break the behaviour
  });

  it('rejects an unknown level', () => {
    // @ts-expect-error The test gives a level that does not exist.
    assert.throws(() => bump(start, 'huge'), /Unknown level/);
  });
});

describe('compare', () => {
  it('sorts by MAJOR first, and by BUILD last', () => {
    const sorted = ['0.1.0.0', '0.1.0.1', '0.1.1.0', '0.2.0.0', '1.0.0.0', '10.0.0.0']
      .map(parse)
      .sort(compare)
      .map(format);

    assert.deepEqual(sorted, [
      '0.1.0.0',
      '0.1.0.1',
      '0.1.1.0',
      '0.2.0.0',
      '1.0.0.0',
      '10.0.0.0',
    ]);
  });

  it('gives zero for two equal versions', () => {
    assert.equal(compare(parse('1.2.3.4'), parse('1.2.3.4')), 0);
  });
});

describe('largestLevel', () => {
  it('gives the largest level', () => {
    assert.equal(largestLevel(['build', 'major', 'patch']), 'major');
    assert.equal(largestLevel(['build', 'patch']), 'patch');
    assert.equal(largestLevel(['build', 'build']), 'build');
    assert.equal(largestLevel(['minor', 'patch', 'build']), 'minor');
  });

  it('gives null for an empty list', () => {
    assert.equal(largestLevel([]), null);
  });

  it('rejects an unknown level', () => {
    // @ts-expect-error The test gives a level that does not exist.
    assert.throws(() => largestLevel(['tiny']), /Unknown level/);
  });
});
