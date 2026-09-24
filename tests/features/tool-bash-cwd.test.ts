/**
 * `tool-bash-cwd`.
 *
 * Bash remembers where the shell ended up and nothing else. A `cd` in one call
 * is where the next call starts; an exported variable and a shell function are
 * gone the moment the shell exits. That split is deliberate, and it is what
 * makes worktree switching coherent: the remembered directory is stamped with
 * the SESSION cwd it was recorded under, so when EnterWorktree/ExitWorktree
 * call `setCwd` the stale shell directory is dropped and Bash follows the
 * session instead of carrying on in the old tree while Write and Edit operate
 * in the new one.
 *
 * `proc`, as the record declares: every assertion is the output of a real shell
 * the product spawned through its own `spawnShell`/`resolveBashPath` (Git Bash
 * on Windows, `bash` elsewhere). Nothing is a double. The tool runs through the
 * real validate-then-execute path (`tests/lib/directTool.ts`) against
 * `strictServices` holding only a real `FileState` (Bash names the Read files a
 * command changed) — with no `callId` the output streamer is a no-op, so Bash
 * reaches no other session service and one appearing later fails by name.
 *
 * THE SESSION OBJECT IS THE KEY, LITERALLY. `sessionCwd` is a
 * `WeakMap<SessionServices, …>`, so "the same session" means the same object.
 * Each test below holds exactly one, and the tests that need a second, untracked
 * session build one on purpose.
 *
 * ONE PLATFORM FACT, MEASURED RATHER THAN ASSUMED. Git Bash's `pwd` prints an
 * MSYS path (`/tmp/…`), while the MARKER the tool parses uses `pwd -W`, which
 * prints a native Windows one. The two spellings are never mixed here: every
 * expected directory is obtained by asking a shell to print it, so the
 * assertions compare a shell's spelling with a shell's spelling on every
 * platform. `path.join` is used only where a path leaves the shell — the Glob
 * result in the last test, which fast-glob spells with forward slashes.
 *
 * SPEC ≠ CODE, item 4. The approved checklist explains that item by "a marker
 * pointing at a non-existent path is ignored", and that is not what happens: a
 * failed `cd` does not stop the script, so the marker still prints — it just
 * prints the UNCHANGED, existing directory, and `existsSync` accepts it. The
 * observable claim (a failed `cd` leaves the next call where it was) is true and
 * is what is asserted; the `existsSync` guard is not the reason, and no command
 * reachable on both platforms makes a shell report a directory that is gone.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { FileState, type SessionServices, type ToolContext } from "@magentra/core";
import { bashTool, globTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";

const FEATURE = "tool-bash-cwd";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT =
  "A cd in one Bash call carries to the next, while env vars and shell functions do not, and the session cwd stays authoritative for other tools.";

/** The hidden marker `spawnShell` appends. Plumbing: it must never reach the model. */
const PWD_MARKER = "__MAGENTRA_PWD__";

/** A path as fast-glob spells it with `absolute: true`: forward slashes, on every platform. */
function posix(path: string): string {
  return path.split(sep).join("/");
}

abstract class BashCwdTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** One session for the whole test — the WeakMap that remembers `cd` is keyed on this object. */
  protected readonly session: SessionServices = strictServices({ fileState: new FileState() });

  #dirs: string[] = [];
  protected dir = "";

  override setUp(): void {
    this.dir = this.makeDir();
    mkdirSync(join(this.dir, "a"));
  }

  /**
   * The resolved path, because a shell reports the resolved one: macOS's tmpdir
   * is a symlink (/var → /private/var), and on a Windows host whose TEMP is an
   * 8.3 short name (`C:\Users\RUNNER~1\…`, the GitHub runner's) the marker's
   * `pwd -W` expands it, so the first call and every tracked one would spell the
   * same directory two ways. `.native`, because only it expands 8.3 names — the
   * JS `realpathSync` walks symlinks and leaves `RUNNER~1` as it found it.
   */
  protected makeDir(): string {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "magentra-bashcwd-")));
    this.#dirs.push(dir);
    return dir;
  }

  protected ctx(cwd: string = this.dir, session: SessionServices = this.session): ToolContext {
    return { cwd, session };
  }

  /** Run one Bash call and hand back its text; the result object is returned too for the error cases. */
  protected async bash(command: string, ctx: ToolContext = this.ctx()) {
    return runTool(bashTool, { command, description: "a command this test runs" }, ctx);
  }

  protected async bashText(command: string, ctx: ToolContext = this.ctx()): Promise<string> {
    return resultText(await this.bash(command, ctx));
  }

  /**
   * The way a shell spells `dir`, asked of a shell that has never been told to
   * `cd` anywhere — a fresh session is untracked, so `effectiveCwd` hands back
   * the session cwd itself.
   */
  protected async shellSpelling(dir: string): Promise<string> {
    return this.bashText("pwd", { cwd: dir, session: strictServices({ fileState: new FileState() }) });
  }

  /**
   * Removed HERE, with retries: Windows keeps a handle on a directory a moment
   * after the process that held it is gone, and `force` only forgives ENOENT.
   * Every shell these tests start has exited by the time the call resolves.
   */
  override tearDown(): void {
    const dirs = this.#dirs;
    this.#dirs = [];
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ACdCarriesToTheNextCall extends BashCwdTest {
  readonly id = "a-cd-in-one-call-is-where-the-next-call-starts";
  readonly whyItExists =
    "every call started in the workspace root, so a model that ran `cd packages/core` and then `npm test` tested the wrong package — and the obvious fix, echoing the marker back, put `__MAGENTRA_PWD__/tmp/…` into the tool result the model reads";

  override async run(t: TestRun): Promise<void> {
    const base = await this.bashText("pwd");
    t.assert.equal(base, await this.shellSpelling(this.dir), "the first call must run in the session cwd");

    const cd = await this.bash("cd a");
    t.assert.equal(cd.isError, undefined, `\`cd a\` failed: ${resultText(cd)}`);
    t.assert.equal(
      resultText(cd).includes(PWD_MARKER),
      false,
      "the cwd-tracking marker is plumbing and must never appear in what the model reads",
    );

    t.assert.equal(await this.bashText("pwd"), `${base}/a`, "the next call must start where the last one ended");

    // And it keeps carrying, including back up: this is a tracked directory,
    // not a one-shot memory of the last `cd`.
    t.assert.equal(await this.bashText("cd .. && pwd"), base);
    t.assert.equal(await this.bashText("pwd"), base);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ShellStateDoesNotSurvive extends BashCwdTest {
  readonly id = "env-vars-and-shell-functions-do-not-survive-a-call";
  readonly whyItExists =
    "the directory and the shell state were assumed to persist together, so a model set `export API=…` once and every later call ran without it — silently, because an empty variable expands to nothing rather than to an error";

  override async run(t: TestRun): Promise<void> {
    const set = await this.bash("export FOO=1; f(){ echo fn; }");
    t.assert.equal(set.isError, undefined, `defining the state failed: ${resultText(set)}`);

    const after = await this.bash('echo "[$FOO]"; f');
    const text = resultText(after);
    t.assert.match(text, /\[\]/, "FOO must expand to nothing — a new shell never saw the export");
    t.assert.match(text, /command not found/, "the function must be gone with the shell that defined it");
    t.assert.equal(text.includes("fn"), false, "the function body ran, so shell state survived the call");
    t.assert.equal(after.isError, true, "calling a function that no longer exists is a non-zero exit");

    // The contrast is the whole point: the DIRECTORY from the very same call
    // does survive. Without this, the test above is satisfied by a tool that
    // persists nothing at all.
    const base = await this.shellSpelling(this.dir);
    await this.bash("cd a; export BAR=2");
    const both = await this.bashText('pwd; echo "[$BAR]"');
    t.assert.equal(both, `${base}/a\n[]`, "the directory carries and the variable does not, from one and the same call");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ASessionCwdMoveDropsTheTrackedDirectory extends BashCwdTest {
  readonly id = "a-session-cwd-move-drops-the-tracked-shell-directory";
  readonly whyItExists =
    "after EnterWorktree moved the session cwd, Bash kept running in the tracked directory of the OLD tree while Write and Edit operated in the new one — so the build that was run and the files that were changed were in different checkouts";

  override async run(t: TestRun): Promise<void> {
    const base = await this.shellSpelling(this.dir);
    await this.bash("cd a");
    t.assert.equal(await this.bashText("pwd"), `${base}/a`, "the fixture is a session with a tracked directory");

    // What setCwd does to a tool call: the SAME session, a different cwd.
    const moved = this.makeDir();
    const movedSpelling = await this.shellSpelling(moved);
    t.assert.equal(
      await this.bashText("pwd", this.ctx(moved)),
      movedSpelling,
      "a moved session cwd is authoritative — the tracked directory belongs to a tree this session has left",
    );

    // Coming back does not resurrect it: the entry now records the moved
    // directory as its base, so `a` is gone for good rather than lying in wait.
    t.assert.equal(
      await this.bashText("pwd"),
      base,
      "the pre-move directory came back, so the tracked entry outlived the session cwd it was stamped with",
    );
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AFailedCdLeavesTheNextCallWhereItWas extends BashCwdTest {
  readonly id = "a-failed-cd-leaves-the-next-call-where-it-was";
  readonly whyItExists =
    "a `cd` into a path that does not exist was recorded anyway, so every call after one typo started in a directory the shell could not enter and came back `Failed to start shell` with no trace of the typo that caused it";

  override async run(t: TestRun): Promise<void> {
    const base = await this.shellSpelling(this.dir);

    const failed = await this.bash("cd nonexistent_dir_xyz");
    t.assert.equal(failed.isError, true, "a `cd` into nothing is a non-zero exit, and the model must be told");
    t.assert.match(resultText(failed), /nonexistent_dir_xyz/, "the result must name the directory that was not there");
    t.assert.equal(await this.bashText("pwd"), base, "a failed cd must leave the next call in the session cwd");

    // The same, from a directory that WAS tracked: a failed cd neither moves
    // the shell nor resets it back to the session cwd.
    await this.bash("cd a");
    const failedAgain = await this.bash("cd nonexistent_dir_xyz");
    t.assert.equal(failedAgain.isError, true);
    t.assert.equal(await this.bashText("pwd"), `${base}/a`, "a failed cd threw away a directory the session had legitimately entered");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheTrackedDirectoryIsPrivateToBash extends BashCwdTest {
  readonly id = "the-tracked-shell-directory-is-private-to-bash";
  readonly whyItExists =
    "the tracked shell directory was treated as the session's, so a `cd` inside one Bash call silently re-pointed Glob, Read and Write too — and the session cwd, which is what the rest of the engine reports and restores, no longer described where anything ran";

  override async run(t: TestRun): Promise<void> {
    writeFileSync(join(this.dir, "root.txt"), "root");
    writeFileSync(join(this.dir, "a", "only-in-a.txt"), "inner");

    const base = await this.shellSpelling(this.dir);
    await this.bash("cd a");
    t.assert.equal(await this.bashText("pwd"), `${base}/a`, "the fixture is a session whose shell has moved into `a`");

    // Glob, on the SAME session object and the SAME ctx.cwd, with no path of
    // its own. `*` does not descend, so the two files are a clean discriminator.
    const glob = await runTool(globTool, { pattern: "*" }, this.ctx());
    const lines = resultText(glob).split("\n");
    t.assert.equal(glob.isError, undefined, `Glob refused: ${resultText(glob)}`);
    t.assert.ok(
      lines.includes(posix(join(this.dir, "root.txt"))),
      `Glob must search the session cwd; it returned ${JSON.stringify(lines)}`,
    );
    t.assert.equal(
      lines.includes(posix(join(this.dir, "a", "only-in-a.txt"))),
      false,
      "Glob searched the directory Bash had cd'd into — the tracked shell cwd is Bash's alone",
    );

    // And Bash has not lost it either: private, not discarded.
    t.assert.equal(await this.bashText("pwd"), `${base}/a`);
  }
}

registerFeatureTests(
  new ACdCarriesToTheNextCall(),
  new ShellStateDoesNotSurvive(),
  new ASessionCwdMoveDropsTheTrackedDirectory(),
  new AFailedCdLeavesTheNextCallWhereItWas(),
  new TheTrackedDirectoryIsPrivateToBash(),
);
