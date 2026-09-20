/**
 * `version-hook`.
 *
 * A maintainer squashes a pull request into one commit whose message is the
 * PR title, so the title has to pass the same rule as a commit does. One
 * function, `checkMessage`, is reached three ways: the local `commit-msg`
 * hook (`--message-file` on the message git is about to record), the CI job
 * that writes the PR title to a file and runs the same `--message-file`
 * branch, and the CI job that runs `--range BASE..HEAD` over the PR's commits.
 * All three must agree, or a squash can land a message the release tool
 * cannot parse.
 *
 * `proc`, as the record declares. Every clause below runs the REAL
 * `tools/version/bin/magentra-version.mjs` and the REAL `.githooks/commit-msg`
 * — copied byte for byte into a throwaway repository this test owns, never
 * reimplemented or stubbed, and never run against the developer's own
 * repository.
 *
 * THE SANDBOX. `magentra-version.mjs` computes its own repository root with
 * `git rev-parse --show-toplevel` and reads `version.config.json`/`VERSION`
 * relative to it, and the hook computes the tool's path the same way — so a
 * copy run inside a repo that does not also carry `tools/version/**`,
 * `version.config.json` and `VERSION` cannot find itself. Each test therefore
 * builds `tmp/tools/version/{bin,lib}`, `tmp/.githooks`, `tmp/version.config.json`
 * and `tmp/VERSION` as copies of this repository's own files (no dependency —
 * the tool's own header says so — so nothing else needs to be vendored in).
 *
 * THE HOOK IS WIRED ONLY WHERE THE HOOK ITSELF IS UNDER TEST (checklist 5).
 * Every other repository leaves `core.hooksPath` unset, because the fixture
 * commits for checklists 2 and 3 include messages the hook is SUPPOSED to
 * reject — wiring it in those repos would stop the fixture from being built at
 * all, self-blocking `git commit` on the exact input needed to prove the tool
 * agrees with itself.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";
import { repoRoot } from "../lib/inventory.ts";

const FEATURE = "version-hook";

/** Verbatim from the record. */
const INVARIANT = "The same check runs in the local hook, on the PR title, and over the PR's commit range, and all three agree.";

interface Problem {
  readonly message: string;
  readonly hint?: string;
}
interface Config {
  readonly types: Record<string, { bump: string; section: string }>;
  readonly scopes: readonly string[];
  readonly subjectMaxLength: number;
}
interface CommitsModule {
  readonly checkMessage: (message: string, config: Config) => Problem[];
  readonly isGitGenerated: (subject: string) => boolean;
}
interface ConfigModule {
  readonly loadConfig: (root: string) => Config;
}

const requireFromHere = createRequire(import.meta.url);
const commitsModule = requireFromHere(join(repoRoot(), "tools", "version", "lib", "commits.mjs")) as CommitsModule;
const configModule = requireFromHere(join(repoRoot(), "tools", "version", "lib", "config.mjs")) as ConfigModule;
/** The real config, read directly rather than reconstructed, so checklist 3's direct call proves what the tool itself would load. */
const REAL_CONFIG = configModule.loadConfig(repoRoot());

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

abstract class HookTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #repos: string[] = [];

  override async tearDown(): Promise<void> {
    // Every process this test spawns is `spawnSync` — done, by definition,
    // before this runs.
    for (const dir of this.#repos) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#repos = [];
  }

  /** `git`, spawned directly, never through a shell. */
  protected git(dir: string, args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  protected binPath(dir: string): string {
    return join(dir, "tools", "version", "bin", "magentra-version.mjs");
  }

  protected hookPath(dir: string): string {
    return join(dir, ".githooks", "commit-msg");
  }

  /**
   * A throwaway repository carrying real copies of the version tool, the
   * hook, and the two files the tool reads from the repository root — nothing
   * reimplemented, nothing stubbed.
   */
  protected makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "magentra-vhook-"));
    this.#repos.push(dir);

    mkdirSync(join(dir, "tools", "version", "bin"), { recursive: true });
    mkdirSync(join(dir, "tools", "version", "lib"), { recursive: true });
    mkdirSync(join(dir, ".githooks"), { recursive: true });

    copyFileSync(join(repoRoot(), "tools", "version", "bin", "magentra-version.mjs"), this.binPath(dir));
    for (const name of readdirSync(join(repoRoot(), "tools", "version", "lib"))) {
      copyFileSync(join(repoRoot(), "tools", "version", "lib", name), join(dir, "tools", "version", "lib", name));
    }
    copyFileSync(join(repoRoot(), ".githooks", "commit-msg"), this.hookPath(dir));
    copyFileSync(join(repoRoot(), "version.config.json"), join(dir, "version.config.json"));
    copyFileSync(join(repoRoot(), "VERSION"), join(dir, "VERSION"));

    this.git(dir, ["init", "-q"]);
    this.git(dir, ["config", "user.email", "tests@magentra.invalid"]);
    this.git(dir, ["config", "user.name", "MAGENTRA tests"]);
    return dir;
  }

  /** Wires the copied hook into THIS repository — only for the test that is about the hook itself. */
  protected enableHook(dir: string): void {
    this.git(dir, ["config", "core.hooksPath", ".githooks"]);
  }

  protected commitEmpty(dir: string, message: string, isoSeconds?: string): void {
    const env = isoSeconds ? { ...process.env, GIT_AUTHOR_DATE: isoSeconds, GIT_COMMITTER_DATE: isoSeconds } : process.env;
    execFileSync("git", ["commit", "--allow-empty", "-m", message], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  }

  /** `git commit`, which the hook may refuse — captured rather than thrown. */
  protected tryCommit(dir: string, message: string): Run {
    const res = spawnSync("git", ["commit", "--allow-empty", "-m", message], { cwd: dir, encoding: "utf8" });
    return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  /** The version tool, run exactly as the hook and CI run it: `node <bin> <args…>`. */
  protected runTool(dir: string, args: readonly string[]): Run {
    const res = spawnSync(process.execPath, [this.binPath(dir), ...args], { cwd: dir, encoding: "utf8" });
    return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  /** The hook script itself, through `sh` — not through `git commit` — with a message file as its one argument. */
  protected runHookDirect(dir: string, messageFile: string): Run {
    const res = spawnSync("sh", [this.hookPath(dir), messageFile], { cwd: dir, encoding: "utf8" });
    return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class MessageFileAgreesOnAValidAndAMalformedSubject extends HookTest {
  readonly id = "check-message-file-accepts-a-correct-subject-and-rejects-a-malformed-one";
  readonly whyItExists =
    "if --message-file passed a malformed subject, the PR-title CI job (which uses exactly this branch) would wave through a title the release tool cannot later parse into a changelog entry";

  override run(t: TestRun): void {
    const dir = this.makeRepo();

    const goodFile = join(dir, "good.txt");
    writeFileSync(goodFile, "feat(core): add x\n", "utf8");
    const good = this.runTool(dir, ["check", "--message-file", goodFile]);
    t.assert.equal(good.status, 0, good.stdout + good.stderr);
    t.assert.match(good.stdout, /The commit message is correct\./);

    const badFile = join(dir, "bad.txt");
    writeFileSync(badFile, "Add x\n", "utf8");
    const bad = this.runTool(dir, ["check", "--message-file", badFile]);
    t.assert.equal(bad.status, 1);
    t.assert.match(bad.stdout, /does not have the necessary form: "Add x"/);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class RangeCheckFlagsExactlyTheOneBadCommitAndSkipsTheMerge extends HookTest {
  readonly id = "range-check-flags-exactly-one-bad-commit-and-the-merge-is-neither-listed-nor-counted";
  readonly whyItExists =
    "counting a merge commit as a real change would blame it for someone else's history, and missing or over-reporting the one malformed commit would leave a bad PR title-equivalent commit unflagged or flag an innocent one";

  override run(t: TestRun): void {
    const dir = this.makeRepo();
    this.commitEmpty(dir, "chore: base", "2020-01-01T00:00:01Z");
    const base = this.git(dir, ["rev-parse", "HEAD"]).trim();

    this.commitEmpty(dir, "feat: ok", "2020-01-01T00:00:02Z");
    this.commitEmpty(dir, "bad message", "2020-01-01T00:00:03Z");

    this.git(dir, ["checkout", "-b", "feature"]);
    this.commitEmpty(dir, "feat: branch work", "2020-01-01T00:00:04Z");
    this.git(dir, ["checkout", "-"]);
    execFileSync("git", ["merge", "--no-ff", "feature", "-m", "Merge branch 'feature'"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:05Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:05Z" },
    });

    const result = this.runTool(dir, ["check", "--range", `${base}..HEAD`]);
    t.assert.equal(result.status, 1);
    // `ui.error` prints to stderr and `ui.success`/`ui.info` print to stdout
    // (tools/version/lib/ui.mjs), so the bad commit's own header line and the
    // final tally live on stderr while the good commits and the problem
    // detail live on stdout — the report is only complete read together.
    const combined = `${result.stdout}\n${result.stderr}`;

    const badLines = combined.split("\n").filter((line) => line.includes("bad message"));
    t.assert.ok(badLines.length > 0, `expected at least one line naming the bad commit, got:\n${combined}`);
    t.assert.ok(
      badLines.some((line) => line.includes("✗")),
      `expected a line marking "bad message" as wrong, got:\n${combined}`,
    );

    t.assert.equal(combined.includes("Merge branch"), false, "the merge commit's own subject must not appear anywhere in the report");
    t.assert.match(combined, /1 of 3 commit message\(s\) are not correct\./, "the merge must not be counted among the checked commits either");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AllThreeCheckersAgreeAcrossFourKindsOfMessage extends HookTest {
  readonly id = "message-file-range-and-direct-checkmessage-agree-on-valid-invalid-type-overlength-and-merge-subjects";
  readonly whyItExists =
    "the whole point of one shared function is that the hook, the PR-title job and the PR-commits job never disagree — if any of the three used a different rule, a title could pass the hook and fail CI, or the reverse, and a maintainer would have no way to know which one to trust";

  override run(t: TestRun): void {
    const dir = this.makeRepo();
    this.commitEmpty(dir, "chore: base", "2020-01-01T00:00:01Z");
    const base = this.git(dir, ["rev-parse", "HEAD"]).trim();

    const VALID = "feat(core): add x";
    const INVALID_TYPE = "bogus: add x";
    const OVER_LENGTH = `fix(core): ${"x".repeat(90)}`;
    const MERGE = "Merge speculative branch into main";
    t.assert.ok(OVER_LENGTH.length > REAL_CONFIG.subjectMaxLength, "the fixture must actually exceed the configured limit");

    const messages = [VALID, INVALID_TYPE, OVER_LENGTH, MERGE];
    messages.forEach((message, i) => this.commitEmpty(dir, message, `2020-01-01T00:00:0${i + 2}Z`));

    const range = this.runTool(dir, ["check", "--range", `${base}..HEAD`]);
    // See the note in checklist 2: a bad commit's header line is `ui.error`
    // (stderr); a good one is `ui.success` (stdout). Only the two together are
    // the whole report.
    const combined = `${range.stdout}\n${range.stderr}`;

    for (const message of messages) {
      const direct = commitsModule.checkMessage(message, REAL_CONFIG).length === 0;

      const file = join(dir, "msg.txt");
      writeFileSync(file, `${message}\n`, "utf8");
      const fromFile = this.runTool(dir, ["check", "--message-file", file]).status === 0;

      t.assert.equal(fromFile, direct, `message-file disagreed with checkMessage() for: ${JSON.stringify(message)}`);

      const isGitGenerated = commitsModule.isGitGenerated(message);
      const flaggedGood = combined.split("\n").some((l) => l.includes(message) && l.includes("✓"));
      const flaggedBad = combined.split("\n").some((l) => l.includes(message) && l.includes("✗"));

      if (isGitGenerated) {
        // A git-generated subject is never printed at all — not counted as
        // good, not counted as bad. `checkMessage` agrees: it treats it as no
        // problem, but the SAME thing `--range` proves by omission.
        t.assert.equal(direct, true, "checkMessage must treat a git-generated subject as no problem");
        t.assert.equal(flaggedGood || flaggedBad, false, `a Merge subject must not be listed by --range at all, good or bad:\n${combined}`);
      } else {
        t.assert.equal(flaggedBad, !direct, `--range disagreed with checkMessage() for: ${JSON.stringify(message)}`);
        t.assert.equal(flaggedGood, direct, `--range disagreed with checkMessage() for: ${JSON.stringify(message)}`);
      }
    }
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class MissingArgumentsFailLoudlyAndNoReleaseBranchFallsBackToTheLastCommit extends HookTest {
  readonly id = "a-missing-message-file-path-or-range-fails-loudly-and-no-release-branch-checks-only-the-last-commit";
  readonly whyItExists =
    "a --message-file or --range invoked with no value could silently check nothing and report success, which is worse than not running at all; and a repository where the release branch is unreachable must still check something rather than throwing past CI's actual PR commits";

  override run(t: TestRun): void {
    const dir = this.makeRepo();
    this.commitEmpty(dir, "chore: base", "2020-01-01T00:00:01Z");
    // Renamed explicitly, so "no release branch reachable" holds regardless of
    // what this machine's `init.defaultBranch` happens to be.
    this.git(dir, ["branch", "-m", "solo"]);

    const noPath = this.runTool(dir, ["check", "--message-file"]);
    t.assert.equal(noPath.status, 1);
    t.assert.match(noPath.stderr, /--message-file needs a path\./);

    const noRange = this.runTool(dir, ["check", "--range"]);
    t.assert.equal(noRange.status, 1);
    t.assert.match(noRange.stderr, /--range needs a range\./);

    t.assert.equal(this.git(dir, ["branch", "--show-current"]).trim(), "solo");
    const bare = this.runTool(dir, ["check"]);
    t.assert.equal(bare.status, 0, bare.stdout + bare.stderr);
    t.assert.match(bare.stdout, /Cannot find the branch "main"\. The tool checks only the last commit\./);
    t.assert.match(bare.stdout, /All 1 commit message\(s\) are correct\./, "exactly the last commit, and only it, must have been checked");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheHookInvokesTheRealToolAndARejectionStopsGit extends HookTest {
  readonly id = "the-commit-msg-hook-invokes-the-version-tool-and-a-rejected-message-stops-the-commit";
  readonly whyItExists =
    "the hook is the only one of the three checkers that runs on a developer's machine before anything reaches CI — if it invoked the wrong script, the wrong subcommand, or silently exited 0 on a bad message, every other guarantee here would still let a malformed commit land";

  override run(t: TestRun): void {
    const hookSource = readFileSync(join(repoRoot(), ".githooks", "commit-msg"), "utf8");
    t.assert.ok(
      hookSource.includes('exec node "$(git rev-parse --show-toplevel)/tools/version/bin/magentra-version.mjs"'),
      "the hook must exec the version tool at the repository root it is running in",
    );
    t.assert.ok(hookSource.includes('check --message-file "$1"'), "the hook must run 'check --message-file' with its own first argument");

    const dir = this.makeRepo();
    this.enableHook(dir);
    this.commitEmpty(dir, "chore: base", "2020-01-01T00:00:01Z");
    const before = this.git(dir, ["rev-parse", "HEAD"]).trim();

    // Run directly through `sh`, bypassing `git commit` entirely, against a
    // message the version tool itself must reject — the 73-character subject
    // this feature's own brief calls out, one character past subjectMaxLength.
    const oneOver = `fix(core): ${"x".repeat(REAL_CONFIG.subjectMaxLength + 1 - "fix(core): ".length)}`;
    t.assert.equal(oneOver.length, REAL_CONFIG.subjectMaxLength + 1, "the fixture must be exactly one character over the limit");
    const badFile = join(dir, "bad-subject.txt");
    writeFileSync(badFile, `${oneOver}\n`, "utf8");
    const direct = this.runHookDirect(dir, badFile);
    t.assert.notEqual(direct.status, 0, "the hook, run directly through sh, must exit non-zero for an over-length subject");
    t.assert.match(
      direct.stdout,
      new RegExp(`is ${REAL_CONFIG.subjectMaxLength + 1} characters`),
      "the hook's own output must name the real tool's real reason, not a paraphrase",
    );

    // The boundary: exactly the limit passes, run the same way.
    const exactly = oneOver.slice(0, -1);
    t.assert.equal(exactly.length, REAL_CONFIG.subjectMaxLength);
    const goodFile = join(dir, "good-subject.txt");
    writeFileSync(goodFile, `${exactly}\n`, "utf8");
    const directGood = this.runHookDirect(dir, goodFile);
    t.assert.equal(directGood.status, 0, directGood.stdout + directGood.stderr);

    // And now through the real `git commit`, wired via core.hooksPath: the
    // over-length message must be refused and HEAD must not move.
    const refused = this.tryCommit(dir, oneOver);
    t.assert.notEqual(refused.status, 0);
    t.assert.equal(this.git(dir, ["rev-parse", "HEAD"]).trim(), before, "a commit the hook refused must not have moved HEAD");

    const accepted = this.tryCommit(dir, exactly);
    t.assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    t.assert.notEqual(this.git(dir, ["rev-parse", "HEAD"]).trim(), before, "a commit the hook accepted must have moved HEAD");
    t.assert.equal(this.git(dir, ["log", "-1", "--format=%s"]).trim(), exactly);
  }
}

registerFeatureTests(
  new MessageFileAgreesOnAValidAndAMalformedSubject(),
  new RangeCheckFlagsExactlyTheOneBadCommitAndSkipsTheMerge(),
  new AllThreeCheckersAgreeAcrossFourKindsOfMessage(),
  new MissingArgumentsFailLoudlyAndNoReleaseBranchFallsBackToTheLastCommit(),
  new TheHookInvokesTheRealToolAndARejectionStopsGit(),
);
