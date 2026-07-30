// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bump,
  compare,
  format,
  largestLevel,
  legacyBuild,
  parse,
} from '../lib/version.mjs';

describe('parse', () => {
  it('reads a version with three parts', () => {
    assert.deepEqual(parse('0.1.0'), { major: 0, minor: 1, patch: 0 });
    assert.deepEqual(parse('12.34.56'), { major: 12, minor: 34, patch: 56 });
  });

  it('ignores the spaces at the ends', () => {
    assert.deepEqual(parse('  1.2.3\n'), { major: 1, minor: 2, patch: 3 });
  });

  it('reads a legacy four-part version and drops the BUILD part', () => {
    // Every release up to v0.13.0.0 is tagged with four parts, and those tags
    // stay in the repository forever. The tag reader must keep understanding
    // them, or the next release looks like the first one.
    assert.deepEqual(parse('0.13.0.0'), { major: 0, minor: 13, patch: 0 });
    assert.equal(format(parse('0.12.1.1')), '0.12.1');
  });

  it('rejects text that is not a version', () => {
    for (const bad of ['1.2', '1.2.3.4.5', '1.2.3.x', 'v1.2.3', '', 'abc']) {
      assert.throws(() => parse(bad), /Invalid version/, `must reject "${bad}"`);
    }
  });
});

describe('format', () => {
  it('writes the three parts', () => {
    assert.equal(format({ major: 0, minor: 1, patch: 0 }), '0.1.0');
  });

  it('is the opposite of parse', () => {
    assert.equal(format(parse('3.2.1')), '3.2.1');
  });
});

describe('bump', () => {
  const start = parse('1.2.3');

  it('increases MAJOR and clears the smaller parts', () => {
    assert.equal(format(bump(start, 'major')), '2.0.0');
  });

  it('increases MINOR and clears PATCH', () => {
    assert.equal(format(bump(start, 'minor')), '1.3.0');
  });

  it('increases PATCH', () => {
    assert.equal(format(bump(start, 'patch')), '1.2.4');
  });

  it('does not change the given version', () => {
    bump(start, 'major');
    assert.equal(format(start), '1.2.3');
  });

  it('follows the rules that VERSIONING.md gives', () => {
    // This is the example in VERSIONING.md. It must stay correct.
    let current = parse('0.1.0');
    current = bump(current, 'patch');
    assert.equal(format(current), '0.1.1'); // docs: repair a typo
    current = bump(current, 'patch');
    assert.equal(format(current), '0.1.2'); // refactor: split a module
    current = bump(current, 'patch');
    assert.equal(format(current), '0.1.3'); // fix: repair a defect
    current = bump(current, 'minor');
    assert.equal(format(current), '0.2.0'); // feat: add a feature
    current = bump(current, 'major');
    assert.equal(format(current), '1.0.0'); // feat!: break the behaviour
  });

  it('never produces a version that an updater reads as equal', () => {
    // The reason the version is semver at all: two different releases must never
    // report the same version, or the desktop updater answers "no update".
    // See docs/adr/0008-the-version-is-semver.md.
    const seen = new Set();
    let current = parse('0.13.0');
    for (const level of ['patch', 'patch', 'minor', 'patch', 'major']) {
      seen.add(format(current));
      const next = bump(current, /** @type {'major' | 'minor' | 'patch'} */ (level));
      assert.equal(compare(next, current) > 0, true, `${format(next)} must beat ${format(current)}`);
      current = next;
    }
    seen.add(format(current));
    assert.equal(seen.size, 6);
  });

  it('rejects an unknown level', () => {
    // @ts-expect-error The test gives a level that does not exist.
    assert.throws(() => bump(start, 'huge'), /Unknown level/);
  });
});

describe('compare', () => {
  it('sorts by MAJOR first, and by PATCH last', () => {
    const sorted = ['0.1.0', '0.1.1', '0.2.0', '1.0.0', '10.0.0']
      .map(parse)
      .sort(compare)
      .map(format);

    assert.deepEqual(sorted, ['0.1.0', '0.1.1', '0.2.0', '1.0.0', '10.0.0']);
  });

  it('gives zero for two equal versions', () => {
    assert.equal(compare(parse('1.2.3'), parse('1.2.3')), 0);
  });

  it('reads a legacy four-part version as equal to its three-part form', () => {
    assert.equal(compare(parse('0.13.0.0'), parse('0.13.0')), 0);
  });
});

describe('largestLevel', () => {
  it('gives the largest level', () => {
    assert.equal(largestLevel(['patch', 'major', 'minor']), 'major');
    assert.equal(largestLevel(['patch', 'minor']), 'minor');
    assert.equal(largestLevel(['patch', 'patch']), 'patch');
  });

  it('gives null for an empty list', () => {
    assert.equal(largestLevel([]), null);
  });

  it('rejects an unknown level', () => {
    // @ts-expect-error The test gives a level that does not exist.
    assert.throws(() => largestLevel(['tiny']), /Unknown level/);
  });
});

describe('legacyBuild', () => {
  it('reads the dropped fourth part', () => {
    assert.equal(legacyBuild('0.13.0.1'), 1);
    assert.equal(legacyBuild('1.2.3.47'), 47);
  });

  it('gives zero for a three-part version', () => {
    assert.equal(legacyBuild('0.13.0'), 0);
  });

  it('orders two legacy tags that share a semantic version', () => {
    // v0.13.0.0 and v0.13.0.1 are both 0.13.0. Picking the older of the tie
    // would make the next release read the newer one's commits again.
    assert.equal(compare(parse('0.13.0.0'), parse('0.13.0.1')), 0);
    assert.equal(legacyBuild('0.13.0.1') > legacyBuild('0.13.0.0'), true);
  });
});
