---
name: Glob
---
Fast filename/path matching. Supports glob patterns like "**/*.js" or "src/**/*.{ts,tsx}".

- Matches file names and paths only; it never looks inside files (use Grep for contents).
- Results are sorted by modification time, most recently modified first.
- * matches within one path segment; ** crosses directories; {a,b} alternates; ? matches one character.
- `node_modules`, `.git`, and MAGENTRA's own `.magentra/` state directory and other directory of files start with `.` are skipped. To search the state directory, name it in the pattern or path (e.g. ".magentra/**/*.json") — it holds session transcripts and worktree checkouts, so an accidental match is a large waste of context.
- An empty result is not an error. Prefer this over find/ls via Bash.
