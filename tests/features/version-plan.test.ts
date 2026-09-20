/**
 * `version-plan`.
 *
 * `makePlan` derives the next version instead of letting someone choose it:
 * the base is the larger of the VERSION file and the highest version tag, the
 * commits since that tag are parsed as Conventional Commits, and the largest
 * bump level present decides the release. Commits that do not parse are listed
 * as ignored, git's own merge commits are dropped, and no tag means the first
 * release at the current version.
 *
 * `fs`, and the record said `pure`: the plan is read off a git repository, so
 * each test builds one in a temp directory — real `git init`, real commits,
 * real tags — and the tool runs its own `git log` and `git tag` against it.
 * Those git invocations are synchronous and finished before the call returns,
 * so what the test owns is the directory, which is the `fs` kind's promise.
 * Re-declared 2026-09-19.
 *
 * Every git call here pins its identity and switches signing off with `-c`
 * flags, so the developer's global configuration cannot make the fixture
 * prompt for a key or refuse a commit.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";

const FEATURE = "version-plan";

/** Verbatim from the record. */
const INVARIANT = "makePlan returns the next version from a commit range using the largest bump level present.";

interface Version {
  major: number;
  minor: number;
  patch: number;
}
interface Plan {
  current: Version;
  next: Version;
  level: string | null;
  isFirstRelease: boolean;
  hasRelease: boolean;
  fromTag: string | null;
  commits: { type: string; subject: string; breaking: boolean }[];
  ignored: { subject: string; shortHash: string }[];
}
interface Config {
  tagPrefix: string;
  types: Record<string, { bump: string; section: string }>;
}
interface PlanModule {
  makePlan(root: string, config: Config, current: Version): Plan;
}

const LIB = join(repoRoot(), "tools", "version", "lib");

async function planner(): Promise<{ makePlan: PlanModule["makePlan"]; config: Config }> {
  const { makePlan } = (await import(pathToFileURL(join(LIB, "plan.mjs")).href)) as PlanModule;
  const { loadConfig } = (await import(pathToFileURL(join(LIB, "config.mjs")).href)) as { loadConfig(root: string): Config };
  return { makePlan, config: loadConfig(repoRoot()) };
}

const IDENTITY = ["-c", "user.name=Feature Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

abstract class PlanTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Slower than a pure call: several git processes per test. */
  override readonly timeoutMs: number = 60_000;

  #n = 0;

  /** A fresh repository with one root commit. */
  protected repo(): string {
    const dir = this.tempDir("magentra-plan-");
    git(dir, "init", "-q", "-b", "main");
    this.commit(dir, "chore: root");
    return dir;
  }

  /** One commit touching a new file, with `subject` (and an optional body). */
  protected commit(dir: string, subject: string, body?: string): void {
    this.#n += 1;
    writeFileSync(join(dir, `file-${this.#n}.txt`), `${this.#n}\n`, "utf8");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "--no-verify", "-m", subject, ...(body !== undefined ? ["-m", body] : []));
  }

  protected tag(dir: string, name: string): void {
    git(dir, "tag", name);
  }

  protected version(text: string): Version {
    const [major, minor, patch] = text.split(".").map(Number);
    return { major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0 };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheLargestLevelWins extends PlanTest {
  readonly id = "docs-fix-and-feat-after-a-tag-make-a-minor-release";
  readonly whyItExists = "a plan that took the level of the LAST commit released a feat as a patch whenever a docs commit followed it";

  override async run(t: TestRun): Promise<void> {
    const { makePlan, config } = await planner();
    const dir = this.repo();
    this.tag(dir, "v1.2.3");
    this.commit(dir, "docs: a");
    this.commit(dir, "fix: b");
    this.commit(dir, "feat: c");
    const plan = makePlan(dir, config, this.version("1.2.3"));
    t.assert.equal(plan.level, "minor");
    t.assert.deepEqual(plan.next, { major: 1, minor: 3, patch: 0 });
    t.assert.equal(plan.hasRelease, true);
    t.assert.equal(plan.isFirstRelease, false);
    t.assert.equal(plan.fromTag, "v1.2.3");
    t.assert.deepEqual(plan.commits.map((c) => c.subject), ["a", "b", "c"], "the three commits since the tag, oldest first, and not the root commit before it");
    t.assert.deepEqual(plan.ignored, []);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ABreakingChangeIsMajor extends PlanTest {
  readonly id = "a-bang-or-a-breaking-change-footer-makes-a-major-release-whatever-the-type";
  readonly whyItExists = "a breaking change on a chore commit was released as a patch because only feat was ever inspected for the bang";

  override async run(t: TestRun): Promise<void> {
    const { makePlan, config } = await planner();
    const bang = this.repo();
    this.tag(bang, "v1.2.3");
    this.commit(bang, "fix: a");
    this.commit(bang, "chore!: b");
    const fromBang = makePlan(bang, config, this.version("1.2.3"));
    t.assert.equal(fromBang.level, "major");
    t.assert.deepEqual(fromBang.next, { major: 2, minor: 0, patch: 0 });
    t.assert.equal(fromBang.commits.find((c) => c.subject === "b")?.breaking, true);

    const footer = this.repo();
    this.tag(footer, "v1.2.3");
    this.commit(footer, "docs: explain", "BREAKING CHANGE: x is gone");
    const fromFooter = makePlan(footer, config, this.version("1.2.3"));
    t.assert.equal(fromFooter.level, "major", "the footer on a docs commit is a break too");
    t.assert.deepEqual(fromFooter.next, { major: 2, minor: 0, patch: 0 });
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class PatchOnlyAndNothingToRelease extends PlanTest {
  readonly id = "a-lone-fix-is-a-patch-and-non-conforming-commits-are-ignored-not-released";
  readonly whyItExists = "commits that did not parse were counted as patches, so a branch of 'wip' commits produced a release with an empty changelog";

  override async run(t: TestRun): Promise<void> {
    const { makePlan, config } = await planner();
    const patch = this.repo();
    this.tag(patch, "v1.2.3");
    this.commit(patch, "fix: a");
    const fromFix = makePlan(patch, config, this.version("1.2.3"));
    t.assert.equal(fromFix.level, "patch");
    t.assert.deepEqual(fromFix.next, { major: 1, minor: 2, patch: 4 });

    const noise = this.repo();
    this.tag(noise, "v1.2.3");
    this.commit(noise, "wip");
    this.commit(noise, "Update readme");
    // A merge commit, made by git: a second branch merged back with --no-ff.
    git(noise, "checkout", "-q", "-b", "side");
    this.commit(noise, "fix: on the side");
    git(noise, "checkout", "-q", "main");
    git(noise, "merge", "-q", "--no-ff", "--no-edit", "side");
    const fromNoise = makePlan(noise, config, this.version("1.2.3"));
    t.assert.deepEqual(fromNoise.ignored.map((c) => c.subject), ["wip", "Update readme"], "both non-conforming subjects are listed as ignored");
    t.assert.deepEqual(fromNoise.commits.map((c) => c.subject), ["on the side"], "the merged fix counts; the merge commit itself appears nowhere");
    t.assert.equal(fromNoise.ignored.some((c) => c.subject.startsWith("Merge")), false, "the merge commit is not ignored-noise either");

    const nothing = this.repo();
    this.tag(nothing, "v1.2.3");
    this.commit(nothing, "wip");
    const fromNothing = makePlan(nothing, config, this.version("1.2.3"));
    t.assert.equal(fromNothing.level, null);
    t.assert.equal(fromNothing.hasRelease, false);
    t.assert.deepEqual(fromNothing.next, fromNothing.current, "no release means the version stays");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheHighestTagOutranksAStaleVersionFile extends PlanTest {
  readonly id = "when-the-version-file-lags-the-highest-tag-the-tag-is-the-base";
  readonly whyItExists = "a fix on a stale checkout released v0.1.1 while v0.2.0 already existed, because the VERSION file was the only base considered";

  override async run(t: TestRun): Promise<void> {
    const { makePlan, config } = await planner();
    const dir = this.repo();
    this.tag(dir, "v0.2.0");
    this.commit(dir, "fix: a");
    const plan = makePlan(dir, config, this.version("0.1.0"));
    t.assert.deepEqual(plan.current, { major: 0, minor: 2, patch: 0 }, "the base is the tag, not the lagging file");
    t.assert.deepEqual(plan.next, { major: 0, minor: 2, patch: 1 }, "so the fix releases 0.2.1, never 0.1.1");

    // And the other way round: a VERSION file ahead of every tag is the base.
    const ahead = this.repo();
    this.tag(ahead, "v0.2.0");
    this.commit(ahead, "fix: b");
    const fromFile = makePlan(ahead, config, this.version("0.5.0"));
    t.assert.deepEqual(fromFile.next, { major: 0, minor: 5, patch: 1 });
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class NoTagMeansTheFirstRelease extends PlanTest {
  readonly id = "a-repository-with-commits-and-no-version-tag-plans-the-first-release-at-the-current-version";
  readonly whyItExists = "the first release bumped the version the VERSION file already declared, so the very first tag never matched the file";

  override async run(t: TestRun): Promise<void> {
    const { makePlan, config } = await planner();
    const dir = this.repo();
    this.commit(dir, "feat: begin");
    this.commit(dir, "wip");
    const plan = makePlan(dir, config, this.version("0.1.0"));
    t.assert.equal(plan.isFirstRelease, true);
    t.assert.equal(plan.fromTag, null);
    t.assert.equal(plan.level, null);
    t.assert.equal(plan.hasRelease, true, "a first release IS a release");
    t.assert.deepEqual(plan.next, { major: 0, minor: 1, patch: 0 }, "at the current version, unchanged");
    t.assert.deepEqual(plan.commits.map((c) => c.subject), ["root", "begin"], "every conforming commit in the history is in the first changelog");
    t.assert.deepEqual(plan.ignored.map((c) => c.subject), ["wip"]);
  }
}

registerFeatureTests(new TheLargestLevelWins(), new ABreakingChangeIsMajor(), new PatchOnlyAndNothingToRelease(), new TheHighestTagOutranksAStaleVersionFile(), new NoTagMeansTheFirstRelease());
