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
        content: `old_string not found in ${path}. Check for exact whitespace/indentation; do not include the Read line-number prefix.`,
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
