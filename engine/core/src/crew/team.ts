import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The CREW team system: a workspace defines specialist agents as small markdown
 * files under .magentra/team/. Each file has a hand-parsed YAML-ish frontmatter
 * block (name/role/model/color/emoji/tools/docs) and a body that becomes the
 * agent's role prompt. The main session is always the orchestrator — never a
 * file — so an agent named or id'd "orchestrator" is rejected.
 */

export interface CrewAgent {
  id: string;
  name: string;
  role: string;
  model?: string;
  /**
   * Dedicated inference endpoint (optional trio, all shareable-safe): which API
   * kind this member speaks, its base URL, and the NAME of the env var holding
   * its key. The key itself never lives in a team file. A member without these
   * runs on the session provider (model: alone stays a same-host model swap).
   */
  provider?: "anthropic" | "openai-compatible";
  baseUrl?: string;
  apiKeyEnv?: string;
  color?: string;
  emoji?: string;
  tools?: string[];
  docs: string[];
  rolePrompt: string;
  sourcePath: string;
}

const ID_RE = /^[a-z0-9_-]+$/;

/** Fields parsed out of one team file, before id/sourcePath are attached. */
type ParsedAgent = Omit<CrewAgent, "id" | "sourcePath">;

/** Scans <cwd>/.magentra/team/*.md into crew agents; malformed files are skipped with a warning. */
export function loadTeam(cwd: string): { agents: CrewAgent[]; warnings: string[] } {
  const warnings: string[] = [];
  const agents: CrewAgent[] = [];
  const dir = join(cwd, ".magentra", "team");
  if (!existsSync(dir)) return { agents, warnings };

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const id = file.slice(0, -".md".length);
    if (!ID_RE.test(id)) {
      warnings.push(`team/${file}: id "${id}" must match [a-z0-9_-]`);
      continue;
    }
    if (id === "orchestrator") {
      warnings.push(`team/${file}: "orchestrator" is reserved — the orchestrator is the main session, not a file`);
      continue;
    }
    const sourcePath = join(dir, file);
    let text: string;
    try {
      text = decodeTextFile(readFileSync(sourcePath));
    } catch (err) {
      warnings.push(`team/${file}: ${(err as Error).message}`);
      continue;
    }
    const parsed = parseAgentFile(text);
    if (typeof parsed === "string") {
      warnings.push(`team/${file}: ${parsed}`);
      continue;
    }
    if (parsed.agent.name.toLowerCase() === "orchestrator") {
      warnings.push(`team/${file}: name "orchestrator" is reserved for the main session`);
      continue;
    }
    for (const w of parsed.warnings) warnings.push(`team/${file}: ${w}`);
    agents.push({ id, sourcePath, ...parsed.agent });
  }
  return { agents, warnings };
}

/** Decodes a team file tolerantly: UTF-16 LE/BE via BOM (PowerShell's default
 *  redirection encoding on Windows), otherwise UTF-8 with any BOM stripped. */
function decodeTextFile(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The shared liberal frontmatter scanner: models and humans write YAML-ish
 * frontmatter, so this supports "key: value", "key:" followed by "- item"
 * block lists, quoted values, and tolerates stray unparseable lines. Keys are
 * lowercased. Returns an error message string on a missing/unterminated fence.
 * Reused by the mission loader — keep it schema-free; callers own validation.
 */
export function scanFrontmatter(text: string): { fields: Record<string, string>; body: string } | string {
  const lines = text.replace(/\r/g, "").split("\n");

  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length || lines[i]!.trim() !== "---") {
    return "missing frontmatter (expected a --- fence on the first line)";
  }
  const start = i + 1;
  let end = -1;
  for (let j = start; j < lines.length; j++) {
    if (lines[j]!.trim() === "---") {
      end = j;
      break;
    }
  }
  if (end === -1) return "unterminated frontmatter (missing closing ---)";

  const fields: Record<string, string> = {};
  let currentListKey: string | undefined;
  for (let j = start; j < end; j++) {
    const line = lines[j]!;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (currentListKey && trimmed.startsWith("- ")) {
      const item = unquote(trimmed.slice(2).trim());
      if (item) fields[currentListKey] = fields[currentListKey] ? `${fields[currentListKey]}, ${item}` : item;
      continue;
    }
    currentListKey = undefined;
    const colon = line.indexOf(":");
    if (colon === -1) continue; // stray line — tolerate, do not reject the file
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = unquote(line.slice(colon + 1).trim());
    if (value === "") {
      currentListKey = key; // "docs:" header of a YAML block list
      if (!(key in fields)) fields[key] = "";
    } else {
      fields[key] = value;
    }
  }

  return { fields, body: lines.slice(end + 1).join("\n").trim() };
}

/**
 * Parses one team file into its fields. Returns an error message string on
 * malformed input (the file is skipped), or the agent plus non-fatal warnings
 * (e.g. an unknown provider value — the agent still loads, the bad key is ignored).
 */
function parseAgentFile(text: string): { agent: ParsedAgent; warnings: string[] } | string {
  const scanned = scanFrontmatter(text);
  if (typeof scanned === "string") return scanned;
  const { fields, body } = scanned;

  const name = fields.name;
  const role = fields.role;
  if (!name) return "missing required frontmatter key: name";
  if (!role) return "missing required frontmatter key: role";
  if (!body) return "missing role prompt (body after the frontmatter is empty)";

  const warnings: string[] = [];
  const parsed: ParsedAgent = { name, role, docs: splitList(fields.docs), rolePrompt: body };
  if (fields.model) parsed.model = fields.model;
  if (fields.provider) {
    if (fields.provider === "anthropic" || fields.provider === "openai-compatible") {
      parsed.provider = fields.provider;
    } else {
      warnings.push(`unknown provider "${fields.provider}" (expected anthropic or openai-compatible) — key ignored`);
    }
  }
  const baseUrl = fields.baseurl ?? fields.base_url;
  if (baseUrl) parsed.baseUrl = baseUrl;
  const apiKeyEnv = fields.apikeyenv ?? fields.api_key_env;
  if (apiKeyEnv) parsed.apiKeyEnv = apiKeyEnv;
  if (fields.color) parsed.color = fields.color;
  if (fields.emoji) parsed.emoji = fields.emoji;
  const tools = splitList(fields.tools);
  if (tools.length > 0) parsed.tools = tools;
  return { agent: parsed, warnings };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tools a crew specialist always keeps, on top of any explicit allow-list. */
export const CREW_ALWAYS_ALLOWED = ["Read", "Grep", "Glob", "TaskGet", "TaskList", "BackpackSearch"];

/**
 * The single source of truth for the team-file format, derived from what
 * {@link parseAgentFile} actually accepts. Both the orchestrator's crew section
 * ({@link crewSection}) and the /build-crew subagent prompt ({@link buildCrewPrompt})
 * embed this verbatim, so the format the model is told and the format the loader
 * parses can never drift. Concrete and few-shot on purpose: the product targets
 * weak (26B-class) models. Keep it in step with parseAgentFile above if you change it.
 */
export const TEAM_FILE_FORMAT = `Each specialist is ONE markdown file at .magentra/team/<id>.md. The file name without the .md is the agent id: lowercase letters, digits, hyphen or underscore only (e.g. reviewer.md, test-runner.md). The id "orchestrator" is reserved — never use it.

The file is EXACTLY: a "---" fence alone on the first line, then "key: value" frontmatter lines, then a closing "---" fence alone on its own line, then the role prompt as the plain markdown body. Do NOT wrap the file in code fences or backticks.

Frontmatter keys:
- name  (REQUIRED) — the specialist's display name, e.g. Argus.
- role  (REQUIRED) — a short role title, e.g. Code Reviewer.
- model (optional) — a model id to run this specialist on; omit it to use the session's default model.
- provider (optional) — "openai-compatible" (the default) or "anthropic": which API kind this specialist's own endpoint speaks. Only needed together with a dedicated endpoint.
- baseurl (optional) — a dedicated OpenAI-compatible endpoint URL for this specialist (e.g. http://localhost:11434/v1 for a local Ollama, or another hosted /v1 API). Omit it to use the session's endpoint. With baseurl set, also set model to a model that endpoint actually serves.
- apikeyenv (optional) — the NAME of the environment variable holding the API key for this specialist's endpoint (e.g. MY_OPENROUTER_KEY). Never write an actual API key into a team file — team files are shareable; keys stay in the environment or .env.
- emoji (optional) — a single emoji shown next to the agent in the UI.
- color (optional) — a color name (e.g. blue, green) for the UI.
- tools (optional) — a comma-separated list of tool names this specialist may use; omit it to grant the standard toolset. Read, Grep, Glob, TaskGet, TaskList and BackpackSearch are always available regardless.
- docs  (optional) — a comma-separated list of workspace-relative file paths to load into this specialist's knowledge backpack.

Body: everything after the closing "---" is the role prompt (REQUIRED — it must not be empty). Write it in the second person ("You are ..."), concise and specific about what the specialist owns and how it reports.

Complete worked example — the file .magentra/team/reviewer.md, written exactly like this:
---
name: Argus
role: Code Reviewer
emoji: 🔍
tools: Read, Grep, Glob, Bash
docs: docs/ARCHITECTURE.md
---
You are Argus, the crew's code reviewer. Given a diff or a set of changed files,
check correctness, error handling, and adherence to the project's conventions.
Report concrete findings as "path:line — problem — suggested fix", most severe
first. Do not rewrite the code yourself; your job is the review.`;

/**
 * The self-contained task handed to the /build-crew general-purpose subagent. It
 * embeds {@link TEAM_FILE_FORMAT} (single source of truth) and the workspace's own
 * valid tool names, so a weak model gets a concrete, format-explicit, few-shot brief.
 */
export function buildCrewPrompt(opts: { toolNames: string[]; atlas?: string }): string {
  const context = opts.atlas
    ? `This workspace already has a design atlas. Treat it as your understanding of the stack and needs — do not re-explore unless something is unclear:

<atlas>
${opts.atlas}
</atlas>`
    : `This workspace has no design atlas yet. First, briefly explore it (read package.json / pyproject.toml / Cargo.toml / go.mod, the src/ layout, and the test setup with Glob/Grep/Read) to learn the stack and what work it needs. Keep exploration short — a handful of reads.`;

  return `You are designing the specialist crew for this workspace. The crew is a small team of subagents the orchestrator routes tasks to. Your job: pick 2 to 4 specialists that fit THIS workspace, then Write one team file for each.

${context}

Pick 2-4 specialists whose roles are DISTINCT and do not overlap, matched to the workspace's actual stack and needs. Good examples for a typical code project: a Code Reviewer, a Test Runner (writes and runs the test suite), a Docs Keeper (keeps README/docs in sync), a Refactorer. Choose the ones that fit; do not invent roles the workspace has no use for.

Write EACH specialist to its own file at .magentra/team/<id>.md with the Write tool, following this EXACT format:

${TEAM_FILE_FORMAT}

Valid tool names for the "tools:" key in THIS workspace: ${opts.toolNames.join(", ")}. Use only names from this list, or omit the "tools:" key entirely to grant the standard toolset.

Rules:
- Create between 2 and 4 files, each a distinct specialist.
- Use a lowercase id as the file name (e.g. reviewer.md, test-runner.md). Never name one "orchestrator".
- Keep each role prompt to a few concrete sentences: what the specialist owns and how it reports.
- Actually Write each file with the Write tool. Do NOT just print the file contents as your answer.
- When done, end with a one-line list of the file paths you created.`;
}

/** The orchestrator's roster + rules section, appended to the main session's system prompt. */
export function crewSection(agents: CrewAgent[]): string {
  const roster = agents
    .map((a) => {
      const oneLine = a.rolePrompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
      return `- ${a.id} — ${a.name}, ${a.role}${oneLine ? `: ${oneLine}` : ""} (${a.docs.length} doc${a.docs.length === 1 ? "" : "s"})`;
    })
    .join("\n");
  return `# Your crew (you are the orchestrator)
You carry no specialist knowledge yourself — the crew does. Route the work; do not try to be every specialist.

Roster:
${roster}

Rules:
- For any team-relevant mission, assign every task an owner from the roster (an id above) via TaskUpdate's owner field.
- Execute an owned task by calling the CrewRun tool with its taskId — that runs the owning specialist on it.
- Dispatch INDEPENDENT owned tasks in parallel: call CrewRun once per task in the same message and the specialists work concurrently. Only dependent tasks (blocked-by) wait their turn.
- Verify each returned result against the task's own acceptance check before marking the task completed. A failed check goes back to the owner (CrewRun again) with the evidence of what fell short.
- A task with no suitable specialist you may own yourself: set its owner to "orchestrator" and do it directly (not via CrewRun).
- You may design and evolve this crew yourself: when the user asks for a crew (or a new specialist), propose the roster in chat first — names, roles, what each owns, suggested backpack documents — and after the user agrees, Write the .magentra/team/<id>.md files. They hot-load. (The /build-crew command bootstraps a whole crew from scratch when none exists.)

Team file format (exact — the loader is strict):
${TEAM_FILE_FORMAT}`;
}
