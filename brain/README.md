# brain/

The single source of MAGENTRA's model-facing defaults: every prompt the engine
sends, every tool description, every tool parameter description, and which
built-in tools a session is offered. Code keeps the logic and the schema
*shape* (zod types, optional/required); the prose lives here.

The engine never reads this folder at run time. `npm run build` runs
`tools/brain/compile.mjs` first, which validates brain/ and writes
`engine/protocol/src/brain.generated.ts` (gitignored). `tsc -b` compiles that
module into `engine/protocol/dist`, and the app bundle inlines it into
`engine.cjs`, so a packaged install carries these defaults with no brain/
folder beside it.

User overrides still apply on top, unchanged: `~/.magentra/prompts/<id>.txt`
(or `$MAGENTRA_PROMPTS_DIR/<id>.txt`) replaces a prompt's default, and a blank
override file switches it off. A tool's description is the prompt
`tool.<Name>`.

## The one exception

The `subagent.*` prompts (group `6 · Subagents (Agent tool)`) and
`engine/core/src/agent/agents.ts` stay in code as literals. The compiler
rejects a `subagent.*` id or a group-6 folder here.

## What stays in code

brain/ holds the prose the engine writes to steer the model: system and
conditional sections, reminders, finishing rungs, refusal and wrapper texts the
session composes (`Tool failed: {{error}}`, the hook wrappers, the switched-off
refusal), and every side call's system prompt and instruction. What stays in
code is text that only frames or reports runtime data:

- labels around data in a side call's user message (clarify's
  `Codebase overview:` / `Incoming request:`, WebFetch's `Page URL:` /
  `Page content:` / `Question:`, the auto-namer's `---` fences);
- a tool's own result text: what it did, its errors, Bash's background notice,
  WebFetch's redirect notice;
- refusals that report a fact: `Unknown tool "…". Available tools: …`,
  `Invalid input for …: <zod issues>`, the `Permission denied.` fallback;
- `<task-notification>` event reports (a background task's exit, a Monitor's
  event lines, its noise stop);
- user-visible status lines (`command_output` text: ⏸ ↻ ⚡ ⚙).

Known residuals, recorded for a person to reword through an approved change
(each is pinned bytes or a model-facing change):

- With Agent withheld by default, the TaskOutput and TaskStop descriptions
  still mention a background Agent, and `reminder.stall-ask` still says
  "(you are a subagent)".
- Monitor's noise-stop notification (engine/tools/src/monitor.ts) sends the
  literal text `{{noiseLimit}}` and `{{noiseWindowSec}}`: it was never rendered,
  before or after the move.

## Layout

```
brain/
  README.md                              this file
  availability.json                      the tool set per context
  prompts/<group-dir>/<id>.md            one file per prompt
  tools/<ToolName>/description.md        the tool's description template
  tools/<ToolName>/params.md             optional: its parameters' descriptions
```

`<group-dir>` is fixed by the prompt's group:

| group | folder |
| --- | --- |
| `1 · Core system prompt` | `1-core-system` |
| `2 · Conditional system sections` | `2-conditional-system` |
| `3 · In-turn reminders` | `3-in-turn-reminders` |
| `4 · End-of-turn rungs` | `4-end-of-turn-rungs` |
| `5 · Background inference calls` | `5-background-inference` |
| `7 · Tool descriptions` | `7-tool-descriptions` (non-`tool.*` prompts only; tool descriptions live in `tools/`) |

## File rules

These rules are exact. What the model receives is the compiled bytes, so a
stripped trailing space or a lost final newline changes a prompt.
`brain/.editorconfig` and `brain/.gitattributes` protect the folder, and the
compiler folds CRLF to LF (and drops a leading BOM) before anything else.

**Frontmatter.** The first line is exactly `---`. Then come `key: value` lines,
each with exactly one space after the colon, a non-empty value, no leading or
trailing whitespace, and one physical line per value. Then a line that is
exactly `---`. Unknown, duplicate or missing keys are errors.

**Body.** The body is everything after the closing `---` line, minus exactly
one trailing `\n`. The file must end with a newline. Nothing else is trimmed:
a leading blank line, a trailing space, or a second trailing newline is part of
the text. An empty body is an error.

### `prompts/<group-dir>/<id>.md`

```
---
id: reminder.stall-ask
group: 3 · In-turn reminders
label: Stall — ask the user
channel: reminder
where: When it fires and what it is for, on one line.
placeholders: name, tasks
---
<the exact prompt text>
```

- `id` must equal the file name without `.md`. It is a dotted lower-case id,
  and it is also the override file name (`<id>.txt`). It may not start with
  `subagent.` or `tool.`.
- `group` must be the exact group string of the folder it sits in.
- `channel` is one of `system`, `system-conditional`, `reminder`, `tool`,
  `side-call`, `side-call-user`, `subagent`.
- `placeholders` is optional. It lists the `{{name}}` slots the engine fills,
  separated by commas, in the order the code declares them. Omit the line when
  there are none. Every `{{slot}}` in the text must be listed. A listed name
  with no slot is allowed (`system.identity` ships that way).
- Duplicate ids anywhere under `prompts/` are errors.

### `tools/<ToolName>/description.md`

```
---
name: Read
---
<the description TEMPLATE, {{slots}} unfilled>
```

The folder name must be a built-in tool (`BUILTIN_TOOLS` in
`tools/brain/compile.mjs`), and `name` must equal the folder name. Slot values
(`descriptionVars`) stay in code. Each tool has its own folder because some
descriptions (TaskCreate, TaskUpdate, Write) contain `## ` headings of their
own. Only `description.md` and `params.md` may sit in a tool folder.

### `tools/<ToolName>/params.md`

```
## file_path
The absolute path to the file to read

## offset
The line number to start reading from. Only provide if the file is too large to read at once
```

- There is no frontmatter. The first line is a heading.
- A heading is a line that starts with `## ` at column 0. Its path runs to the
  end of the line and contains no whitespace. A path is either:
  - dot-separated field names, where array elements are transparent:
    `questions.options.label` is the `label` field of the elements of
    `questions[].options[]`, and a `.describe()` on an array itself is at the
    array's path; or
  - `(root)`, for a `.describe()` on the tool's schema object itself (Workflow).
- A section's text is the lines after its heading, up to the next heading or
  the end of the file. Every section except the last ends with its text's own
  newline followed by exactly one blank line. The last section ends with one
  newline. The compiler removes exactly those characters and nothing else.
- A `.describe()` text containing a line that starts with `## ` cannot be
  written here, because it would read as a heading.
- Duplicate paths and empty sections are errors.
- `{{...}}` in a parameter text is not a slot. It is sent as written (Bash's
  `timeout` ships a literal `{{maxTimeout}}`).
- A section that states a value the code owns (Monitor's `timeout_ms` default,
  PushNotification's `message` cap) is checked against that constant with
  `assertToolParamStates` when the tool module loads, so changing one without
  the other fails the import.
- A section that no `toolParam()` call reads is an orphan.
  `unreadToolParams()` lists them once the tool modules have loaded.

### `availability.json`

```json
{ "main": ["Read", "..."], "overdrive": ["Read", "..."] }
```

This file names the built-in tools a **root** session offers: `main` while
OVERDRIVE is off, `overdrive` while it is on.

- A built-in tool missing from the current context's list is not offered in
  `toolSchemas()`, so it is neither sent to the model nor counted in context.
  A call to it is refused by name, with the same text as a switched-off tool.
- The file applies only to built-in tools. MCP tools (`mcp__*`) and any tool an
  embedder registers itself are never filtered by it.
- Child (subagent) sessions ignore it. They keep their agent type's tool subset
  (agents.ts).
- An entry naming a tool that is not built-in fails the compile with that name.
  Duplicate entries fail too, as does any key other than `main` and `overdrive`.
- It ships with every built-in tool except `Agent` and `Workflow`, in both
  contexts. An embedder or test can override it per engine with the
  `EngineOptions.toolAvailability` field (or the `SessionOptions` field of the
  same name), for example `toolAvailabilityWith("Agent")` from
  `@magentra/protocol`. This is not a setting and is never persisted.

## How code reads it (`@magentra/protocol`)

| need | call |
| --- | --- |
| a prompt id, in place of a `definePrompt({...})` literal | `const X = brainPrompt("reminder.stall-ask")`, then `promptText(X)` / `renderPrompt(X, vars)` as before |
| a tool's description template | `description: toolDescription("Read")` |
| a parameter's `.describe()` text | `z.string().describe(toolParam("Read", "file_path"))` |
| the shipped tool sets | `brainAvailability()` |
| a prompt's shipped default, never an override (safe at module load) | `promptDefault("system.git")` |
| a params.md text that states a code constant | `assertToolParamStates("Monitor", "timeout_ms", "(default 300000)")`, with the value built from the constant |

Each accessor throws on an unknown key while its module loads, so a typo fails
the import instead of sending the model something else.

## Verify

The CLI (and so `npm run build`) also requires the brain to be complete: a
folder for every built-in tool, and a file for every id the engine's source
names with `brainPrompt("<id>")`. A deleted file fails the build, not the
first import. (`compileBrain(dir)` imported without `{ complete: true }`
accepts a partial brain, for tests of one rule at a time.)

```bash
node tools/brain/compile.mjs --check   # validate brain/, and fail if the generated module is stale
npm run build                          # compile brain/, then tsc -b
npm test                               # the pins: system-prompt-is-pinned, tool-wire-contract-is-pinned
```

Use `node tools/brain/compile.mjs --brain <dir> --out <file>` to compile
another folder without touching the real generated module.

Rewording a prompt or tool text here moves pinned bytes
(`tests/approved/`). Only a person approves that. See AGENTS.md rule 5. The
prompts the pins do not cover (reminders, rungs, side calls) are held against
their pre-migration text by `tests/features/fixtures/brain-baseline/`, which a
person updates with the rewording.
