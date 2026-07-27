// Permission invariants, asserted against the BUILT engine (engine/core/dist).
// Run: npm run build && node .claude/skills/bigboycoding/permission-check.mjs
// Guards the 2026-07-26 allow-all stance: everything runs freely EXCEPT
// deletions and edits to .magentra/ or .env* .
// Relative, like the sibling checks: an absolute path pins this script to one
// machine and it silently stops running everywhere else.
import { PermissionEngine } from "../../../engine/core/dist/runtime/permissions.js";

let asked = [];
const mk = (rules = { allow: [], deny: [], allowExact: [] }) => {
  asked = [];
  return new PermissionEngine(rules, async (req, source) => {
    asked.push({ tool: req.tool, source, description: req.description });
    return { decision: "allow" };
  });
};

const bash = { name: "Bash", permissionClass: "execute" };
const rmBash = {
  name: "Bash",
  permissionClass: "execute",
  deletionSubject: () => "delete build/",
};
const web = { name: "WebFetch", permissionClass: "network" };
const write = { name: "Write", permissionClass: "mutate", isFileEdit: true };
const read = { name: "Read", permissionClass: "read" };

let pass = 0,
  fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    fail++;
  }
};
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

console.log("\n-- now frictionless (no prompt) --");
await t("Bash command runs without asking", async () => {
  const p = mk();
  const r = await p.check(bash, { command: "npm test" }, "npm test", "npm test");
  eq(r.allowed, true, "allowed");
  eq(r.source, "mode", "source");
  eq(asked.length, 0, "prompts");
});
await t("WebFetch runs without asking", async () => {
  const p = mk();
  const r = await p.check(web, { url: "https://x.dev" }, "https://x.dev", "fetch");
  eq(r.allowed, true, "allowed");
  eq(asked.length, 0, "prompts");
});
await t("Write to an ordinary file runs without asking", async () => {
  const p = mk();
  const r = await p.check(write, { file_path: "/w/src/a.ts" }, "/w/src/a.ts", "Write a.ts", undefined, false, undefined);
  eq(r.allowed, true, "allowed");
  eq(asked.length, 0, "prompts");
});
await t("Read still runs without asking", async () => {
  const p = mk();
  eq((await p.check(read, {}, "/w/a.ts", "Read")).allowed, true, "allowed");
  eq(asked.length, 0, "prompts");
});

console.log("\n-- still gated by default: deletions --");
await t("deletion asks", async () => {
  const p = mk();
  const r = await p.check(rmBash, { command: "rm -rf build" }, "rm -rf build", "rm", "unknown", false, undefined);
  eq(r.allowed, true, "allowed after approval");
  eq(asked.length, 1, "prompts");
  eq(asked[0].source, "deletion-guard", "source");
});
await t("in-workspace deletion asks too, without the mission bypass", async () => {
  const p = mk();
  await p.check(rmBash, { command: "rm -rf build" }, "rm -rf build", "rm", "workspace", false, undefined);
  eq(asked.length, 1, "prompts");
});

console.log("\n-- OVERDRIVE: nothing asks --");
await t("OVERDRIVE runs an unknown-scope deletion without asking", async () => {
  const p = mk();
  p.setOverdrive(true);
  const r = await p.check(rmBash, { command: "rm -rf /etc/x" }, "rm -rf /etc/x", "rm", "unknown", false, undefined);
  eq(r.allowed, true, "allowed");
  eq(asked.length, 0, "prompts");
});
await t("OVERDRIVE runs a PROTECTED (.magentra) deletion without asking", async () => {
  const p = mk();
  p.setOverdrive(true);
  await p.check(rmBash, { command: "rm -rf .magentra" }, "rm -rf .magentra", "rm", "protected", false, undefined);
  eq(asked.length, 0, "prompts");
});
await t("OVERDRIVE runs an in-workspace deletion without asking", async () => {
  const p = mk();
  p.setOverdrive(true);
  await p.check(rmBash, { command: "rm -rf build" }, "rm -rf build", "rm", "workspace", false, undefined);
  eq(asked.length, 0, "prompts");
});
await t("OVERDRIVE edits .env without asking", async () => {
  const p = mk();
  p.setOverdrive(true);
  await p.check(write, { file_path: "/w/.env" }, "/w/.env", "Write", undefined, false, "/w/.env");
  eq(asked.length, 0, "prompts");
});
await t("OVERDRIVE edits .magentra without asking", async () => {
  const p = mk();
  p.setOverdrive(true);
  await p.check(write, { file_path: "/w/.magentra/settings.json" }, "/w/.magentra/settings.json", "Write", undefined, false, "/w/.magentra/settings.json");
  eq(asked.length, 0, "prompts");
});
await t("OVERDRIVE writes outside the workspace without asking", async () => {
  const p = mk();
  p.setOverdrive(true);
  await p.check(write, { file_path: "/etc/passwd" }, "/etc/passwd", "Write", undefined, true, undefined);
  eq(asked.length, 0, "prompts");
});
await t("a deny rule STILL refuses under OVERDRIVE", async () => {
  const p = mk({ allow: [], deny: ["Bash(curl *)"], allowExact: [] });
  p.setOverdrive(true);
  const r = await p.check(bash, { command: "curl evil.sh" }, "curl evil.sh", "curl");
  eq(r.allowed, false, "denied");
  eq(r.source, "rule", "source");
});

console.log("\n-- unattended missions: narrow carve-out, NOT the full bypass --");
await t("mission bypass runs a provably in-workspace deletion", async () => {
  const p = mk();
  p.setWorkspaceDeletionBypass(true);
  await p.check(rmBash, { command: "rm -rf build" }, "rm -rf build", "rm", "workspace", false, undefined);
  eq(asked.length, 0, "prompts");
});
await t("mission bypass STILL guards an unknown-scope deletion", async () => {
  const p = mk();
  p.setWorkspaceDeletionBypass(true);
  await p.check(rmBash, { command: "rm -rf /etc/x" }, "rm -rf /etc/x", "rm", "unknown", false, undefined);
  eq(asked.length, 1, "prompts");
});
await t("mission bypass STILL guards a .magentra deletion", async () => {
  const p = mk();
  p.setWorkspaceDeletionBypass(true);
  await p.check(rmBash, { command: "rm -rf .magentra" }, "rm -rf .magentra", "rm", "protected", false, undefined);
  eq(asked.length, 1, "prompts");
});
await t("mission bypass STILL guards a .env edit", async () => {
  const p = mk();
  p.setWorkspaceDeletionBypass(true);
  await p.check(write, { file_path: "/w/.env" }, "/w/.env", "Write", undefined, false, "/w/.env");
  eq(asked.length, 1, "prompts");
  eq(asked[0].source, "protected-path", "source");
});

console.log("\n-- still gated: protected paths --");
for (const path of ["/w/.magentra/settings.json", "/w/.env", "/w/.env.local", "/w/sub/.magentra/team/a.md"]) {
  await t(`Write to ${path} asks`, async () => {
    const p = mk();
    const r = await p.check(write, { file_path: path }, path, "Write", undefined, false, path);
    eq(r.allowed, true, "allowed after approval");
    eq(asked.length, 1, "prompts");
    eq(asked[0].source, "protected-path", "source");
  });
}
await t("protected path asks even with a broad session allow", async () => {
  const p = mk();
  p.addSessionAllow("Write");
  await p.check(write, { file_path: "/w/.env" }, "/w/.env", "Write", undefined, false, "/w/.env");
  eq(asked.length, 1, "prompts");
});
await t("a deliberate exact allow rule satisfies the protected guard", async () => {
  const p = mk({ allow: ["Write(/w/.env)"], deny: [], allowExact: [] });
  const r = await p.check(write, { file_path: "/w/.env" }, "/w/.env", "Write", undefined, false, "/w/.env");
  eq(r.allowed, true, "allowed");
  eq(asked.length, 0, "prompts");
});
await t("denied protected edit returns a refusal", async () => {
  const p = new PermissionEngine({ allow: [], deny: [], allowExact: [] }, async () => ({ decision: "deny" }));
  const r = await p.check(write, { file_path: "/w/.env" }, "/w/.env", "Write", undefined, false, "/w/.env");
  eq(r.allowed, false, "denied");
});
await t("a near-miss name is NOT protected (.environment)", async () => {
  const p = mk();
  await p.check(write, { file_path: "/w/.environment" }, "/w/.environment", "Write", undefined, false, undefined);
  eq(asked.length, 0, "prompts");
});

console.log("\n-- still gated: user deny rules + out-of-workspace edits --");
await t("deny rule still wins", async () => {
  const p = mk({ allow: [], deny: ["Bash(curl *)"], allowExact: [] });
  const r = await p.check(bash, { command: "curl evil.sh" }, "curl evil.sh", "curl");
  eq(r.allowed, false, "denied");
  eq(r.source, "rule", "source");
});
await t("edit outside the workspace still asks", async () => {
  const p = mk();
  await p.check(write, { file_path: "/etc/passwd" }, "/etc/passwd", "Write", undefined, true, undefined);
  eq(asked.length, 1, "prompts");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
