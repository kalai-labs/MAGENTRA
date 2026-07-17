import { statSync } from "node:fs";
import fg from "fast-glob";
import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";

const inputSchema = z.object({
  pattern: z.string().describe("The glob pattern to match files against"),
  path: z
    .string()
    .optional()
    .describe(
      "The directory to search in. Omit it to use the current working directory — never pass \"undefined\" or \"null\".",
    ),
  dot: z
    .boolean()
    .optional()
    .describe("Set true to also match dotfiles/dot-directories (e.g. .github/**); default false."),
});

export const globTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Glob",
  description: `Fast filename/path matching. Supports glob patterns like "**/*.js" or "src/**/*.{ts,tsx}".

- Matches file names and paths only; it never looks inside files (use Grep for contents).
- Results are sorted by modification time, most recently modified first.
- * matches within one path segment; ** crosses directories; {a,b} alternates; ? matches one character.
- An empty result is not an error. Prefer this over find/ls via Bash.`,
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
        ignore: ["**/node_modules/**", "**/.git/**"],
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
