import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanFrontmatter } from "../crew/team.js";

/**
 * The MISSION system: research-lab missions a user sends their agent crew on.
 * A mission is a small markdown file under .magentra/missions/ describing a
 * standing investigation — sweep the web for keywords, research a question,
 * compile a report. Missions are the research-lab layer over the crew:
 * versionable, shareable files that survive sessions. The engine runs them on
 * demand (/mission run) or on a cron schedule (the optional `schedule` key),
 * turning each into a full orchestrator turn via {@link buildMissionPrompt}.
 */

export interface Mission {
  id: string;
  name: string;
  description?: string;
  keywords: string[];
  /** Optional 5-field cron expression. NOT validated here — the engine's cron parser validates when scheduling. */
  schedule?: string;
  /** Optional workspace-relative output path for the final report. */
  deliverable?: string;
  /** Output-token budget per run (orchestrator turn AND each specialist run). */
  budgetTokens?: number;
  /** A standing mission: /mission start loops it — run, cool down, run again. */
  continuous: boolean;
  /** Cooldown between continuous runs, in seconds (engine clamps 60s–1h; default 300). */
  cooldownSeconds?: number;
  /** The markdown body: the mission's full charter text. */
  brief: string;
  sourcePath: string;
}

const ID_RE = /^[a-z0-9_-]+$/;

/** Scans <cwd>/.magentra/missions/*.md into missions; malformed files are skipped with a warning. */
export function loadMissions(cwd: string): { missions: Mission[]; warnings: string[] } {
  const warnings: string[] = [];
  const missions: Mission[] = [];
  const dir = join(cwd, ".magentra", "missions");
  if (!existsSync(dir)) return { missions, warnings };

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const id = file.slice(0, -".md".length);
    if (!ID_RE.test(id)) {
      warnings.push(`missions/${file}: id "${id}" must match [a-z0-9_-]`);
      continue;
    }
    const sourcePath = join(dir, file);
    let text: string;
    try {
      text = decodeTextFile(readFileSync(sourcePath));
    } catch (err) {
      warnings.push(`missions/${file}: ${(err as Error).message}`);
      continue;
    }
    const scanned = scanFrontmatter(text);
    if (typeof scanned === "string") {
      warnings.push(`missions/${file}: ${scanned}`);
      continue;
    }
    const { fields, body } = scanned;
    if (!fields.name) {
      warnings.push(`missions/${file}: missing required frontmatter key: name`);
      continue;
    }
    if (!body) {
      warnings.push(`missions/${file}: missing mission charter (body after the frontmatter is empty)`);
      continue;
    }
    const mission: Mission = {
      id,
      name: fields.name,
      keywords: splitList(fields.keywords),
      continuous: /^(true|yes|1)$/i.test(fields.continuous ?? ""),
      brief: body,
      sourcePath,
    };
    if (fields.description) mission.description = fields.description;
    if (fields.schedule) mission.schedule = fields.schedule;
    if (fields.deliverable) mission.deliverable = fields.deliverable;
    if (fields.mode) {
      // Permission modes were removed (2026-07-20): unattended runs always
      // take the never-ask stance now. Old mission files may still carry it.
      warnings.push(`missions/${file}: the "mode" key is obsolete (unattended runs never ask) — key ignored`);
    }
    if (fields.budget) {
      const budget = Number(fields.budget);
      if (Number.isInteger(budget) && budget > 0) mission.budgetTokens = budget;
      else warnings.push(`missions/${file}: budget "${fields.budget}" is not a positive whole number of tokens — key ignored`);
    }
    if (fields.cooldown) {
      const seconds = parseDurationSeconds(fields.cooldown);
      if (seconds !== undefined) mission.cooldownSeconds = seconds;
      else warnings.push(`missions/${file}: cooldown "${fields.cooldown}" is not a duration (use e.g. 90s, 15m, 1h) — key ignored`);
    }
    missions.push(mission);
  }
  missions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { missions, warnings };
}

/** Decodes a mission file tolerantly: UTF-16 LE/BE via BOM (PowerShell's default
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

/** Parses "90", "90s", "15m", "1h" into seconds; undefined when unparseable. */
export function parseDurationSeconds(raw: string): number | undefined {
  const match = /^(\d+)\s*(s|m|h)?$/i.exec(raw.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  return value * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
}

/** The workspace-relative path a mission's report lands at (its deliverable, or the default out path). */
export function missionDeliverablePath(mission: Mission): string {
  return mission.deliverable ?? `.magentra/missions/out/${mission.id}/report.md`;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The single source of truth for the mission-file format, derived from what
 * {@link loadMissions} actually accepts. Everywhere the model is told about
 * missions embeds this verbatim, so the format the model is told and the format
 * the loader parses can never drift. Concrete and few-shot on purpose: the
 * product targets weak (26B-class) models. Keep it in step with loadMissions
 * above if you change it. The worked example after the "written exactly like
 * this:" marker line is extracted verbatim by the tests — keep the marker.
 */
export const MISSION_FILE_FORMAT = `Each mission is ONE markdown file at .magentra/missions/<id>.md. The file name without the .md is the mission id: lowercase letters, digits, hyphen or underscore only (e.g. lit-scan.md, market_watch.md).

The file is EXACTLY: a "---" fence alone on the first line, then "key: value" frontmatter lines, then a closing "---" fence alone on its own line, then the mission charter as the plain markdown body. Do NOT wrap the file in code fences or backticks.

Frontmatter keys:
- name        (REQUIRED) — the mission's display name, e.g. Literature scan.
- description (optional) — one sentence saying what the mission is for, shown in listings.
- keywords    (optional) — a comma-separated list of search terms; each one is swept on the web (WebSearch) every run.
- schedule    (optional) — a standard 5-field cron expression (minute hour day-of-month month day-of-week, e.g. "0 7 * * 1" = every Monday 07:00) for automatic runs; omit it to run only on demand.
- deliverable (optional) — a workspace-relative file path where the final report is written; omit it to use the default .magentra/missions/out/<id>/report.md.
- continuous  (optional) — "true" marks a standing mission: /mission start loops it (run, cool down, run again) until /mission stop.
- cooldown    (optional) — the pause between continuous runs, e.g. 90s, 15m, 1h (default 5m; clamped between 60s and 1h).
- budget      (optional) — output-token budget per run, e.g. 60000; the run pauses when it is spent.

Body: everything after the closing "---" is the mission charter (REQUIRED — it must not be empty). Write what the lab is investigating and what counts as done: the question, the scope, and the shape of a good answer.

Complete worked example — the file .magentra/missions/lit-scan.md, written exactly like this:
---
name: Literature scan
description: Weekly sweep of new work on agent memory and tool-use benchmarks.
keywords: agent memory, tool use benchmarks
schedule: 0 7 * * 1
deliverable: research/weekly-scan.md
---
Track new papers, posts, and benchmark releases on agent memory systems and
tool-use evaluation. For each notable find, capture the source URL, a two-line
summary, and why it matters to our work. Done means: every keyword swept, each
claim backed by a source URL, and the report updated with this week's findings.`;

/**
 * Builds the turn prompt that launches a mission — the full brief handed to the
 * orchestrator model. Structured for a weak orchestrator: header + charter,
 * an explicit per-keyword web sweep, a task-decomposition method (crew-aware
 * when a team is loaded), and a concrete deliverable instruction.
 */
export function buildMissionPrompt(mission: Mission, opts: { hasTeam: boolean; previousReport?: boolean }): string {
  const sections: string[] = [];

  sections.push(`MISSION "${mission.name}" (id: ${mission.id})

${mission.brief}`);

  if (opts.previousReport) {
    sections.push(`## Standing mission — the report already exists
This mission has run before: ${missionDeliverablePath(mission)} holds the previous report. Read it FIRST. This run UPDATES it — do not start from scratch:
- Lead the report with a "What's new since the last run" section (dated).
- Merge new findings into the existing structure; never duplicate an already-reported item.
- Prune or mark items the new evidence shows to be stale or wrong.
If the sweep turns up nothing genuinely new, say exactly that in the what's-new section — an honest "no change" beats padding.`);
  }

  if (mission.keywords.length > 0) {
    const lines = mission.keywords.map((k) => `- "${k}"`).join("\n");
    sections.push(`## Web sweep
Sweep the web for EACH of these keywords:
${lines}

For EACH keyword: run WebSearch on it, then follow the most promising hits with WebFetch to read the actual pages. Capture the source URL with every claim you take from the web — a claim without its URL does not count as evidence.`);
  }

  const method = opts.hasTeam
    ? `## Method
Decompose this mission into tasks with TaskCreate. Make each task self-contained: what to do, and its own acceptance check (how to tell it is done). Create a final verification task that states the expected end state of the whole mission.
Assign every task an owner from the crew roster via TaskUpdate's owner field, and execute owned tasks with CrewRun. Verify each returned report against the task's acceptance check before marking the task completed; a failed check goes back to the owner with the evidence of what fell short. A task with no suitable specialist is owned by "orchestrator" — do it yourself directly.`
    : `## Method
Decompose this mission into tasks with TaskCreate. Make each task self-contained: what to do, and its own acceptance check (how to tell it is done). Create a final verification task that states the expected end state of the whole mission.
There is no crew loaded — execute the tasks yourself, directly, one at a time, checking each against its acceptance check before completing it.`;
  sections.push(method);

  const outPath = missionDeliverablePath(mission);
  sections.push(`## Deliverable
Write the final report to ${outPath} with the Write tool. The report must contain: the findings, the evidence with source URLs, what was verified (and how), and the open questions that remain. End the turn with a short summary of the findings and the report path.`);

  return sections.join("\n\n");
}

/**
 * Which continuous missions are running, persisted so the loop survives a
 * restart: the engine re-arms a wakeup for every active id at startup.
 * Lives at .magentra/missions/continuous.json.
 */
export interface ContinuousState {
  active: Record<string, { startedAt: string }>;
}

function continuousStatePath(cwd: string): string {
  return join(cwd, ".magentra", "missions", "continuous.json");
}

export function loadContinuousState(cwd: string): ContinuousState {
  try {
    const raw = JSON.parse(readFileSync(continuousStatePath(cwd), "utf8")) as ContinuousState;
    if (raw !== null && typeof raw === "object" && raw.active !== null && typeof raw.active === "object") return raw;
  } catch {
    /* absent or unreadable → nothing running */
  }
  return { active: {} };
}

export function saveContinuousState(cwd: string, state: ContinuousState): void {
  const path = continuousStatePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * A starter mission file for `id`, guaranteed to load cleanly through
 * {@link loadMissions}: valid frontmatter with a humanized name, example
 * keywords to replace, the default deliverable path, and a short body scaffold.
 */
export function missionTemplate(id: string): string {
  const name = id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
  return `---
name: ${name || id}
keywords: replace-this-keyword, and-this-one
deliverable: .magentra/missions/out/${id}/report.md
---
Describe what the lab should investigate: the question, the scope, and the
sources that matter. Replace the keywords above with the search terms to sweep.

What counts as done: state the shape of a good answer — what the report must
contain for this mission to be considered complete.`;
}
