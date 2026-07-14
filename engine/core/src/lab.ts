import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanFrontmatter } from "./crew/team.js";

/**
 * The lab blueprint: ONE hand-editable markdown file (magentricks.md at the
 * workspace root) that declares the whole lab — every crew member and every
 * mission — in the exact same frontmatter+body format the individual files
 * use. `/lab load` compiles it into the canonical per-file layout
 * (.magentra/team/*.md, .magentra/missions/*.md), which stays the runtime
 * source of truth (hot-reload, packs, hiring all operate on it). `/lab save`
 * is the inverse: snapshot the current lab back into the blueprint.
 *
 * Direction is always explicit (load = blueprint→files, save = files→
 * blueprint); there is no background two-way sync to fight with.
 */

export const LAB_FILE_NAME = "magentricks.md";

export interface LabSection {
  kind: "member" | "mission";
  id: string;
  /** The section body: a complete team/mission file text (frontmatter + body). */
  content: string;
}

export interface ParsedLab {
  sections: LabSection[];
  warnings: string[];
}

const ID_RE = /^[a-z0-9_-]+$/;
/** `## member: scout`, `## agent scout`, `## mission: radar` — colon optional. */
const SECTION_RE = /^##\s+(member|agent|mission)\s*:?\s*(\S+)\s*$/i;

/** Finds the blueprint in a workspace (magentricks.md, any casing), or undefined. */
export function findLabFile(cwd: string): string | undefined {
  try {
    const hit = readdirSync(cwd).find((f) => f.toLowerCase() === LAB_FILE_NAME);
    return hit ? join(cwd, hit) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses a blueprint into member/mission sections. Everything outside a
 * `## member:`/`## mission:` header (title, notes) is ignored — the file is
 * yours to annotate. Each section's content is validated structurally here
 * (fences, required keys) so a broken section is reported without touching
 * disk; the strict loaders re-validate after materialization.
 */
export function parseLabFile(text: string): ParsedLab {
  const warnings: string[] = [];
  const sections: LabSection[] = [];
  const lines = text.replace(/\r/g, "").split("\n");

  let current: { kind: "member" | "mission"; id: string; start: number } | undefined;
  const flush = (endExclusive: number): void => {
    if (!current) return;
    const content = lines.slice(current.start, endExclusive).join("\n").trim();
    const problem = validateSection(current.kind, content);
    if (problem) warnings.push(`${current.kind} "${current.id}": ${problem}`);
    else sections.push({ kind: current.kind, id: current.id, content });
    current = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const match = SECTION_RE.exec(lines[i]!);
    if (!match) continue;
    flush(i);
    const kind = match[1]!.toLowerCase() === "mission" ? "mission" : "member";
    const id = match[2]!.toLowerCase();
    if (!ID_RE.test(id)) {
      warnings.push(`${kind} "${match[2]}": id must match [a-z0-9_-]`);
      continue;
    }
    if (kind === "member" && id === "orchestrator") {
      warnings.push(`member "orchestrator" is reserved — the orchestrator is the main session`);
      continue;
    }
    if (sections.some((s) => s.kind === kind && s.id === id)) {
      warnings.push(`${kind} "${id}": duplicate section — the first one wins`);
      continue;
    }
    current = { kind, id, start: i + 1 };
  }
  flush(lines.length);

  if (sections.length === 0 && warnings.length === 0) {
    warnings.push(`no sections found — declare them as "## member: <id>" and "## mission: <id>" headers`);
  }
  return { sections, warnings };
}

/** Structural check of one section's content; returns a problem string or undefined. */
function validateSection(kind: "member" | "mission", content: string): string | undefined {
  const scanned = scanFrontmatter(content);
  if (typeof scanned === "string") return scanned;
  if (!scanned.fields.name) return "missing required frontmatter key: name";
  if (kind === "member" && !scanned.fields.role) return "missing required frontmatter key: role";
  if (!scanned.body) return kind === "member" ? "missing role prompt (empty body)" : "missing mission charter (empty body)";
  return undefined;
}

export interface CompileResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  warnings: string[];
}

/** Where a section materializes on disk. */
function sectionPath(cwd: string, section: LabSection): string {
  const dir = section.kind === "member" ? join(cwd, ".magentra", "team") : join(cwd, ".magentra", "missions");
  return join(dir, `${section.id}.md`);
}

/**
 * Materializes a parsed blueprint into the canonical per-file layout. Upsert
 * only: files the blueprint doesn't mention are never touched or deleted
 * (hired members and hand-made missions survive a load). An existing file is
 * overwritten only when its content actually differs — the blueprint is
 * authoritative for the sections it declares.
 */
export function compileLab(cwd: string, parsed: ParsedLab): CompileResult {
  const result: CompileResult = { created: [], updated: [], unchanged: [], warnings: [...parsed.warnings] };
  for (const section of parsed.sections) {
    const path = sectionPath(cwd, section);
    const label = `${section.kind} ${section.id}`;
    const next = `${section.content}\n`;
    if (existsSync(path)) {
      const prev = readFileSync(path, "utf8").replace(/\r/g, "");
      if (prev.trim() === section.content) {
        result.unchanged.push(label);
        continue;
      }
      writeFileSync(path, next);
      result.updated.push(label);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next);
      result.created.push(label);
    }
  }
  return result;
}

/**
 * The inverse of load: snapshots the CURRENT lab (however it was built — by
 * hand, /build-crew, or hiring) into blueprint text. Sections carry each
 * file's content verbatim, so save→load round-trips to "unchanged".
 */
export function snapshotLab(cwd: string): { text: string; members: number; missions: number } {
  const readAll = (dir: string): Array<{ id: string; content: string }> => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ id: f.slice(0, -3), content: readFileSync(join(dir, f), "utf8").replace(/\r/g, "").trim() }));
  };
  const members = readAll(join(cwd, ".magentra", "team"));
  const missions = readAll(join(cwd, ".magentra", "missions"));

  const parts: string[] = [
    "# Magentricks — the lab blueprint",
    "",
    "One file, the whole lab. Edit members and missions below, then apply with",
    "`/lab load`. Snapshot the live lab back into this file with `/lab save`.",
    "Anything outside the `## member:` / `## mission:` sections is ignored.",
  ];
  for (const m of members) parts.push("", `## member: ${m.id}`, "", m.content);
  for (const m of missions) parts.push("", `## mission: ${m.id}`, "", m.content);
  parts.push("");
  return { text: parts.join("\n"), members: members.length, missions: missions.length };
}
