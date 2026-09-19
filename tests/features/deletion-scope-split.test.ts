/**
 * `deletion-scope-split`.
 *
 * OVERDRIVE means nothing asks — except for one target. Before a deleting Bash
 * command runs, the Bash tool classifies what it would remove: `workspace`
 * (plain rm/del/find/mv whose every path provably resolves inside the tree,
 * judged against Bash's tracked cwd), `unknown` (history rewrites, `$`/backtick
 * substitution, `~`, bare or root wildcards, out-of-tree paths) or `protected`
 * (a `.magentra` state directory, or an unparseable command that mentions one).
 * The permission engine treats `protected` as always-ask: it beats the "Allow
 * deletions" off-switch and an explicit allow rule, it records no grant when
 * the user clicks "always allow", and the one thing it yields to is OVERDRIVE,
 * a switch the user threw by hand.
 *
 * `pure`, as the record declares — every assertion here is a function of its
 * arguments. The classifier never touches the disk (`insideWorkspace` resolves
 * paths, it does not stat them), and `PermissionEngine` is constructed with the
 * callbacks it calls, so the approval prompt and the persistence of a grant are
 * both readable without a frontend or a settings file.
 *
 * WHAT THE PACKAGE ACTUALLY EXPORTS. The checklist calls `bashDeletionScope()`
 * directly; `@magentra/tools` exports only `.` and that file's `index.ts`
 * re-exports `bashDeletionSubject` alone, so the classifier is module-private.
 * It is reached here the way the Session reaches it — `bashTool.deletionScope`,
 * the `ToolDefinition` hook — which is also the surface that would have to keep
 * working. Its `ToolContext` is the real one minus the session, because
 * `effectiveCwd` uses the session purely as a WeakMap key for `cd` tracking: a
 * session the map has never seen resolves to `ctx.cwd`, which is exactly the
 * "shellCwd === workspace" case the checklist asks for.
 */

import { join, resolve } from "node:path";

import {
  PermissionEngine,
  type ApprovalSource,
  type PermissionRequestPayload,
  type SessionServices,
  type ToolContext,
} from "@magentra/core";
import type { PermissionDecision } from "@magentra/protocol";
import { bashTool } from "@magentra/tools";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "deletion-scope-split";

/** Verbatim from the record. */
const INVARIANT = "Deleting a .magentra target asks in every mode except OVERDRIVE.";

/** A workspace root that exists as a path, not as a directory — nothing here reads the disk. */
const WORKSPACE = resolve(join("/", "magentra-ws"));

/** The Bash input for one command, as the schema produces it. */
function bashInput(command: string): { command: string; description: string; run_in_background: boolean } {
  return { command, description: `run ${command}`, run_in_background: false };
}

/** The tool context the Session builds, minus the session — see the header. */
function context(cwd = WORKSPACE): ToolContext {
  return { cwd, session: {} as SessionServices };
}

/** The classifier, through the hook the Session calls. */
function scopeOf(command: string, cwd = WORKSPACE): "workspace" | "unknown" | "protected" {
  const classify = bashTool.deletionScope;
  if (classify === undefined) throw new Error("bashTool no longer declares deletionScope — the split is gone");
  return classify(bashInput(command), context(cwd));
}

/** One recorded call to the approval callback. */
interface Ask {
  readonly payload: PermissionRequestPayload;
  readonly source: ApprovalSource;
}

/** One recorded "always allow" persistence. */
interface Persisted {
  readonly tool: string;
  readonly subject: string;
  readonly prefix?: boolean;
}

/**
 * A PermissionEngine wired to recording callbacks — the frontend and the
 * settings writer are the two collaborators `check()` is defined in terms of,
 * and both are constructor parameters of the real class.
 */
function engineWith(
  rules: { allow: string[]; deny: string[] },
  answer: PermissionDecision,
): { permissions: PermissionEngine; asks: Ask[]; persisted: Persisted[] } {
  const asks: Ask[] = [];
  const persisted: Persisted[] = [];
  const permissions = new PermissionEngine(
    rules,
    async (payload, source) => {
      asks.push({ payload, source });
      return { decision: answer };
    },
    (tool, subject, prefix) => {
      persisted.push({ tool, subject, ...(prefix !== undefined ? { prefix } : {}) });
    },
  );
  return { permissions, asks, persisted };
}

abstract class DeletionScopeTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheClassifierSplitsThreeWays extends DeletionScopeTest {
  readonly id = "the-bash-classifier-splits-a-deletion-into-workspace-protected-and-unprovable";
  readonly whyItExists =
    "`rm -rf .magentra` was classified the same as `rm -rf tmp/build` — a plain path inside the tree — so an autonomous cleanup could wipe the workspace's settings, sessions and transcripts without a single prompt";

  override run(t: TestRun): void {
    // Protected: the state directory itself, and emptying its contents.
    t.assert.equal(scopeOf("rm -rf .magentra"), "protected", "the state directory is never routine cleanup");
    t.assert.equal(scopeOf("rm -rf .magentra/*"), "protected", "emptying it is deleting it");

    // Workspace: a plain path that provably resolves inside the tree.
    t.assert.equal(scopeOf("rm -rf tmp/build"), "workspace", "a relative path under the cwd is provably in-tree");
    t.assert.equal(
      scopeOf(`rm -rf ${join(WORKSPACE, "tmp", "build")}`),
      "workspace",
      "and so is the same path written absolutely",
    );

    // Unknown: everything the static classifier cannot see through.
    t.assert.equal(scopeOf("rm -rf ~/x"), "unknown", "`~` is the user's home, not this workspace");
    t.assert.equal(scopeOf("rm -rf $DIR"), "unknown", "a substitution could expand to anything");
    t.assert.equal(scopeOf("rm -rf *"), "unknown", "a bare wildcard at the root has no literal prefix to judge");
    t.assert.equal(
      scopeOf(`rm -rf ${join(WORKSPACE, "..", "elsewhere")}`),
      "unknown",
      "a path that climbs out of the tree is not in-tree",
    );

    // The three verdicts are the whole codomain, and the split is a real split:
    // the same command is `workspace` under one cwd and `unknown` under another.
    const elsewhere = resolve(join("/", "other-ws"));
    t.assert.equal(scopeOf("rm -rf tmp/build", elsewhere), "workspace", "judged against the cwd it was given");
    t.assert.notEqual(scopeOf("rm -rf tmp/build"), scopeOf("rm -rf ~/x"), "the split separates these two");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheGuardOffSwitchDoesNotCoverTheStateDir extends DeletionScopeTest {
  readonly id = "a-protected-deletion-asks-with-no-subject-even-with-the-deletion-guard-off";
  readonly whyItExists =
    "a user who turned 'Allow deletions' on to stop being prompted for `rm -rf dist` also turned off the prompt for `rm -rf .magentra`, and the setting they wanted for build output silently covered their own session history";

  override async run(t: TestRun): Promise<void> {
    const command = "rm -rf .magentra";
    const input = bashInput(command);
    const { permissions, asks } = engineWith({ allow: [], deny: [] }, "allow_once");
    permissions.setDeletionGuard(false);
    t.assert.equal(permissions.getDeletionGuard(), false, "the off-switch really is off");

    const outcome = await permissions.check(bashTool, input, command, input.description, "protected");

    t.assert.equal(asks.length, 1, "the user was asked, with the guard switched off");
    t.assert.equal(asks[0]!.source, "deletion-guard", "and asked as the deletion guard, not as an ordinary prompt");
    t.assert.equal(asks[0]!.payload.tool, "Bash");
    t.assert.equal(asks[0]!.payload.description, command, "the prompt names what would be deleted");
    t.assert.equal(
      asks[0]!.payload.subject,
      undefined,
      "no subject: its presence is what lets a frontend offer 'always allow', and this one must ask every time",
    );
    t.assert.equal(outcome.allowed, true);
    t.assert.equal(outcome.source, "user", "the answer came from the user, not from the stance");

    // The contrast: with the guard off, an ordinary in-workspace deletion of
    // the same shape runs without a prompt. That is the setting working.
    const plain = bashInput("rm -rf tmp/build");
    const plainOutcome = await permissions.check(bashTool, plain, plain.command, plain.description, "workspace");
    t.assert.equal(asks.length, 1, "the off-switch still covers an ordinary deletion");
    t.assert.equal(plainOutcome.source, "mode");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnExplicitRuleDoesNotBeatIt extends DeletionScopeTest {
  readonly id = "an-explicit-allow-rule-does-not-beat-a-protected-deletion";
  readonly whyItExists =
    "one `Bash(rm -rf .magentra)` line in settings — the narrow, deliberate kind of rule that is allowed to beat the deletion guard — turned deleting the workspace's own state into a standing permission no later prompt would ever mention again";

  override async run(t: TestRun): Promise<void> {
    const command = "rm -rf .magentra";
    const input = bashInput(command);
    const { permissions, asks } = engineWith({ allow: [`Bash(${command})`], deny: [] }, "allow_once");

    const outcome = await permissions.check(bashTool, input, command, input.description, "protected");
    t.assert.equal(asks.length, 1, "the explicit rule did not stand in for the confirmation");
    t.assert.equal(asks[0]!.source, "deletion-guard");
    t.assert.equal(asks[0]!.payload.subject, undefined);
    t.assert.equal(outcome.source, "user");

    // The same rule, on a deletion that is NOT protected, does beat the guard —
    // otherwise this test would pass against a rule that simply never matches.
    const plain = bashInput("rm -rf tmp/build");
    const plainRun = engineWith({ allow: ["Bash(rm -rf tmp/build)"], deny: [] }, "allow_once");
    const plainOutcome = await plainRun.permissions.check(
      bashTool,
      plain,
      plain.command,
      plain.description,
      "workspace",
    );
    t.assert.equal(plainRun.asks.length, 0, "an explicit rule does beat the guard for an ordinary deletion");
    t.assert.equal(plainOutcome.source, "rule");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AlwaysAllowRecordsNothing extends DeletionScopeTest {
  readonly id = "always-allow-on-a-protected-deletion-records-no-grant-so-the-next-one-asks-again";
  readonly whyItExists =
    "clicking 'always allow' once on a `.magentra` deletion wrote a grant to settings, so every later deletion of the state directory — in this session and in every session after it — ran silently on a decision the user made about one command";

  override async run(t: TestRun): Promise<void> {
    const command = "rm -rf .magentra";
    const input = bashInput(command);
    const { permissions, asks, persisted } = engineWith({ allow: [], deny: [] }, "allow_always");

    const first = await permissions.check(bashTool, input, command, input.description, "protected");
    t.assert.equal(first.allowed, true);
    t.assert.equal(asks.length, 1);
    t.assert.deepEqual(persisted, [], "'always allow' on a protected deletion is not written down");

    const second = await permissions.check(bashTool, input, command, input.description, "protected");
    t.assert.equal(second.allowed, true);
    t.assert.equal(asks.length, 2, "the identical call asked a second time");
    t.assert.equal(asks[1]!.source, "deletion-guard");
    t.assert.deepEqual(persisted, [], "and still recorded nothing");

    // The contrast: the same answer on an ordinary deletion DOES record an
    // exact grant, and the second identical call then runs without asking.
    const plain = bashInput("rm -rf tmp/build");
    const plainRun = engineWith({ allow: [], deny: [] }, "allow_always");
    await plainRun.permissions.check(bashTool, plain, plain.command, plain.description, "workspace");
    t.assert.deepEqual(plainRun.persisted, [{ tool: "Bash", subject: plain.command, prefix: false }]);
    const again = await plainRun.permissions.check(bashTool, plain, plain.command, plain.description, "workspace");
    t.assert.equal(plainRun.asks.length, 1, "an ordinary deletion remembers the grant");
    t.assert.equal(again.source, "rule");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class OverdriveIsTheOneModeThatSkipsIt extends DeletionScopeTest {
  readonly id = "overdrive-is-the-one-mode-that-skips-a-protected-deletion";
  readonly whyItExists =
    "OVERDRIVE promises the model that nothing asks, so a prompt nobody is watching would hang an autonomous run forever on a question with no answer";

  override async run(t: TestRun): Promise<void> {
    const command = "rm -rf .magentra";
    const input = bashInput(command);
    const { permissions, asks, persisted } = engineWith({ allow: [], deny: [] }, "deny");

    // Off: it asks. The answer here is "deny", so a skipped guard is impossible
    // to confuse with an approval.
    const attended = await permissions.check(bashTool, input, command, input.description, "protected");
    t.assert.equal(asks.length, 1, "outside OVERDRIVE the protected deletion asks");
    t.assert.equal(attended.allowed, false);

    permissions.setOverdrive(true);
    const autonomous = await permissions.check(bashTool, input, command, input.description, "protected");
    t.assert.equal(asks.length, 1, "OVERDRIVE asked nothing — the count did not move");
    t.assert.equal(autonomous.allowed, true);
    t.assert.equal(autonomous.source, "mode", "allowed by the stance, not by a user or a rule");
    t.assert.deepEqual(persisted, [], "and nothing was written down on the way past");

    // A deny rule is the one thing OVERDRIVE still honours — so "nothing asks"
    // is not "nothing is checked".
    const denied = engineWith({ allow: [], deny: [`Bash(${command})`] }, "deny");
    denied.permissions.setOverdrive(true);
    const refused = await denied.permissions.check(bashTool, input, command, input.description, "protected");
    t.assert.equal(refused.allowed, false, "a deny rule the user wrote still refuses under OVERDRIVE");
    t.assert.equal(refused.source, "rule");
    t.assert.equal(denied.asks.length, 0, "and it refuses without asking");
  }
}

registerFeatureTests(
  new TheClassifierSplitsThreeWays(),
  new TheGuardOffSwitchDoesNotCoverTheStateDir(),
  new AnExplicitRuleDoesNotBeatIt(),
  new AlwaysAllowRecordsNothing(),
  new OverdriveIsTheOneModeThatSkipsIt(),
);
