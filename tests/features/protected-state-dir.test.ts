/**
 * `protected-state-dir`.
 *
 * MAGENTRA's own state lives in a folder named `.magentra`; secrets live in
 * `.env` files. Two guards cover them, and both sit above the allow rules and
 * the stance: `protectedEditPath` classifies a Write/Edit target, and the Bash
 * tool's own `deletionScope` classifies a removal as `protected` when it hits
 * — or cannot be proved not to hit — a folder NAMED `.magentra`. A protected
 * edit may be satisfied only by a deliberate narrow grant (an explicit
 * `Tool(path)` rule, or an earlier "always allow" on that exact file); a
 * protected deletion may not be satisfied at all: it carries no subject, so
 * no frontend can offer "always allow", and it records no grant.
 *
 * `pure` + `fs`, and the record said `pure`. Re-declared 2026-09-20. Items 1
 * and 4 are classifiers over strings; items 2, 3, 5 and 6 are
 * `PermissionEngine.check` with its two callbacks recorded. Item 7 is what a
 * pure test cannot reach: `Session.fileEditProtectedPath` is private, so the
 * only honest way to show that a real Write is routed into the guard — and
 * that "always allow" is written into this workspace's own settings file — is
 * a real Engine on a scripted provider, which is also the only place the
 * persistence half of item 3 can be observed.
 *
 * TWO THINGS THE CHECKLIST COULD NOT KNOW:
 *   - PACKAGE SURFACE. `bashDeletionScope`, `isMagentraStateDir` and
 *     `MAGENTRA_MENTION` are NOT exported from `@magentra/tools` (the index
 *     re-exports only `resolveBashPath`, `spawnShell`, `killTree` and
 *     `bashDeletionSubject`). Item 4 therefore goes through the observable
 *     surface the Session itself uses: `bashTool.deletionScope(input, ctx)`.
 *   - THE RECORD'S INVARIANT IS HALF STALE. It ends "broad grants and
 *     OVERDRIVE never satisfy it", and the code says otherwise:
 *     `check()` guards the protected-path block with `!this.overdrive`, and
 *     the deletion guard computes no subject at all in that stance. The
 *     approved description agrees with the code ("OVERDRIVE is the one switch
 *     that skips both guards", checklist item 6), so item 6 asserts what the
 *     code does. Reported as spec≠code; the invariant is copied verbatim above
 *     because the record is the record.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PermissionEngine, protectedEditPath, type ApprovalSource, type PermissionRequestPayload } from "@magentra/core";
import type { CoreEvent, PermissionDecision } from "@magentra/protocol";
import { bashTool, writeTool } from "@magentra/tools";

import { strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "protected-state-dir";

/** Verbatim from the record. */
const INVARIANT =
  "An edit into a .magentra path segment or a .env* file confirms every time; broad grants and OVERDRIVE never satisfy it.";

/** An absolute workspace on either platform. Nothing in the pure items touches the disk. */
const WS = resolve("/magentra-protected-probe");

interface Ask {
  readonly payload: PermissionRequestPayload;
  readonly source: ApprovalSource;
}

interface Probe {
  readonly engine: PermissionEngine;
  readonly asks: Ask[];
  readonly grants: { tool: string; subject: string; prefix: boolean | undefined }[];
}

function probe(opts: { allow?: string[]; deny?: string[]; answer?: PermissionDecision; message?: string } = {}): Probe {
  const asks: Ask[] = [];
  const grants: Probe["grants"] = [];
  const engine = new PermissionEngine(
    { allow: opts.allow ?? [], deny: opts.deny ?? [], allowExact: [] },
    async (payload, source) => {
      asks.push({ payload, source });
      return { decision: opts.answer ?? "allow_once", ...(opts.message !== undefined ? { message: opts.message } : {}) };
    },
    (tool, subject, prefix) => grants.push({ tool, subject, prefix }),
  );
  return { engine, asks, grants };
}

function bashInput(command: string): { command: string; description: string; run_in_background: boolean } {
  return { command, description: `run ${command}`, run_in_background: false };
}

/** The Bash tool's own scope classifier, reached the way the Session reaches it. */
function deletionScopeOf(command: string): "workspace" | "unknown" | "protected" {
  return bashTool.deletionScope!(bashInput(command), { cwd: WS, session: strictServices({}) });
}

abstract class ProtectedTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheProtectedEditClassifier extends ProtectedTest {
  readonly id = "a-magentra-segment-or-a-dot-env-basename-is-protected-and-nothing-else-is";
  readonly whyItExists =
    "a classifier that matched on the substring '.env' swept in `src/env.ts` and `.envrc` and asked about edits nobody needed to confirm, which trains the user to click through the one prompt that matters";

  override run(t: TestRun): void {
    for (const p of [join(WS, ".magentra", "settings.json"), join(WS, ".MAGENTRA", "x"), join(WS, ".env"), join(WS, ".env.local"), join(WS, "a", ".magentra", "b", "c.json")]) {
      t.assert.equal(protectedEditPath(p), p, `${p} is protected, and the path itself comes back`);
    }
    for (const p of [join(WS, "src", "env.ts"), join(WS, ".envrc"), join(WS, "magentra", "x"), join(WS, "dotmagentra", "x"), join(WS, ".environment")]) {
      t.assert.equal(protectedEditPath(p), undefined, `${p} is an ordinary edit`);
    }
    // Both separators are understood, because a path reaches this from either
    // platform's own resolver.
    t.assert.equal(protectedEditPath("/w/.magentra/settings.json"), "/w/.magentra/settings.json");
    t.assert.equal(protectedEditPath("C:\\w\\.magentra\\settings.json"), "C:\\w\\.magentra\\settings.json");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ABroadGrantNeverSatisfiesTheEditGuard extends ProtectedTest {
  readonly id = "a-protected-edit-asks-through-broad-allow-rules-and-a-session-allow";
  readonly whyItExists =
    "one 'allow for this session' on an ordinary Write added a bare `Write` rule, and the next Write in the same session silently replaced the user's `.env`";

  override async run(t: TestRun): Promise<void> {
    const target = join(WS, ".env");
    const p = probe({ allow: ["Write", "Write(*)"], answer: "deny", message: "not that file" });
    p.engine.addSessionAllow("Write");

    const out = await p.engine.check(writeTool, { file_path: target, content: "SECRET=1" }, target, "Write .env", undefined, false, target);

    t.assert.equal(p.asks.length, 1, "it asked, past every broad grant in play");
    t.assert.equal(p.asks[0]?.source, "protected-path");
    t.assert.equal(p.asks[0]?.payload.subject, target, "the payload names the file, so an always-allow can be scoped to it");
    t.assert.equal(out.allowed, false, "a denial is a denial");
    t.assert.equal(out.source, "user");
    t.assert.match(out.message ?? "", /protected path/, out.message ?? "(no message)");
    t.assert.match(out.message ?? "", /not that file/, "the user's own words reach the model");
    t.assert.deepEqual(p.grants, [], "a refusal records nothing");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AlwaysAllowRecordsOnlyThatExactFile extends ProtectedTest {
  readonly id = "an-always-allow-on-a-protected-edit-records-only-that-exact-file";
  readonly whyItExists =
    "the grant was recorded for the TOOL, so one approved edit to `.magentra/settings.json` quietly licensed every later write to `.env` as well — the opposite of a guard that confirms every time";

  override async run(t: TestRun): Promise<void> {
    const dotenv = join(WS, ".env");
    const dotenvLocal = join(WS, ".env.local");
    const p = probe({ answer: "allow_always" });

    await p.engine.check(writeTool, { file_path: dotenv, content: "A=1" }, dotenv, "Write .env", undefined, false, dotenv);
    t.assert.deepEqual(p.grants, [{ tool: "Write", subject: dotenv, prefix: false }], "a literal grant for this one file, never a command shape");

    const again = await p.engine.check(writeTool, { file_path: dotenv, content: "A=2" }, dotenv, "Write .env", undefined, false, dotenv);
    t.assert.equal(p.asks.length, 1, "the identical file does not ask a second time");
    t.assert.equal(again.allowed, true);
    t.assert.equal(again.source, "rule");

    const neighbour = await p.engine.check(writeTool, { file_path: dotenvLocal, content: "B=1" }, dotenvLocal, "Write .env.local", undefined, false, dotenvLocal);
    t.assert.equal(p.asks.length, 2, "a different protected file still asks");
    t.assert.equal(p.asks[1]?.payload.subject, dotenvLocal);
    t.assert.equal(neighbour.source, "user");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ADeletionThatCouldReachTheStateDirIsProtected extends ProtectedTest {
  readonly id = "a-deletion-that-could-reach-the-state-dir-is-classified-protected-and-a-deeper-path-is-not";
  readonly whyItExists =
    "`rm -rf .magentr*` and `rm -rf $(cat list)` were classified as ordinary workspace cleanup, so an autonomous run deleted the sessions, transcripts and settings of the workspace it was working in";

  override run(t: TestRun): void {
    for (const command of ["rm -rf .magentra", "rm -rf .magentra/", "rm -rf .magentra/*", "rm -rf .MAGENTRA", "rm -rf .magentr*", "rm -rf $(cat x) .magentra", `rm -rf ${join(WS, ".magentra")}`]) {
      t.assert.equal(deletionScopeOf(command), "protected", `${command} must be treated as the state dir`);
    }
    t.assert.equal(deletionScopeOf("rm -rf .magentra/worktrees/foo"), "workspace", "a path INSIDE the state dir is routine cleanup");
    t.assert.equal(deletionScopeOf("rm -rf build"), "workspace", "and so is an ordinary directory");
    t.assert.equal(deletionScopeOf("rm -rf /"), "unknown", "a target outside the workspace is not provable, so it keeps the ordinary guard");
    t.assert.equal(deletionScopeOf("rm -rf $(cat x)"), "unknown", "an unanalyzable command that never mentions the state dir is merely unknown");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AProtectedDeletionAsksWithNothingToGrant extends ProtectedTest {
  readonly id = "a-protected-deletion-asks-with-no-subject-even-with-the-guard-off-and-an-explicit-rule";
  readonly whyItExists =
    "with 'Allow deletions' switched on, `rm -rf .magentra` ran with no prompt at all — and the first fix still offered 'always allow' on the card, which would have made the second attempt silent forever";

  override async run(t: TestRun): Promise<void> {
    const subject = "rm -rf .magentra";
    t.assert.equal(deletionScopeOf(subject), "protected", "the classifier's verdict this test is built on");

    const p = probe({ allow: [`Bash(${subject})`], answer: "allow_always" });
    p.engine.setDeletionGuard(false);

    const out = await p.engine.check(bashTool, bashInput(subject), subject, "remove the state dir", "protected", false, undefined);
    t.assert.equal(p.asks.length, 1, "it asked with the guard off AND an explicit subject rule in settings");
    t.assert.equal(p.asks[0]?.source, "deletion-guard");
    t.assert.equal("subject" in (p.asks[0]?.payload ?? {}), false, "no subject: there is nothing for a frontend to offer 'always allow' on");
    t.assert.equal(p.asks[0]?.payload.description, subject, "the card describes what would be deleted");
    t.assert.equal(out.allowed, true);
    t.assert.equal(out.source, "user");
    t.assert.deepEqual(p.grants, [], "an allow_always on a protected deletion records nothing");

    const second = await p.engine.check(bashTool, bashInput(subject), subject, "remove the state dir", "protected", false, undefined);
    t.assert.equal(p.asks.length, 2, "so the identical command asks again");
    t.assert.equal(second.source, "user");
  }
}

/* ---- checklist 6 ----------------------------------------------------- */

class OverdriveIsTheOneSwitchThatSkipsBoth extends ProtectedTest {
  readonly id = "overdrive-skips-both-protected-guards";
  readonly whyItExists =
    "a stance whose whole promise is that nothing asks cannot keep two dialogs nobody is there to answer — and the opposite mistake, a guard that keeps asking, is what stalls an unattended run on its first state-dir edit";

  override async run(t: TestRun): Promise<void> {
    const target = join(WS, ".magentra", "settings.json");
    const p = probe();
    p.engine.setOverdrive(true);

    const edit = await p.engine.check(writeTool, { file_path: target, content: "{}" }, target, "Write settings", undefined, false, target);
    t.assert.equal(edit.allowed, true);
    t.assert.equal(edit.source, "mode");

    const deletion = await p.engine.check(bashTool, bashInput("rm -rf .magentra"), "rm -rf .magentra", "remove the state dir", "protected", false, undefined);
    t.assert.equal(deletion.allowed, true);
    t.assert.equal(deletion.source, "mode");

    t.assert.deepEqual(p.asks, [], "neither guard reached the frontend");
    t.assert.deepEqual(p.grants, [], "and neither recorded anything");
  }
}

/* ---- the guard and its grant, through the real Session — fs ---------- */

class TheSessionRoutesARealWriteIntoTheGuard extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-real-write-to-dot-env-asks-once-and-the-grant-is-written-into-this-workspaces-settings";
  readonly whyItExists =
    "`fileEditProtectedPath` is the only thing that turns a Write's `file_path` into the guard's argument, and the grant is only durable if it reaches this workspace's settings file — either half failing leaves every unit assertion above green while the real app asks about the wrong files, or asks again after a restart";

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-protected-");
    const dotenv = join(workspace, ".env");
    const dotenvLocal = join(workspace, ".env.local");
    const ordinary = join(workspace, "notes.md");

    this.#engine = await startScriptedEngine({
      workspace,
      permissions: "allow_always",
      turns: [
        {
          toolCalls: [
            { name: "Write", input: { file_path: ordinary, content: "ordinary\n" } },
            { name: "Write", input: { file_path: dotenv, content: "A=1\n" } },
            { name: "Write", input: { file_path: dotenv, content: "A=2\n" } },
            { name: "Write", input: { file_path: dotenvLocal, content: "B=1\n" } },
          ],
        },
        { text: "all four written" },
      ],
    });

    const turn = await this.#engine.runTurn("write the files");
    t.assert.deepEqual(turn.errors, [], turn.errors.join(" | "));
    t.assert.equal(turn.toolResults.length, 4, "all four Write calls ran");
    for (const result of turn.toolResults) t.assert.equal(result.isError, false, result.resultPreview);
    t.assert.equal(readFileSync(dotenv, "utf8"), "A=2\n", "the approved edits really happened");

    const asked = turn.events
      .filter((e): e is Extract<CoreEvent, { type: "permission_request" }> => e.type === "permission_request")
      .map((e) => e.subject);
    t.assert.deepEqual(asked, [dotenv, dotenvLocal], "the ordinary file never asked, `.env` asked once, and `.env.local` asked on its own account");

    // The grant is durable: it lands in THIS workspace's settings file, which
    // is what makes the second `.env` write silent after a restart too.
    const projectSettings = join(workspace, ".magentra", "settings.json");
    t.assert.equal(existsSync(projectSettings), true, "the engine's own state dir holds the workspace settings");
    const saved = JSON.parse(readFileSync(projectSettings, "utf8")) as { permissions?: { allowExact?: { tool: string; subject: string; prefix?: boolean }[] } };
    const exact = saved.permissions?.allowExact ?? [];
    t.assert.deepEqual(
      exact,
      [
        { tool: "Write", subject: dotenv },
        { tool: "Write", subject: dotenvLocal },
      ],
      "one literal grant per approved file, and no prefix grant anywhere near a protected path",
    );
  }
}

registerFeatureTests(
  new TheProtectedEditClassifier(),
  new ABroadGrantNeverSatisfiesTheEditGuard(),
  new AlwaysAllowRecordsOnlyThatExactFile(),
  new ADeletionThatCouldReachTheStateDirIsProtected(),
  new AProtectedDeletionAsksWithNothingToGrant(),
  new OverdriveIsTheOneSwitchThatSkipsBoth(),
  new TheSessionRoutesARealWriteIntoTheGuard(),
);
