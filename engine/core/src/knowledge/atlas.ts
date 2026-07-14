import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Path (relative to the workspace cwd) of the whole-design map the agent maintains. */
export const ATLAS_FILENAME = ".magentra/ATLAS.md";

const MAX_ATLAS_BYTES = 12_288;
const TRUNCATION_NOTICE = "\n[atlas truncated at 12KB — condense it]";

/** Reads the workspace's design atlas, truncating oversized content at a line boundary. */
export function loadAtlas(cwd: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(join(cwd, ATLAS_FILENAME), "utf8");
  } catch {
    return undefined;
  }
  if (!content.trim()) return undefined;

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= MAX_ATLAS_BYTES) return content;

  const buf = Buffer.from(content, "utf8");
  const head = buf.subarray(0, MAX_ATLAS_BYTES).toString("utf8");
  const cut = head.lastIndexOf("\n");
  const truncated = cut >= 0 ? head.slice(0, cut) : head;
  return truncated + TRUNCATION_NOTICE;
}

const CODE_EXTENSIONS = new Set([".ts", ".js", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".cs", ".rb", ".php"]);

const MARKER_FILES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"];

/** Cheap, depth-1 heuristic for "is this workspace worth mapping" — never recurses. */
export function workspaceLooksNonTrivial(cwd: string): boolean {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    let codeFileCount = 0;
    for (const entry of entries) {
      if (entry.isFile()) {
        if (MARKER_FILES.includes(entry.name)) return true;
        if (entry.name.endsWith(".sln")) return true;
        const dot = entry.name.lastIndexOf(".");
        if (dot >= 0 && CODE_EXTENSIONS.has(entry.name.slice(dot))) codeFileCount++;
      } else if (entry.isDirectory() && entry.name === "src") {
        return true;
      }
    }
    if (codeFileCount >= 5) return true;
    return false;
  } catch {
    return false;
  }
}

/** Commits of drift past the stamped commit before an existing atlas is auto-rebuilt. */
export const ATLAS_STALE_COMMIT_THRESHOLD = 20;

/**
 * ATLAS BUILD — the shape of it
 *
 * The old build was one explore agent left to discover the codebase from
 * scratch: up to 15 SEQUENTIAL model rounds, each re-sending a context that grew
 * with every file it read. Cost and latency grew faster than linearly, and it
 * blocked the session throughout.
 *
 * The build now runs in three stages:
 *
 *   1. FACTS (no model at all). The import graph and the symbol index already
 *      know the structure — which files exist, what each exports, what imports
 *      what. Deriving that costs nothing, so the agents are never made to
 *      rediscover it by grepping.
 *
 *   2. FAN-OUT (parallel). The orchestrator partitions the workspace into areas
 *      and gives each its own agent, pre-loaded with that area's facts. An agent
 *      only has to answer what the facts cannot: what is this FOR. It replies
 *      with one compact section.
 *
 *   3. SYNTHESIS (one cheap call). The orchestrator writes the opening overview
 *      from the sections and assembles the document.
 *
 * The agents run concurrently, so wall-clock is roughly one agent's run rather
 * than the sum of fifteen rounds.
 */

/** Hard ceiling on the fan-out. The orchestrator picks the real number from the repo's shape. */
export const ATLAS_MAX_AGENTS = 10;

/**
 * How many area agents run at once.
 *
 * Kept well below the session's subagent cap, and deliberately modest: the build
 * is a BACKGROUND job, so it shares the API with whatever the user is doing at
 * the same time. Fan out too wide and their next message simply queues behind
 * the map — which reads, from the outside, exactly like the app hanging.
 * Parallelism is the point, but not at the cost of the foreground.
 */
export const ATLAS_FANOUT_CONCURRENCY = 3;

/**
 * Tool rounds one area agent may spend. Far below the old single-agent budget of
 * 15: an area is small, and its structure arrives as facts, so the agent reads a
 * handful of files to learn intent and then writes. A cap it hits is not fatal —
 * whatever it returned is still used.
 */
export const ATLAS_AREA_MAX_ITERATIONS = 5;

/** Chars one area section may contribute. Ten of these must fit the 12KB budget. */
export const ATLAS_SECTION_MAX_CHARS = 900;

/** A slice of the workspace handed to one agent. */
export interface AtlasArea {
  /** Human name, and the section heading: e.g. "engine/core". */
  name: string;
  /** Files in this area (workspace-relative, posix), most important first. */
  files: string[];
}

/** The role for an area agent: the reply IS the deliverable, and it must stay small. */
export const ATLAS_AREA_ROLE =
  "You are a codebase cartographer mapping ONE area of a project. You are read-only: you have no Write or Edit tool and must never attempt one — the harness captures your reply text itself, so replying IS delivering. You are given the area's structure as established facts; do not re-derive them. Read source only to learn what the code is FOR. Answer with one compact Markdown section and nothing else.";

/**
 * The task for one area agent. The facts block carries everything the import
 * graph and symbol index already know, so the agent spends its rounds on intent
 * rather than on rediscovering structure.
 */
export function atlasAreaPrompt(area: AtlasArea, facts: string): string {
  return `Map the area **${area.name}** of this codebase.

These facts are already established — trust them, do not verify them:

${facts}

Read a few of the listed files (Read/Grep) only to answer what the facts cannot: what this area is FOR, what its responsibility is, and where its boundary lies.

Reply with EXACTLY one Markdown section and nothing else — no preamble, no closing remarks:

## ${area.name}
<one or two sentences: what this area is for, and its responsibility>
- **Entry points:** <the file(s) a reader should open first, and why>
- **Key pieces:** <2-4 bullets, each a name and a one-line purpose>
- **Depends on:** <which other areas / external packages, and what for>

Hard limit: ${ATLAS_SECTION_MAX_CHARS} characters. Be dense. Describe responsibilities, not file listings.`;
}

/** The synthesis step: one cheap, tool-free call that opens the document. */
export const ATLAS_OVERVIEW_SYSTEM =
  "You write the opening of a codebase atlas. Given per-area summaries, state what the project IS and how its pieces fit together. Reply with the overview paragraph only — no heading, no bullet list, no preamble.";

export function atlasOverviewPrompt(project: string, sections: string[], stats: string): string {
  return `Project: ${project}
${stats}

Area summaries:

${sections.join("\n\n")}

Write ONE paragraph (3-5 sentences) that a new contributor reads first: what this project is, its architecture in a sentence, and the direction its dependencies flow. No heading, no bullets, no preamble.`;
}

/** Stitches the finished document: title, overview, then one section per area. */
export function assembleAtlas(project: string, overview: string, sections: string[]): string {
  return [`# ${project} — atlas`, "", overview.trim(), "", ...sections.map((s) => s.trim())].join("\n") + "\n";
}

/**
 * Make one agent's reply safe to paste into the document. A weak model wanders:
 * it adds a preamble, wraps the section in a code fence, promotes its heading to
 * `#` (which would fight the atlas title), or ignores the length limit. Repair
 * what is repairable rather than discarding a good section over its packaging.
 */
export function normalizeAtlasSection(reply: string, areaName: string): string {
  let text = reply.trim();

  // Unwrap a ```markdown fence, if the model added one.
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fence?.[1]) text = fence[1].trim();

  // Drop any preamble before the first heading ("Here is the section: ## x").
  const headingAt = text.search(/^#{1,6}\s+\S/m);
  if (headingAt > 0) text = text.slice(headingAt).trim();

  // Force exactly one `## ` heading naming the area: a `#` would rival the atlas
  // title, and a missing heading would break the document's structure.
  const lines = text.split("\n");
  if (lines[0] !== undefined && /^#{1,6}\s+/.test(lines[0])) lines[0] = `## ${areaName}`;
  else lines.unshift(`## ${areaName}`);
  text = lines.join("\n").trim();

  if (text.length > ATLAS_SECTION_MAX_CHARS) {
    const cut = text.lastIndexOf("\n", ATLAS_SECTION_MAX_CHARS);
    text = (cut > 0 ? text.slice(0, cut) : text.slice(0, ATLAS_SECTION_MAX_CHARS)).trimEnd();
  }
  return text;
}

/**
 * True when `text` structurally resembles the atlas the build assembles:
 * it opens with a single `# ` H1 heading and carries a real module map. This
 * product targets weak LLMs whose `explore` subagent can return a refusal, an
 * apology, or a one-line ramble instead of an atlas; this substance bar keeps
 * such garbage out of ATLAS.md (and off every future system prompt). Pure.
 *
 * Bar (derived from the prompt: an opening H1 + one-paragraph overview + module
 * map): the first non-blank line is an H1, plus either >= 2 `## ` module
 * sections or >= 10 non-blank lines. An apology/one-liner/refusal meets neither.
 */
export function looksLikeAtlas(text: string): boolean {
  const lines = text.split("\n");
  const firstNonBlank = lines.find((l) => l.trim().length > 0)?.trim();
  // Must open with an H1 (`# heading`) — not `##`, not prose, not an apology.
  if (firstNonBlank === undefined || !/^#\s+\S/.test(firstNonBlank)) return false;
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  const sections = nonBlank.filter((l) => /^##\s+\S/.test(l.trim())).length;
  return sections >= 2 || nonBlank.length >= 10;
}

/** Reads ATLAS.md untruncated (unlike loadAtlas), or undefined when missing/empty; used for staleness. */
export function readAtlasRaw(cwd: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(join(cwd, ATLAS_FILENAME), "utf8");
  } catch {
    return undefined;
  }
  return content.trim() ? content : undefined;
}

/** SHA-256 (hex) of a string — the hand-edit fingerprint carried in the stamp. */
function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const ATLAS_STAMP_RE = /<!--\s*magentra-atlas\s+commit=(\S+)\s+built=(\S+)(?:\s+sha=(\S+))?\s*-->/;

/**
 * Parses the freshness stamp the engine appends when it builds the atlas. `sha`
 * (the fingerprint of the content above the stamp) is present only in the
 * current format; old machine-written stamps lack it and leave it undefined.
 */
export function parseAtlasStamp(content: string): { commit: string; built: string; sha?: string } | undefined {
  const m = ATLAS_STAMP_RE.exec(content);
  if (!m) return undefined;
  return { commit: m[1]!, built: m[2]!, ...(m[3] !== undefined ? { sha: m[3] } : {}) };
}

/**
 * The HTML-comment freshness stamp line recording the build commit, ISO time,
 * and a SHA-256 fingerprint of the atlas body it was written for (used to detect
 * later hand edits). Single source of truth for the stamp format.
 */
export function atlasStampLine(commit: string | undefined, built: string, sha: string): string {
  return `<!-- magentra-atlas commit=${commit ?? "none"} built=${built} sha=${sha} -->`;
}

/** The atlas body (everything above the stamp) whose hash the stamp fingerprints. */
function atlasBody(content: string): string {
  return `${content.trimEnd()}\n\n`;
}

/** Writes atlas content plus a freshness stamp (commit + build time + body hash), creating .magentra/. */
export function writeAtlas(cwd: string, content: string, commit: string | undefined): void {
  const path = join(cwd, ATLAS_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  const body = atlasBody(content);
  const stamp = atlasStampLine(commit, new Date().toISOString(), sha256(body));
  writeFileSync(path, `${body}${stamp}\n`, "utf8");
}

/**
 * True when the on-disk atlas body no longer matches the SHA-256 in its stamp —
 * i.e. a human edited the file after the engine wrote it. Old-format stamps
 * carry no sha and are treated as machine-owned (never hand-edited), so a legacy
 * atlas is still eligible for auto-rebuild. Pure.
 */
export function atlasWasHandEdited(content: string): boolean {
  const m = ATLAS_STAMP_RE.exec(content);
  if (!m || m[3] === undefined) return false;
  return sha256(content.slice(0, m.index)) !== m[3];
}

/**
 * Decides whether an existing atlas has drifted enough to auto-rebuild.
 * `countCommitsSince` returns the commits between the stamped commit and HEAD,
 * or undefined when the commit is unknown (rebased/GC'd) or the workspace is not
 * a git repo. Pure and injectable so the policy is unit-testable without git:
 *  - no stamp, or a non-git build ("none") → not stale (the model maintains it)
 *  - unknown commit → stale (rebuild)
 *  - >= ATLAS_STALE_COMMIT_THRESHOLD commits of drift → stale
 */
export function atlasIsStale(
  content: string,
  countCommitsSince: (commit: string) => number | undefined,
): boolean {
  const stamp = parseAtlasStamp(content);
  if (!stamp || stamp.commit === "none") return false;
  const count = countCommitsSince(stamp.commit);
  if (count === undefined) return true;
  return count >= ATLAS_STALE_COMMIT_THRESHOLD;
}

/** HEAD commit hash, or undefined when cwd is not a git repo. */
export function gitHead(cwd: string): string | undefined {
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

/** Commits from `commit` (exclusive) to HEAD, or undefined if the ref is unknown / not a repo. */
export function gitCommitsSince(cwd: string, commit: string): number | undefined {
  const out = runGit(cwd, ["rev-list", `${commit}..HEAD`, "--count"]);
  if (out === undefined) return undefined;
  const n = Number(out);
  return Number.isInteger(n) ? n : undefined;
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}
