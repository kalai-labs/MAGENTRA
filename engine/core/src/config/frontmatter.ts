/**
 * Slim `---`-delimited frontmatter, parsed by hand — no YAML dependency, no
 * type coercion, every value a string. Shared by the skill loaders (action
 * skills read a couple of keys loosely; discipline skills validate strictly on
 * top of the ordered entry list, which also preserves repeated keys like
 * `gate:` and the line numbers needed for precise error messages).
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
