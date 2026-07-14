import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR_NAME } from "@magentra/protocol";

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
}

/**
 * Loads skills from `<cwd>/.magentra/skills`. Two layouts are recognized:
 *   - a directory containing `SKILL.md`
 *   - a flat `<name>.md` file (name defaults to the basename without `.md`)
 * `SKILL.md` may open with `---`-delimited frontmatter; only the scalar `name:`
 * and `description:` keys are read (parsed by hand — no YAML dependency). When
 * frontmatter is absent, the name falls back to the directory/file name and the
 * description to the first non-empty body line. Unreadable entries are skipped;
 * scanning does not recurse beyond one level.
 */
export function loadSkills(cwd: string): Skill[] {
  const dir = join(cwd, STATE_DIR_NAME, "skills");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const skill = readSkillFile(join(full, "SKILL.md"), entry);
      if (skill) skills.push(skill);
    } else if (entry.toLowerCase().endsWith(".md")) {
      const skill = readSkillFile(full, entry.slice(0, entry.length - 3));
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

function readSkillFile(path: string, fallbackName: string): Skill | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const { frontmatter, body } = splitFrontmatter(text);
  const name = frontmatter.name?.trim() || fallbackName;
  const description = frontmatter.description?.trim() || firstLine(body) || name;
  return { name, description, body: body.trim(), path };
}

function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: normalized };

  const frontmatter: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") {
      i++;
      break;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: lines.slice(i).join("\n") };
}

function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}
