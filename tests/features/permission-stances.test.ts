/**
 * `permission-stances`.
 *
 * Two stances and one fixed resolution order. A call is decided by the deny
 * rules first, then the protected-path guard (`.magentra/**`, `.env*`), then
 * the deletion guard, then the allow rules (settings, session, exact grants),
 * and only then by the stance default — which, since 2026-07-26, is `allow`
 * for EVERY permission class: `stanceDefault()` returns "allow" and consults
 * nothing about the tool. Nothing asks because of what a tool IS; the two
 * things that still ask are shapes of TARGET, and both sit above the stance.
 * OVERDRIVE turns those two off plus the out-of-workspace downgrade; a deny
 * rule is the one thing it does not override, and it refuses rather than asks.
 *
 * `pure` + `fs`, and the record said `pure`. Re-declared 2026-09-20. Items 1–5
 * are `PermissionEngine.check` as a function of its arguments: the approval
 * hop and the persistence hop are constructor callbacks (the `testEndpoint`
 * shape PureTest's header names), so no I/O is involved. The REAL tool
 * definitions are used as inputs — `bashTool`, `writeTool`, `readTool`,
 * `webFetchTool`, `askUserQuestionTool` — so the per-class sweep in item 4 is
 * the shipped tool set and not five hand-written objects. Item 6 is the arm a
 * pure test cannot reach: that the ordering holds through the real Session,
 * which is the only thing that computes `editProtectedPath` and hands it to
 * `check` — a real Engine on a scripted provider, writing real files into a
 * real workspace.
 *
 * The scripted provider is the only double, and nothing asserts on what it
 * returned: item 6 asserts on the `permission_request` events the real
 * PermissionEngine caused and on the files the real Write tool left behind.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { PermissionEngine, type AnyToolDefinition, type ApprovalSource, type ExactGrant, type PermissionRequestPayload } from "@magentra/core";
import type { CoreEvent, PermissionDecision } from "@magentra/protocol";
import { askUserQuestionTool, bashTool, readTool, webFetchTool, writeTool } from "@magentra/tools";

import { strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "permission-stances";

/** Verbatim from the record. */
const INVARIANT = "Resolution order is deny rules > process-kill guard > protected-path guard > deletion guard > allow rules > stance default.";

/** An absolute path on either platform. Nothing here touches the disk — the
 *  guards under test are path arithmetic over strings. */
const WS = resolve("/magentra-stance-probe");

/** One recorded trip to the frontend. */
interface Ask {
  readonly payload: PermissionRequestPayload;
  readonly source: ApprovalSource;
}

interface Probe {
  readonly engine: PermissionEngine;
  /** Every `requestApproval` call, in order. Empty is the assertion that nothing asked. */
  readonly asks: Ask[];
  /** Every `persistExact` call — the "always allow" the engine wanted written. */
  readonly grants: { tool: string; subject: string; prefix: boolean | undefined }[];
}

function probe(opts: { allow?: string[]; deny?: string[]; allowExact?: ExactGrant[]; answer?: PermissionDecision } = {}): Probe {
  const asks: Ask[] = [];
  const grants: Probe["grants"] = [];
  const engine = new PermissionEngine(
    { allow: opts.allow ?? [], deny: opts.deny ?? [], allowExact: opts.allowExact ?? [] },
    async (payload, source) => {
      asks.push({ payload, source });
      return { decision: opts.answer ?? "allow_once" };
    },
    (tool, subject, prefix) => grants.push({ tool, subject, prefix }),
  );
  return { engine, asks, grants };
}

/** A Bash input the real tool's own classifiers accept. */
function bashInput(command: string): { command: string; description: string; run_in_background: boolean } {
  return { command, description: `run ${command}`, run_in_background: false };
}

/** The real Bash classifier's verdict for a command, as the Session computes it.
 *  `strictServices({})` is only a WeakMap key here — anything the tool actually
 *  reached for would throw by name. */
function deletionScopeOf(command: string): "workspace" | "unknown" | "protected" {
  return bashTool.deletionScope!(bashInput(command), { cwd: WS, session: strictServices({}) });
}

abstract class StanceTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class ADenyRuleIsDecidedFirst extends StanceTest {
  readonly id = "a-deny-rule-refuses-before-every-other-branch-including-overdrive";
  readonly whyItExists =
    "a user who wrote `deny: Bash(rm *)` and then turned OVERDRIVE on had the rule silently ignored, because the stance was read before the rules — and a broad `Bash(*)` allow could out-rank the deny for the same reason";

  override async run(t: TestRun): Promise<void> {
    const p = probe({ deny: ["Bash(rm *)"], allow: ["Bash(*)"] });
    p.engine.setOverdrive(true);
    p.engine.addSessionAllow("Bash");

    const subject = "rm -rf x";
    const out = await p.engine.check(bashTool, bashInput(subject), subject, "delete x", deletionScopeOf(subject), false, undefined);

    t.assert.equal(out.allowed, false, "the deny rule refuses even in OVERDRIVE with a broad allow and a session allow");
    t.assert.equal(out.source, "rule", "the refusal is the rule's, not the user's");
    t.assert.deepEqual(p.asks, [], "a deny rule refuses; it never asks");
    t.assert.match(out.message ?? "", /Permission denied by settings rule/, out.message ?? "(no message)");

    // Same engine, a subject the rule does not cover: the deny branch is not a
    // blanket refusal of the tool.
    const allowed = await p.engine.check(bashTool, bashInput("ls -la"), "ls -la", "list", undefined, false, undefined);
    t.assert.equal(allowed.allowed, true, "a command the deny pattern does not match is untouched");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheProtectedPathGuardOutranksAllowRules extends StanceTest {
  readonly id = "a-protected-path-edit-asks-ahead-of-broad-allow-rules";
  readonly whyItExists =
    "a broad `Write` allow rule (or a session allow picked up from one earlier click) let the agent overwrite .env and .magentra/settings.json with no prompt, which is the one edit that cannot be undone from the transcript";

  override async run(t: TestRun): Promise<void> {
    const target = join(WS, ".env");
    const broad = probe({ allow: ["Write", "Write(*)"] });
    broad.engine.addSessionAllow("Write");
    broad.engine.addSessionAllow("Write", target); // a subject-scoped SESSION allow is still not a settings rule

    const out = await broad.engine.check(writeTool, { file_path: target, content: "SECRET=1" }, target, "Write .env", undefined, false, target);

    t.assert.equal(broad.asks.length, 1, "the guard asked exactly once, ahead of three allow rules that all matched");
    t.assert.equal(broad.asks[0]?.source, "protected-path", "and it asked as the protected-path guard, not as the stance");
    t.assert.ok(broad.asks[0]?.payload.description?.includes(`protected path: ${target}`), broad.asks[0]?.payload.description ?? "(no description)");
    t.assert.equal(out.allowed, true);
    t.assert.equal(out.source, "user", "an allowed protected edit is the USER's decision, never the rule's");

    // The one thing that satisfies it above the stance: a deliberate,
    // subject-scoped rule in settings. Resolution then falls through to the
    // allow rules, which is where it is answered.
    const explicit = probe({ allow: [`Write(${target})`] });
    const through = await explicit.engine.check(writeTool, { file_path: target, content: "x" }, target, "Write .env", undefined, false, target);
    t.assert.deepEqual(explicit.asks, [], "an explicit `Write(<path>)` rule is a standing decision about this exact file");
    t.assert.equal(through.source, "rule", "and it is the allow-rule branch, below the guard, that answers");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheDeletionGuardOutranksBroadGrants extends StanceTest {
  readonly id = "the-deletion-guard-outranks-broad-grants-and-yields-only-to-an-explicit-subject-rule";
  readonly whyItExists =
    "one `Bash(*)` in settings — or one 'allow for this session' click on a harmless command — turned every later `rm -rf` into a silent deletion, because the allow rules were consulted before the guard";

  override async run(t: TestRun): Promise<void> {
    const subject = "rm -rf ./tmp/x";
    const scope = deletionScopeOf(subject);
    t.assert.equal(scope, "workspace", "the real classifier resolves this target inside the workspace");

    const broad = probe({ allow: ["Bash(*)", "Bash"] });
    broad.engine.addSessionAllow("Bash");
    const asked = await broad.engine.check(bashTool, bashInput(subject), subject, "delete tmp", scope, false, undefined);
    t.assert.equal(broad.asks.length, 1, "the guard asked despite a wildcard rule, a bare-tool rule and a session allow");
    t.assert.equal(broad.asks[0]?.source, "deletion-guard");
    t.assert.equal(broad.asks[0]?.payload.subject, subject, "an ordinary deletion carries its subject, so a frontend may offer 'always allow'");
    t.assert.equal(asked.source, "user");

    const explicit = probe({ allow: ["Bash(rm -rf ./tmp/*)"] });
    const through = await explicit.engine.check(bashTool, bashInput(subject), subject, "delete tmp", scope, false, undefined);
    t.assert.deepEqual(explicit.asks, [], "an explicit subject-scoped rule is the deliberate standing decision the guard yields to");
    t.assert.equal(through.allowed, true);
    t.assert.equal(through.source, "rule");

    // With the guard switched off (the desktop's "Allow deletions"), the same
    // call resolves through the ordinary path instead.
    const off = probe();
    off.engine.setDeletionGuard(false);
    const unguarded = await off.engine.check(bashTool, bashInput(subject), subject, "delete tmp", scope, false, undefined);
    t.assert.deepEqual(off.asks, [], "the guard is what asks; off, nothing else does");
    t.assert.equal(unguarded.source, "mode", "and the stance default answers it");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class NoGuardMeansTheRuleThenTheStance extends StanceTest {
  readonly id = "with-no-guard-triggered-a-rule-allows-as-rule-and-every-class-falls-through-to-the-allow-stance";
  readonly whyItExists =
    "the stance default used to ask per permission CLASS, so a `mode`-sourced allow and a `rule`-sourced allow were confused for each other and a change to the default silently re-introduced prompts for commands and network calls";

  override async run(t: TestRun): Promise<void> {
    const ruled = probe({ allow: ["Bash(ls *)"] });
    const byRule = await ruled.engine.check(bashTool, bashInput("ls -la"), "ls -la", "list", deletionScopeOf("ls -la"), false, undefined);
    t.assert.deepEqual(ruled.asks, []);
    t.assert.equal(byRule.allowed, true);
    t.assert.equal(byRule.source, "rule", "a matching allow rule answers as the rule, above the stance");

    // The stance default is ALLOW for every class — proved over the shipped
    // tools, one per permission class, with no rule of any kind in play.
    const bare = probe();
    const calls: { tool: AnyToolDefinition; input: unknown; subject: string | undefined }[] = [
      { tool: readTool, input: { file_path: join(WS, "a.ts") }, subject: join(WS, "a.ts") },
      { tool: writeTool, input: { file_path: join(WS, "b.ts"), content: "x" }, subject: join(WS, "b.ts") },
      { tool: bashTool, input: bashInput("ls -la"), subject: "ls -la" },
      { tool: webFetchTool, input: { url: "https://example.invalid", prompt: "p" }, subject: undefined },
      { tool: askUserQuestionTool, input: { questions: [] }, subject: undefined },
    ];
    const classes = new Set<string>();
    for (const call of calls) {
      classes.add(call.tool.permissionClass);
      const out = await bare.engine.check(call.tool, call.input, call.subject, "d", undefined, false, undefined);
      t.assert.equal(out.allowed, true, `${call.tool.name} (${call.tool.permissionClass}) runs without a rule`);
      t.assert.equal(out.source, "mode", `${call.tool.name} is allowed by the stance, not by a rule`);
    }
    t.assert.deepEqual([...classes].sort(), ["execute", "interact", "mutate", "network", "read"], "all five permission classes were covered by real tools");
    t.assert.deepEqual(bare.asks, [], "nothing asked: no deletion, no protected path, no escape from the workspace");
    t.assert.deepEqual(bare.grants, [], "and nothing was persisted, because nothing was approved");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class OverdriveTurnsOffTheTargetGuards extends StanceTest {
  readonly id = "overdrive-turns-off-both-target-guards-and-the-out-of-workspace-downgrade-but-not-deny";
  readonly whyItExists =
    "an unattended OVERDRIVE run stopped on an approval dialog nobody was there to answer, and the turn sat until the user came back — while the opposite mistake, OVERDRIVE ignoring a deny rule, silently ran what the user had forbidden";

  override async run(t: TestRun): Promise<void> {
    const outside = join(resolve("/magentra-elsewhere"), ".bashrc");
    const protectedPath = join(WS, ".magentra", "settings.json");

    // First, the contrast: with OVERDRIVE off, an escape from the workspace is
    // downgraded from the allow stance to an ask.
    const normal = probe();
    const downgraded = await normal.engine.check(writeTool, { file_path: outside, content: "x" }, outside, "Write outside", undefined, true, undefined);
    t.assert.equal(normal.asks.length, 1, "an edit outside the workspace asks in the normal stance");
    t.assert.equal(normal.asks[0]?.source, "ask", "and it asks as the stance, not as a guard");
    t.assert.equal(downgraded.source, "user");

    const p = probe({ deny: ["Bash(rm -rf /)"] });
    p.engine.setOverdrive(true);

    const deletion = await p.engine.check(bashTool, bashInput("rm -rf x"), "rm -rf x", "delete x", deletionScopeOf("rm -rf x"), false, undefined);
    t.assert.equal(deletion.allowed, true, "a deletion runs");
    t.assert.equal(deletion.source, "mode");

    const edit = await p.engine.check(writeTool, { file_path: protectedPath, content: "{}" }, protectedPath, "Write settings", undefined, false, protectedPath);
    t.assert.equal(edit.allowed, true, "an edit to .magentra runs");
    t.assert.equal(edit.source, "mode");

    const escape = await p.engine.check(writeTool, { file_path: outside, content: "x" }, outside, "Write outside", undefined, true, undefined);
    t.assert.equal(escape.allowed, true, "an edit outside the workspace runs");
    t.assert.equal(escape.source, "mode", "the downgrade to 'ask' is off too");

    t.assert.deepEqual(p.asks, [], "nothing asked, literally");

    const denied = await p.engine.check(bashTool, bashInput("rm -rf /"), "rm -rf /", "delete everything", deletionScopeOf("rm -rf /"), false, undefined);
    t.assert.equal(denied.allowed, false, "the deny rule still refuses in OVERDRIVE");
    t.assert.equal(denied.source, "rule");
    t.assert.deepEqual(p.asks, [], "and it refused without asking");
  }
}

/* ---- checklist 2 + 4, through the real Session — fs ------------------- */

class TheOrderHoldsInARealTurn extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-real-turn-writes-without-a-prompt-and-still-stops-for-a-magentra-edit-under-a-broad-allow-rule";
  readonly whyItExists =
    "the ordering is only as real as what the Session passes in: an ordinary Write that started prompting, or a `.magentra` Write that stopped prompting because `fileEditProtectedPath` was no longer computed, would both leave every unit assertion above green";

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-stance-");
    const ordinary = join(workspace, "notes.md");
    const stateFile = join(workspace, ".magentra", "notes.md");

    this.#engine = await startScriptedEngine({
      workspace,
      // A broad allow rule for the whole Write tool: it must answer the
      // ordinary edit and must NOT answer the protected one.
      settings: { permissions: { allow: ["Write"], deny: [], allowExact: [] } },
      permissions: "allow_once",
      turns: [
        {
          toolCalls: [
            { name: "Write", input: { file_path: ordinary, content: "ordinary\n" } },
            { name: "Write", input: { file_path: stateFile, content: "state\n" } },
          ],
        },
        { text: "both written" },
      ],
    });

    const turn = await this.#engine.runTurn("write both files");
    t.assert.deepEqual(turn.errors, [], turn.errors.join(" | "));
    t.assert.equal(turn.toolResults.length, 2, "both Write calls ran");
    for (const result of turn.toolResults) t.assert.equal(result.isError, false, result.resultPreview);

    t.assert.equal(existsSync(ordinary), true, "the ordinary file landed");
    t.assert.equal(existsSync(stateFile), true, "and so did the approved one");

    const requests = turn.events.filter((e): e is Extract<CoreEvent, { type: "permission_request" }> => e.type === "permission_request");
    t.assert.equal(requests.length, 1, `exactly one prompt in the turn, for the .magentra edit — got ${requests.map((r) => String(r.subject)).join(", ") || "none"}`);
    t.assert.equal(requests[0]?.subject, stateFile, "and it is the protected path that asked");
    t.assert.ok(requests[0]?.description?.includes("protected path"), requests[0]?.description ?? "(no description)");
  }
}

registerFeatureTests(
  new ADenyRuleIsDecidedFirst(),
  new TheProtectedPathGuardOutranksAllowRules(),
  new TheDeletionGuardOutranksBroadGrants(),
  new NoGuardMeansTheRuleThenTheStance(),
  new OverdriveTurnsOffTheTargetGuards(),
  new TheOrderHoldsInARealTurn(),
);
