---
name: Grep
---
Content search built on ripgrep. Always prefer this over grep/rg via Bash.

- Full regex syntax (Rust regex engine); escape literal braces etc. (interface\{\}).
- Filter with glob (e.g. "**/*.tsx") or type (e.g. "js", "py").
- output_mode: "files_with_matches" (default, just paths), "content" (matching lines; supports -n/-A/-B/-C), "count" (matches per file).
- Respects .gitignore by default. multiline: true lets patterns span lines.
