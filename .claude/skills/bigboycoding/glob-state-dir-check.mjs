#!/usr/bin/env node
// Glob must not spend the user's context on MAGENTRA's own state directory.
//
// `.magentra/` holds session transcripts and, when worktrees are in use, entire
// second checkouts of the repository. `dot: false` hides it from an ordinary
// search, so the regression is invisible until something passes `dot: true` —
// which the agent does routinely, to find `.github`, `.claude` and friends.
// This drives the real tool against a real temp tree so the exclusion is
// checked as behaviour, not as a string in an array.
//
//   npm run build && node .claude/skills/bigboycoding/glob-state-dir-check.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../../../engine/tools/dist/glob.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const root = mkdtempSync(join(tmpdir(), "magentra-glob-"));
const write = (rel, body = "x") => {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  return abs;
};

// A workspace shaped like a real one: source, the state dir with a transcript
// and a worktree checkout, plus the near-miss names that must NOT be excluded.
write("src/app.ts");
write("src/util.ts");
write(".github/workflows/ci.yml");
write(".magentra/sessions/s_1.jsonl");
write(".magentra/worktrees/feature/src/app.ts");
write(".magentra/settings.json");
write(".magentra-backup/old.ts"); // near miss: different directory
write("docs/magentra-notes.ts"); // near miss: word in a filename

async function glob(pattern, opts = {}) {
  const res = await globTool.execute({ pattern, ...opts }, { cwd: root, session: {} }, undefined);
  if (res.content === "No files match the pattern.") return [];
  return res.content.split("\n").filter((line) => line && !line.startsWith("[truncated"));
}

const hasState = (files) => files.some((f) => /[\\/]\.magentra[\\/]/.test(f));

console.log("\nGlob — the .magentra state directory\n");
{
  // The regression this exists for: dot:true used to drag the whole state dir in.
  const all = await glob("**/*.ts", { dot: true });
  check("dot:true — state dir excluded", hasState(all), false);
  check("dot:true — worktree checkout excluded", all.some((f) => f.includes("worktrees")), false);
  check("dot:true — ordinary source still found", all.some((f) => f.endsWith("app.ts")), true);
  // Near misses must survive: the exclusion is a path SEGMENT, not a substring.
  check("dot:true — .magentra-backup/ NOT excluded", all.some((f) => f.includes(".magentra-backup")), true);
  check("dot:true — magentra-notes.ts NOT excluded", all.some((f) => f.includes("magentra-notes")), true);
  // Other dot-dirs are unaffected — only the state dir is special.
  const yml = await glob("**/*.yml", { dot: true });
  check("dot:true — .github still found", yml.some((f) => f.includes(".github")), true);
}
{
  const all = await glob("**/*.ts");
  check("dot:false — state dir excluded", hasState(all), false);
  check("dot:false — ordinary source still found", all.some((f) => f.endsWith("app.ts")), true);
}
{
  // Explicitly naming it is a deliberate request and must still work, both via
  // the pattern and via the search root.
  const byPattern = await glob(".magentra/**/*.jsonl", { dot: true });
  check("pattern names it — transcripts found", byPattern.some((f) => f.endsWith("s_1.jsonl")), true);
  const nested = await glob("**/.magentra/**/*.json", { dot: true });
  check("nested pattern names it — settings found", nested.some((f) => f.endsWith("settings.json")), true);
  const byPath = await glob("**/*.json", { dot: true, path: join(root, ".magentra") });
  check("path names it — settings found", byPath.some((f) => f.endsWith("settings.json")), true);
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "state dir is excluded unless asked for" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
