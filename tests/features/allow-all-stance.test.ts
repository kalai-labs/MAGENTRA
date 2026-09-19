/**
 * `allow-all-stance`.
 *
 * OVERDRIVE is the fully-autonomous stance `/overdrive on` throws. While it is
 * on, `PermissionEngine.check` never reaches the frontend: the protected-path
 * block is skipped (`!this.overdrive`), `deletionSubject` is not even computed
 * at any scope — the `.magentra` state dir included — and the out-of-workspace
 * downgrade from `allow` to `ask` is switched off. Every one of those calls
 * comes back `source: "mode"`, the stance answering for itself. The single
 * exception is a deny rule the user wrote: it is resolved first, and it
 * REFUSES rather than asking, because an unattended run has nobody to ask.
 *
 * `pure` + `fs`, and the record said `pure`. Re-declared 2026-09-20. Items 1–5
 * are the engine as a function of its arguments — the approval and persistence
 * hops are constructor callbacks, so a probe that records them involves no I/O,
 * and the tool definitions handed to `check` are the shipped `bashTool` and
 * `writeTool`, classifiers and all. Item 6 is the half a pure test cannot see:
 * that the switch is actually wired from the slash command to the engine that
 * decides, proved on a real Engine writing a real file into a real `.magentra`
 * directory with no prompt in the stream.
 *
 * NOTE ON THE RECORD'S PROSE. It says "only the deletion guard and the
 * `.magentra` protection still ask", which the code contradicts and the
 * approved description corrects: OVERDRIVE skips both. The invariant below —
 * "nothing asks, literally" — is what the code does, and what is asserted here.
 *
 * The scripted provider is the only double, and nothing asserts on what it
 * returned: item 6 asserts on the events the real engine emitted, the real
 * tool results, and the files on disk.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { PermissionEngine, type ApprovalSource, type PermissionRequestPayload } from "@magentra/core";
import type { CoreEvent, PermissionDecision } from "@magentra/protocol";
import { bashTool, writeTool } from "@magentra/tools";

import { strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "allow-all-stance";

/** Verbatim from the record. */
const INVARIANT = "OVERDRIVE means nothing asks, literally — except a deny rule, which refuses rather than asks.";

/** An absolute path on either platform; nothing here touches the disk. */
const WS = resolve("/magentra-overdrive-probe");

interface Ask {
  readonly payload: PermissionRequestPayload;
  readonly source: ApprovalSource;
}

interface Probe {
  readonly engine: PermissionEngine;
  /** Every trip to the frontend. In OVERDRIVE this array staying empty IS the feature. */
  readonly asks: Ask[];
  readonly grants: { tool: string; subject: string }[];
}

function overdriveProbe(opts: { allow?: string[]; deny?: string[]; answer?: PermissionDecision } = {}): Probe {
  const asks: Ask[] = [];
  const grants: Probe["grants"] = [];
  const engine = new PermissionEngine(
    { allow: opts.allow ?? [], deny: opts.deny ?? [], allowExact: [] },
    async (payload, source) => {
      asks.push({ payload, source });
      return { decision: opts.answer ?? "allow_once" };
    },
    (tool, subject) => grants.push({ tool, subject }),
  );
  return { engine, asks, grants };
}

function bashInput(command: string): { command: string; description: string; run_in_background: boolean } {
  return { command, description: `run ${command}`, run_in_background: false };
}

/** The real Bash classifier, as the Session computes it for every call. */
function deletionScopeOf(command: string, workspace = WS): "workspace" | "unknown" | "protected" {
  return bashTool.deletionScope!(bashInput(command), { cwd: workspace, session: strictServices({}) });
}

abstract class OverdriveTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class ADeletionRunsUnprompted extends OverdriveTest {
  readonly id = "a-deletion-runs-unprompted-and-is-answered-by-the-stance";
  readonly whyItExists =
    "an overnight autonomous run stopped dead on the first `rm -rf build` approval dialog and was still sitting there in the morning, having done none of the work it was left to do";

  override async run(t: TestRun): Promise<void> {
    const subject = "rm -rf ./build";
    t.assert.notEqual(bashTool.deletionSubject?.(bashInput(subject)), undefined, "the real tool does flag this call as a deletion");

    const p = overdriveProbe();
    p.engine.setOverdrive(true);
    const out = await p.engine.check(bashTool, bashInput(subject), subject, "delete build", deletionScopeOf(subject), false, undefined);

    t.assert.equal(out.allowed, true);
    t.assert.equal(out.source, "mode", "the stance answered, so no rule and no click was involved");
    t.assert.deepEqual(p.asks, [], "the deletion guard never reached the frontend");

    // The same call with OVERDRIVE off is the contrast that makes the assertion mean something.
    const guarded = overdriveProbe();
    await guarded.engine.check(bashTool, bashInput(subject), subject, "delete build", deletionScopeOf(subject), false, undefined);
    t.assert.equal(guarded.asks.length, 1, "with the stance off the very same call asks");
    t.assert.equal(guarded.asks[0]?.source, "deletion-guard");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AProtectedEditRunsUnprompted extends OverdriveTest {
  readonly id = "an-edit-to-magentra-settings-runs-unprompted";
  readonly whyItExists =
    "OVERDRIVE that still stopped for `.magentra/settings.json` could not finish a task that reconfigures the workspace, which is precisely the kind of chore it is switched on for";

  override async run(t: TestRun): Promise<void> {
    const target = join(WS, ".magentra", "settings.json");
    const p = overdriveProbe();
    p.engine.setOverdrive(true);

    const out = await p.engine.check(writeTool, { file_path: target, content: "{}" }, target, "Write settings", undefined, false, target);
    t.assert.equal(out.allowed, true);
    t.assert.equal(out.source, "mode");
    t.assert.deepEqual(p.asks, [], "the protected-path guard is off in this stance");
    t.assert.deepEqual(p.grants, [], "and nothing was persisted, because nothing was approved by anyone");

    const guarded = overdriveProbe();
    await guarded.engine.check(writeTool, { file_path: target, content: "{}" }, target, "Write settings", undefined, false, target);
    t.assert.equal(guarded.asks[0]?.source, "protected-path", "with the stance off the same edit asks");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnEditOutsideTheWorkspaceRunsUnprompted extends OverdriveTest {
  readonly id = "an-edit-outside-the-workspace-runs-unprompted-and-asks-when-the-stance-is-off";
  readonly whyItExists =
    "the out-of-workspace downgrade turns an auto-allowed edit into an approval prompt, and left in place it re-introduced the one dialog an unattended run cannot answer";

  override async run(t: TestRun): Promise<void> {
    const outside = join(resolve("/magentra-elsewhere"), ".bashrc");

    const p = overdriveProbe();
    p.engine.setOverdrive(true);
    const out = await p.engine.check(writeTool, { file_path: outside, content: "x" }, outside, "Write outside", undefined, true, undefined);
    t.assert.equal(out.allowed, true);
    t.assert.equal(out.source, "mode");
    t.assert.deepEqual(p.asks, []);

    const normal = overdriveProbe();
    const downgraded = await normal.engine.check(writeTool, { file_path: outside, content: "x" }, outside, "Write outside", undefined, true, undefined);
    t.assert.equal(normal.asks.length, 1, "in the normal stance the same edit must ask");
    t.assert.equal(normal.asks[0]?.source, "ask", "as the stance's own downgrade, not as a target guard");
    t.assert.equal(downgraded.source, "user");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ADenyRuleRefusesInsteadOfAsking extends OverdriveTest {
  readonly id = "a-deny-rule-refuses-in-overdrive-and-never-asks";
  readonly whyItExists =
    "the one configuration an autonomous stance must not override is the user's own `deny` list — and refusing by ASKING would be the same stall as any other dialog, so it has to come back as a denial the model can read";

  override async run(t: TestRun): Promise<void> {
    const p = overdriveProbe({ deny: ["Bash(rm *)"], allow: ["Bash(*)"] });
    p.engine.setOverdrive(true);

    const subject = "rm -rf x";
    const out = await p.engine.check(bashTool, bashInput(subject), subject, "delete x", deletionScopeOf(subject), false, undefined);
    t.assert.equal(out.allowed, false);
    t.assert.equal(out.source, "rule");
    t.assert.deepEqual(p.asks, [], "it refused without a round trip to a user who is not there");
    t.assert.match(out.message ?? "", /do not retry it verbatim/, "the model is told not to repeat the call");

    // Everything the rule does not name still runs unprompted.
    const other = await p.engine.check(bashTool, bashInput("npm run build"), "npm run build", "build", deletionScopeOf("npm run build"), false, undefined);
    t.assert.equal(other.allowed, true);
    t.assert.deepEqual(p.asks, []);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AProtectedDeletionRunsUnprompted extends OverdriveTest {
  readonly id = "a-protected-magentra-deletion-runs-unprompted-in-this-stance";
  readonly whyItExists =
    "the `protected` scope is the one deletion verdict that beats the 'Allow deletions' switch and explicit allow rules, so an OVERDRIVE that honoured it too would still stop for a prompt — 'nothing asks' with one exception is not the feature";

  override async run(t: TestRun): Promise<void> {
    const subject = "rm -rf .magentra";
    t.assert.equal(deletionScopeOf(subject), "protected", "the real classifier calls this one protected");

    const p = overdriveProbe();
    p.engine.setOverdrive(true);
    const out = await p.engine.check(bashTool, bashInput(subject), subject, "remove the state dir", "protected", false, undefined);
    t.assert.equal(out.allowed, true);
    t.assert.equal(out.source, "mode");
    t.assert.deepEqual(p.asks, [], "not even this one asks");

    // Off, the same verdict asks even with the guard disabled — which is what
    // makes the OVERDRIVE skip a decision rather than a side effect.
    const guarded = overdriveProbe();
    guarded.engine.setDeletionGuard(false);
    await guarded.engine.check(bashTool, bashInput(subject), subject, "remove the state dir", "protected", false, undefined);
    t.assert.equal(guarded.asks.length, 1);
    t.assert.equal(guarded.asks[0]?.source, "deletion-guard");
  }
}

/* ---- the switch, through the real engine — fs ------------------------- */

class TheSwitchReachesTheEngineThatDecides extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "overdrive-on-through-the-engine-writes-into-magentra-with-no-prompt-while-a-deny-rule-still-refuses";
  readonly whyItExists =
    "`/overdrive on` that announced itself but never reached `PermissionEngine.setOverdrive` left every unit assertion green and the user's unattended run still stopping on the first dialog";

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-overdrive-");
    const stateFile = join(workspace, ".magentra", "state.md");
    const forbidden = join(workspace, "forbidden.md");

    this.#engine = await startScriptedEngine({
      workspace,
      settings: { permissions: { allow: [], deny: ["Write(*forbidden.md)"], allowExact: [] } },
      turns: [
        {
          toolCalls: [
            { name: "Write", input: { file_path: stateFile, content: "state\n" } },
            { name: "Write", input: { file_path: forbidden, content: "nope\n" } },
          ],
        },
        { text: "one landed, one was refused" },
        { text: "nothing further" },
        { text: "DONE" },
      ],
    });

    this.#engine.send({ type: "slash_command", command: "overdrive", args: "on" });
    const toggled = await this.#engine.waitFor((e): e is Extract<CoreEvent, { type: "overdrive_changed" }> => e.type === "overdrive_changed");
    t.assert.equal(toggled.enabled, true, "the slash command reached the session");

    const turn = await this.#engine.runTurn("do the chore");
    t.assert.deepEqual(turn.errors, [], turn.errors.join(" | "));

    const requests = turn.events.filter((e) => e.type === "permission_request");
    t.assert.deepEqual(requests, [], "nothing asked, literally — not the protected path, not the refusal");

    t.assert.equal(turn.toolResults.length, 2, "both calls were decided");
    const [wrote, refused] = turn.toolResults;
    t.assert.equal(wrote?.isError, false, wrote?.resultPreview);
    t.assert.equal(existsSync(stateFile), true, "the edit into .magentra landed without a click");
    t.assert.equal(refused?.isError, true, "the denied call came back as an error the model can read");
    t.assert.match(refused?.resultPreview ?? "", /Permission denied by settings rule/);
    t.assert.equal(existsSync(forbidden), false, "and the deny rule stopped the write from happening");
  }
}

registerFeatureTests(
  new ADeletionRunsUnprompted(),
  new AProtectedEditRunsUnprompted(),
  new AnEditOutsideTheWorkspaceRunsUnprompted(),
  new ADenyRuleRefusesInsteadOfAsking(),
  new AProtectedDeletionRunsUnprompted(),
  new TheSwitchReachesTheEngineThatDecides(),
);
