import { execFile } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";

const inputSchema = z.object({
  pattern: z.string().describe("The regular expression pattern to search for in file contents"),
  path: z.string().optional().describe("File or directory to search in. Defaults to the current working directory."),
  glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'),
  type: z.string().optional().describe("File type to search (rg --type), e.g. js, py, rust. More efficient than glob for standard types."),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .default("files_with_matches")
    .describe('"content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts per file'),
  "-i": z.boolean().optional().describe("Case insensitive search"),
  "-n": z.boolean().default(true).describe("Show line numbers (content mode only)"),
  "-A": z.number().int().min(0).optional().describe("Lines to show after each match (content mode only)"),
  "-B": z.number().int().min(0).optional().describe("Lines to show before each match (content mode only)"),
  "-C": z.number().int().min(0).optional().describe("Lines to show before and after each match (content mode only)"),
  multiline: z.boolean().default(false).describe("Enable multiline mode where . matches newlines and patterns can span lines"),
  head_limit: z.number().int().positive().default(250).describe("Limit output to the first N lines/entries"),
});

export const grepTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Grep",
  description: `Content search built on ripgrep. Always prefer this over grep/rg via Bash.

- Full regex syntax (Rust regex engine); escape literal braces etc. (interface\\{\\}).
- Filter with glob (e.g. "**/*.tsx") or type (e.g. "js", "py").
- output_mode: "files_with_matches" (default, just paths), "content" (matching lines; supports -n/-A/-B/-C), "count" (matches per file).
- Respects .gitignore by default. multiline: true lets patterns span lines.`,
  permissionClass: "read",
  permissionSubject: (input) => input.pattern,
  searchTerms: (input) => (input.path ? [input.pattern, input.path] : [input.pattern]),
  execute: (input, ctx, signal) => {
    const args: string[] = ["--no-config", "--color", "never"];
    switch (input.output_mode) {
      case "files_with_matches":
        args.push("--files-with-matches");
        break;
      case "count":
        args.push("--count");
        break;
      case "content":
        if (input["-n"]) args.push("--line-number");
        if (input["-A"] !== undefined) args.push("-A", String(input["-A"]));
        if (input["-B"] !== undefined) args.push("-B", String(input["-B"]));
        if (input["-C"] !== undefined) args.push("-C", String(input["-C"]));
        args.push("--heading");
        break;
    }
    if (input["-i"]) args.push("--ignore-case");
    if (input.multiline) args.push("--multiline", "--multiline-dotall");
    if (input.glob) args.push("--glob", input.glob);
    if (input.type) args.push("--type", input.type);
    args.push("--regexp", input.pattern, input.path ?? ctx.cwd);

    return new Promise((resolve) => {
      execFile(
        rgPath,
        args,
        { cwd: ctx.cwd, maxBuffer: 20 * 1024 * 1024, signal },
        (err, stdout, stderr) => {
          // Blowing the buffer is a RESULT (too many matches), not a failure:
          // return what was captured, truncated honestly.
          if (err && (err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            const lines = stdout.trimEnd().split("\n");
            const capped = lines.slice(0, input.head_limit);
            resolve({
              content:
                capped.join("\n") +
                "\n[truncated — output exceeded the 20MB buffer; narrow the pattern or add a glob filter]",
            });
            return;
          }
          const code = err ? ((err as { code?: number }).code ?? 2) : 0;
          if (code === 0) {
            const lines = stdout.trimEnd().split("\n");
            const capped = lines.slice(0, input.head_limit);
            const suffix =
              lines.length > capped.length
                ? `\n[truncated — ${lines.length - capped.length} more lines; raise head_limit or narrow the pattern]`
                : "";
            resolve({ content: capped.join("\n") + suffix });
          } else if (code === 1) {
            resolve({ content: "No matches found." });
          } else {
            resolve({ content: `ripgrep error: ${stderr || (err as Error).message}`, isError: true });
          }
        },
      );
    });
  },
  inputSchema,
};
