import { readFileSync } from "node:fs";
import { parseFrontmatter } from "../config/frontmatter.js";
import { listSkillFiles } from "../ma/modes.js";

/** An on-demand action skill: a procedure the model invokes via the Skill tool. */
export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
}

/**
 * Loads action skills from `<cwd>/.magentra/skills` — the same folder as
 * discipline skills. Two layouts are recognized: a directory containing
 * `SKILL.md`, or a flat `<name>.md` file (name defaults to the basename).
 * A file may open with `---` frontmatter; the scalar `name:` and
 * `description:` keys are read, and `kind: discipline` files are skipped —
 * those belong to the discipline loader (ma/modes.ts). When frontmatter is
 * absent, the name falls back to the directory/file name and the description
 * to the first non-empty body line. Unreadable entries are skipped.
 */
export function loadSkills(cwd: string): Skill[] {
  const skills: Skill[] = [];
  for (const candidate of listSkillFiles(cwd)) {
    let text: string;
    try {
      text = readFileSync(candidate.path, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    if ((fm.map.kind ?? "").trim() === "discipline") continue;
    const name = fm.map.name?.trim() || candidate.fallbackId;
    const description = fm.map.description?.trim() || firstLine(fm.body) || name;
    skills.push({ name, description, body: fm.body.trim(), path: candidate.path });
  }
  return skills;
}

function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}
