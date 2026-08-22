#!/usr/bin/env node
/**
 * Purpose-built check for the terminal UI's layout core and folder trust.
 *
 * `tui/` has no unit test suite and tsc cannot see either invariant this
 * guards, both of which were real defects:
 *
 *  1. LAYOUT. Committed transcript lines live inside Ink's <Static>, which is
 *     laid out as an absolutely positioned, content-sized box — `flexGrow`
 *     never reaches the right edge there and wrapped continuations do not
 *     align. So tui/src/markdown.ts does the wrapping and the column maths in
 *     cells, and everything below asserts it in cells.
 *
 *  2. NO REFLOW ON COMMIT. The live streaming line and the committed line must
 *     be laid out by the same function at the same width, or a paragraph
 *     visibly re-wraps the instant the model stops talking. That is asserted
 *     directly, because it is the one property a reader actually notices.
 *
 *  3. TRUST. `magentra` runs wherever the shell is. Trust is recorded globally
 *     and inherited by subfolders, and a prefix that is not a path SEGMENT
 *     must never match — `/home/me/work` must not trust `/home/me/workspace`.
 *
 * Run:  npm run build && node .claude/skills/bigboycoding/tui-layout-check.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

// trust.js resolves ~ at call time, so the sandbox must be in place BEFORE it
// is imported — otherwise this check writes into the real profile store.
const sandbox = mkdtempSync(join(tmpdir(), "magentra-tui-check-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

// Resolved against the REPO ROOT, like the other checks here — they are all
// documented as `npm run build && node .claude/skills/bigboycoding/<x>.mjs`.
const DIST = join(process.cwd(), "tui", "dist");
let md, trust;
try {
  md = await import(pathToFileURL(join(DIST, "markdown.js")).href);
  trust = await import(pathToFileURL(join(DIST, "trust.js")).href);
} catch (err) {
  console.error("!! tui is not compiled — run `npm run build` first\n  ", err.message);
  process.exit(2);
}

md.configureMarks({ code: "#code", link: "#link", muted: "#muted" });

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
  } else {
    failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
  }
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const STYLE = { prose: "#prose", muted: "#muted", marker: "#marker", rail: "#rail", code: "#code" };
const rowWidth = (row) =>
  md.displayWidth(row.prefix) + row.spans.reduce((n, s) => n + md.displayWidth(s.text), 0);
const rowText = (row) => row.prefix + row.spans.map((s) => s.text).join("");

// ── display width ──────────────────────────────────────────────────────────
eq("displayWidth: ascii", md.displayWidth("hello"), 5);
eq("displayWidth: CJK counts two cells", md.displayWidth("漢字"), 4);
eq("displayWidth: emoji counts two cells", md.displayWidth("🚀"), 2);
eq("displayWidth: variation selector is free", md.displayWidth("❤️"), 1);
eq("displayWidth: turkish letters count one", md.displayWidth("şğüöçı"), 6);

// ── padding and truncation ─────────────────────────────────────────────────
eq("pad: fills to width", md.displayWidth(md.pad("ab", 6)), 6);
eq("pad: never truncates", md.pad("abcdefgh", 4), "abcdefgh");
ok("truncate: fits the budget", md.displayWidth(md.truncate("a".repeat(50), 10)) <= 10);
eq("truncate: marks the cut", md.truncate("abcdefghij", 5).endsWith("…"), true);
eq("truncate: leaves short text alone", md.truncate("abc", 10), "abc");
{
  const cut = md.truncateStart("engine/core/src/runtime/session.ts", 20);
  eq("truncateStart: keeps the filename", cut.endsWith("session.ts"), true);
  eq("truncateStart: drops the root, marking the cut", cut.startsWith("…"), true);
  eq("truncateStart: lands exactly on the budget", md.displayWidth(cut), 20);
}
ok(
  "truncateStart: fits the budget",
  md.displayWidth(md.truncateStart("a/".repeat(40) + "file.ts", 18)) <= 18,
);

// ── wrapping ───────────────────────────────────────────────────────────────
{
  const spans = [{ text: "the quick brown fox jumps over the lazy dog", color: "#prose" }];
  const rows = md.wrapSpans(spans, 12);
  ok(
    "wrapSpans: no row exceeds the width",
    rows.every((r) => r.reduce((n, s) => n + md.displayWidth(s.text), 0) <= 12),
    JSON.stringify(rows.map((r) => r.map((s) => s.text).join(""))),
  );
  eq(
    "wrapSpans: loses no words",
    rows
      .map((r) => r.map((s) => s.text).join(""))
      .join(" ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" "),
    "the quick brown fox jumps over the lazy dog",
  );
}
{
  const rows = md.wrapSpans([{ text: "x".repeat(30), color: "#prose" }], 10);
  ok("wrapSpans: hard-splits a word longer than the line", rows.length === 3);
  ok(
    "wrapSpans: hard split still respects the width",
    rows.every((r) => r.reduce((n, s) => n + md.displayWidth(s.text), 0) <= 10),
  );
}
{
  // A bold phrase straddling a row boundary must stay bold on BOTH rows —
  // that is the whole reason inline marks are tokenised before wrapping.
  const spans = md.inlineSpans("plain **a very emphatic phrase here** tail", { color: "#prose" });
  const rows = md.wrapSpans(spans, 14);
  const boldRows = rows.filter((r) => r.some((s) => s.bold));
  ok("wrapSpans: a bold run survives a row break", boldRows.length >= 2, JSON.stringify(rows));
  ok(
    "wrapSpans: no asterisks leak into the output",
    !rows.some((r) => r.some((s) => s.text.includes("*"))),
  );
}

// ── inline marks ───────────────────────────────────────────────────────────
{
  const spans = md.inlineSpans("use `parseHeader` and [docs](http://x/y)", { color: "#prose" });
  const joined = spans.map((s) => s.text).join("");
  ok("inlineSpans: backticks are consumed", !joined.includes("`"));
  ok("inlineSpans: code takes the code colour", spans.some((s) => s.color === "#code" && s.text === "parseHeader"));
  ok("inlineSpans: link text is underlined", spans.some((s) => s.underline && s.text === "docs"));
  ok("inlineSpans: the url stays visible", joined.includes("http://x/y"));
}

// ── block shapes and the hanging indent ────────────────────────────────────
{
  const long = "a bullet item long enough that it certainly has to wrap more than once here";
  const rows = md.layoutLine(`- ${long}`, 40, "  ", STYLE);
  ok("bullet: wraps to several rows", rows.length > 1);
  eq("bullet: first row carries the glyph", rows[0].prefix, "  • ");
  ok(
    "bullet: continuations hang under the TEXT, not the glyph",
    rows.slice(1).every((r) => md.displayWidth(r.prefix) === md.displayWidth(rows[0].prefix)),
    JSON.stringify(rows.map((r) => r.prefix)),
  );
  ok("bullet: every row fits the width", rows.every((r) => rowWidth(r) <= 40));
}
{
  const rows = md.layoutLine("> a quoted aside that is quite long and must wrap at least once", 30, "  ", STYLE);
  ok("quote: every row keeps the bar", rows.every((r) => r.prefix.includes("│")), JSON.stringify(rows.map((r) => r.prefix)));
  ok("quote: every row fits the width", rows.every((r) => rowWidth(r) <= 30));
}
{
  const rows = md.layoutLine("## A heading", 40, "◆ ", STYLE);
  eq("heading: strips its hashes", rowText(rows[0]), "◆ A heading");
  ok("heading: is bold", rows[0].spans.every((s) => s.bold));
}
{
  const rows = md.layoutLine("1. numbered item", 40, "  ", STYLE);
  eq("numbered: keeps its own number", rows[0].prefix, "  1. ");
}
{
  const rows = md.layoutLine("---", 40, "  ", STYLE);
  eq("rule: renders as one row", rows.length, 1);
  eq("rule: fills the width exactly", rowWidth(rows[0]), 40);
}
{
  const rows = md.layoutLine("const x = 1; // " + "y".repeat(80), 40, "  ", STYLE, true);
  ok("code: every row carries the gutter", rows.every((r) => r.prefix.includes("│")));
  ok("code: every row fits the width", rows.every((r) => rowWidth(r) <= 40));
  ok(
    "code: is never inline-parsed",
    md.layoutLine("a *b* `c` **d**", 40, "  ", STYLE, true)[0].spans.map((s) => s.text).join("") ===
      "a *b* `c` **d**",
  );
}
{
  // Plain prose under the ◆ marker: continuation rows align under the text.
  const rows = md.layoutLine("x".repeat(10) + " " + "y".repeat(60), 30, "◆ ", STYLE);
  eq("prose: first row carries the marker", rows[0].prefix, "◆ ");
  ok(
    "prose: continuations align under the marker's text column",
    rows.slice(1).every((r) => r.prefix === "  "),
    JSON.stringify(rows.map((r) => r.prefix)),
  );
}

// ── the no-reflow guarantee ────────────────────────────────────────────────
{
  // LiveLine and TranscriptLine call layoutLine with the same arguments; if
  // they ever diverge, a finished paragraph visibly re-wraps on commit.
  const text =
    "The bug is in `parseHeader` — the loop runs one index past the end of the buffer, so the request is rejected.";
  for (const width of [40, 60, 80, 100, 132]) {
    const live = md.layoutLine(text, width, "◆ ", STYLE);
    const committed = md.layoutLine(text, width, "◆ ", STYLE);
    eq(`no reflow at width ${width}`, JSON.stringify(live), JSON.stringify(committed));
    ok(`no row overflows at width ${width}`, live.every((r) => rowWidth(r) <= width));
  }
}
{
  // Degenerate widths must still terminate and still produce something.
  for (const width of [1, 2, 3, 8]) {
    const rows = md.layoutLine("some ordinary words here", width, "◆ ", STYLE);
    ok(`width ${width}: still produces rows`, rows.length > 0);
  }
}

// ── folder trust ───────────────────────────────────────────────────────────
{
  const root = join(sandbox, "projects", "alpha");
  const child = join(root, "src", "deep");
  const sibling = join(sandbox, "projects", "alpha-other");

  ok("trust: nothing is trusted before anything is recorded", !trust.isTrusted(root));
  trust.trustFolder(root);
  ok("trust: the recorded folder is trusted", trust.isTrusted(root));
  ok("trust: a subfolder inherits trust", trust.isTrusted(child));
  ok(
    "trust: a sibling sharing a name PREFIX is NOT trusted",
    !trust.isTrusted(sibling),
    `${sibling} must not inherit from ${root}`,
  );
  ok("trust: an unrelated folder is not trusted", !trust.isTrusted(join(sandbox, "elsewhere")));
  ok("trust: a trailing separator is not meaningful", trust.isTrusted(root + sep));
  if (process.platform === "win32") {
    ok("trust: windows paths compare case-insensitively", trust.isTrusted(root.toUpperCase()));
  }
}

rmSync(sandbox, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:\n`);
  for (const f of failures) console.error("  ✗ " + f);
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`tui-layout-check: ${passed} assertions passed`);
