/**
 * Slim `---`-delimited frontmatter, parsed by hand — no YAML dependency, no
 * type coercion, every value a string. Two readers over the same shape, because
 * their callers need different things:
 *
 *   parseFrontmatter — the skill loaders. Keeps keys verbatim, preserves
 *     repeated keys (`gate:`) as an ordered entry list, and records line
 *     numbers so discipline skills can report precise errors.
 *   scanFrontmatter  — the mission loader. Lowercases keys, folds YAML block
 *     lists into one comma-joined value, and reports a malformed fence as an
 *     error string so the whole file can be skipped.
 */

export interface FrontmatterEntry {
  key: string;
  value: string;
  /** 1-based line number of the entry in the original text. */
  line: number;
}

export interface Frontmatter {
  /** Whether the text opened with a `---` block at all. */
  present: boolean;
  /** Every `key: value` line in order, repeats preserved. */
  entries: FrontmatterEntry[];
  /** Last-wins convenience view of {@link entries}. */
  map: Record<string, string>;
  body: string;
  /** 1-based line number where the body starts in the original text. */
  bodyLine: number;
}

/** Strips a surrounding quote pair, if any — people quote frontmatter values out of YAML habit. */
function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^﻿/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { present: false, entries: [], map: {}, body: normalized, bodyLine: 1 };
  }

  const entries: FrontmatterEntry[] = [];
  const map: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") {
      i++;
      break;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue; // tolerated for action skills; strict callers re-check entries
    const key = line.slice(0, colon).trim();
    const value = unquote(line.slice(colon + 1).trim());
    if (key) {
      entries.push({ key, value, line: i + 1 });
      map[key] = value;
    }
  }
  return { present: true, entries, map, body: lines.slice(i).join("\n"), bodyLine: i + 1 };
}

/**
 * Scans a `---`-fenced frontmatter block loosely. Deliberately not YAML, but
 * more forgiving than {@link parseFrontmatter}: it supports "key: value",
 * "key:" followed by "- item" block lists, quoted values, and tolerates stray
 * unparseable lines. Keys are lowercased. Returns an error message string on a
 * missing/unterminated fence. Keep it schema-free — callers own validation.
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
      const item = unquote(trimmed.slice(2).trim()).trim();
      if (item) fields[currentListKey] = fields[currentListKey] ? `${fields[currentListKey]}, ${item}` : item;
      continue;
    }
    currentListKey = undefined;
    const colon = line.indexOf(":");
    if (colon === -1) continue; // stray line — tolerate, do not reject the file
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = unquote(line.slice(colon + 1).trim()).trim();
    if (value === "") {
      currentListKey = key; // "docs:" header of a YAML block list
      if (!(key in fields)) fields[key] = "";
    } else {
      fields[key] = value;
    }
  }

  return { fields, body: lines.slice(end + 1).join("\n").trim() };
}
