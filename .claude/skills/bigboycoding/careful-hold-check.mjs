#!/usr/bin/env node
// CAREFUL MODE hold invariants, asserted against the BUILT engine.
//
// `npm run build` proves these types line up. It proves nothing about whether
// the hold actually refuses anything — and the hold IS the feature: without it,
// CAREFUL MODE is a polite request that a model in OVERDRIVE is free to ignore
// while it edits the user's repository. engine/* has no unit suite, so this
// stands in for one.
//
//   npm run build && node .claude/skills/bigboycoding/careful-hold-check.mjs

import { PermissionEngine } from "../../../engine/core/dist/runtime/permissions.js";
import {
  SCOUT_TOOLS,
  classifyCarefulAnswer,
  parseCarefulVerdict,
  CAREFUL_APPROVE_LABEL,
  CAREFUL_CANCEL_LABEL,
} from "../../../engine/core/dist/runtime/careful.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const tool = (name, permissionClass) => ({
  name,
  permissionClass,
  ...(permissionClass === "mutate" ? { isFileEdit: true } : {}),
});

/** A PermissionEngine whose approval callback throws — nothing in a scout phase
 *  may ever reach a user prompt, so a call that asks is itself a failure. */
function freshEngine(rules = { allow: [], deny: [] }) {
  return new PermissionEngine(rules, async () => {
    throw new Error("the hold must never ask the user — it refuses outright");
  });
}

const allow = async (engine, t, subject) =>
  (await engine.check(t, {}, subject, undefined)).allowed;

console.log("\nCAREFUL MODE — hold invariants\n");

// ── The hold refuses everything outside the scout allowlist ──────────────────
{
  const engine = freshEngine();
  engine.setCarefulHold(true);
  for (const name of ["Write", "Edit"]) {
    check(`held: ${name} refused`, await allow(engine, tool(name, "mutate")), false);
  }
  for (const name of ["Bash", "Monitor", "Workflow", "EnterWorktree"]) {
    check(`held: ${name} refused`, await allow(engine, tool(name, "execute")), false);
  }
  for (const name of ["WebFetch", "WebSearch"]) {
    check(`held: ${name} refused`, await allow(engine, tool(name, "network")), false);
  }
  // Class "read" is NOT the allowlist: these spawn children or record state.
  for (const name of ["Agent", "CrewRun", "TaskCreate", "AskUserQuestion"]) {
    check(`held: ${name} refused (not a scout tool)`, await allow(engine, tool(name, "read")), false);
  }
  for (const name of SCOUT_TOOLS) {
    check(`held: ${name} allowed`, await allow(engine, tool(name, "read")), true);
  }
}

// ── The hold outranks every grant that would otherwise open the tool ─────────
{
  const engine = freshEngine({ allow: ["Bash", "Write(*)", "Edit(src/a.ts)"], deny: [] });
  engine.setCarefulHold(true);
  check("held: a bare allow rule does not open Bash", await allow(engine, tool("Bash", "execute"), "ls"), false);
  check("held: a wildcard allow rule does not open Write", await allow(engine, tool("Write", "mutate"), "x.ts"), false);
  check(
    "held: an exact allow rule does not open Edit",
    await allow(engine, tool("Edit", "mutate"), "src/a.ts"),
    false,
  );
  engine.addSessionAllow("Bash", "*");
  check("held: a session allow does not open Bash", await allow(engine, tool("Bash", "execute"), "ls"), false);
}

// ── OVERDRIVE does not lift the hold. This is the whole point of the mode. ───
{
  const engine = freshEngine();
  engine.setOverdrive(true);
  engine.setCarefulHold(true);
  check("held + OVERDRIVE: Write still refused", await allow(engine, tool("Write", "mutate"), "x.ts"), false);
  check("held + OVERDRIVE: Bash still refused", await allow(engine, tool("Bash", "execute"), "rm -rf /"), false);
  check("held + OVERDRIVE: Read still allowed", await allow(engine, tool("Read", "read"), "x.ts"), true);
}

// ── Lifting restores ordinary behaviour ─────────────────────────────────────
{
  const engine = freshEngine();
  engine.setOverdrive(true);
  engine.setCarefulHold(true);
  check("held: Write refused", await allow(engine, tool("Write", "mutate"), "x.ts"), false);
  engine.setCarefulHold(false);
  check("lifted: Write allowed again", await allow(engine, tool("Write", "mutate"), "x.ts"), true);
  check("lifted: Bash allowed again", await allow(engine, tool("Bash", "execute"), "ls"), true);
  check("lifted: isCarefulHeld() false", engine.isCarefulHeld(), false);
}

// ── A user's own deny rule still outranks the hold (it refuses either way) ───
{
  const engine = freshEngine({ allow: [], deny: ["Read(secret.txt)"] });
  engine.setCarefulHold(true);
  check("held: a deny rule still refuses a scout tool", await allow(engine, tool("Read", "read"), "secret.txt"), false);
}

// ── Unheld engines are untouched by any of this ─────────────────────────────
{
  const engine = freshEngine();
  check("unheld: Write allowed", await allow(engine, tool("Write", "mutate"), "x.ts"), true);
  check("unheld: Bash allowed", await allow(engine, tool("Bash", "execute"), "ls"), true);
  check("unheld: isCarefulHeld() false by default", engine.isCarefulHeld(), false);
}

// ── Approval answers classify correctly ─────────────────────────────────────
console.log("");
check("approve label → approve", classifyCarefulAnswer(CAREFUL_APPROVE_LABEL).kind, "approve");
check("cancel label → cancel", classifyCarefulAnswer(CAREFUL_CANCEL_LABEL).kind, "cancel");
check("free text → revise", classifyCarefulAnswer("use a hook instead").kind, "revise");
check("free text carries through", classifyCarefulAnswer("use a hook instead").text, "use a hook instead");
// An unanswered gate must never read as approval.
check("undefined → cancel", classifyCarefulAnswer(undefined).kind, "cancel");
check("empty string → cancel", classifyCarefulAnswer("   ").kind, "cancel");

// ── Predictor verdicts fail open (false), never closed ──────────────────────
console.log("");
check("verdict true", parseCarefulVerdict('{"careful": true}'), true);
check("verdict true with prose around it", parseCarefulVerdict('Sure!\n{"careful": true}\n'), true);
check("verdict false", parseCarefulVerdict('{"careful": false}'), false);
check("malformed json → false", parseCarefulVerdict("{careful: yes"), false);
check("empty → false", parseCarefulVerdict(""), false);
check("non-object json → false", parseCarefulVerdict("[1,2,3]"), false);
check("wrong type → false", parseCarefulVerdict('{"careful": "true"}'), false);

console.log(`\n${failures === 0 ? "all invariants hold" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
