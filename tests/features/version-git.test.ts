/**
 * `version-git`.
 *
 * `tools/version/lib/git.mjs` is the only place the version tool talks to git:
 * every exported function reads tags, commits or remote state through one
 * `execFileSync('git', args, …)` call with no shell, so a branch name or a
 * commit subject can never be interpreted as a command. Deciding a release
 * from wrong or missing history would re-release an old version or duplicate
 * changelog entries, so the module must also never write anything back.
 *
 * `proc`, as the record declares — a real `git` binary is spawned for every
 * assertion below, in a throwaway repository this test builds and destroys.
 * `git.mjs`'s own functions are called in-process (`createRequire`, since the
 * module is plain `.mjs` with no declaration file — the established idiom in
 * this suite, see `mirror-default-base-url.test.ts`); what makes this `proc`
 * and not `pure` is that every one of those calls spawns a real `git` child
 * underneath, and the read-only claim can only be proven against one.
 *
 * COMMIT TIMESTAMPS ARE PINNED with `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`.
 * Commits made back to back in a test can land in the same second, and git's
 * default order then falls back to its own graph walk rather than creation
 * order — so an unpinned version of checklist 2 passed or failed depending on
 * how fast the machine ran it. Pinning distinct seconds is what makes "oldest
 * first" a claim this test can actually check.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";
import { repoRoot } from "../lib/inventory.ts";

const FEATURE = "version-git";

/** Verbatim from the record. */
const INVARIANT =
  "versionTags, commitsSince, originUrl, githubHttpsUrl and hasUncommittedChanges answer correctly and never mutate the repository.";

interface VersionTagEntry {
  readonly tag: string;
  readonly version: { readonly major: number; readonly minor: number; readonly patch: number };
  readonly build: number;
}

interface RawCommit {
  readonly hash: string;
  readonly shortHash: string;
  readonly subject: string;
  readonly body: string;
}

interface GitModule {
  readonly versionTags: (root: string, tagPrefix: string) => VersionTagEntry[];
  readonly commitsSince: (root: string, fromTag: string | null) => RawCommit[];
  readonly originUrl: (root: string) => string | null;
  readonly githubHttpsUrl: (url: string | null) => string | null;
  readonly hasUncommittedChanges: (root: string) => boolean;
}

const requireFromHere = createRequire(import.meta.url);
const git = requireFromHere(join(repoRoot(), "tools", "version", "lib", "git.mjs")) as GitModule;

/**
 * Shared setup: a throwaway `git` repository per test, with an identity of its
 * own so a commit succeeds on a bare machine with no `~/.gitconfig` — set
 * LOCALLY, in the repo, rather than passed as `-c` flags, because this suite's
 * brief for this feature calls for a repo that behaves like one a developer
 * actually has, not one that only ever sees one git invocation at a time.
 */
abstract class GitToolTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #repos: string[] = [];

  override async tearDown(): Promise<void> {
    // `execFileSync` blocks until each git process exits, so by the time this
    // runs every child this test spawned is already gone — the retrying
    // rmSync is here only for the handle Windows can hold open a moment
    // longer than the process itself.
    for (const dir of this.#repos) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#repos = [];
  }

  /** A fresh repository with a real git identity configured locally. */
  protected makeRepo(prefix = "magentra-vgit-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#repos.push(dir);
    this.runGit(dir, ["init", "-q"]);
    this.runGit(dir, ["config", "user.email", "tests@magentra.invalid"]);
    this.runGit(dir, ["config", "user.name", "MAGENTRA tests"]);
    return dir;
  }

  /** `git`, spawned directly — never through a shell, never through `npx`. */
  protected runGit(dir: string, args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  /** One commit, at a pinned second so ordering across several commits is deterministic. */
  protected commitAt(dir: string, file: string, contents: string, message: string, isoSeconds: string): void {
    writeFileSync(join(dir, file), contents, "utf8");
    this.runGit(dir, ["add", "."]);
    execFileSync("git", ["commit", "-q", "-m", message], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_DATE: isoSeconds, GIT_COMMITTER_DATE: isoSeconds },
    });
  }

  /** `HEAD`, the tag list, the working-tree status and the reflog — everything a mutation could touch. */
  protected snapshot(dir: string): Record<string, string> {
    return {
      head: this.runGit(dir, ["rev-parse", "HEAD"]),
      tags: this.runGit(dir, ["tag", "--list"]),
      status: this.runGit(dir, ["status", "--porcelain"]),
      reflog: this.runGit(dir, ["reflog", "show", "HEAD"]),
    };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class VersionTagsOrdersNewestFirstAndIgnoresAStrayTag extends GitToolTest {
  readonly id = "version-tags-orders-newest-first-and-ignores-a-non-version-tag";
  readonly whyItExists =
    "a wrong sort, or a stray non-version tag slipping through, would make the next release start its changelog from the wrong point and either repeat commits already released or skip real ones";

  override run(t: TestRun): void {
    const dir = this.makeRepo();
    this.commitAt(dir, "f.txt", "one\n", "feat: first", "2020-01-01T00:00:01Z");
    for (const tag of ["v0.1.0", "v0.2.0", "v0.13.0.0", "v0.13.0.1", "vfoo"]) this.runGit(dir, ["tag", tag]);

    const tags = git.versionTags(dir, "v");
    t.assert.deepEqual(
      tags.map((entry) => entry.tag),
      ["v0.13.0.1", "v0.13.0.0", "v0.2.0", "v0.1.0"],
      "the legacy build number must break the v0.13.0.0/v0.13.0.1 tie, newest first",
    );
    t.assert.equal(
      tags.some((entry) => entry.tag === "vfoo"),
      false,
      "vfoo looks like a version tag only by prefix, and must never be treated as one",
    );

    const untagged = this.makeRepo("magentra-vgit-empty-");
    this.commitAt(untagged, "f.txt", "one\n", "feat: only commit", "2020-01-01T00:00:01Z");
    t.assert.deepEqual(git.versionTags(untagged, "v"), [], "a repository with no version tags must report none, not throw");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class CommitsSinceExcludesMergesAndSplitsAMultilineBody extends GitToolTest {
  readonly id = "commits-since-a-tag-excludes-merges-and-splits-a-multiline-body";
  readonly whyItExists =
    "a merge commit counted as a real change would attribute someone else's work to the merge, and a multi-line body split on the wrong boundary would corrupt the changelog entry — while a repository with no commits at all used to make git log fail, which this function must turn into an empty release rather than a crash";

  override run(t: TestRun): void {
    const dir = this.makeRepo();
    this.commitAt(dir, "f.txt", "a\n", "feat: first", "2020-01-01T00:00:01Z");
    this.runGit(dir, ["tag", "v0.1.0"]);
    this.commitAt(dir, "f.txt", "b\n", "fix: second\n\nline one\nline two", "2020-01-01T00:00:02Z");

    this.runGit(dir, ["checkout", "-b", "feature"]);
    this.commitAt(dir, "g.txt", "c\n", "feat: branch work", "2020-01-01T00:00:03Z");
    this.runGit(dir, ["checkout", "-"]);
    execFileSync("git", ["merge", "--no-ff", "feature", "-m", "Merge branch 'feature'"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:04Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:04Z" },
    });
    this.commitAt(dir, "h.txt", "d\n", "chore: third", "2020-01-01T00:00:05Z");

    const commits = git.commitsSince(dir, "v0.1.0");
    t.assert.deepEqual(
      commits.map((c) => c.subject),
      ["fix: second", "feat: branch work", "chore: third"],
      "oldest first, and the merge commit must not appear at all",
    );
    const withBody = commits.find((c) => c.subject === "fix: second");
    t.assert.equal(withBody?.body, "line one\nline two", "a multi-line body must survive intact, not be cut at the first newline");
    t.assert.equal(
      commits.every((c) => /^[0-9a-f]{40}$/.test(c.hash) && c.hash.startsWith(c.shortHash)),
      true,
      "each commit carries its real full and short hash",
    );

    const empty = this.makeRepo("magentra-vgit-nocommits-");
    t.assert.deepEqual(git.commitsSince(empty, null), [], "a repository with no commits must answer with no commits, not throw");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class GithubHttpsUrlMapsEveryRemoteFormAndOriginUrlIsNullWithNone extends GitToolTest {
  readonly id = "github-https-url-maps-every-remote-form-and-origin-url-is-null-with-none";
  readonly whyItExists =
    "a remote form left unmapped would break the changelog's compare links for a plain collaborator clone, and reporting a URL for a repository with no origin would print a link to nothing instead of omitting it";

  override run(t: TestRun): void {
    t.assert.equal(git.githubHttpsUrl("git@github.com:owner/name.git"), "https://github.com/owner/name");
    t.assert.equal(git.githubHttpsUrl("https://github.com/owner/name.git"), "https://github.com/owner/name");
    t.assert.equal(git.githubHttpsUrl("https://github.com/owner/name"), "https://github.com/owner/name");
    t.assert.equal(git.githubHttpsUrl(null), null);
    t.assert.equal(git.githubHttpsUrl("https://gitlab.com/owner/name.git"), null, "a non-GitHub remote must not be mapped to a GitHub URL");

    const dir = this.makeRepo();
    this.commitAt(dir, "f.txt", "one\n", "feat: first", "2020-01-01T00:00:01Z");
    t.assert.equal(git.originUrl(dir), null, "a repository with no origin remote must report null, not throw or invent one");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class HasUncommittedChangesTracksTheWorkingTree extends GitToolTest {
  readonly id = "has-uncommitted-changes-toggles-with-the-working-tree";
  readonly whyItExists =
    "apply refuses to release when this reports true; if it reported clean with a real modification sitting in the working tree, apply would silently fold an unrelated, unreviewed change into the release commit";

  override run(t: TestRun): void {
    const dir = this.makeRepo();
    this.commitAt(dir, "f.txt", "one\n", "feat: first", "2020-01-01T00:00:01Z");
    t.assert.equal(git.hasUncommittedChanges(dir), false, "right after a commit the tree is clean");

    writeFileSync(join(dir, "untracked.txt"), "new\n", "utf8");
    t.assert.equal(git.hasUncommittedChanges(dir), true, "an untracked file is still a real change to the working tree");

    this.runGit(dir, ["add", "."]);
    this.runGit(dir, ["commit", "-q", "-m", "feat: second"]);
    t.assert.equal(git.hasUncommittedChanges(dir), false, "committing the new file returns the tree to clean");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class EveryExportedFunctionIsReadOnlyAndSpawnsOnlyABareGit extends GitToolTest {
  readonly id = "every-exported-function-is-read-only-and-spawns-only-a-bare-git";
  readonly whyItExists =
    "a mutating call, or a git invocation that went through a shell, would let a branch name or a commit subject execute as a command while this tool was only supposed to be deciding what to release";

  override run(t: TestRun): void {
    const source = readFileSync(join(repoRoot(), "tools", "version", "lib", "git.mjs"), "utf8");
    const execCalls = [...source.matchAll(/execFileSync\(\s*('[^']*'|"[^"]*")/g)];
    t.assert.equal(execCalls.length, 1, "every git invocation must funnel through the one wrapper — a second call site is a second place to get this wrong");
    t.assert.equal(execCalls[0]?.[1], "'git'", "the command must be the literal 'git', never a variable that could resolve to something else");
    t.assert.equal(/\bshell\s*:/.test(source), false, "no execFileSync call may pass a shell option");
    t.assert.equal(source.includes("npx"), false, "the module must never shell out through npx");

    const dir = this.makeRepo();
    this.commitAt(dir, "f.txt", "one\n", "feat: first", "2020-01-01T00:00:01Z");
    this.runGit(dir, ["tag", "v0.1.0"]);
    this.commitAt(dir, "f.txt", "two\n", "fix: second", "2020-01-01T00:00:02Z");

    const before = this.snapshot(dir);
    git.versionTags(dir, "v");
    git.commitsSince(dir, "v0.1.0");
    git.commitsSince(dir, null);
    git.originUrl(dir);
    git.githubHttpsUrl("https://github.com/owner/name.git");
    git.hasUncommittedChanges(dir);
    const after = this.snapshot(dir);

    t.assert.deepEqual(after, before, "HEAD, the tag list, the working-tree status and the reflog must be byte-identical after every exported function ran");
  }
}

registerFeatureTests(
  new VersionTagsOrdersNewestFirstAndIgnoresAStrayTag(),
  new CommitsSinceExcludesMergesAndSplitsAMultilineBody(),
  new GithubHttpsUrlMapsEveryRemoteFormAndOriginUrlIsNullWithNone(),
  new HasUncommittedChangesTracksTheWorkingTree(),
  new EveryExportedFunctionIsReadOnlyAndSpawnsOnlyABareGit(),
);
