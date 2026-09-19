/**
 * `pre-turn-snapshot`.
 *
 * OVERDRIVE runs deletions and rewrites without asking, so before each ROOT
 * turn the Session parks a `git stash create` commit of the working tree and
 * reports the ref as `overdriveSnapshot` on that turn's `turn_finished`. It is
 * a recovery net for tracked, uncommitted work an autonomous turn destroys.
 * Nothing is reported when the tree was clean (HEAD already is the snapshot),
 * when the workspace is not a repository, when OVERDRIVE is off, or when git
 * fails — and a failed snapshot never stops the turn.
 *
 * `fs`, as the record declares. The subject is a real repository on disk and
 * the commit object git writes into it, so every case below runs `git` itself
 * in a temp workspace this test created, and reads the snapshot back out of
 * that repository with `git cat-file` and `git show`.
 *
 * FIVE OF THE SIX RUN THE REAL ENGINE; THE CHILD CASE CANNOT. `Session.runTurn`
 * is reached through `Engine` on the scripted provider, and OVERDRIVE is turned
 * on with the `set_overdrive` frame the desktop app sends — that is the whole
 * path. A CHILD session is the exception: `Session.emitFromChild` drops a
 * child's `turn_started`/`turn_finished` outright (they would double-count the
 * parent's turn in the UI), so a subagent's `turn_finished` never reaches the
 * engine's event stream and its absence there would prove nothing at all. The
 * child case therefore constructs the real shipped `Session` directly with
 * `child: true` — the same class, from the same built package, with the same
 * FakeProvider — beside an otherwise identical root one in the same dirty
 * repository, and compares the two events. That is the only place the flag is
 * observable, and it is the flag the record's WHERE section names.
 *
 * GIT IS RUN WITH ITS IDENTITY ON THE COMMAND LINE. `HOME` and `USERPROFILE`
 * are redirected before anything boots (the engine reads `~/.magentra`), which
 * also hides the developer's `.gitconfig`, so the fixture's own commit passes
 * `-c user.email` / `-c user.name` rather than depending on a machine.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session, loadSettings, type Settings } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";
import { FakeProvider } from "@magentra/providers";
import { createDefaultRegistry } from "@magentra/tools";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "pre-turn-snapshot";

/** Verbatim from the record. */
const INVARIANT =
  "An uncapped OVERDRIVE turn captures a pre-turn git stash ref, absent when the tree was clean or the workspace is not a repo.";

/** What the tracked file held when it was committed, and what it holds uncommitted at turn time. */
const COMMITTED = "one\n";
const UNCOMMITTED = "two\n";

type TurnFinished = Extract<CoreEvent, { type: "turn_finished" }>;

abstract class SnapshotTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A real Engine boots and a real `git` runs several times in each of these. */
  override readonly timeoutMs: number = 90_000;

  #engine: ScriptedEngine | undefined;
  #workspace: string | undefined;

  protected get workspace(): string {
    if (this.#workspace === undefined) throw new Error("makeWorkspace() has not run yet");
    return this.#workspace;
  }

  /**
   * Not `FsTest.tempDir`: git holds this directory while it runs, and on Windows
   * the handle can outlive the process by a moment, while the kind's own
   * teardown removes its directories with no retries.
   */
  protected makeWorkspace(prefix: string): string {
    this.redirectHome();
    this.#workspace = mkdtempSync(join(tmpdir(), prefix));
    return this.#workspace;
  }

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
    const dir = this.#workspace;
    this.#workspace = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }

  /** `git` in the workspace, with an identity of its own so no machine's config is needed. */
  protected git(...args: string[]): string {
    return execFileSync("git", ["-c", "user.email=tests@magentra.invalid", "-c", "user.name=MAGENTRA tests", ...args], {
      cwd: this.workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** A repository with one committed tracked file. */
  protected initRepo(): void {
    this.git("init", "-q");
    writeFileSync(join(this.workspace, "tracked.txt"), COMMITTED);
    this.git("add", "tracked.txt");
    this.git("commit", "-q", "-m", "first");
  }

  /** The settings the scripted fixture pins, for a Session built by hand. */
  protected settings(): Settings {
    return { ...loadSettings(this.workspace).settings, clarify: false, contextWindow: 200_000 };
  }

  /** One text-only turn through the real Engine, with OVERDRIVE set the way the app sets it. */
  protected async oneTurn(overdrive: boolean): Promise<TurnFinished> {
    const engine = await startScriptedEngine({
      workspace: this.workspace,
      turns: [{ text: "nothing to do here.", stopReason: "end_turn" }],
    });
    this.#engine = engine;
    if (overdrive) engine.send({ type: "set_overdrive", enabled: overdrive });

    const turn = await engine.runTurn("look around");
    if (turn.errors.length > 0) throw new Error(`the turn raised: ${turn.errors.join("; ")}`);
    const finished = turn.events.find((e): e is TurnFinished => e.type === "turn_finished");
    if (finished === undefined) throw new Error("the turn never finished");
    return finished;
  }
}

/* ---- checklist 1 ------------------------------------------------------ */

class TheDirtyTreeIsParkedAsARealCommit extends SnapshotTest {
  readonly id = "an-overdrive-turn-in-a-dirty-repo-reports-a-stash-ref-that-still-holds-the-uncommitted-bytes";
  readonly whyItExists =
    "OVERDRIVE rewrote a tracked file that had never been committed and the user had no way back: the ref was reported as a plain string nobody had checked, so 'a snapshot was taken' was true and 'the work is recoverable' was not";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace("magentra-snapshot-dirty-");
    this.initRepo();
    // The state the net exists for: edited, never committed. Plus an untracked
    // file, which `git stash create` cannot see and must not claim to hold.
    writeFileSync(join(this.workspace, "tracked.txt"), UNCOMMITTED);
    writeFileSync(join(this.workspace, "untracked.txt"), "scratch\n");

    const finished = await this.oneTurn(true);

    const ref = finished.overdriveSnapshot;
    t.assert.notEqual(ref, undefined, "the turn reported a snapshot");
    t.assert.match(ref ?? "", /^[0-9a-f]{40}$/, "and it is an object name, not a message about one");
    t.assert.equal(this.git("cat-file", "-t", ref ?? "").trim(), "commit", "the ref really exists in this repository, as a commit");

    t.assert.equal(
      this.git("show", `${ref}:tracked.txt`),
      UNCOMMITTED,
      "the parked commit holds the UNCOMMITTED bytes — that is what makes an autonomous rewrite recoverable",
    );
    t.assert.notEqual(this.git("rev-parse", "HEAD").trim(), ref, "and it is not just HEAD, which never held them");

    // Tracked files only, exactly as the prose says: this is a limit of
    // `git stash create`, and it is asserted rather than assumed.
    const untracked = spawnSync("git", ["cat-file", "-e", `${ref}:untracked.txt`], { cwd: this.workspace, encoding: "utf8" });
    t.assert.notEqual(untracked.status, 0, "an untracked file is absent from the snapshot");
    t.assert.equal(readFileSync(join(this.workspace, "untracked.txt"), "utf8"), "scratch\n", "though it is still on disk — the snapshot changed nothing");
  }
}

/* ---- checklist 2 ------------------------------------------------------ */

class ACleanTreeParksNothing extends SnapshotTest {
  readonly id = "an-overdrive-turn-on-a-clean-tree-reports-no-snapshot-key-at-all";
  readonly whyItExists =
    "git answers a clean tree with an empty line, and the empty string was reported as the ref — the frontend then offered a recovery command built from nothing, which fails in a way that reads as the snapshot having been lost";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace("magentra-snapshot-clean-");
    this.initRepo();
    t.assert.equal(this.git("status", "--porcelain"), "", "the fixture really is a clean tree");

    const finished = await this.oneTurn(true);

    t.assert.equal("overdriveSnapshot" in finished, false, "the key is absent, not an empty string");
    t.assert.equal(finished.stopReason, "end_turn", "and the turn ran normally");
  }
}

/* ---- checklist 3 ------------------------------------------------------ */

class AWorkspaceThatIsNotARepositoryReportsNothing extends SnapshotTest {
  readonly id = "an-overdrive-turn-in-a-directory-with-no-git-reports-no-snapshot-key";
  readonly whyItExists =
    "every turn in a non-repository spawned git to be told it was not a repository, and the failure was reported to the user as an OVERDRIVE error on a turn that had nothing wrong with it";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace("magentra-snapshot-norepo-");
    writeFileSync(join(this.workspace, "tracked.txt"), UNCOMMITTED);

    const finished = await this.oneTurn(true);

    t.assert.equal("overdriveSnapshot" in finished, false, "nothing is reported for a tree git does not manage");
    t.assert.equal(finished.stopReason, "end_turn", "and the turn is untouched by the absence");
    t.assert.equal(
      spawnSync("git", ["rev-parse", "--git-dir"], { cwd: this.workspace, encoding: "utf8" }).status !== 0,
      true,
      "the workspace still is not a repository — nothing created one on the way past",
    );
  }
}

/* ---- checklist 4 ------------------------------------------------------ */

class OutsideOverdriveNothingIsParked extends SnapshotTest {
  readonly id = "the-same-dirty-repo-in-the-normal-stance-is-not-snapshotted";
  readonly whyItExists =
    "the snapshot ran on every turn, so an attended session — which deletes nothing without asking — paid a `git stash create` over the whole working tree before each message";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace("magentra-snapshot-off-");
    this.initRepo();
    writeFileSync(join(this.workspace, "tracked.txt"), UNCOMMITTED);

    const finished = await this.oneTurn(false);

    t.assert.equal("overdriveSnapshot" in finished, false, "the net belongs to the stance that needs it");
    t.assert.equal(finished.stopReason, "end_turn");
    t.assert.match(
      this.git("status", "--porcelain"),
      /^\s*M\s+tracked\.txt$/m,
      "the tracked file is still modified, so the absence is the stance's doing and not the tree's",
    );
  }
}

/* ---- checklist 5 ------------------------------------------------------ */

class AChildSessionSharesTheTreeAndParksNothing extends SnapshotTest {
  readonly id = "a-child-session-does-not-snapshot-even-in-overdrive-while-an-identical-root-one-does";
  readonly whyItExists =
    "every subagent parked its own snapshot of the same working tree, so a fan-out of five wrote five stash commits of identical content per turn — cost and garbage for a net the root had already hung";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace("magentra-snapshot-child-");
    this.initRepo();
    writeFileSync(join(this.workspace, "tracked.txt"), UNCOMMITTED);

    const finishedFor = async (child: boolean): Promise<TurnFinished> => {
      const events: CoreEvent[] = [];
      const session = new Session({
        cwd: this.workspace,
        settings: this.settings(),
        provider: new FakeProvider([{ text: "nothing to do here.", stopReason: "end_turn" }]),
        registry: createDefaultRegistry(),
        emit: (event) => events.push(event),
        requestApproval: async () => ({ decision: "deny" as const }),
        askUser: async () => {
          throw new Error("this turn must not reach the user");
        },
        child,
      });
      session.setOverdrive(true);
      try {
        await session.runTurn("look around");
      } finally {
        session.background.stopAll();
      }
      const finished = events.find((e): e is TurnFinished => e.type === "turn_finished");
      if (finished === undefined) throw new Error(`the ${child ? "child" : "root"} turn never finished`);
      return finished;
    };

    // The control first: same class, same tree, same stance — only the flag differs.
    const root = await finishedFor(false);
    t.assert.match(root.overdriveSnapshot ?? "", /^[0-9a-f]{40}$/, "a root session in this exact tree does park a snapshot");

    const child = await finishedFor(true);
    t.assert.equal("overdriveSnapshot" in child, false, "the child shares the root's tree, so it hangs no second net");
    t.assert.equal(child.stopReason, "end_turn", "and its turn ran to the end");
  }
}

class AFailingGitDoesNotStopTheTurn extends SnapshotTest {
  readonly id = "a-git-that-fails-on-a-broken-repository-leaves-the-turn-running";
  readonly whyItExists =
    "the snapshot was awaited without a catch, so a repository git refused to read — a half-written .git, a permissions problem — threw out of runTurn before the first model call and OVERDRIVE could not answer at all";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace("magentra-snapshot-brokengit-");
    // A `.git` that exists and is not a repository: the `existsSync` guard is
    // satisfied, git is really spawned, and it exits 128.
    mkdirSync(join(this.workspace, ".git"));
    writeFileSync(join(this.workspace, ".git", "not-a-repository.txt"), "junk\n");
    const probe = spawnSync("git", ["stash", "create"], { cwd: this.workspace, encoding: "utf8" });
    t.assert.notEqual(probe.status, 0, "the fixture really does make git fail");
    t.assert.match(probe.stderr, /not a git repository/, "and fail for the reason this test is about");

    const finished = await this.oneTurn(true);

    t.assert.equal(finished.stopReason, "end_turn", "the turn ran and ended normally — the net is best-effort");
    t.assert.equal("overdriveSnapshot" in finished, false, "with nothing reported, rather than a ref that cannot be resolved");
  }
}

registerFeatureTests(
  new TheDirtyTreeIsParkedAsARealCommit(),
  new ACleanTreeParksNothing(),
  new AWorkspaceThatIsNotARepositoryReportsNothing(),
  new OutsideOverdriveNothingIsParked(),
  new AChildSessionSharesTheTreeAndParksNothing(),
  new AFailingGitDoesNotStopTheTurn(),
);
