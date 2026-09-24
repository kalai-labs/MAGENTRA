import { readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";
import { unifiedDiff } from "./util/diff.js";

/** Flattens newlines/tabs and ellipsizes to `n` chars for a one-line UI preview. */
function flatten(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

const inputSchema = z.object({
  file_path: z.string().describe("The absolute path to the file to modify"),
  old_string: z.string().describe("The text to replace"),
  new_string: z.string().describe("The text to replace it with (must be different from old_string)"),
  replace_all: z.boolean().default(false).describe("Replace all occurrences of old_string (default false)"),
});

export const editTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Edit",
  description: `Performs exact string replacement in a file.

- You must Read the file in this session before editing; the call fails otherwise.
- old_string must match the file contents exactly, including whitespace and indentation, and must be unique in the file — otherwise the edit fails. Never include the Read line-number prefix (number + tab) in old_string.
- Keep old_string short: the smallest unique anchor — a few lines at most — copied from your latest Read of the file, never retyped from memory. A long old_string written from memory fails on one missing character.
- Set replace_all: true to replace every occurrence instead of requiring uniqueness.`,
  permissionClass: "mutate",
  isFileEdit: true,
  permissionSubject: (input) => input.file_path,
  describeInput: (input) =>
    `Edit ${basename(input.file_path)}: "${flatten(input.old_string, 40)}" → "${flatten(input.new_string, 40)}"`,
  execute: async (input, ctx) => {
    const path = input.file_path;
    if (!isAbsolute(path)) {
      return { content: `file_path must be absolute, got: ${path}`, isError: true };
    }
    if (input.old_string === input.new_string) {
      return { content: "old_string and new_string are identical — nothing to change.", isError: true };
    }
    const stale = ctx.session.fileState.checkFresh(path);
    if (stale) return { content: stale, isError: true };

    let before: string;
    try {
      before = readFileSync(path, "utf8");
    } catch {
      return { content: `File does not exist: ${path}`, isError: true };
    }

    const occurrences = countOccurrences(before, input.old_string);
    if (occurrences === 0) {
      return {
        content: `old_string not found in ${path}.${closestMatchHint(before, input.old_string)} Check for exact whitespace/indentation; do not include the Read line-number prefix.`,
        isError: true,
      };
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        content: `old_string matches ${occurrences} places in ${path}. Provide a larger unique snippet with more surrounding context, or set replace_all: true to change every occurrence.`,
        isError: true,
      };
    }

    const after = input.replace_all
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, () => input.new_string);
    writeFileSync(path, after);
    ctx.session.fileState.recordRead(path);

    const rel = relative(ctx.cwd, path) || path;
    ctx.session.emit({ type: "file_edited", path, diff: unifiedDiff(rel, before, after) });
    return {
      content: `Edited ${path}: replaced ${input.replace_all ? occurrences : 1} occurrence${occurrences > 1 && input.replace_all ? "s" : ""}.`,
    };
  },
  inputSchema,
};

/**
 * Where old_string stops matching the file, so a one-character slip in a long
 * anchor is found in one retry instead of three (field test 2026-09-23: one
 * missing "/" in "/GameConfig.Overrides.json"). The longest PREFIX of
 * old_string the file contains is found by binary search — about log2(length)
 * substring scans, bounded for a file of any size — and both sides are quoted
 * at the first character that differs.
 */
function closestMatchHint(content: string, needle: string): string {
  if (needle === "") return " old_string is empty — give the exact text to replace, copied from your latest Read of the file.";
  let lo = 0;
  let hi = needle.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (content.includes(needle.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  // Never split a surrogate pair: the quoted difference starts at the whole character.
  if (lo > 0 && lo < needle.length && /[\uD800-\uDBFF]/.test(needle[lo - 1]!)) lo -= 1;
  const at = content.indexOf(needle.slice(0, lo)) + lo;
  // A CRLF file quoted with bare \n breaks at its first line end, however short
  // the match before it: that is the one miss worth naming even there.
  const crlf = content[at] === "\r" && needle[lo] === "\n" ? " (the file has Windows CRLF line endings; old_string has bare \\n)" : "";
  // A matched head shorter than this is likely a coincidence ("    const "),
  // not where the anchor went wrong. For a short anchor — the kind the Edit
  // description asks for — half of it matching is already telling.
  if (!crlf && lo < Math.min(16, Math.ceil(needle.length / 2))) {
    return " Not even its beginning appears in the file — Read the file again and copy a short anchor from it.";
  }
  const quote = (s: string): string => JSON.stringify(s.slice(0, 40));
  const fileLine = content.slice(0, at).split("\n").length;
  return (
    ` It matches the file for its first ${lo} of ${needle.length} characters, up to ${quote(needle.slice(Math.max(0, lo - 30), lo))};` +
    ` then old_string has ${quote(needle.slice(lo))} where the file (line ${fileLine}) has ${quote(content.slice(at))}${crlf}.`
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
