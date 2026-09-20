/**
 * `tool-bash`.
 *
 * Bash is two promises in one tool. The first is a PREDICATE the permission
 * engine leans on: `bashDeletionSubject` decides whether a command is
 * destructive, and it must say yes to `rm -rf build` and no to
 * `npm run del-lint` — the second being a false positive that trains a user to
 * click through deletion prompts. The second promise is about what happens when
 * the command runs long: on timeout the whole PROCESS TREE dies, not just the
 * shell that node happens to hold a handle to.
 *
 * KIND RE-DECLARED, 2026-09-20: the record said `["proc"]`; it now reads
 * `["pure", "proc"]`. Checklist items 1–3 are a string in and a string out —
 * `bashDeletionSubject` is exported from `@magentra/tools` and reaches nothing.
 * tests/README's own rule is that spawning a process to reach a function that
 * was already reachable buys nothing, so the matcher is proved `pure` and only
 * the two items that really run a shell (4 and 5) are `proc`.
 *
 * `bashDeletionScope` and `bashDeletionTargets` are NOT package exports (the
 * index re-exports only `resolveBashPath`, `spawnShell`, `killTree` and
 * `bashDeletionSubject`), so the workspace/unknown/protected classification the
 * WHERE section lists is not reachable from here — it belongs to
 * `deletion-scope-split` and `protected-state-dir`, which own it.
 *
 * The `proc` half runs the tool through the real validate-then-execute path
 * (`tests/lib/directTool.ts`) against `strictServices({})`: with no `callId`
 * the output streamer is a no-op, so Bash touches no session service at all and
 * one appearing in a future version fails by name instead of reading
 * `undefined`. The shell it spawns is the product's own (Git Bash on Windows,
 * `bash` elsewhere, via `resolveBashPath`) — nothing here is a double.
 *
 * TWO PLATFORM FACTS, MEASURED RATHER THAN ASSUMED.
 *  - Git Bash's `pwd` prints an MSYS path (`/tmp/…`), not a Windows one, so the
 *    tree-kill proof below never compares a printed path. It compares the SIZE
 *    of a file a grandchild was appending to, which is the same observation on
 *    every platform.
 *  - `killTree` is `taskkill /pid … /T /F` on win32 and `process.kill(-pid)`
 *    on POSIX. The assertion is the outcome the two share: the grandchild
 *    stopped writing.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "@magentra/core";
import { bashDeletionSubject, bashTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "tool-bash";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT =
  "The deletion matcher fires on standalone destructive tokens and phrases without false-positiving on substrings, and a timeout kills the whole process tree.";

/** The hidden marker `spawnShell` appends to track `cd`. It is plumbing, never output. */
const PWD_MARKER = "__MAGENTRA_PWD__";

/* ---- the matcher: a string in, a verdict out ------------------------- */

abstract class DeletionMatcherTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /**
   * Every command in `commands` must be flagged, and flagged by being RETURNED:
   * the permission prompt shows what `deletionSubject` hands back, so a
   * matcher that answered `true` would leave the user approving nothing.
   */
  protected allFlagged(t: TestRun, commands: readonly string[]): void {
    for (const command of commands) {
      t.assert.equal(
        bashDeletionSubject(command),
        command,
        `${JSON.stringify(command)} is destructive and must be flagged, with the command itself as the subject`,
      );
    }
  }

  protected noneFlagged(t: TestRun, commands: readonly string[]): void {
    for (const command of commands) {
      t.assert.equal(
        bashDeletionSubject(command),
        undefined,
        `${JSON.stringify(command)} deletes nothing — flagging it is a prompt the user learns to click through`,
      );
    }
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class StandaloneTokensAndPhrasesFire extends DeletionMatcherTest {
  readonly id = "a-standalone-destructive-token-or-phrase-is-flagged-wherever-a-command-can-start";
  readonly whyItExists =
    "a matcher anchored at the start of the string read `echo a && del b` as harmless, so a deletion hidden behind a shell separator ran with no prompt at all; and one that matched only lower case let `RM x` through";

  override run(t: TestRun): void {
    this.allFlagged(t, [
      "rm -rf build",
      // Case-insensitive: the keyword list is lower case, the command need not be.
      "RM x",
      // After a separator. `&&` is non-word, so the leading \b is already satisfied.
      "echo a && del b",
      "git clean -fd",
      "DROP TABLE users",
      "kubectl delete pod x",
      "trash foo",
    ]);

    // The tool's own wiring, not just the function: `deletionSubject` is what
    // PermissionEngine.check calls, and a matcher nothing is wired to is inert.
    t.assert.equal(
      bashTool.deletionSubject?.({ command: "rm -rf build", description: "clear the build output", run_in_background: false }),
      "rm -rf build",
      "bashTool.deletionSubject must be the matcher — the permission engine reads the tool, never the function",
    );
    t.assert.equal(bashTool.permissionClass, "execute");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class SubstringsAndSafeFormsDoNotFire extends DeletionMatcherTest {
  readonly id = "a-substring-or-a-safe-form-is-never-flagged";
  readonly whyItExists =
    "`npm run del-lint` tripped the `del` keyword and `format` tripped `rm`, so ordinary build commands raised a deletion prompt every time — which is exactly how a user stops reading the prompt that matters";

  override run(t: TestRun): void {
    this.noneFlagged(t, [
      // `del` is there, but hyphen-joined: not a standalone command token.
      "npm run del-lint",
      // "format" contains "rm" with word characters on both sides.
      "format",
      "mkdir x",
      // The SAFE, merged-only delete. Only its letter case separates it from -D.
      "git branch -d old",
      // A plain rename inside the tree destroys nothing.
      "mv a b",
      "git checkout main",
      // `find` alone is a search; only `-delete` makes it a deletion.
      "find . -name x",
    ]);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheThreeSpecialCasesAndTheMvRule extends DeletionMatcherTest {
  readonly id = "the-three-special-cased-shapes-and-the-mv-rule";
  readonly whyItExists =
    "the shared case-insensitive pattern cannot tell `git branch -D` from `-d`, cannot end a phrase on `--`, and cannot reach a `-delete` flag sitting at the end of a find; each one was a real deletion that ran without a prompt";

  override run(t: TestRun): void {
    this.allFlagged(t, [
      "git branch -D old",
      "git checkout -- src/a.ts",
      'find . -name "*.tmp" -delete',
      // -f clobbers an existing destination silently.
      "mv -f a b",
      // A destination outside the workspace removes the file from it.
      "mv a /tmp/b",
      "mv a ../b",
    ]);

    // The two negatives that give the special cases their shape. Both are one
    // character away from a command above.
    t.assert.equal(
      bashDeletionSubject("git branch -d old"),
      undefined,
      "the -D/-d distinction holds only by letter case, which is why it is checked case-sensitively and separately",
    );
    t.assert.equal(
      bashDeletionSubject("git checkout --"),
      undefined,
      "`git checkout --` with no path discards nothing; the pattern requires the path that follows",
    );
  }
}

/* ---- what happens when it actually runs ------------------------------- */

abstract class BashRunTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** One session for the life of one test: Bash's cwd tracking is keyed on it. */
  readonly #session = strictServices({});
  #dirs: string[] = [];
  protected dir = "";

  override setUp(): void {
    // `realpath`, because macOS's tmpdir is a symlink (/var → /private/var) and
    // a shell reports the resolved path.
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), "magentra-bash-")));
    this.#dirs.push(this.dir);
  }

  protected ctx(): ToolContext {
    return { cwd: this.dir, session: this.#session };
  }

  protected async bash(command: string, timeout?: number) {
    return runTool(
      bashTool,
      { command, description: "a command this test runs", ...(timeout !== undefined ? { timeout } : {}) },
      this.ctx(),
    );
  }

  /**
   * The directories are removed HERE rather than by a kind helper, with
   * retries: Windows keeps a handle on a directory a moment after the process
   * that held it is gone, and `force` only forgives ENOENT. Every child these
   * tests start is either finished or killed by the tool before this runs.
   */
  override tearDown(): void {
    const dirs = this.#dirs;
    this.#dirs = [];
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class OneStreamAndAnHonestExitCode extends BashRunTest {
  readonly id = "stdout-and-stderr-come-back-as-one-result-and-a-non-zero-exit-is-an-error";
  readonly whyItExists =
    "only stdout was returned, so a command that failed came back empty and looked like it had printed nothing — the model then retried it instead of reading the error that was on stderr all along";

  override async run(t: TestRun): Promise<void> {
    const failed = await this.bash("echo out; echo err 1>&2; exit 2");
    const text = resultText(failed);
    t.assert.match(text, /out/, "stdout must be in the result");
    t.assert.match(text, /err/, "stderr must be in the SAME result — a separate channel is one the model never sees");
    t.assert.equal(failed.isError, true, "a non-zero exit is an error result, not a quiet success");
    t.assert.equal(
      text.includes(PWD_MARKER),
      false,
      "the cwd-tracking marker is plumbing and must never appear in what the model reads",
    );

    const silent = await this.bash("exit 0");
    t.assert.equal(resultText(silent), "(no output)", "a successful command that printed nothing says so");
    t.assert.equal(silent.isError, undefined, "exit 0 is not an error");

    // The foreground-sleep block, which is what makes item 5's command a
    // subshell rather than a bare `sleep`.
    const slept = await this.bash("sleep 5");
    t.assert.equal(slept.isError, true);
    t.assert.match(resultText(slept), /Foreground sleep is blocked/);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ATimeoutKillsTheWholeTree extends BashRunTest {
  readonly id = "a-timeout-kills-the-whole-process-tree-not-just-the-shell";
  readonly whyItExists =
    "the timeout killed the shell node held a handle to and left its children running, so every timed-out build left an orphan compiler behind holding the output directory and the next command failed for a reason nobody could see";

  override async run(t: TestRun): Promise<void> {
    const beat = join(this.dir, "beat.txt");

    // A GRANDCHILD: the subshell is a child of the shell Bash spawned, so
    // killing only the shell would leave it appending forever. A bare
    // `sleep N` is blocked by the tool, which is why the wait is a loop.
    const started = Date.now();
    const result = await this.bash("( while true; do echo tick >> beat.txt; sleep 0.2; done ) & echo started; wait", 700);
    const elapsed = Date.now() - started;

    t.assert.equal(result.isError, true, "a timed-out command is an error");
    t.assert.ok(
      resultText(result).startsWith("Command timed out after 700ms"),
      `the result must name the timeout it hit; it said ${JSON.stringify(resultText(result).slice(0, 80))}`,
    );
    t.assert.match(resultText(result), /started/, "output produced before the timeout is kept, not thrown away");
    t.assert.ok(elapsed < 5_000, `the call must return at its timeout, not at the command's end; it took ${elapsed}ms`);

    // The tree is dead: the grandchild was writing every 200ms, so if anything
    // survived, the file keeps growing. This is the same observation on win32
    // (taskkill /T) and POSIX (kill on the process group).
    //
    // The file is SAMPLED rather than read twice, because the kill is not
    // synchronous with the result: `killTree` SPAWNS `taskkill` on win32, so
    // the result resolves a few milliseconds before the tree is actually gone
    // and one last tick can still land. What the feature promises is that the
    // writing STOPS and stays stopped — so that is what is measured, over a
    // window five beats wide, instead of a single read that would be a race.
    t.assert.equal(existsSync(beat), true, "the grandchild must have run at all, or this proves nothing");
    const sizes: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      sizes.push(statSync(beat).size);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    t.assert.ok(sizes[0]! > 0, "the grandchild wrote nothing, so its death is not evidence of a tree kill");
    const settled = sizes.slice(10);
    t.assert.deepEqual(
      settled,
      settled.map(() => settled[0]),
      `the grandchild was still writing a second after the timeout — killTree reached the shell and not its tree; sizes were ${sizes.join(",")}`,
    );
  }
}

registerFeatureTests(
  new StandaloneTokensAndPhrasesFire(),
  new SubstringsAndSafeFormsDoNotFire(),
  new TheThreeSpecialCasesAndTheMvRule(),
  new OneStreamAndAnHonestExitCode(),
  new ATimeoutKillsTheWholeTree(),
);
