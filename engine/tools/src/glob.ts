import { statSync } from "node:fs";
import fg from "fast-glob";
import { z } from "zod";
import { toolDescription, toolParam } from "@magentra/protocol";
import type { ToolDefinition } from "@magentra/core";

const inputSchema = z.object({
  pattern: z.string().describe(toolParam("Glob", "pattern")),
  path: z
    .string()
    .optional()
    .describe(toolParam("Glob", "path")),
  dot: z
    .boolean()
    .optional()
    .describe(toolParam("Glob", "dot")),
});

/**
 * Matches a `.magentra` path SEGMENT — the workspace state directory, not a
 * file that merely has the word in its name (`docs/magentra-notes.md`,
 * `.magentra-backup/`). Anchored on separators at both ends for that reason.
 */
const STATE_DIR_SEGMENT = /(^|[\\/])\.magentra([\\/]|$)/i;

/** True when the caller deliberately aimed at the state directory, in the
 *  pattern or in the search root. Only then is it worth listing: everything in
 *  there is MAGENTRA's own bookkeeping, and an accidental match spends the
 *  user's context on session transcripts and worktree checkouts. */
function targetsStateDir(pattern: string, path: string | undefined): boolean {
  return STATE_DIR_SEGMENT.test(pattern) || (path !== undefined && STATE_DIR_SEGMENT.test(path));
}

export const globTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Glob",
  description: toolDescription("Glob"),
  permissionClass: "read",
  permissionSubject: (input) => input.pattern,
  searchTerms: (input) => [input.pattern],
  execute: async (input, ctx) => {
    const cwd = input.path ?? ctx.cwd;
    let matches: string[];
    try {
      matches = await fg(input.pattern, {
        cwd,
        absolute: true,
        onlyFiles: true,
        dot: input.dot ?? false,
        suppressErrors: true,
        // `dot: false` already hides `.magentra` from an ordinary search, but
        // the moment a caller passes dot:true (to find .github, .claude, …) the
        // state directory comes with it — session transcripts and whole
        // worktree checkouts. Exclude it explicitly, and only step aside when
        // the caller actually asked for it.
        ignore: [
          "**/node_modules/**",
          "**/.git/**",
          ...(targetsStateDir(input.pattern, input.path) ? [] : ["**/.magentra/**"]),
        ],
      });
    } catch (err) {
      return { content: `Glob failed: ${(err as Error).message}`, isError: true };
    }
    if (matches.length === 0) return { content: "No files match the pattern." };

    const withTimes = matches.map((file) => {
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        // race with deletion; keep at epoch
      }
      return { file, mtime };
    });
    withTimes.sort((a, b) => b.mtime - a.mtime);

    const capped = withTimes.slice(0, 1000);
    const suffix =
      withTimes.length > capped.length
        ? `\n[truncated — ${withTimes.length - capped.length} more matches; narrow the pattern]`
        : "";
    return { content: capped.map((m) => m.file).join("\n") + suffix };
  },
  inputSchema,
};
