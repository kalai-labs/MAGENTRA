## pattern
The regular expression pattern to search for in file contents

## path
File or directory to search in. Defaults to the current working directory.

## glob
Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob

## type
File type to search (rg --type), e.g. js, py, rust. More efficient than glob for standard types.

## output_mode
"content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts per file

## -i
Case insensitive search

## -n
Show line numbers (content mode only)

## -A
Lines to show after each match (content mode only)

## -B
Lines to show before each match (content mode only)

## -C
Lines to show before and after each match (content mode only)

## multiline
Enable multiline mode where . matches newlines and patterns can span lines

## head_limit
Limit output to the first N lines/entries
