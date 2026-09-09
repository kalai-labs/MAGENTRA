# Area: engine/tools  (2,932 lines — 27 registered tools)

`createDefaultRegistry()` registers exactly 27. Verified against the registry
array, not the docs.

## Permission classes (the axis the permission engine switches on)

| Class | Tools |
| --- | --- |
| read (9) | Read, Glob, Grep, GraphQuery, Addon, Agent, TaskList, TaskGet, TaskOutput |
| mutate (2) | Write, Edit — both `isFileEdit: true` |
| execute (6) | Bash, Monitor, Workflow, EnterWorktree, ExitWorktree, TaskStop |
| interact (8) | AskUserQuestion, CronCreate, CronDelete, CronList, ScheduleWakeup, PushNotification, TaskCreate, TaskUpdate |
| network (2) | WebFetch, WebSearch |

`deletionSubject` (routes to the always-ask deletion guard): Bash, ExitWorktree.

## Per-tool behaviour worth a test

**Read** — absolute path required. Directory / missing / empty each get a distinct
explanatory error, never content. IMAGE (png/jpg/jpeg/gif/webp) is NOT returned:
it goes to the vision endpoint and the DESCRIPTION enters the transcript; with no
vision model the read is REFUSED with "you cannot see it — do not describe or
draw conclusions from it". Image cap 8MB (base64 inflates ~⅓). DOCUMENTS
(pdf/docx/pptx/xlsx/rtf/odt/epub) text-extracted, 20MB cap, output gets an
`[extracted from …]` header. Binary detected by a NUL byte in the first 8192
bytes → honest refusal, not mojibake. cat -n format; lines over 2000 chars
clipped with "[truncated — line continues]"; 2000-line default window with a
continuation notice naming the exact next offset. outputByteLimit 250,000.
Every successful read calls `fileState.recordRead`.
IMAGE_TYPES is MIRRORED in app/main.js (attach picker) — a mirrored-constant pair.

**Write** — overwriting a file not Read this session (or changed on disk since)
FAILS via `fileState.checkFresh`. Parent dirs created. Emits `file_edited` with a
unifiedDiff. Adds a note steering to Edit for incremental change.

**Edit** — must have Read first. old_string must be unique unless replace_all;
0 occurrences and >1 occurrences give different, actionable errors. Identical
old/new refused. Never include the Read line-number prefix (stated in the error).
Emits `file_edited` with a diff.

**Glob** — fast-glob, absolute, onlyFiles, sorted by mtime DESC, capped at 1000
with a truncation notice. Skips node_modules and .git always. **Skips
`.magentra/` unless the pattern or path names it** — matched on a path SEGMENT
regex so `docs/magentra-notes.md` and `.magentra-backup/` do NOT count as
targeting it. Reason: the state dir holds session transcripts and whole worktree
checkouts; an accidental match burns the user's context. Empty result is not an
error.

**Grep** — ripgrep via @vscode/ripgrep (`rgPath`), `--no-config`, colour never.
3 output modes (files_with_matches default / content / count); -i, -n, -A/-B/-C,
multiline (adds --multiline-dotall), glob, type, head_limit default 250.
Respects .gitignore. **Blowing the 20MB buffer is treated as a RESULT, not a
failure** — returns what was captured with an honest truncation note. rg exit 1
= "No matches found." (not an error); exit ≥2 = error.

**Bash** — cwd persists across calls, env/functions do not. Timeout in ms,
default/max from constants; on timeout the whole PROCESS TREE is killed
(`killTree`). run_in_background returns a task id, streams output to a file, and
fires a task notification on exit. Interactive flags refused (no TTY).
DELETION GUARD: a hand-built matcher over single words
(rm/rmdir/rd/del/erase/unlink/rimraf/shred/trash/remove-item) and phrases
(git clean|rm|push --force|push -f|reset --hard|stash drop|stash clear,
terraform destroy, drop table/database, truncate table, kubectl delete),
matched case-insensitively as a STANDALONE token — so `npm run del-lint` does
not false-positive on `del`, and `format`/`mkdir` never match. Three cases need
their own patterns because the shared one cannot express them:
`git branch -D` (case-SENSITIVE, so safe `-d` never fires),
`git checkout -- <path>` (ends in non-word chars, needs a lookahead),
`find … -delete` (flag can sit anywhere in the segment).
`mv` counts only with -f/--force or a destination outside the workspace.

**Agent** — fresh subagent, own context window, restricted tool set, returns its
final report as the tool result. Parallel calls in one turn run concurrently.
Shares cwd, starts with NO memory of the conversation. Subagents cannot spawn
subagents and cannot ask the user questions. The picker list of agent types is
built on EVERY read, not captured in a module constant — so editing a blurb in
the registry reaches the model, and emptying one drops the type from the list
entirely (switching a prompt off means the same thing everywhere).

**AskUserQuestion** — up to 5 questions, blocks until answered. UI always adds an
"Other" free-text option.

**TaskCreate/Update/List/Get** — session task list with a real dependency graph.
List tags pending items `[pending READY]` or `[pending BLOCKED by #ids]` from
whether blockers are done. Update's contract: never mark completed while tests
fail or work is partial.

**TaskStop / TaskOutput** — control backgrounded Bash, Monitor, or background
Agent by task id. TaskOutput blocks by default until finish/timeout;
block:false returns what exists now. Unknown/finished ids are reported, not
errors to retry.

**WebFetch** — network class. http:// upgraded to https://. Same-host redirects
followed; a redirect to a DIFFERENT host is NOT followed — it returns the target
so the caller decides. 15-minute page cache. The answer is produced by a
separate DIGEST model call (settings.smallModel else the session model) over
extracted text.

**WebSearch** — three pluggable backends: DuckDuckGo (works with no key),
Brave, Tavily. allowed_domains / blocked_domains. `parseDuckDuckGoHtml` is
exported and independently testable.

**Monitor** — long-lived command; each stdout line becomes a batched event
delivered on the next turn. Explicitly the WRONG tool for a single event (use
backgrounded Bash that exits on the condition).

**EnterWorktree / ExitWorktree** — git worktrees under
`.magentra/worktrees/<name>`, branch `magentra/<name>`. Base ref from
`settings.worktree.baseRef`: "fresh" (origin's default branch) or "head";
defaults to fresh. Name validation: 1-64 chars, per-segment `[A-Za-z0-9._-]+`,
no empty/`.`/`..`. Random `wt-<hex>` when unnamed. Active worktree tracked in a
WeakMap keyed on SessionServices identity (per-session). Exit "keep" preserves;
"remove" REFUSES and lists the work if there are uncommitted changes or commits
not in the base ref, unless discard_changes. A worktree entered by existing path
is never removed. No-op when none active. Emits `cwd_changed`.

**GraphQuery** — 5 modes over the workspace import graph: `slice` (ranked
minimal context by personalized PageRank within a token budget, plus edges),
`blast` (transitive importers grouped by hop distance), `deps` (forward closure,
externals listed separately), `structure` (top files by PageRank, articulation
points, bridges, component/file/edge counts), `rank` (most central, optionally
seeded).

**Cron ×3 + ScheduleWakeup** — fire a prompt only when the minute matches AND
the session is IDLE (never mid-turn). Recurring jobs auto-expire 7 days after
creation. Session-only unless `durable`. ScheduleWakeup clamps to [60,3600]s,
fires once, then removes itself.

**PushNotification** — best-effort OS notification, platform-dependent, never
interrupts or fails the current work.

**Addon** — loads an addon's instructions into the conversation; substitutes
`$ARGUMENTS` or appends args.

**Workflow** — deterministic multi-subagent orchestration from a JS (not TS)
script that must open with a PURE literal `export const meta`. Hooks: agent()
(opts label/phase/agentType/model/schema; with schema the reply is JSON-Schema
validated, markdown fences stripped, ONE retry, null on failure), pipeline()
(per-item through all stages, NO barrier — the documented default),
parallel() (a barrier; a throwing thunk resolves null), phase(), log(), args,
and `budget` — output-token ceiling, ENFORCED: agent() throws once
remaining() hits 0. Concurrency capped at 4; total agent calls capped at 100.

## Candidate features (tools area) — 27 tools, ~31 test-worthy units
t-01 Registry registers exactly 27 tools, each with name/description/schema/class/execute
t-02 Read: image → vision description, refused without a vision model
t-03 Read: document extraction + 20MB cap + header
t-04 Read: binary NUL detection
t-05 Read: line window, clipping, continuation offset
t-06 Write/Edit: read-before-write freshness gate
t-07 Edit: uniqueness and replace_all semantics
t-08 file_edited diff emission from Write and Edit
t-09 Glob: .magentra excluded unless targeted (segment-anchored)
t-10 Glob: mtime ordering + 1000 cap
t-11 Grep: 3 output modes, flags, gitignore, exit-code mapping
t-12 Grep: maxBuffer overflow is a truncated result, not an error
t-13 Bash: deletion-guard matcher (incl. the 3 special-cased patterns and the mv rule)
t-14 Bash: timeout kills the whole process tree
t-15 Bash: background task id + streaming + completion notification
t-16 Bash: cwd persistence across calls
t-17 Agent: isolation, restricted tools, no nesting, no user questions
t-18 Agent: type list read live, disabled blurb drops the type
t-19 Task graph: READY/BLOCKED tagging from blockedBy
t-20 TaskOutput blocking vs non-blocking
t-21 WebFetch: https upgrade, cross-host redirect NOT followed, 15-min cache, digest model
t-22 WebSearch: 3 backends, domain filters, DuckDuckGo HTML parsing
t-23 Monitor: line→batched event delivery
t-24 Worktree: create/enter/exit, baseRef fresh|head, name validation
t-25 Worktree: remove refuses on uncommitted work or unmerged commits
t-26 GraphQuery: 5 modes
t-27 Cron: idle-only firing, 7-day expiry, durability
t-28 ScheduleWakeup: clamp + fire-once
t-29 PushNotification best-effort
t-30 Addon: $ARGUMENTS substitution vs append
t-31 Workflow: meta literal, pipeline vs parallel, schema retry, budget enforcement, caps
