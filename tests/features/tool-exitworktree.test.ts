/**
 * `tool-exitworktree`.
 *
 * Leaving a worktree is the moment work can be destroyed, so ExitWorktree is
 * built out of refusals. `remove` asks git two questions first — `git status
 * --porcelain` and `git log <base>..HEAD` — and if either answers, it refuses
 * and LISTS what it found rather than deleting it; `discard_changes: true` is
 * the only override. A worktree MAGENTRA did not create is never removed at
 * all, whatever the action says. And with nothing active, the whole tool is a
 * no-op that is not an error.
 *
 * `proc`, as the record declares: every assertion here is the state of a real
 * git repository after the real tool ran real `git` processes over it. Nothing
 * is a double. The tools run through the real validate-then-execute path
 * (`tests/lib/directTool.ts`); the session is a `strictServices` that provides
 * exactly the two optional capabilities the worktree tools reach for —
 * `setCwd`, recorded so the tests can say whether the session moved, and
 * `worktreeBaseRef` — so a tool that starts depending on anything else fails by
 * name instead of reading `undefined`.
 *
 * THE SESSION OBJECT IS THE KEY, LITERALLY. The active worktree lives in a
 * `WeakMap<SessionServices, WorktreeState>` inside `worktree.ts` and is
 * unreachable from outside, so "there is an active worktree" can only be
 * established by entering one and can only be observed through what the next
 * call answers. Each test below holds exactly one session object for that
 * reason, and EnterWorktree is part of every fixture.
 *
 * CHECKLIST 5 IS ASSERTED WHERE THE TWO SHAPES OCCUR, not as a test of its
 * own: `deletionSubject` is what routes a `remove` to the user in every
 * permission stance, so it is checked inside the `remove` test and inside the
 * `keep` test, beside the call it gates. Standing alone it would restate the
 * one-line function; beside the calls it says the gate is on the destructive
 * path and off the safe one. The record therefore still declares `proc` alone.
 *
 * ONE PLATFORM FACT, MEASURED RATHER THAN ASSUMED. `git worktree list
 * --porcelain` prints FORWARD slashes on Windows, while `ctx.cwd` and
 * `path.join` produce backslashes — so EnterWorktree's `path` variant hands
 * `setCwd` a forward-slash path and ExitWorktree hands it back a backslash one.
 * Every path comparison below therefore runs through {@link samePath}, which is
 * the tool's own `normalizePath` rule: canonicalise (native realpath), forward
 * slashes, and case-fold on win32. The fixture deliberately keeps tmpdir's own
 * spelling — on a host whose TEMP is an 8.3 short name, as the GitHub runner's
 * is, the path-entered test then proves EnterWorktree recognises a short-name
 * spelling of a worktree git lists by its long one.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import type { SessionServices, ToolContext } from "@magentra/core";
import { enterWorktreeTool, exitWorktreeTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";

const FEATURE = "tool-exitworktree";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT =
  "remove refuses and lists the work when there are uncommitted changes or commits not in the base ref, and a worktree entered by existing path is never removed.";

/**
 * The fixture's own git calls carry their identity and switches inline, so the
 * developer's global config cannot decide whether a commit in this test signs,
 * or whether a checkout rewrites line endings and leaves a "clean" worktree
 * dirty. `core.autocrlf` is set once in the repo, because the worktrees share
 * the repository's config and the TOOL's own `git status` reads it.
 */
const GIT_ID = ["-c", "user.name=MAGENTRA Test", "-c", "user.email=test@magentra.invalid", "-c", "commit.gpgsign=false"];

/**
 * The tool's own `normalizePath`: canonical when the path exists (native
 * realpath — the only one that expands an 8.3 name like `RUNNER~1`), else
 * resolved; forward slashes, no trailing slash, case-folded on win32.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let real = resolvePath(p);
    try {
      real = realpathSync.native(real);
    } catch {
      /* does not exist — the resolved spelling is all there is */
    }
    const abs = real.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  };
  return norm(a) === norm(b);
}

abstract class ExitWorktreeTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Every directory this session's `setCwd` was handed, in order. */
  protected readonly cwdCalls: string[] = [];

  /**
   * One session for the whole test — the active-worktree WeakMap is keyed on
   * this object, and `worktreeBaseRef` is provided because `strictServices`
   * throws on a property the test did not build.
   */
  protected readonly session: SessionServices = strictServices({
    setCwd: (dir: string) => {
      this.cwdCalls.push(dir);
    },
    worktreeBaseRef: "fresh",
  });

  #roots: string[] = [];
  /** The repository the session starts in. */
  protected work = "";

  /**
   * A repository with one commit. With `withRemote`, it also has a bare origin
   * and `refs/remotes/origin/HEAD`, which is what makes EnterWorktree's "fresh"
   * base resolve to `origin/main` instead of falling back to `HEAD` — and the
   * base ref is what `git log <base>..HEAD` is measured against.
   */
  protected makeRepo(withRemote: boolean): void {
    // `realpath`, because macOS's tmpdir is a symlink (/var → /private/var) and
    // git echoes resolved paths.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "magentra-wt-")));
    this.#roots.push(root);
    this.work = join(root, "work");
    mkdirSync(this.work);
    this.git(["init", "-b", "main"], this.work);
    this.git(["config", "core.autocrlf", "false"], this.work);
    writeFileSync(join(this.work, "f.txt"), "one\n");
    this.git(["add", "f.txt"], this.work);
    this.git(["commit", "-m", "one"], this.work);
    if (!withRemote) return;
    const origin = join(root, "origin.git");
    mkdirSync(origin);
    this.git(["init", "--bare", "-b", "main"], origin);
    this.git(["remote", "add", "origin", origin], this.work);
    this.git(["push", "-u", "origin", "main"], this.work);
    this.git(["remote", "set-head", "origin", "-a"], this.work);
  }

  /** A fixture git call. Synchronous, so the child is reaped before it returns. */
  protected git(args: readonly string[], cwd: string): string {
    return execFileSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  /** The directory this root owns, for a worktree created outside `.magentra`. */
  protected sibling(name: string): string {
    return join(this.#roots[this.#roots.length - 1]!, name);
  }

  protected ctx(): ToolContext {
    return { cwd: this.work, session: this.session };
  }

  protected async enter(input: Record<string, unknown>) {
    return runTool(enterWorktreeTool, input, this.ctx());
  }

  protected async exit(input: Record<string, unknown>) {
    return runTool(exitWorktreeTool, input, this.ctx());
  }

  /** The worktree EnterWorktree creates for `name`. */
  protected worktreeDir(name: string): string {
    return join(this.work, ".magentra", "worktrees", name);
  }

  protected branches(): string[] {
    return this.git(["branch", "--list", "--format=%(refname:short)"], this.work)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Removed HERE, with retries: a worktree is a real checkout git had open, and
   * Windows keeps a handle a moment after the process that held it is gone
   * while `force` only forgives ENOENT. Every git process these tests start is
   * synchronous or awaited, so none is alive by the time this runs.
   */
  override tearDown(): void {
    const roots = this.#roots;
    this.#roots = [];
    for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class UncommittedWorkIsRefusedAndListed extends ExitWorktreeTest {
  readonly id = "remove-refuses-uncommitted-work-and-lists-it-without-moving-the-session";
  readonly whyItExists =
    "one ExitWorktree call deleted a worktree with an hour of uncommitted work in it, and the half-measure was worse: the refusal restored the session cwd first, so the session was outside a worktree it still believed it was in and the next Write landed in the main checkout";

  override async run(t: TestRun): Promise<void> {
    this.makeRepo(false);
    const entered = await this.enter({ name: "wt1" });
    t.assert.equal(entered.isError, undefined, `EnterWorktree failed: ${resultText(entered)}`);
    const dir = this.worktreeDir("wt1");
    t.assert.equal(existsSync(dir), true, "the fixture needs a worktree to refuse to remove");
    t.assert.equal(this.cwdCalls.length, 1, "entering moves the session cwd exactly once");

    writeFileSync(join(dir, "untracked.txt"), "an hour of work");

    // The gate that sends this call to the user in the first place.
    t.assert.equal(
      typeof exitWorktreeTool.deletionSubject?.({ action: "remove", discard_changes: false }),
      "string",
      "remove must declare a deletionSubject, or PermissionEngine.check never asks the user about it",
    );

    const refused = await this.exit({ action: "remove" });
    const text = resultText(refused);
    t.assert.equal(refused.isError, true, "a refusal the model can mistake for success is not a refusal");
    t.assert.match(text, /Refusing to remove worktree/);
    t.assert.match(text, /Uncommitted changes:/, "the refusal must LIST the work, not merely mention that some exists");
    t.assert.match(text, /untracked\.txt/, "an untracked file is work too — `git status --porcelain` reports it as ??");
    t.assert.match(text, /discard_changes:true/, "the refusal has to name the way past it");

    t.assert.equal(existsSync(dir), true, "the worktree was removed despite the refusal");
    t.assert.equal(existsSync(join(dir, "untracked.txt")), true, "the work the refusal was protecting is gone");
    t.assert.deepEqual(this.cwdCalls.length, 1, "a refusal must not move the session cwd — nothing was left, so there is nothing to leave");

    // Still active: a refusal is not a silent exit. The session can still get
    // out the safe way, which would be impossible if the state had been cleared.
    const kept = await this.exit({ action: "keep" });
    t.assert.equal(kept.isError, undefined);
    t.assert.equal(this.cwdCalls.length, 2);
    t.assert.ok(samePath(this.cwdCalls[1]!, this.work), `keep must restore ${this.work}; it restored ${this.cwdCalls[1]}`);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class CommitsNotInTheBaseRefAreRefusedUntilDiscarded extends ExitWorktreeTest {
  readonly id = "remove-refuses-commits-not-in-the-base-ref-until-discard-changes-says-otherwise";
  readonly whyItExists =
    "a committed-but-unmerged branch looked clean to `git status`, so removing the worktree also ran `git branch -D` and took the only ref to those commits with it — committing the work was what made it disposable";

  override async run(t: TestRun): Promise<void> {
    this.makeRepo(true);
    const entered = await this.enter({ name: "wt2" });
    t.assert.equal(entered.isError, undefined, `EnterWorktree failed: ${resultText(entered)}`);
    t.assert.match(
      resultText(entered),
      /\(base origin\/main\)/,
      "the log check is measured against the base ref, so this test is only meaningful with a real remote behind it",
    );
    const dir = this.worktreeDir("wt2");

    writeFileSync(join(dir, "new.txt"), "committed work\n");
    this.git(["add", "new.txt"], dir);
    this.git(["commit", "-m", "work that is not on origin/main"], dir);
    t.assert.equal(this.git(["status", "--porcelain"], dir), "", "the fixture must be CLEAN, or this proves the status check instead");

    const refused = await this.exit({ action: "remove" });
    const text = resultText(refused);
    t.assert.equal(refused.isError, true);
    t.assert.match(text, /Refusing to remove worktree/);
    t.assert.match(text, /Commits not in origin\/main:/, "the refusal must name the base ref it measured against");
    t.assert.match(text, /work that is not on origin\/main/, "and list the commits themselves");
    t.assert.equal(
      /Uncommitted changes:/.test(text),
      false,
      "the two reasons are separate lists; reporting a clean tree as dirty makes the refusal impossible to act on",
    );
    t.assert.equal(existsSync(dir), true);
    t.assert.equal(this.cwdCalls.length, 1, "a refusal leaves the session inside the worktree");

    // The override, and everything it is supposed to take with it.
    t.assert.ok(this.branches().includes("magentra/wt2"), "the fixture branch must exist before removal");
    const removed = await this.exit({ action: "remove", discard_changes: true });
    t.assert.equal(removed.isError, undefined, `discard_changes must get past the refusal: ${resultText(removed)}`);
    t.assert.match(resultText(removed), /Removed worktree/);
    t.assert.equal(existsSync(dir), false, "discard_changes:true must actually remove the worktree");
    t.assert.equal(this.branches().includes("magentra/wt2"), false, "the branch goes with the worktree that carried it");
    t.assert.equal(this.cwdCalls.length, 2);
    t.assert.ok(samePath(this.cwdCalls[1]!, this.work), `the session cwd must be restored to ${this.work}`);

    // And the state really is cleared, not merely reported as removed.
    t.assert.equal(resultText(await this.exit({ action: "keep" })), "No worktree session is active; nothing to exit.");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class KeepPreservesEverythingAndASecondExitIsANoOp extends ExitWorktreeTest {
  readonly id = "keep-leaves-the-worktree-and-branch-and-a-second-exit-is-a-no-op";
  readonly whyItExists =
    "the no-op case came back as an error, so a model that called ExitWorktree defensively got a tool failure for doing the right thing and started avoiding the call that restores the session cwd";

  override async run(t: TestRun): Promise<void> {
    this.makeRepo(false);
    const entered = await this.enter({ name: "wt3" });
    t.assert.equal(entered.isError, undefined, `EnterWorktree failed: ${resultText(entered)}`);
    const dir = this.worktreeDir("wt3");
    t.assert.equal(this.git(["status", "--porcelain"], dir), "", "a freshly created worktree is clean");

    // The other half of the deletion gate: `keep` destroys nothing, so it must
    // not be routed to the user as a deletion.
    t.assert.equal(
      exitWorktreeTool.deletionSubject?.({ action: "keep", discard_changes: false }),
      undefined,
      "keep deletes nothing — a deletion prompt here is a prompt the user learns to click through",
    );

    const kept = await this.exit({ action: "keep" });
    t.assert.equal(kept.isError, undefined);
    t.assert.match(resultText(kept), /branch preserved/);
    t.assert.equal(existsSync(dir), true, "keep must leave the worktree on disk");
    t.assert.ok(this.branches().includes("magentra/wt3"), "keep must leave the branch too — that is the whole difference from remove");
    t.assert.equal(this.cwdCalls.length, 2);
    t.assert.ok(samePath(this.cwdCalls[1]!, this.work), `keep must restore ${this.work}; it restored ${this.cwdCalls[1]}`);

    const again = await this.exit({ action: "keep" });
    t.assert.equal(resultText(again), "No worktree session is active; nothing to exit.");
    t.assert.equal(again.isError, undefined, "nothing to do is not a failure");
    t.assert.equal(this.cwdCalls.length, 2, "a no-op must not call setCwd again");

    // Not even `remove`, which would otherwise be the destructive path.
    const removeWithNothing = await this.exit({ action: "remove" });
    t.assert.equal(resultText(removeWithNothing), "No worktree session is active; nothing to exit.");
    t.assert.equal(removeWithNothing.isError, undefined);
    t.assert.equal(existsSync(dir), true, "with no active session, remove must not reach for the worktree that is still on disk");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class APathEnteredWorktreeIsNeverRemoved extends ExitWorktreeTest {
  readonly id = "a-worktree-entered-by-path-is-never-removed-even-with-discard-changes";
  readonly whyItExists =
    "remove treated every active worktree as one MAGENTRA had created, so entering the user's own checkout by path and exiting deleted it and force-deleted its branch — a directory this tool never made and has no business removing";

  override async run(t: TestRun): Promise<void> {
    this.makeRepo(false);

    // A worktree git made, outside `.magentra/worktrees`, on a branch of the
    // user's own naming.
    const manual = this.sibling("hand-made");
    this.git(["worktree", "add", manual, "-b", "hand"], this.work);
    writeFileSync(join(manual, "user-work.txt"), "not ours to delete");

    const entered = await this.enter({ path: manual });
    t.assert.equal(entered.isError, undefined, `EnterWorktree by path failed: ${resultText(entered)}`);
    t.assert.match(resultText(entered), /ExitWorktree will not remove it/, "the promise is made when the worktree is entered");
    t.assert.equal(this.cwdCalls.length, 1);
    t.assert.ok(samePath(this.cwdCalls[0]!, manual), `the session must move into ${manual}; it moved to ${this.cwdCalls[0]}`);

    // The most destructive call the schema allows.
    const exited = await this.exit({ action: "remove", discard_changes: true });
    t.assert.equal(exited.isError, undefined, `leaving a path-entered worktree is not a failure: ${resultText(exited)}`);
    t.assert.match(resultText(exited), /never removed by Magentra/, "the refusal has to say why nothing was deleted");
    t.assert.equal(existsSync(manual), true, "discard_changes must not reach a worktree MAGENTRA did not create");
    t.assert.equal(existsSync(join(manual, "user-work.txt")), true, "the user's uncommitted file was deleted");
    t.assert.ok(this.branches().includes("hand"), "the branch is not MAGENTRA's either");

    t.assert.equal(this.cwdCalls.length, 2);
    t.assert.ok(samePath(this.cwdCalls[1]!, this.work), `the session cwd must still be restored to ${this.work}`);
    t.assert.equal(resultText(await this.exit({ action: "keep" })), "No worktree session is active; nothing to exit.");
  }
}

registerFeatureTests(
  new UncommittedWorkIsRefusedAndListed(),
  new CommitsNotInTheBaseRefAreRefusedUntilDiscarded(),
  new KeepPreservesEverythingAndASecondExitIsANoOp(),
  new APathEnteredWorktreeIsNeverRemoved(),
);
