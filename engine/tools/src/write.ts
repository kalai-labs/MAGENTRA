import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { z } from "zod";
import { toolDescription, toolParam } from "@magentra/protocol";
import type { ToolDefinition } from "@magentra/core";
import { unifiedDiff } from "./util/diff.js";

const inputSchema = z.object({
  file_path: z.string().describe(toolParam("Write", "file_path")),
  content: z.string().describe(toolParam("Write", "content")),
});

export const writeTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Write",
  description: toolDescription("Write"),
  permissionClass: "mutate",
  isFileEdit: true,
  permissionSubject: (input) => input.file_path,
  describeInput: (input) =>
    `Write ${basename(input.file_path)} (${existsSync(input.file_path) ? "overwrite" : "create"}, ${Buffer.byteLength(input.content)} bytes)`,
  execute: async (input, ctx) => {
    const path = input.file_path;
    if (!isAbsolute(path)) {
      return { content: `file_path must be absolute, got: ${path}`, isError: true };
    }
    let before = "";
    const existed = existsSync(path);
    if (existed) {
      const stale = ctx.session.fileState.checkFresh(path);
      if (stale) return { content: stale, isError: true };
      before = readFileSync(path, "utf8");
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.content);
    ctx.session.fileState.recordRead(path);

    const rel = relative(ctx.cwd, path) || path;
    ctx.session.emit({ type: "file_edited", path, diff: unifiedDiff(rel, before, input.content) });
    const note = existed
      ? "\nnote: existing file replaced entirely — for incremental changes, use Edit instead of rewriting with Write."
      : "";
    return { content: `File written: ${path} (${Buffer.byteLength(input.content)} bytes)${note}` };
  },
  inputSchema,
};
