# Magentra — Architecture

Magentra is a headless agentic coding engine plus a terminal frontend. The core is
UI-agnostic: it emits typed events and consumes typed requests over a versioned protocol,
so a terminal REPL today and a VS Code fork tomorrow are both thin clients of the same
engine.

This document is the build-time alignment artifact. It is kept current as phases land.

## Package layout

```
packages/
├── protocol/    # typed event/request schema + NDJSON framing + product branding constants
├── providers/   # Provider interface, AnthropicProvider, FakeProvider
├── core/        # Session, agent loop, permission engine, prompt assembly,
│                # context/compaction, transcript store, settings, subagent spawner
├── tools/       # every built-in tool, one module each, registered via a registry
└── cli/         # terminal frontend: full-screen matrix TUI (tui/), readline
                 # REPL fallback, and `magentra --serve` stdio mode
```

### CLI frontends

`cli` ships two human-facing presentations of the one event protocol, chosen at
startup in `main.ts`:

- **Matrix TUI** (`src/tui/`) — the default on an interactive, colour-capable
  TTY. A hand-rolled full-screen ANSI interface (alternate screen buffer, raw-mode
  line editor, digital-rain splash, green-phosphor theme). Pure logic is isolated
  from I/O for unit testing: `ansi.ts` (palette + escape primitives), `wrap.ts`
  (ANSI-aware wrapping), `keys.ts` (keypress decoder), `lineEditor.ts`, `rain.ts`
  (deterministic with an injected RNG), `statusBar.ts`, and `render.ts` (events →
  transcript lines). `screen.ts` and `tui.ts` hold the terminal I/O and the
  event-loop wiring; `tui.ts` restores the terminal on every exit path (quit,
  SIGINT/SIGTERM, uncaught exception).
- **Readline REPL** (`src/repl.ts`) — the non-TTY fallback (pipes/CI), and also
  used when `TERM=dumb` or `NO_COLOR` is set. Same event stream, no escape codes.

Both share `src/shared.ts` — input-line classification and the y/a/n permission,
plan, and question answer parsers — so the two frontends can never drift on those
semantics. Mid-turn permission/question/plan prompts are serialized through the
same async mutex in both; the engine protocol is identical either way.

Dependency direction (strict, enforced by TS project references):

```
protocol  ←  providers  ←  core  ←  tools  ←  cli
```

- `protocol` has zero dependencies. It defines the seam a future IDE consumes.
- `core` never imports from `tools`; tools are injected at startup via the registry.
  This keeps the engine embeddable with any tool subset (subagents use restricted sets).
- `cli` is the only package allowed to touch stdin/stdout for user interaction.
  `core` has no `console.log` for user output — everything flows through events.

## Data flow

```
 user input (REPL / stdio JSON / in-process API)
        │  FrontendRequest {user_message | permission_response | interrupt | ...}
        ▼
 ┌─────────────────────────── core: Session ───────────────────────────┐
 │                                                                      │
 │  system prompt assembly ──► Provider.stream(model, system, msgs,     │
 │  (identity + env + memory)      tools, signal)                       │
 │                                   │ ProviderEvent stream             │
 │        ┌──────────────────────────┘                                  │
 │        ▼                                                             │
 │  turn loop: collect text/thinking/tool_use blocks                    │
 │        │ tool calls?                                                 │
 │        ├─ no ──► turn_finished                                       │
 │        └─ yes ─► zod-validate input ─► permission engine             │
 │                        │ invalid → error tool_result (self-correct)  │
 │                        │ ask → emit permission_request, await reply  │
 │                        ▼                                             │
 │                  execute (read-only calls in parallel, mutating      │
 │                  sequential) ─► truncate to byte budget ─►           │
 │                  tool_results appended as next user msg ─► loop      │
 │                                                                      │
 │  transcript: append-only JSONL (.magentra/sessions/<id>.jsonl)       │
 │  context manager: usage tracking → compaction at threshold           │
 └──────────────────────────────────────────────────────────────────────┘
        │  CoreEvent {text_delta | tool_call_started | file_edited | ...}
        ▼
 frontend renders (terminal markdown / future IDE inline diffs)
```

Background work (Bash `run_in_background`, monitors, background subagents, cron) runs
under a `BackgroundManager`; completions inject `<task-notification>` system-reminders
into the next turn and emit `background_notification` events immediately.

## The protocol (the VS Code seam)

Versioned (`PROTOCOL_VERSION = 1`), defined once in `@magentra/protocol`, documented in
`docs/PROTOCOL.md`. Transports:

1. **In-process**: `Engine` exposes `events` (async iterable / emitter) and `send(request)`.
2. **stdio**: `magentra --serve` frames the same objects as newline-delimited JSON.

Rule: if the CLI can do it, it does it through this protocol. The CLI holds no private
references into core internals.

Core → frontend events: `session_started`, `turn_started`, `text_delta`,
`thinking_delta`, `tool_call_started`, `tool_call_finished`, `permission_request`,
`question_request`, `plan_ready`, `task_list_updated`, `file_edited` (unified diff),
`background_notification`, `mode_changed`, `session_list`, `turn_finished`, `error`.

Frontend → core requests: `user_message`, `permission_response`, `question_response`,
`plan_decision`, `interrupt`, `set_mode`, `slash_command`, `bang_command`,
`resume_session`, `list_sessions`.

## Core concepts

### Provider abstraction

```ts
interface Provider {
  stream(req: StreamRequest): AsyncIterable<ProviderEvent>; // accepts AbortSignal
  countTokens?(msgs: Msg[]): Promise<number>;
}
```

`ProviderEvent`: `text_delta`, `thinking_delta`, `tool_use_start/delta/end`,
`message_end {stopReason, usage}`. `AnthropicProvider` wraps `@anthropic-ai/sdk`
streaming with retry/backoff on 429/5xx/overloaded honoring `retry-after`.
`FakeProvider` plays back scripted turns; the entire test suite runs on it — no test
touches the network. Parallel `tool_use` blocks in one assistant message are first-class.

### Session and turn loop

A `Session` owns: message history, tool registry, permission engine, `TaskStore`,
`FileState` (mtime+hash per file read, powering Edit/Write freshness), background
manager, transcript writer, and the event sink. Loop safety caps: max iterations per
user turn (default 50) and max tokens per turn; hitting a cap ends the turn with an
explanatory message. Tool exceptions become error tool_results, never crashes. Abort
(Esc / `interrupt`) propagates an `AbortSignal` through every provider call, tool
execution, and subagent.

### Permission engine

Modes: `default` (mutating tools prompt), `acceptEdits` (file edits auto-approved,
Bash still prompts), `plan` (read-only enforcement), `bypass` (explicit
`--dangerously-bypass` opt-in). Settings rules (`allow`/`deny` lists matching tool name +
argument glob, e.g. `Bash(git status*)`) resolve as: deny > allow > mode default.
Approvals flow over the protocol; allow-always writes a session rule. Every decision is
logged to the transcript.

### System prompt assembly

Composed at runtime from exported prose sections (one string per section, swappable by
an embedding IDE): identity/behavior core (original text implementing the reference
behaviors), environment block, project memory (`MAGENTRA.md`, falling back to
`AGENTS.md`), skills list. Harness-injected `<system-reminder>` blocks carry task-list
changes, background completions, plan-mode entry, and hook feedback; the prompt tells
the model these come from the harness, not the user.

### Modes (`.ma` styles): core vs optional

Ten built-in `.ma` styles shape how the agent works (directives, shared vocab, turn
injections, tool gates, checklists); the full format is in `docs/MA-FORMAT.md`. Seven
are **core** quality modes — `headlights`, `prover`, `deepmodule`, `surgeon`,
`sentinel`, `obvious`, `lexicon` — always active in every session and non-disableable;
this is the product's killer feature. The single source of truth is `CORE_MODE_IDS` in
`packages/core/src/modes.ts`. The other three (`grill`, `entropy`, `reshape`) are
**optional**, toggled per session via `settings.modes.active` (optional ids only,
default `[]`) or the `set_modes` request. The `ModeEngine` unions core in, resolves
`@conflicts` (core always wins), and refuses any attempt to drop a core mode with a
one-line `command_output` message. `ModeSummary.core` lets frontends render locked chips.

### Design atlas (first-visit auto-exploration)

The workspace's whole-design map lives at `.magentra/ATLAS.md` and is injected into
the system prompt whenever present. First-visit auto-exploration is an unconditional
killer feature — it cannot be disabled. On a session's first user turn, if either no
atlas exists in a non-trivial workspace **or** the existing atlas has drifted
materially, the engine dispatches the read-only `explore` subagent to map the codebase
and writes its report back to `ATLAS.md` — the subagent stays read-only, the Session
persists the file. (Subagents themselves never auto-explore: it would recurse and a
child cannot own the workspace atlas.) Each build appends a freshness stamp
(`<!-- magentra-atlas commit=<hash> built=<iso> sha=<sha256-of-body> -->`);
`parseAtlasStamp`/`atlasStampLine` are the single source of truth for the format.
Staleness = `git rev-list <stamp>..HEAD --count` ≥ 20 (an unknown stamp after a rebase
also counts as stale, a non-git build never does). Progress is surfaced as
`command_output` notices (exploring… / ready / failed).

Three guards keep the feature safe against weak-model output and against destroying
user work:

- **Validation** — the explore report is written only if `looksLikeAtlas` passes: the
  first non-blank line must be an H1 and the body must carry a real module map
  (≥ 2 `## ` sections or ≥ 10 non-blank lines). A refusal, apology, or one-line ramble
  from a weak subagent is rejected, so garbage never lands on disk or in future system
  prompts.
- **Hand-edit protection** — the stamp's `sha` fingerprints the atlas body. Before a
  staleness rebuild, `atlasWasHandEdited` recomputes that hash; a mismatch means the
  user edited the file, so the engine skips the rebuild (emitting a one-line
  `atlas was hand-edited` notice) rather than clobbering their work. Old-format stamps
  without a `sha` are treated as machine-owned and remain eligible for rebuild.
- **Bounded build** — the build blocks the first message, so the explore spawn runs
  with a reduced iteration budget (`ATLAS_BUILD_MAX_ITERATIONS = 15`, applied via the
  `spawnAgent` `maxIterations` option). If the child hits the cap, whatever it produced
  still goes through validation — a partial-but-valid atlas is kept.

Exploration is best-effort: any failure (empty output, non-atlas output, or an error)
emits a notice and falls back to the one-time missing-atlas `<system-reminder>` nudge.

### Context management

Cumulative usage tracked from provider `usage`. At ~80% of the model window (config),
compaction summarizes the oldest span via a dedicated summarization call (task state,
decisions, files touched, open items), replaces it with a summary message, keeps the
recent tail verbatim. Full JSONL transcript is never rewritten — compaction is a view.
`/compact` triggers it manually.

### State on disk

- `.magentra/` in the workspace: `sessions/*.jsonl` (append-only transcripts, one
  message per line), `settings.json`, `tasks/` (background task output), `plans/`,
  `worktrees/`, `skills/`, `scheduled_tasks.json`.
- `~/.magentra/`: global `settings.json`, global `skills/`.
- Env vars override file config; project settings override global; zod-validated with
  warn-on-unknown-keys.

## Tool inventory (implementation status in docs/TOOLS.md)

Every tool is one module exporting
`{name, description, inputSchema (zod), permissionClass, execute(input, ctx, signal)}`.
Permission classes: `read` | `mutate` | `execute` | `network` | `interact`. Read-only
calls in one assistant turn run concurrently; mutating ones run sequentially in call
order. Field names match the reference schemas exactly.

Currently shipped (registered in `createDefaultRegistry`): the Phase-1 set — Read, Write,
Edit, Glob, Grep, Bash, TaskCreate/TaskUpdate/TaskList/TaskGet, AskUserQuestion. The later
phases below are the roadmap, not yet in the source tree. Per-tool field tables and behavior
live in `docs/TOOLS.md`.

- **Phase 1**: Read, Write, Edit, Glob, Grep, Bash (+ background tasks),
  TaskCreate/TaskUpdate/TaskList/TaskGet, AskUserQuestion.
- **Phase 2**: Agent (subagents: `general-purpose`, `explore`, `plan`; no recursion in
  v1), WebFetch, WebSearch, EnterPlanMode/ExitPlanMode, Monitor, TaskStop/TaskOutput.
- **Phase 3**: Skill (+ skills loader + built-in slash commands), hooks
  (PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/Stop), MCP stdio client
  (`mcp__<server>__<tool>`), EnterWorktree/ExitWorktree, CronCreate/Delete/List,
  ScheduleWakeup, PushNotification.
- **Phase 4 (stretch)**: Workflow (node:vm sandbox, journal + resume), SendMessage,
  TeamCreate/TeamDelete.

## Dependencies (one-line justifications)

- `@anthropic-ai/sdk` — official client; streaming, retries, token counting.
- `zod` — runtime validation of tool inputs, settings, and protocol frames.
- `fast-glob` — battle-tested glob engine for the Glob tool.
- `@vscode/ripgrep` — ships a prebuilt `rg` binary so Grep works with zero user setup.
- `vitest` — test runner with first-class TS/ESM support.
- `typescript`, `@types/node` — build/type tooling only.

Everything else (NDJSON framing, diffing, REPL, process management, cron parsing,
JSONL store) is hand-rolled: small, boring, dependency-free.

## Testing strategy

All loop logic runs against `FakeProvider` + a temp-dir workspace. Phase-1 suite:
loop termination, parallel tool calls, invalid-input self-correction, permission deny
path, edit-uniqueness failures, output truncation, iteration cap, transcript replay.
The stdio protocol has a contract test that drives a full turn over `magentra --serve`
— that test is what the future VS Code integration relies on.

Development happens on Windows but Linux/macOS are the support targets; Windows-specific
gaps are documented, not engineered around.

## Phase plan

1. **Working agent** — providers, protocol, core loop, permissions, Phase-1 tools,
   readline CLI, FakeProvider suite. Gate: rename-across-repo demo with approval
   prompts, interrupt works, transcript replayable.
2. **Serious agent** — subagents, plan mode end-to-end (read-only enforcement proven by
   test), WebFetch/WebSearch, Monitor, background notifications. Gate: explore → plan →
   approve → execute flow.
3. **Product** — skills/slash commands, hooks, MCP client, worktrees, cron/wakeups,
   push notifications. Gate: skill invocation alters behavior; PreToolUse hook blocks
   with stderr fed back; MCP tools appear; worktree round-trip; idle cron fires.
4. **Stretch** — Workflow engine (sandboxed scripts, deterministic resume via run
   journal), team tools.

Each phase ends with green tests, a runnable CLI demo, updated docs, and a git commit.

## Reference material

The seven files under `core_markdowns/` are architectural reference for tool contracts
and behaviors (schemas normative; `cc_f5.md` wins conflicts). Their prose is another
vendor's — no verbatim text from them ships in Magentra prompts, tool descriptions, or
docs.
