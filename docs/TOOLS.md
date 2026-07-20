# Magentra Tools

This documents every tool registered in the default registry
(`engine/tools/src/index.ts`, assembled by `createDefaultRegistry()`). Each tool is a
single module exporting a `ToolDefinition` (`engine/core/src/agent/tool.ts`): a name, a
description, a zod `inputSchema`, a `permissionClass`, and an async `execute(input, ctx,
signal)`.

Currently registered (see `createDefaultRegistry()` for the authoritative list): **Read,
Write, Edit, Glob, Grep, Bash, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion,
Agent, TaskStop, TaskOutput, WebFetch, WebSearch, Monitor,
EnterWorktree, ExitWorktree, PushNotification, CronCreate, CronDelete, CronList,
ScheduleWakeup, Skill, Workflow, GraphQuery, CrewRun, BackpackSearch** — plus any
`mcp__<server>__<tool>` entries wired in from configured MCP servers at startup.

The reference sections below cover the original core set (Read through AskUserQuestion) in
full detail; for the rest, each tool's module under `engine/tools/src/` carries its
complete contract in its `ToolDefinition` description and doc comments.

## Permission model

Every tool declares one of five permission classes, and each tool call is resolved against
the active permission mode and the user's `allow`/`deny` rules
(`engine/core/src/runtime/permissions.ts`).

| Class | Meaning | Examples |
| --- | --- | --- |
| `read` | Observes state, never mutates. | Read, Glob, Grep, TaskList, TaskGet |
| `mutate` | Changes files on disk. | Write, Edit |
| `execute` | Runs arbitrary commands. | Bash |
| `network` | Reaches the network. | WebFetch, WebSearch, MCP tools |
| `interact` | Talks to the user / task list; no filesystem or shell effect. | TaskCreate, TaskUpdate, AskUserQuestion |

Resolution order is **deny rule → allow rule → mode default**. The mode default is computed
per tool:

| Mode | `read` / `interact` | `mutate` (file edits) | `execute` / other `mutate` | Notes |
| --- | --- | --- | --- | --- |
| `default` | allow | ask | ask | Prompts the user for anything that changes state. |
| `acceptEdits` | allow | allow | ask | File-editing tools (`isFileEdit`) auto-approved; Bash still prompts. |
| `plan` | allow | deny | deny | Read-only enforcement; the agent records intended changes in the plan instead. |
| `bypass` | allow | allow | allow | Everything runs unprompted (`--dangerously-bypass`). |

Rules are strings of the form `Tool` or `Tool(subject-glob)`, where the subject is the tool's
`permissionSubject` (for Bash the command string; for file tools the path; for Glob/Grep the
pattern). `*` in a rule is a wildcard. Example: `Bash(git status*)` allows any command
starting with `git status`. An `allow_session` decision from a permission prompt adds a
session-scoped exact-match rule so the identical call is not asked again.

Concurrency: `read`-class tools and any tool marked `parallelSafe` (the task tools) run
concurrently within one assistant turn; everything else runs sequentially in call order so
permission prompts never race.

## Common behaviors

- **File freshness.** The session tracks which files have been read this session. `Edit`
  requires the file to have been read first; `Write` requires it for a file that already
  exists. If the file changed on disk since it was read, the call fails with a "re-read
  first" error. Successful reads/writes/edits refresh the record.
- **Output truncation.** A tool result larger than its byte budget (default 40 000 bytes;
  `Read` raises this to 250 000) is clipped to the head and tail with a marker in between.
  Several tools also cap their own output before returning (Glob at 1000 paths, Grep via
  `head_limit`, Bash at ~30 000 chars).
- **Cancellation.** Every `execute` receives an `AbortSignal`; an `interrupt` request aborts
  in-flight tool work (Bash kills its process tree, ripgrep is signalled).
- **Errors are data.** A tool that fails returns `{ isError: true }` with an explanatory
  message rather than throwing; the message goes back to the model so it can self-correct.

---

## Read

Reads a file from the local filesystem. **Permission class:** `read`. Output byte limit:
250 000.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `file_path` | string | yes | — | Absolute path to the file. |
| `offset` | integer ≥ 0 | no | 0 | Line number to start reading from (large files). |
| `limit` | positive integer | no | 2000 | Number of lines to read. |

**Contract.** The path must be absolute. Output is `cat -n` style: a right-padded line
number, a tab, then the line, starting at line 1 (or at `offset+1`). Lines longer than 2000
characters are clipped with a `[line truncated]` marker. When more lines remain past the
window, a trailing notice tells the model the next `offset` to use. Image files (`.png`,
`.jpg`/`.jpeg`, `.gif`, `.webp`) are returned as an image content block rather than text. A
file whose head contains a NUL byte is refused as binary with an explanatory error (naming
what Read does handle and pointing at Bash tooling — `file`, `strings`, `unzip -l` — for
the rest) instead of returning a page of mojibake. A successful read records the file for
freshness checks.

**Error modes.** Non-absolute path; file does not exist; path is a directory (suggests Glob);
binary file (see above); an empty file returns the note `(the file exists but is empty)` as a
normal (non-error) result.

## Write

Writes a file, overwriting an existing one. **Permission class:** `mutate` (`isFileEdit`, so
auto-approved in `acceptEdits`). Subject: `file_path`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `file_path` | string | yes | — | Absolute path to write (must be absolute). |
| `content` | string | yes | — | Full file contents. |

**Contract.** Path must be absolute. If the file already exists it must be fresh (read this
session and unchanged on disk) or the write fails. Missing parent directories are created.
After writing, the file is recorded as read, and a `file_edited` event carrying a unified
diff is emitted. Returns the byte count written.

**Error modes.** Non-absolute path; stale/never-read existing file.

## Edit

Exact string replacement within a file. **Permission class:** `mutate` (`isFileEdit`).
Subject: `file_path`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `file_path` | string | yes | — | Absolute path to modify. |
| `old_string` | string | yes | — | Text to replace (exact, including whitespace). |
| `new_string` | string | yes | — | Replacement text; must differ from `old_string`. |
| `replace_all` | boolean | no | `false` | Replace every occurrence instead of requiring uniqueness. |

**Contract.** The file must have been read this session and be unchanged on disk. By default
`old_string` must match exactly once; if it matches multiple times the call fails and asks
for a larger unique snippet or `replace_all: true`. With `replace_all` every occurrence is
replaced. On success the file is re-recorded and a `file_edited` unified-diff event is
emitted; the result states how many occurrences changed.

**Error modes.** Non-absolute path; `old_string` identical to `new_string`; stale/never-read
file; file does not exist; `old_string` not found; multiple matches without `replace_all`.

## Glob

Filename/path matching by glob pattern. **Permission class:** `read`. Subject: `pattern`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `pattern` | string | yes | — | Glob, e.g. `**/*.ts` or `src/**/*.{ts,tsx}`. |
| `path` | string | no | session cwd | Directory to search in. |
| `dot` | boolean | no | `false` | Also match dotfiles/dot-directories (e.g. `.github/**`). |

**Contract.** Matches file names/paths only (never file contents). Returns absolute paths,
files only, sorted most-recently-modified first, capped at 1000 with a "narrow the pattern"
notice when exceeded. `node_modules` and `.git` are ignored, and dotfiles are excluded
unless `dot: true`. An empty result (`No files match the pattern.`) is not an error.

**Error modes.** An internal glob-engine failure returns `Glob failed: …` as an error.

## Grep

Content search built on ripgrep. **Permission class:** `read`. Subject: `pattern`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `pattern` | string | yes | — | Regular expression (Rust regex engine). |
| `path` | string | no | session cwd | File or directory to search. |
| `glob` | string | no | — | Filter files by glob (`rg --glob`). |
| `type` | string | no | — | Filter by file type (`rg --type`), e.g. `js`, `py`. |
| `output_mode` | `content` \| `files_with_matches` \| `count` | no | `files_with_matches` | What to emit. |
| `-i` | boolean | no | — | Case-insensitive. |
| `-n` | boolean | no | `true` | Show line numbers (content mode). |
| `-A` | integer ≥ 0 | no | — | Lines of trailing context (content mode). |
| `-B` | integer ≥ 0 | no | — | Lines of leading context (content mode). |
| `-C` | integer ≥ 0 | no | — | Lines of context each side (content mode). |
| `multiline` | boolean | no | `false` | Let `.` match newlines and patterns span lines. |
| `head_limit` | positive integer | no | 250 | Cap on emitted lines/entries. |

**Contract.** Respects `.gitignore` by default. In `content` mode results are grouped under
file headings and, when `-n` is set, prefixed with line numbers. Output beyond `head_limit`
is dropped with a "raise head_limit or narrow the pattern" notice. Blowing ripgrep's 20MB
capture buffer is treated as a result (too many matches), not a failure: what was captured
is returned, capped at `head_limit`, with a "narrow the pattern or add a glob filter"
truncation notice. No matches returns `No matches found.` (not an error).

**Error modes.** A ripgrep failure (exit code > 1, e.g. an invalid regex) returns `ripgrep
error: …` as an error.

## Bash

Executes a shell command, returning combined stdout/stderr. **Permission class:** `execute`.
Subject: `command`; the approval prompt shows `description`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `command` | string | yes | — | The command to run. |
| `description` | string | yes | — | Short active-voice summary shown in the approval prompt. |
| `timeout` | positive integer ≤ 600000 | no | 120000 | Timeout in milliseconds. |
| `run_in_background` | boolean | no | `false` | Detach and stream output to a file. |

**Contract.**
- **Persistent working directory.** The shell's cwd persists across calls within a session
  (a `cd` in one call carries to the next). Environment variables and shell functions do
  **not** persist. Prefer absolute paths.
- **Foreground sleep is blocked.** A bare `sleep N` command is refused with guidance to run
  the wait in the background instead.
- **Background semantics.** With `run_in_background: true` the tool returns immediately with a
  task id; output streams to a file (readable via `Read`), and a `background_notification`
  fires when the process exits. The model can poll the output file meanwhile.
- **Timeouts and cancellation.** On timeout or interrupt the entire process tree is killed
  (`taskkill /T /F` on Windows, process-group `SIGKILL` elsewhere). Output is clipped to
  ~30 000 characters (head + tail).
- **Shell resolution.** On Windows it resolves Git Bash explicitly (checking common install
  paths) so paths are native and consumable by Node, rather than picking up WSL's `bash`.
  `MAGENTRA_BASH` overrides the shell path.
- **No TTY.** Interactive flags (`-i`) do not work; there is no terminal.

**Error modes.** Non-zero exit (marked as error, output included); timeout; interrupt; shell
fails to start; blocked foreground sleep.

## TaskCreate

Adds a task to the session task list. **Permission class:** `interact` (`parallelSafe`).

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `subject` | string | yes | — | Brief imperative title. |
| `description` | string | yes | — | What needs to be done. |
| `activeForm` | string | no | — | Present-continuous label shown while in progress. |
| `metadata` | object | no | — | Arbitrary key/value metadata. |

**Contract.** Creates a `pending` task and returns its id. Task changes emit
`task_list_updated`. Intended for multi-step work; a `task_list_updated` event reflects the
new list.

## TaskUpdate

Updates an existing task. **Permission class:** `interact` (`parallelSafe`).

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `taskId` | string | yes | — | Id of the task to update. |
| `subject` | string | no | — | New subject. |
| `description` | string | no | — | New description. |
| `activeForm` | string | no | — | New present-continuous label. |
| `status` | `pending` \| `in_progress` \| `completed` \| `deleted` | no | — | New status; `deleted` removes it. |
| `owner` | string | no | — | New owner. |
| `metadata` | object | no | — | Keys merged in; a `null` value deletes that key. |
| `addBlocks` | string[] | no | — | Task ids this task blocks. |
| `addBlockedBy` | string[] | no | — | Task ids that block this task. |

**Contract.** Applies the patch and returns the updated task's status and subject (or a
"deleted" note). Emits `task_list_updated`.

**Error modes.** Unknown `taskId` returns an error message.

## TaskList

Lists all tasks in the session. **Permission class:** `read`. No input fields.

**Contract.** Returns one line per task with id, status, owner (if any), subject, and any
`blockedBy` ids. An empty list returns `The task list is empty.`

## TaskGet

Retrieves one task in full. **Permission class:** `read`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `taskId` | string | yes | — | Id of the task to retrieve. |

**Contract.** Returns the task as pretty-printed JSON (description, status, owner, `blocks`,
`blockedBy`, metadata).

**Error modes.** Unknown id returns `No task with id …` as an error.

## AskUserQuestion

Asks the user up to four multiple-choice questions and blocks until answered. **Permission
class:** `interact`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `questions` | array (1–4) | yes | — | The questions to ask. |

Each question object:

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `question` | string | yes | — | The full question, ending in `?`. |
| `header` | string (≤ 12 chars) | yes | — | Short chip label. |
| `options` | array (2–4) | yes | — | The choices. |
| `multiSelect` | boolean | no | `false` | Allow selecting multiple options. |

Each option object:

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | string | yes | — | Concise display text (1–5 words). |
| `description` | string | yes | — | What choosing it means, including trade-offs. |
| `preview` | string | no | — | Optional preview content shown when focused. |

**Contract.** Emits a `question_request` event and awaits a `question_response` (see the
question round-trip in `docs/PROTOCOL.md`). Answers arrive keyed positionally (`"q:<idx>"`,
so duplicate question texts cannot collide); the question's exact text is accepted as a
fallback for older frontends. The frontend always adds an "Other" free-text option
automatically, so tools should not include one. The result is returned to the model as the
user's selections, formatted per question.
