/**
 * `deletion-guard`.
 *
 * The stance default is ALLOW for every class — commands, edits and network
 * calls all run without asking. That is only tolerable because the two things
 * worth confirming are not classes of TOOL but shapes of TARGET, and the first
 * of them is removal: `rm`, `del`, `git clean`, a forced push, `DROP TABLE`,
 * `terraform destroy`. Those always ask, in both stances, and the only things
 * that get past the question are the user turning the guard off, OVERDRIVE, or
 * an explicit LITERAL grant for that exact command text.
 *
 * `pure` + `proc`, as the record declares.
 *
 *   - `pure` is the classifier and the resolution order. `bashDeletionSubject`
 *     is a function of a string, and `PermissionEngine` takes the approval hop
 *     and the persistence hop as constructor callbacks — so the whole decision
 *     table is readable without a frontend, a settings file or a disk.
 *   - `proc` is the one claim a table cannot make: that a real destructive
 *     command, in a real session, on a real file, is actually stopped — and
 *     that approving it really does remove the file. A guard that is right in
 *     a unit test and unwired in the Session is the failure this half exists
 *     for, so the last test boots a real Engine and lets the Bash tool spawn a
 *     real shell against a real workspace.
 *
 * WHAT THE PACKAGE EXPORTS. `bashDeletionSubject` is exported from
 * `@magentra/tools` and used directly. `DELETION_SINGLE_WORDS`,
 * `DELETION_PHRASES`, `DELETION_PATTERN`, `GIT_BRANCH_FORCE_DELETE`,
 * `GIT_CHECKOUT_DISCARD`, `FIND_DELETE` and `mvIsDestructive` are all
 * module-private, so each is proved through the one function that consults
 * them — which is also the surface the Session reaches, via
 * `bashTool.deletionSubject`.
 *
 * OVERDRIVE IS ASSERTED AS THE CODE, NOT AS A PARAPHRASE. `permissions.ts`
 * does not ask and then allow in that stance; it computes NO deletion subject
 * at all (`this.overdrive ? undefined : …`). "Nothing asked" would also be
 * true of a branch that asked and auto-approved, so the last pure test counts
 * the calls the real `bashTool.deletionSubject` receives and requires zero.
 *
 * The scripted provider is the only double, and nothing here asserts on what
 * it answered: the proc test's assertions are a `permission_request` the real
 * PermissionEngine caused, and a file that is or is not still on the disk.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PermissionEngine, type ApprovalSource, type ExactGrant, type PermissionRequestPayload } from "@magentra/core";
import type { CoreEvent, PermissionDecision } from "@magentra/protocol";
import { bashDeletionSubject, bashTool } from "@magentra/tools";

import { strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "deletion-guard";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT =
  "Anything that removes a file, folder or worktree always asks, in both stances, overridable only by an explicit literal subject grant.";

/** A workspace root that exists as a path and not as a directory — the pure half never touches a disk. */
const WS = join(tmpdir(), "magentra-deletion-probe");

/** The Bash input for one command, exactly as the tool's own schema produces it. */
function bashInput(command: string): { command: string; description: string; run_in_background: boolean } {
  return { command, description: `run ${command}`, run_in_background: false };
}

/**
 * The tool's own deletion-scope verdict, computed the way the Session computes
 * it. `strictServices({})` is a WeakMap key and nothing more here — anything
 * the classifier actually reached for would throw by name instead of reading
 * `undefined`.
 */
function scopeOf(command: string): "workspace" | "unknown" | "protected" {
  return bashTool.deletionScope!(bashInput(command), { cwd: WS, session: strictServices({}) });
}

/** One recorded trip to the frontend. */
interface Ask {
  readonly payload: PermissionRequestPayload;
  readonly source: ApprovalSource;
}

interface Probe {
  readonly engine: PermissionEngine;
  /** Every `requestApproval` call, in order. Empty is the assertion that nothing asked. */
  readonly asks: Ask[];
  /** Every `persistExact` call — the "always allow" the engine wanted written to settings. */
  readonly grants: { tool: string; subject: string; prefix: boolean | undefined }[];
  /** How many times the REAL `bashTool.deletionSubject` was consulted. */
  readonly subjectCalls: { n: number };
  /** `bashTool`, watched. Everything it does is the shipped tool's. */
  readonly tool: typeof bashTool;
}

function probe(opts: { allow?: string[]; deny?: string[]; allowExact?: ExactGrant[]; answer?: PermissionDecision } = {}): Probe {
  const asks: Ask[] = [];
  const grants: Probe["grants"] = [];
  const subjectCalls = { n: 0 };
  const engine = new PermissionEngine(
    { allow: opts.allow ?? [], deny: opts.deny ?? [], allowExact: opts.allowExact ?? [] },
    async (payload, source) => {
      asks.push({ payload, source });
      return { decision: opts.answer ?? "allow_once" };
    },
    (tool, subject, prefix) => grants.push({ tool, subject, prefix }),
  );
  const tool: typeof bashTool = {
    ...bashTool,
    deletionSubject: (input) => {
      subjectCalls.n += 1;
      return bashTool.deletionSubject?.(input);
    },
  };
  return { engine, asks, grants, subjectCalls, tool };
}

/** `PermissionEngine.check` for one Bash command, with the arguments the Session passes. */
function checkCommand(p: Probe, command: string): ReturnType<PermissionEngine["check"]> {
  const input = bashInput(command);
  return p.engine.check(p.tool, input, command, input.description, scopeOf(command), false, undefined);
}

abstract class DeletionGuardTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheClassifierFlagsWhatDestroys extends DeletionGuardTest {
  readonly id = "the-classifier-flags-what-destroys-and-passes-over-what-does-not";
  readonly whyItExists =
    "the keywords were matched as substrings, so `npm run del-lint` prompted on every run and users learned to click through the one dialog that matters — while `git branch -D` and `mv -f` slipped past because they are not the word `rm`";

  override async run(t: TestRun): Promise<void> {
    // Each of these is a different branch of the classifier: a single word, a
    // multi-word phrase, a case-sensitive flag, a flag anywhere in the
    // segment, and a rename that can silently clobber.
    const destructive = [
      "rm -rf build",
      "git push --force",
      "git push -f origin main",
      "git reset --hard",
      "DROP TABLE users",
      "find . -name x -delete",
      "mv -f a b",
      "git branch -D foo",
      "git clean -fd",
      "terraform destroy",
      "kubectl delete pod web",
      "git checkout -- src/app.ts",
      "mv a /etc/passwd",
      // After a shell separator too — a destructive tail is the whole reason
      // the match is not anchored to the start of the string.
      "npm run build && rm -rf dist",
    ];
    for (const command of destructive) {
      t.assert.equal(bashDeletionSubject(command), command, `"${command}" must be flagged, and the subject IS the command`);
    }

    const harmless = [
      "ls",
      "mkdir x",
      "npm run del-lint",
      "git branch -d foo",
      "mv a b",
      "npm run format",
      "cat removed.txt",
      "echo 'rmdir'",
      "grep -r unlinked .",
    ];
    for (const command of harmless) {
      t.assert.equal(bashDeletionSubject(command), undefined, `"${command}" destroys nothing and must not prompt`);
    }

    // The distinction that only holds by letter case, asserted as a pair so a
    // stray `i` flag on the pattern cannot pass unnoticed.
    t.assert.notEqual(bashDeletionSubject("git branch -D foo"), undefined);
    t.assert.equal(bashDeletionSubject("git branch -d foo"), undefined, "the safe, merged-only delete must not ask");

    // The Session reaches the classifier through the tool definition, not
    // through the export — so that hook has to be wired to the same function.
    t.assert.equal(bashTool.deletionSubject?.(bashInput("rm -rf build")), "rm -rf build");
    t.assert.equal(bashTool.deletionSubject?.(bashInput("ls")), undefined);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ABroadAllowDoesNotGetPast extends DeletionGuardTest {
  readonly id = "a-broad-allow-rule-or-session-grant-does-not-get-past-the-guard";
  readonly whyItExists =
    "one click on 'always allow this session' for a harmless command turned the whole Bash tool into a standing grant, and the next `rm -rf` ran without a word — which is precisely the frictionless policy this guard exists to survive";

  override async run(t: TestRun): Promise<void> {
    const p = probe({ allow: ["Bash", "Bash(*)"] });
    p.engine.addSessionAllow("Bash");
    p.engine.addSessionAllow("Bash", "*");

    const out = await checkCommand(p, "rm -rf build");

    t.assert.equal(p.asks.length, 1, "four grants that all match the tool, and it still asked exactly once");
    t.assert.equal(p.asks[0]?.source, "deletion-guard", "and it asked AS the guard — an 'ask' here would be the stance, which is allow");
    t.assert.equal(out.allowed, true);
    t.assert.equal(out.source, "user", "an allowed deletion is the user's decision, never a rule's");

    // The prompt names the command, because the command is what is being
    // confirmed: the guard replaces the tool's own description with the
    // deletion subject.
    t.assert.equal(p.asks[0]?.payload.description, "rm -rf build");
    t.assert.equal(p.asks[0]?.payload.subject, "rm -rf build", "the subject is present, which is what lets a frontend offer 'always allow'");

    // The guard adds no session grant of its own: the next deletion asks too.
    await checkCommand(p, "rm -rf dist");
    t.assert.equal(p.asks.length, 2, "the guard must re-fire on every matching call, or one approval disables it");

    // And it is not a blanket refusal of the tool — a command that destroys
    // nothing goes straight through on the same engine.
    const benign = await checkCommand(p, "ls -la");
    t.assert.equal(p.asks.length, 2, "a harmless command must not reach the guard at all");
    t.assert.equal(benign.allowed, true);
    t.assert.equal(benign.source, "rule", "it is the allow rule that lets an ordinary command run");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ARefusalTellsTheModelNotToRetry extends DeletionGuardTest {
  readonly id = "a-declined-deletion-refuses-and-says-that-deletions-always-require-approval";
  readonly whyItExists =
    "a declined deletion came back as a bare 'permission denied', so the model reissued the same command a moment later and the user was asked the same question until one of the clicks went the other way";

  override async run(t: TestRun): Promise<void> {
    const p = probe({ allow: ["Bash"], answer: "deny" });
    const out = await checkCommand(p, "rm -rf build");

    t.assert.equal(out.allowed, false);
    t.assert.equal(out.source, "user", "the refusal is the user's, and the transcript records it as such");
    t.assert.match(out.message ?? "", /Deletion calls always require approval/, out.message ?? "(no message)");
    // The instruction that stops the model reissuing the same command.
    t.assert.match(out.message ?? "", /adjust your approach instead of retrying the same call/i, out.message ?? "(no message)");
    t.assert.deepEqual(p.grants, [], "a refusal must never leave a grant behind");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnExplicitSubjectRuleIsTheOverride extends DeletionGuardTest {
  readonly id = "an-explicit-subject-rule-is-the-one-standing-override-and-only-for-that-subject";
  readonly whyItExists =
    "a repeated cleanup step re-prompted forever because the guard ignored the user's own `Bash(rm -rf ./tmp/*)` rule — and the first fix went too far and let a bare `Bash` allow past it too";

  override async run(t: TestRun): Promise<void> {
    const p = probe({ allow: ["Bash(rm -rf ./tmp/*)"] });

    const granted = await checkCommand(p, "rm -rf ./tmp/*");
    t.assert.equal(p.asks.length, 0, "the user's own subject-scoped decision is a standing answer to this exact question");
    t.assert.equal(granted.allowed, true);
    t.assert.equal(granted.source, "rule", "it runs on the rule, not on a fresh approval");

    // A different target is a different decision.
    const other = await checkCommand(p, "rm -rf ./src");
    t.assert.equal(p.asks.length, 1, "a rule for one target must not cover another");
    t.assert.equal(p.asks[0]?.source, "deletion-guard");
    t.assert.equal(other.source, "user");

    // `Bash(*)` is a subject-scoped rule by spelling and a blanket one by
    // meaning — `matchesExplicit` excludes it on purpose.
    const wildcard = probe({ allow: ["Bash(*)"] });
    await checkCommand(wildcard, "rm -rf ./tmp/*");
    t.assert.equal(wildcard.asks.length, 1, "a wildcard subject is not a deliberate decision about this command");
    t.assert.equal(wildcard.asks[0]?.source, "deletion-guard");

    // Nor is a bare tool rule.
    const bare = probe({ allow: ["Bash"] });
    await checkCommand(bare, "rm -rf ./tmp/*");
    t.assert.equal(bare.asks.length, 1, "a bare tool allow is exactly the broad grant the guard exists above");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AlwaysAllowOnADeletionIsLiteral extends DeletionGuardTest {
  readonly id = "always-allow-on-a-deletion-grants-that-literal-command-and-nothing-else";
  readonly whyItExists =
    "'always allow' on a destructive prompt recorded the command's SHAPE, so approving one `rm` in a scratch folder quietly turned the deletion guard off for every `rm` the agent would ever run";

  override async run(t: TestRun): Promise<void> {
    const p = probe({ answer: "allow_always" });

    const first = await checkCommand(p, "rm -rf ./tmp/x");
    t.assert.equal(p.asks.length, 1);
    t.assert.equal(first.allowed, true);

    t.assert.equal(p.grants.length, 1, "the click has to be written down, or it does not survive a restart");
    t.assert.deepEqual(p.grants[0], { tool: "Bash", subject: "rm -rf ./tmp/x", prefix: false }, "prefix:true would widen one approval into a command shape");

    // The identical command no longer asks — that is what the click bought.
    const again = await checkCommand(p, "rm -rf ./tmp/x");
    t.assert.equal(p.asks.length, 1, "the same command asked a second time, so the grant did not take");
    t.assert.equal(again.allowed, true);
    t.assert.equal(again.source, "rule");

    // Anything else still asks.
    await checkCommand(p, "rm -rf other");
    t.assert.equal(p.asks.length, 2, "a different command must ask, or the grant was a shape and not a literal");

    // The other half of "literal": a PREFIX grant, of the kind an ordinary
    // (non-destructive) "always allow" derives, must never satisfy the guard —
    // approving `git push` cannot come to mean `git push --force`.
    const derived = probe({ allowExact: [{ tool: "Bash", subject: "git push", prefix: true }] });
    const forced = await checkCommand(derived, "git push --force");
    t.assert.equal(derived.asks.length, 1, "a derived command-shape grant let a destructive variant through");
    t.assert.equal(derived.asks[0]?.source, "deletion-guard");
    t.assert.equal(forced.source, "user");

    // The same prefix grant still does its own job for what it was granted on.
    const benign = await checkCommand(derived, "git push origin main");
    t.assert.equal(derived.asks.length, 1, "the prefix grant must still cover the harmless command it was made for");
    t.assert.equal(benign.allowed, true);
    t.assert.equal(benign.source, "rule");
  }
}

/* ---- checklist 6 ----------------------------------------------------- */

class TheOffSwitchAndOverdriveComputeNoSubject extends DeletionGuardTest {
  readonly id = "turning-the-guard-off-or-overdrive-on-computes-no-deletion-subject-at-all";
  readonly whyItExists =
    "OVERDRIVE was implemented as 'ask, then answer yes for the user', so an unattended run still stopped on every prompt it was supposed to make impossible — and the 'Allow deletions' setting only suppressed the dialog while the call was still resolved as a user decision";

  override async run(t: TestRun): Promise<void> {
    const command = join(WS, "build");
    // A plainly in-workspace target, so this is the NON-protected case the
    // checklist names — `.magentra` is a different rule, and a different record.
    const subject = `rm -rf ${command}`;
    t.assert.equal(scopeOf(subject), "workspace", "the fixture must be the non-protected case, or this proves the wrong branch");

    const off = probe();
    off.engine.setDeletionGuard(false);
    const withGuardOff = await checkCommand(off, subject);
    t.assert.deepEqual(off.asks, [], "the off-switch means the question is not asked");
    t.assert.equal(withGuardOff.allowed, true);
    t.assert.equal(withGuardOff.source, "mode", "it resolves through the ordinary path, as a stance decision");
    t.assert.equal(off.subjectCalls.n, 0, "with the guard off the tool is never even asked what the call would delete");

    const overdrive = probe();
    overdrive.engine.setOverdrive(true);
    const inOverdrive = await checkCommand(overdrive, subject);
    t.assert.deepEqual(overdrive.asks, [], "OVERDRIVE means nothing asks, literally");
    t.assert.equal(inOverdrive.allowed, true);
    t.assert.equal(inOverdrive.source, "mode");
    // The claim in permissions.ts is stronger than "it did not ask": in this
    // stance the deletion subject is not computed at all.
    t.assert.equal(overdrive.subjectCalls.n, 0, "OVERDRIVE computed a deletion subject, so the guard is being asked and overruled rather than skipped");

    // The guard is ON by default — neither of the two above is the resting state.
    const armed = probe();
    await checkCommand(armed, subject);
    t.assert.equal(armed.asks.length, 1, "the guard must be on without anyone turning it on");
    t.assert.equal(armed.subjectCalls.n, 1, "and the subject is computed exactly once for the call");
    t.assert.equal(armed.engine.getDeletionGuard(), true);

    // And it can be put back: the off-switch is a switch, not a one-way door.
    armed.engine.setDeletionGuard(false);
    armed.engine.setDeletionGuard(true);
    await checkCommand(armed, subject);
    t.assert.equal(armed.asks.length, 2, "turning the guard back on must restore the question");
  }
}

/* ---- the live half: a real deletion, in a real session ----------------- */

class ARealDeletionIsStoppedAndThenAllowed extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-real-rm-is-stopped-by-a-refusal-and-removes-the-file-on-an-approval";
  readonly whyItExists =
    "the guard was right in every unit and unwired in the Session — `Session.executeToolCalls` passed no deletion scope and the decision table never saw a destructive call, so a workspace with `Bash` allowed lost files without a single prompt";

  #engines: ScriptedEngine[] = [];
  #dirs: string[] = [];

  #savedEnv = new Map<string, string | undefined>();

  /**
   * `loadSettings(workspace)` merges `~/.magentra/settings.json` OVER the
   * workspace's, and a developer's own `permissions` block would decide this
   * test. `redirectHome()` belongs to `FsTest`, and this is not an `fs` test,
   * so it is done by hand here and put back in `tearDown`.
   */
  override setUp(): void {
    const home = this.#makeDir("magentra-deletion-home-");
    for (const name of ["HOME", "USERPROFILE"] as const) {
      this.#savedEnv.set(name, process.env[name]);
      process.env[name] = home;
    }
  }

  /** A throwaway directory this test owns. Removed in `tearDown`, after every engine has closed. */
  #makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /**
   * The engines are closed before the directories go: the Bash tool spawns a
   * real shell in the workspace, and a directory cannot be removed from under
   * a live process on Windows. The retries forgive the moment the operating
   * system keeps a handle open after the shell has already exited — a handle
   * the OS has not finished closing is not a defect in this feature.
   */
  override async tearDown(): Promise<void> {
    try {
      for (const engine of this.#engines) await engine.close();
      this.#engines = [];
    } finally {
      for (const [name, value] of this.#savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      this.#savedEnv.clear();
      const dirs = this.#dirs;
      this.#dirs = [];
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }

  /** A workspace holding one file the agent will try to remove. */
  #workspaceWithAFile(): { workspace: string; doomed: string } {
    const workspace = this.#makeDir("magentra-deletion-ws-");
    const doomed = join(workspace, "doomed.txt");
    writeFileSync(doomed, "work the user has not backed up\n", "utf8");
    return { workspace, doomed };
  }

  /** A session whose Bash tool is fully allowed by settings, answering every prompt with `decision`. */
  async #session(workspace: string, decision: PermissionDecision): Promise<ScriptedEngine> {
    const engine = await startScriptedEngine({
      workspace,
      // Bash allowed outright — the broad grant the guard has to survive.
      settings: { permissions: { allow: ["Bash"], deny: [], allowExact: [] } },
      permissions: decision,
      turns: [
        {
          toolCalls: [
            { name: "Bash", input: { command: "rm -f doomed.txt", description: "Tidy the workspace", run_in_background: false } },
          ],
        },
        { text: "handled" },
        { text: "nothing further" },
        { text: "nothing further" },
        { text: "nothing further" },
      ],
    });
    this.#engines.push(engine);
    return engine;
  }

  override async run(t: TestRun): Promise<void> {
    /* --- refused: the file is still there ------------------------------ */

    const refusedWorkspace = this.#workspaceWithAFile();
    const refusing = await this.#session(refusedWorkspace.workspace, "deny");
    const refusedTurn = await refusing.runTurn("clean up the workspace");
    t.assert.deepEqual(refusedTurn.errors, [], refusedTurn.errors.join(" | "));

    const asked = refusedTurn.events.filter(
      (event): event is Extract<CoreEvent, { type: "permission_request" }> => event.type === "permission_request",
    );
    t.assert.equal(asked.length, 1, "a destructive call asked, although settings allow the Bash tool outright");
    // The prompt carries the COMMAND as its description. The ordinary ask path
    // would have carried the tool's own "Tidy the workspace" instead, so this
    // is what says the deletion guard is the branch that fired.
    t.assert.equal(asked[0]?.description, "rm -f doomed.txt", "the prompt must be the guard's, not the stance's");
    t.assert.notEqual(asked[0]?.description, "Tidy the workspace");

    t.assert.equal(existsSync(refusedWorkspace.doomed), true, "the file was deleted although the user said no");
    t.assert.equal(refusedTurn.toolResults.length, 1);
    t.assert.equal(refusedTurn.toolResults[0]?.isError, true, "a refusal must reach the model as an error it can read");
    t.assert.match(refusedTurn.toolResults[0]?.resultPreview ?? "", /Deletion calls always require approval/);

    /* --- approved: the file is really gone ----------------------------- */

    const approvedWorkspace = this.#workspaceWithAFile();
    t.assert.equal(existsSync(approvedWorkspace.doomed), true, "the fixture must start with the file present");
    const approving = await this.#session(approvedWorkspace.workspace, "allow_once");
    const approvedTurn = await approving.runTurn("clean up the workspace");
    t.assert.deepEqual(approvedTurn.errors, [], approvedTurn.errors.join(" | "));

    const askedAgain = approvedTurn.events.filter((event) => event.type === "permission_request");
    t.assert.equal(askedAgain.length, 1, "the guard asks on the approved path too — that is the whole point of always-ask");

    t.assert.equal(approvedTurn.toolResults.length, 1);
    t.assert.equal(
      approvedTurn.toolResults[0]?.isError,
      false,
      `the approved command failed to run: ${approvedTurn.toolResults[0]?.resultPreview}`,
    );
    t.assert.equal(existsSync(approvedWorkspace.doomed), false, "the approved deletion never happened, so the guard is refusing what the user allowed");
  }
}

registerFeatureTests(
  new TheClassifierFlagsWhatDestroys(),
  new ABroadAllowDoesNotGetPast(),
  new ARefusalTellsTheModelNotToRetry(),
  new AnExplicitSubjectRuleIsTheOverride(),
  new AlwaysAllowOnADeletionIsLiteral(),
  new TheOffSwitchAndOverdriveComputeNoSubject(),
  new ARealDeletionIsStoppedAndThenAllowed(),
);
