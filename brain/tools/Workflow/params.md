## (root)
Provide at least one of `script` or `scriptPath`.

## script
Self-contained JS workflow script. Must begin with `export const meta = { name, description }` (a pure literal) followed by a body that uses agent/parallel/pipeline/phase/log.

## scriptPath
Path to a workflow script file (relative to cwd or absolute). Takes precedence over `script`.

## args
Value exposed to the script as the global `args`, verbatim.
