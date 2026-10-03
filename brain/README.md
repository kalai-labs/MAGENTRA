# brain/

The single source of MAGENTRA's model-facing defaults: every prompt the engine
sends, every tool description, every tool parameter description, which
built-in tools a session is offered, and the behaviour knobs that decide when
that prose fires and how hard the agent pushes (`behavior.json`). Code keeps
the logic and the schema *shape* (zod types, optional/required); the prose and
the policy values live here.

The engine never reads this folder at run time. `npm run build` runs
`tools/brain/compile.mjs` first, which validates brain/ and writes
`engine/protocol/src/brain.generated.ts` (gitignored). `tsc -b` compiles that
module into `engine/protocol/dist`, and the app bundle inlines it into
`engine.cjs`, so a packaged install carries these defaults with no brain/
folder beside it.

**Editing it.** `npm run brain-editor` opens the brain editor
(`tools/brain-editor/README.md`): a page that shows and edits everything here,
and the same editor as a command line for agents
(`npm run -s brain-editor -- help changes`). It writes these files by the rules
below, and saves nothing that the compiler or the built engine refuses. Hand
edits remain fine; the rules below are what both must follow.

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
- a Monitor's `<task-notification>` event lines (a background task's exit
  and a Monitor's noise stop are prompts here, `reminder.background-exit` and
  `reminder.monitor-noise-stop`; switched off, each still sends a bare
  one-line notification, because the model must learn the task ended);
- user-visible status lines (`command_output` text: ⏸ ↻ ⚡ ⚙).

Known residuals, recorded for a person to reword through an approved change
(each is a model-facing change):

- The `where` of `finishing.browser-evidence` says it shares the
  runtime-evidence fuse; each rung has its own count
  (`finishing.*.maxNudges`).
- Frontend copy that describes OVERDRIVE as "nothing asks, everything runs"
  (app/renderer, tui TrustGate) is outside brain. Moving an
  `overdrive.guards.*` key to `"refuse"`, or the OVERDRIVE self-verify rounds,
  makes that copy false; the engine's own status lines follow the knobs.

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
  behavior.json                          the behaviour knobs
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
the text. An empty body is an error, except in a prompt marked
`enabled: false`.

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

A core-system section carries one more line, `order: 20`, after
`placeholders` (or after `where`). Any prompt may carry `enabled: false` there
as well.

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
- `order` is **required** on every file in `1-core-system` and allowed nowhere
  else: a non-negative integer, unique in that folder.
- `enabled: false` is allowed on any prompt. Only `false` is accepted; delete
  the line to enable the prompt.

**`order:` — brain decides the system prompt's sections.** The engine opens
the system prompt with the `1-core-system` files sorted by `order`
(`BRAIN_CORE_ORDER`, read through `coreSectionOrder()`). Each is rendered with
`{{product}}` and `{{repo}}` filled, trimmed, and dropped when blank; the
sections are joined with one blank line. Two of them are data sections whose
text code fills: `system.environment` (the cwd/platform/model block) and
`system.addons-block` (the addon roster, only when an addon is installed).
They hold their place in the order like any other section. `behaviorCore()` is
the order without those two. The shipped numbers are 10, 20 … 110; the gaps
leave room to insert. A new section file added here with an `order` joins the
prompt with no code change. Today
`tests/features/brain-is-the-single-source.test.ts` fails on a new core file
whose id no `brainPrompt("<id>")` call names.

**`enabled: false` — switch a prompt off from brain.** The prompt registers
BLANK (its default text is `""`), which is exactly what a blank override file
does: a system section is dropped, a reminder is never injected, a side call
whose prompt is off does not run, and a wrapper falls back to the bare fact it
wraps. An end-of-turn rung whose own text is off (`reminder.recovery-nudge`,
`reminder.incomplete-tasks`, `finishing.runtime-evidence`,
`finishing.browser-evidence`, `finishing.self-verify`, `reminder.wrapup-nudge`)
does not fire at all: no status line, no message, no extra model call, and its
count is not spent. `reminder.length-continuation` off switches every
output-length resume off, the context-overflow resume included: the cut-off
answer is delivered as is. The catalog reports it `disabled`. A user's non-blank override file
still wins over it. The body may be empty, or kept for later; it is not
shipped either way. The shipped brain uses no `enabled: false`.

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

## `behavior.json` — the behaviour knobs

Prose alone cannot change when prose fires or what the harness does. This file
holds those policy values: which end-of-turn rungs run and how far they push,
the stall detector's thresholds, clarify's limits, what OVERDRIVE does beyond
its prompt section, and the plain-word lists the evidence rungs judge by. Every
shipped value equals the constant it replaced, so the shipped brain behaves
exactly as the engine did before the file existed. Change a value, run
`npm run build`, and the behaviour changes.

`tools/brain/compile.mjs` holds the one definition of every key
(`BEHAVIOR_SPEC`: type, range, doc string, and **no values**). The values live
only here. The compiler emits three things into `brain.generated.ts`:

- `BrainBehavior`, the typed shape (and `BrainBehaviorOverrides`, the partial
  `overdrive.overrides` takes), with each key's range and doc as JSDoc;
- `BRAIN_BEHAVIOR`, this file, validated, keys in spec order;
- `BRAIN_BEHAVIOR_SPEC`, the rules as data, which the runtime seam validates
  against.

**Validation.** The file must be complete: every key, nothing else. Each
problem names the dotted key:

```
behavior.json: unknown key "finishing.nudgeBudgt"
behavior.json: missing key "stall.pivots"
behavior.json: finishing.nudgeBudget must be an integer (got "3")
behavior.json: finishing.nudgeBudget: 11 is out of range 0..10
behavior.json: overdrive.guards.deletions: "ask" is not one of "run", "refuse"
behavior.json: evidence.codeExtensions[1]: "TS" does not match /^\.[a-z0-9+_-]+$/
behavior.json: evidence.codeExtensions lists ".ts" twice
behavior.json: in OVERDRIVE (overdrive.overrides applied): context.compaction.forceKeepTailMessages (2) must not be more than context.compaction.keepTailMessages (1)
```

The one cross rule: `context.compaction.forceKeepTailMessages` ≤
`context.compaction.keepTailMessages`, checked on the base and on the base with
`overdrive.overrides` applied.

**Settings stay settings.** brain holds the default POLICY of a build, the same
for every user. `~/.magentra/settings.json` holds per-user choices, and
behavior.json duplicates none of them. There is no per-user override layer for
these keys. The only other channel is `EngineOptions.behavior` /
`SessionOptions.behavior` (`BehaviorOverride`): an embedder and test seam like
`toolAvailability`, merged over the shipped object, validated by the same
rules, and never persisted. Where a setting and a key meet:

- `settings.clarify` decides whether clarify runs at all; `clarify.enabled` is
  ANDed with it, so brain can only switch clarify off. `settings.model` and
  `settings.smallModel` name the models; `clarify.model` picks one of the two.
- `settings.maxTokensPerResponse` decides how often a response is cut off;
  `finishing.lengthCutoff.*` decides whether and how often it is resumed.
- `settings.compactionThreshold` / `contextWindow` decide when compaction
  fires; `context.*` decides what it keeps and how many overflow recoveries a
  turn gets.
- The Allow-deletions toggle governs attended deletions; `overdrive.guards.*`
  govern only the OVERDRIVE stance. User allow and deny rules sit above every
  key here.

### The keys

`int a..b` is an integer in that range (inclusive). Every finite range exists
so no value can loop a turn. "Reads" names where the engine reads the key.

**`finishing` — the end-of-turn ladder.** The rung order, each rung's
`end_turn` requirement, steering being drained first, the Stop-hook fuse and
the DONE sentinel stay in code.

| key | type | ships | effect | reads |
| --- | --- | --- | --- | --- |
| `nudgeBudget` | int 0..10 | 3 | Per-turn budget shared by the error-recovery nudge (rung 4) and the wrap-up nudge (rung 9). 0 switches both off. | session.ts rungs 4 and 9 |
| `maxNamedFiles` | int 1..50 | 8 | How many changed files the runtime-evidence, browser-evidence and self-verify closing texts name before " and N more". | finishing.ts |
| `lengthCutoff.enabled` | boolean | true | false: a text answer cut off at the output limit ends the turn as delivered, not resumed with `reminder.length-continuation`. A cut-off tool call is still refused with `reminder.tool-cutoff`. | session.ts rung 3 |
| `lengthCutoff.maxStreak` | int 0..10 | 3 | Consecutive output-limit cutoffs a turn resumes (text) or rides through (tool calls) before it ends visibly. 0: the first cutoff ends the turn. | session.ts rung 3, tool-cutoff bound |
| `errorRecovery.enabled` | boolean | true | false: a turn ending right after a failed batch is not nudged. The failed-batch flag is then never spent, so rungs 5 and 9 skip that end too. | session.ts rung 4 |
| `incompleteTasks.maxNudges` | int 0..3 | 1 | Times per turn `reminder.incomplete-tasks` may fire. 0 = off. | session.ts rung 5 |
| `runtimeEvidence.maxNudges` | int 0..3 | 1 | Times per turn `finishing.runtime-evidence` may fire. 0 = off. | session.ts rung 6 |
| `browserEvidence.maxNudges` | int 0..3 | 1 | Times per turn `finishing.browser-evidence` may fire. 0 = off. | session.ts rung 7 |
| `selfVerify.maxRounds` | int 0..3 | 0 | Silent DONE-or-continue self-check rounds per turn. 0 = off. Steering re-arms the count. Ships 0 here and 1 in `overdrive.overrides`: today's "self-verify only in OVERDRIVE". | session.ts rung 8 |
| `selfVerify.minToolCalls` | int 0..1000 | 1 | The least tool calls before a turn is self-verified. 0 lets a chat-only turn self-verify. | session.ts rung 8 |
| `selfVerify.maxSymptoms` | int 0..20 | 6 | How many of the latest reported failures the self-check quotes back. 0 drops that clause. | session.ts rung 8 |
| `selfVerify.maxHedges` | int 0..20 | 5 | How many hedging sentences of the answer the self-check quotes. 0 drops that clause. | finishing.ts findHedges |
| `wrapUp.enabled` | boolean | true | false: a bare final reply is never asked for a summary. | session.ts rung 9 |
| `wrapUp.minToolCalls` | int 0..1000 | 5 | The least tool calls before a short answer counts as a missing wrap-up. | session.ts rung 9 |
| `wrapUp.answerShorterThanChars` | int 0..100000 | 150 | An answer shorter than this, after enough tool calls, gets the wrap-up nudge. 0: never. | session.ts rung 9 |

Self-verify runs in ROOT sessions only. A subagent child never self-verifies,
whatever these values say: its DONE would become the answer it returns to
its parent. The context-overflow resume is separate from `lengthCutoff`: the
engine resumes after an overflow compaction even with `lengthCutoff.enabled`
false or a `maxStreak` of 0 (it is bounded by `context.overflowRecoveries`). It
still counts in the cutoff streak, as it always did: a streak made only of
recovered overflows is always resumed, and once plain cutoffs are mixed in the
streak is judged against `maxStreak` with the overflows included.

**`stall` — the stall detector.** It always runs: it is the only brake on a
looping uncapped root turn. Each value either reminds or asks.

| key | type | ships | effect | reads |
| --- | --- | --- | --- | --- |
| `repeatRounds` | int 2..10 | 3 | Identical rounds in a row (same calls, same results) that count as a stall. | session.ts stall detector |
| `pivots` | int 0..5 | 2 | Stalls that get `reminder.stall-pivot` before every later stall gets `reminder.stall-ask`. The status line shows `n/pivots`. | session.ts stall detector |

**`reminders` — reminders the session injects on its own.**

| key | type | ships | effect | reads |
| --- | --- | --- | --- | --- |
| `planFirst.enabled` | boolean | true | false: no turn-start nudge to lay out multi-step work. Applies to children as to the root. | session.ts turn start |
| `errorBatch.enabled` | boolean | true | false: a failed batch carries no "fix and continue" reminder. | session.ts after a batch |
| `silentReasoning.enabled` | boolean | true | false: long silent reasoning never asks for a sentence to the user. | session.ts (root only) |
| `silentReasoning.thresholdChars` | int 500..1000000 | 8000 | Characters of reasoning with no visible text before `reminder.silent-reasoning` fires, once per silent stretch. | session.ts |

**`clarify` — the clarify pre-layer** (root sessions only, never with a named
addon).

| key | type | ships | effect | reads |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | true | ANDed with `settings.clarify`: brain can switch clarify off, never force it on. | session.ts clarify gate |
| `maxQuestions` | int 1..5 | 5 | How many of the verdict's questions reach the user. | session.ts |
| `model` | `"main"` \| `"small"` | `"main"` | Which configured model judges: `settings.model`, or `settings.smallModel` (falling back to `settings.model`). | session.ts clarify call |
| `skim.enabled` | boolean | true | false: the clarify call gets no "Codebase overview". | session.ts |
| `skim.peekFiles` | 0..20 bare file names | README.md … go.mod (8) | Overview files the peek reads, richest first, when the import graph parses nothing. | session.ts |

**`context`, `tools`.**

| key | type | ships | effect | reads |
| --- | --- | --- | --- | --- |
| `context.overflowRecoveries` | int 0..5 | 2 | Compact-and-retry attempts per turn after a context overflow. 0: the first overflow errors out. | session.ts |
| `context.compaction.keepTailMessages` | int 1..50 | 6 | Recent messages an automatic compaction keeps verbatim. | session.ts compaction |
| `context.compaction.forceKeepTailMessages` | int 1..50 | 2 | Recent messages `/compact` and overflow recovery keep. Never more than `keepTailMessages`. | session.ts compaction |
| `tools.defaultOutputBytes` | int 1000..1000000 | 40000 | Byte cap on a tool result for a tool with no limit of its own. Per-tool limits (Read's 250000) stay tool code. | session.ts tool results |

**`evidence` — the detector lists.** Every entry is plain text, never a regex:
the engine escapes and joins them, so no entry can make a pattern
catastrophic. Lists are unique, lower-case where they are matched
case-insensitively.

| key | entries | ships | effect | reads |
| --- | --- | --- | --- | --- |
| `codeExtensions` | 1..200 suffixes (`.ts`) | 46, `.ts` … `.less` | Changed files that count as runnable source (rung 6, self-verify's closing-code clause). | finishing.ts |
| `uiExtensions` | 0..100 suffixes | 10, `.html` … `.tsx` | Changed files a user sees in a browser (rung 7). Empty: rung 7 never fires. | finishing.ts |
| `uiExcludeInfixes` | 0..20 words | test, spec, stories | `name.<infix>.ext` is a test or story, never the page. | finishing.ts |
| `testDoubleMarkers` | 0..500 substrings, 1..200 chars, one line | 22, `unittest.mock` … `def stub_` | Text that marks written code as a self-written test double (rung 6's second shape). Empty: that shape is off. | finishing.ts |
| `browserRun.tools` | 1..100 words | playwright … wkhtmltoimage (7) | Whole command words that drive a browser. | finishing.ts |
| `browserRun.flags` | 0..20 flags | `--headless`, `--screenshot` | Flags that drive a browser. | finishing.ts |
| `browserRun.readOnlyHeads` | 1..100 words | cat … file (25) | Command heads that only mention a browser tool. | finishing.ts |
| `screenshotExtensions` | 0..20 suffixes | png, jpg, jpeg, gif, webp, bmp | A successful Read of such a file counts as looking at the page. | session.ts |

**`overdrive` — what OVERDRIVE does beyond `system.overdrive` and
availability.json.**

| key | type | ships | effect | reads |
| --- | --- | --- | --- | --- |
| `overrides` | partial of the sections above | `{"finishing": {"selfVerify": {"maxRounds": 1}}}` | See below. | session.ts via `effectiveBehavior` |
| `preTurnSnapshot.enabled` | boolean | true | false: no `git stash create` before OVERDRIVE turns. A failed snapshot never blocks a turn. | session.ts |
| `preTurnSnapshot.timeoutMs` | int 1000..120000 | 10000 | Longest a turn waits for the snapshot. Never 0, which execFile reads as no timeout. | session.ts |
| `guards.deletions` | `"run"` \| `"refuse"` | `"run"` | A deletion at a non-protected path. | permissions.ts |
| `guards.protectedDeletions` | `"run"` \| `"refuse"` | `"run"` | A deletion of `.magentra` state. | permissions.ts |
| `guards.protectedEdits` | `"run"` \| `"refuse"` | `"run"` | Write or Edit into `.magentra/` or a `.env` file. | permissions.ts |
| `guards.outsideWorkspaceEdits` | `"run"` \| `"refuse"` | `"run"` | Write or Edit outside the workspace. | permissions.ts |

### `overdrive.overrides`

A deep partial of `finishing`, `stall`, `reminders`, `clarify`, `context`,
`tools` and `evidence`, merged over those sections while OVERDRIVE is on. It
applies to ROOT sessions only: a subagent child runs the base values. Each
leaf is validated by the same rule as the key it overrides, and an unknown key
fails (`unknown key "overdrive.overrides.finishing.x"`). A list in an override
replaces the whole list. `overdrive` itself cannot be overridden. So OVERDRIVE
can push harder or softer than normal mode from brain alone, for example
`{"finishing": {"nudgeBudget": 5}, "stall": {"pivots": 1}}`.

In a `BehaviorOverride` (the runtime seam), `overdrive.overrides` is one value:
it replaces the shipped overrides object whole, so `{ overdrive: { overrides:
{} } }` means "no OVERDRIVE overrides".

### `overdrive.guards`: tighten-only

OVERDRIVE never asks, because nobody is there to answer. Each guard either
runs the call unasked (`"run"`, the shipped value) or refuses it (`"refuse"`)
with its own refusal text: `reminder.overdrive-deletion-refused`,
`reminder.overdrive-protected-edit-refused` or
`reminder.overdrive-outside-edit-refused`. Those three texts are sent only
under `"refuse"`.

- The protected decision is taken first, and its value wins: a `.magentra`
  deletion follows `protectedDeletions`, never `deletions`.
- An explicit narrow allow rule, or a literal grant, passes a `deletions` or
  an `outsideWorkspaceEdits` refusal only. Nothing passes a
  `protectedDeletions` or a `protectedEdits` refusal: a protected refusal is
  absolute. (Outside OVERDRIVE a narrow grant does satisfy the attended
  protected-path ask, which is a separate check.)
- `protectedEdits` and `outsideWorkspaceEdits` cover the Write and Edit tools
  only. A shell redirect (`echo x > .env`) is not covered.
- Deletion detection is best-effort: it reads a command's targets, and a
  directory change earlier in a compound command is not followed. Treat
  `"refuse"` as a strong default, not a sandbox.
- Worktree removal counts as a deletion: under `deletions: "refuse"` the
  agent cannot remove its worktree. A worktree lives under
  `.magentra/worktrees/`, so under `protectedEdits: "refuse"` no Write or Edit
  inside it runs either.
- Deny rules always refuse first, and the kill-by-name refusal (taskkill /IM,
  pkill, killall, Stop-Process -Name) is a fixed floor with no key.
- A refused call can be retried by the model. In an uncapped root turn the
  stall detector's reminders are what bound that.

### Prose that states a knob's value

Some prompts tell the model a fact that is only true for some knob values. The
compiler checks them (`CLAIMS` in compile.mjs) against the model-facing TEXT,
never the `where` line (no model reads it). When a knob makes the phrase false,
the build prints a WARNING, never a failure, naming the prompt file and the
phrase to reword:

```
brain: warning: prompts/2-conditional-system/system.overdrive.md: says "Every call runs the moment you make it", which is not true with overdrive.guards.deletions = "refuse", … — reword the prompt
```

| prompt | phrase | true while |
| --- | --- | --- |
| `system.overdrive` | "Every call runs the moment you make it" | every `overdrive.guards.*` is `"run"` |
| `system.overdrive` | "Only two things can still stop a call" | every `overdrive.guards.*` is `"run"` |
| `system.overdrive` | "deletions at any path" | `guards.deletions` and `guards.protectedDeletions` are `"run"` |
| `system.overdrive` | "edits to \`.magentra\` state and \`.env\` files" | `guards.protectedEdits` is `"run"` |
| `system.overdrive` | "writes outside the workspace" | `guards.outsideWorkspaceEdits` is `"run"` |
| `system.harness` | "if an OVERDRIVE section appears, not even on those" | `guards.deletions`, `protectedDeletions` and `protectedEdits` are `"run"` |
| `system.deletion-policy` | "They run without an extra confirmation prompt" | `guards.deletions` and `guards.protectedDeletions` are `"run"` (checked for OVERDRIVE, where the guards apply) |
| `reminder.stall-ask` | "strategy pivots have not produced progress either" | `stall.pivots` ≥ 1, in both stances |

Rewording the phrase away silences its claim. Several `where` lines also state
shipped values (`reminder.recovery-nudge` "Capped at 3",
`reminder.silent-reasoning` "8,000+", `reminder.stall-pivot` "three
consecutive", `finishing.self-verify` "never in normal mode"); they are
metadata for a person and are not checked.

### Deliberately not knobs

| stays in code | why |
| --- | --- |
| The ladder's order and its bounds mechanism (end_turn requirement, steering first, each rung's count, the Stop-hook fuse, the DONE sentinel) | Load-bearing order and loop bounds. Only on/off, counts and budgets are exposed. |
| The stall detector's existence and fingerprint | It is the only brake on a looping uncapped root turn. |
| Deny rules, and the resolution order deny > kill > protected > deletion > allow > stance | Safety floor. |
| Every tool_use gets a tool_result (synthetic results, refusals, the `Permission denied.` fallback) | Safety floor; the provider rejects a dangling call. |
| The attended guards (protected-path ask, deletion guard, outside-workspace ask) | They ARE the floor outside OVERDRIVE; the Allow-deletions toggle is the per-user switch. |
| Kill-by-name in OVERDRIVE | "refuse" is the only value safe unattended; a one-valued key is not a choice. |
| The deletion and kill detection lists | Exposing them would let brain shrink a guard. |
| The self-verify symptom, hedge and not-a-symptom regexes; browser install patterns | English regexes: raw regex from brain invites ReDoS. |
| Compaction sizing internals (summary budget, clip sizes, chunk sizes) | Derived from the window; a bad value loops or crashes. When compaction fires is the user's setting. |
| Clarify's verdict-call token budget, skim size internals, option bounds (2..4) and header length | Copies of the AskUserQuestion schema or parser robustness. |
| Root-turn caps (`maxIterationsPerTurn` / `maxTokensPerTurn` on the root) | Interactive root turns run uncapped by design; the values are settings. |
| Cron, wakeup and tool limits | Stated in tool descriptions; a knob would leave the description stating a value the code no longer uses. |
| The OVERDRIVE boot stance | Owned by the frontends (the app re-sends it; the TUI trusts folders). |
| Subagent internals (`agents.ts`, `subagent.*`, child limits) | Out of scope. Children inherit the root's resolved base behaviour. |
| Frontend copy describing OVERDRIVE (app/, tui/) | Untyped frontend text brain cannot reach; recorded as a residual above. |

## How code reads it (`@magentra/protocol`)

| need | call |
| --- | --- |
| a prompt id, in place of a `definePrompt({...})` literal | `const X = brainPrompt("reminder.stall-ask")`, then `promptText(X)` / `renderPrompt(X, vars)` as before |
| a tool's description template | `description: toolDescription("Read")` |
| a parameter's `.describe()` text | `z.string().describe(toolParam("Read", "file_path"))` |
| the shipped tool sets | `brainAvailability()` |
| a prompt's shipped default, never an override (safe at module load) | `promptDefault("system.git")` |
| a params.md text that states a code constant | `assertToolParamStates("Monitor", "timeout_ms", "(default 300000)")`, with the value built from the constant |
| a prompt rendered, or undefined when it is switched off | `renderPromptIfEnabled(X, vars) ?? fact` |
| the core sections in brain's order | `coreSectionOrder()` |
| the shipped behaviour (deep-frozen) | `brainBehavior()` |
| the behaviour a session runs with: shipped, or an `EngineOptions.behavior` override merged in and validated | `resolveBehavior(override?)` |
| what a session reads right now (OVERDRIVE overrides applied for a root session) | `effectiveBehavior(resolved, overdrive && !child)` |
| a test's one-knob change | `behaviorWith({ finishing: { nudgeBudget: 1 } })`, passed as `EngineOptions.behavior` |
| validate a complete behaviour object, in the compiler's words | `behaviorProblems(value)` |

Each accessor throws on an unknown key while its module loads, so a typo fails
the import instead of sending the model something else.

## Verify

The CLI (and so `npm run build`) also requires the brain to be complete: a
folder for every built-in tool, a file for every id the engine's source
names with `brainPrompt("<id>")`, and `behavior.json`. A deleted file fails the
build, not the first import. (`compileBrain(dir)` imported without
`{ complete: true }` accepts a partial brain, for tests of one rule at a time;
it still validates a `behavior.json` that is present.) Claim warnings print as
`brain: warning: …` and never fail the build.

```bash
node tools/brain/compile.mjs --check   # validate brain/, and fail if the generated module is stale
npm run build                          # compile brain/, then tsc -b
npm test                               # brain-is-the-single-source, brain-controls-behavior, …
```

Use `node tools/brain/compile.mjs --brain <dir> --out <file>` to compile
another folder without touching the real generated module.

No test holds the wording of a prompt or tool text (`docs/decisions/0016`):
tests read the text they need from brain, so a rewording stays green. It still
changes what every session sends, so the owner approves it (AGENTS.md rule 5).
Three things do depend on words, and a rewording must keep them:

- `finishing.self-verify` must tell the model to answer with the word
  `isSelfVerifyDone()` accepts (`DONE`), or an OVERDRIVE self-check round can
  never end;
- the Monitor `timeout_ms` and PushNotification `message` parameter texts must
  state the code's values (`assertToolParamStates()`), or the engine refuses
  to load;
- a `CLAIMS` phrase in `tools/brain/compile.mjs` only warns while the phrase
  is in its prompt; reword the phrase away and that claim guards nothing.
