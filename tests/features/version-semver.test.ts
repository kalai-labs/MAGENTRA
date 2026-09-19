/**
 * `version-semver`.
 *
 * `tools/version/lib/version.mjs` is the dependency-free semver core of the
 * version tool: parse, format, bump, compare, the legacy four-part BUILD reader
 * and `largestLevel`. The desktop updater orders releases by semver and nothing
 * else, and the old four-part tags live in the repository forever, so a wrong
 * answer here misorders a release or misreads history.
 *
 * `pure`: every function is a function of its arguments. The module is plain
 * ESM JavaScript with JSDoc types, outside the `tsc` chain, so it is loaded by
 * `import()` and described by the interface below.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "version-semver";

/** Verbatim from the record. */
const INVARIANT =
  "parse and format round-trip every supported form, bump applies the right level, and compare orders correctly including legacy builds.";

interface Version {
  major: number;
  minor: number;
  patch: number;
}
type Level = "major" | "minor" | "patch";

interface VersionModule {
  LEVELS: readonly Level[];
  parse(text: string): Version;
  format(version: Version): string;
  legacyBuild(text: string): number;
  bump(version: Version, level: Level): Version;
  compare(a: Version, b: Version): number;
  largestLevel(levels: readonly Level[]): Level | null;
}

async function versionModule(): Promise<VersionModule> {
  return (await import(pathToFileURL(join(repoRoot(), "tools", "version", "lib", "version.mjs")).href)) as VersionModule;
}

abstract class SemverTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class ParseAndFormatRoundTrip extends SemverTest {
  readonly id = "parse-and-format-round-trip-and-a-legacy-fourth-part-is-read-then-dropped";
  readonly whyItExists =
    "a parser that rejected the four-part tags of every release up to v0.13.0.0 made the next release look like the first one and re-released the whole history";

  override async run(t: TestRun): Promise<void> {
    const v = await versionModule();
    t.assert.equal(v.format(v.parse("0.1.0")), "0.1.0");
    t.assert.equal(v.format(v.parse(" 12.34.56 ")), "12.34.56", "surrounding whitespace, as a VERSION file may carry it, is tolerated");
    t.assert.deepEqual(v.parse("0.13.0.7"), { major: 0, minor: 13, patch: 0 }, "a legacy four-part version parses to its three semver parts");
    t.assert.equal(v.legacyBuild("0.13.0.7"), 7, "and the dropped BUILD part is still readable, to order a tie");
    t.assert.equal(v.legacyBuild("0.13.0"), 0, "a three-part version has build 0");
    t.assert.deepEqual([...v.LEVELS], ["major", "minor", "patch"], "the levels, largest first");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class InvalidVersionsThrow extends SemverTest {
  readonly id = "parse-throws-invalid-version-for-every-malformed-form";
  readonly whyItExists =
    "a lenient parser that read 'v1.2.3' or '1.2' as a version would compute the next release from a number that was never one";

  override async run(t: TestRun): Promise<void> {
    const v = await versionModule();
    for (const bad of ["1.2", "v1.2.3", "1.2.3-beta", "1.2.3.4.5", ""]) {
      t.assert.throws(() => v.parse(bad), /Invalid version/, `parse(${JSON.stringify(bad)}) must throw`);
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class BumpZeroesTheSmallerParts extends SemverTest {
  readonly id = "bump-raises-one-level-zeroes-the-smaller-parts-and-never-mutates-its-input";
  readonly whyItExists =
    "a minor bump that kept the patch number produced 1.3.3 after 1.2.3, and a bump that mutated its argument changed the 'current' version the plan was still reporting";

  override async run(t: TestRun): Promise<void> {
    const v = await versionModule();
    const base: Version = { major: 1, minor: 2, patch: 3 };
    t.assert.deepEqual(v.bump(base, "major"), { major: 2, minor: 0, patch: 0 });
    t.assert.deepEqual(v.bump(base, "minor"), { major: 1, minor: 3, patch: 0 });
    t.assert.deepEqual(v.bump(base, "patch"), { major: 1, minor: 2, patch: 4 });
    t.assert.deepEqual(base, { major: 1, minor: 2, patch: 3 }, "the input is unchanged");
    t.assert.throws(() => v.bump(base, "build" as Level), /Unknown level/, "an unknown level is refused, not treated as patch");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class CompareOrdersNumerically extends SemverTest {
  readonly id = "compare-orders-numerically-per-part-and-ignores-a-legacy-build";
  readonly whyItExists =
    "a string comparison put 1.10.0 before 1.9.9, so the updater offered an older release as an upgrade";

  override async run(t: TestRun): Promise<void> {
    const v = await versionModule();
    t.assert.ok(v.compare(v.parse("1.10.0"), v.parse("1.9.9")) > 0, "1.10.0 is newer than 1.9.9");
    t.assert.ok(v.compare(v.parse("2.0.0"), v.parse("1.99.99")) > 0, "2.0.0 is newer than 1.99.99");
    t.assert.equal(v.compare(v.parse("3.4.5"), v.parse("3.4.5")), 0, "equal versions compare equal");
    t.assert.ok(v.compare(v.parse("0.13.0.1"), v.parse("0.13.1")) < 0, "a legacy build compares by its three semver parts only");
    t.assert.equal(v.compare(v.parse("0.13.0.1"), v.parse("0.13.0.9")), 0, "two legacy builds of one version are the same version");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class LargestLevelPicksTheBiggest extends SemverTest {
  readonly id = "largestlevel-picks-the-biggest-level-null-for-none-and-throws-on-an-unknown-one";
  readonly whyItExists =
    "a release with one feat and ten docs commits is a minor release; picking the most frequent level instead of the largest shipped it as a patch";

  override async run(t: TestRun): Promise<void> {
    const v = await versionModule();
    t.assert.equal(v.largestLevel(["patch", "minor", "patch"]), "minor");
    t.assert.equal(v.largestLevel(["patch", "major"]), "major");
    t.assert.equal(v.largestLevel(["patch"]), "patch");
    t.assert.equal(v.largestLevel([]), null, "no levels means no release");
    t.assert.throws(() => v.largestLevel(["minor", "huge" as Level]), /Unknown level/);
  }
}

registerFeatureTests(new ParseAndFormatRoundTrip(), new InvalidVersionsThrow(), new BumpZeroesTheSmallerParts(), new CompareOrdersNumerically(), new LargestLevelPicksTheBiggest());
