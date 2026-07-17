# Magentra — Architecture

Magentra is a headless agentic coding engine plus a desktop frontend. The core is
UI-agnostic: it emits typed events and consumes typed requests over a versioned protocol,
so the Electron app today and a VS Code fork tomorrow are both thin clients of the same
engine.

This document is the build-time alignment artifact. It is kept current as phases land.

## Package layout

```
engine/
├── protocol/    # typed event/request schema + NDJSON framing + product branding constants
├── providers/   # Provider interface, AnthropicProvider, OpenAI-compatible provider, FakeProvider
├── core/        # Session, agent loop, permission engine, prompt assembly,
│                # context/compaction, transcript store, settings, subagent spawner
├── tools/       # every built-in tool, one module each, registered via a registry
└── host/        # headless process: runs the engine and speaks NDJSON over stdio

app/             # the desktop app (Electron) — the engine's only frontend today
```

### Frontends

The engine has exactly one process boundary: `engine/host`, a headless binary that
speaks the protocol as NDJSON over stdio (`--cwd <workspace> [--mode …]
[--dangerously-bypass]`). The desktop app (`app/`) spawns exactly that process per
open workspace and renders the event stream:

- `app/main.js` — Electron main process: window, the engine child process, IPC.
- `app/main/` — pure pieces of the main process (config, logging).
- `app/preload.js` — the contextBridge surface the renderer may touch.
- `app/renderer/` — the UI; `modules/` are classic scripts loaded in order.

Dependency direction (strict, enforced by TS project references):

```
protocol  ←  providers  ←  core  ←  tools  ←  host
```

- `protocol` has zero dependencies. It defines the seam a future IDE consumes.
- `core` never imports from `tools`; tools are injected at startup via the registry.
  This keeps the engine embeddable with any tool subset (subagents use restricted sets).
- `host` is the only package allowed to touch stdin/stdout for user interaction.
  `core` has no `console.log` for user output — everything flows through events.
- `app` is plain JavaScript outside the TS build; it talks to the engine only
  through the host's stdio stream.

## Data flow

```
 user input (desktop app / stdio NDJSON / in-process API)
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
 frontend renders (desktop app markdown / future IDE inline diffs)
```

Background work (Bash `run_in_background`, monitors, background subagents, cron) runs
under a `BackgroundManager`; completions inject `<task-notification>` system-reminders
into the next turn and emit `background_notification` events immediately.

## The protocol (the VS Code seam)

Versioned (`PROTOCOL_VERSION = 1`), defined once in `@magentra/protocol`, documented in
`docs/PROTOCOL.md`. Transports:

1. **In-process**: `Engine` exposes `events` (async iterable / emitter) and `send(request)`.
2. **stdio**: the `engine/host` binary frames the same objects as newline-delimited JSON;
   the desktop app spawns it per workspace.

Rule: if the desktop app can do it, it does it through this protocol. The app holds no
private references into core internals.

Core → frontend events: `session_started` (with the slash-command registry in
`commands` and the per-model `rateCard`), `turn_started`, `tool_output_delta`,
`retry_status`, `text_delta`, `thinking_delta`, `tool_call_started`,
`tool_call_finished`, `agent_spawned`, `agent_finished`, `permission_request`,
`question_request`, `plan_ready`, `task_list_updated`, `file_edited` (unified diff),
`background_notification`, `mode_changed`, `command_output`, `session_list`,
`turn_finished`, `error`, `modes_updated`, `team_updated`, `backpack_progress`,
`session_restored`, `model_catalog`, `cwd_changed`, `missions_updated`.

Frontend → core requests: `user_message`, `permission_response`, `question_response`,
`plan_decision`, `interrupt`, `set_mode`, `set_deletion_guard`, `slash_command`,
`bang_command`, `resume_session`, `delete_session`, `stop_background`,
`rename_session`, `archive_session`, `list_sessions`, `set_modes`, `reload_team`.

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

Eleven built-in `.ma` styles shape how the agent works (directives, shared vocab, turn
injections, tool gates, checklists); the full format is in `docs/MA-FORMAT.md`. Seven
are **core** quality modes — `headlights`, `prover`, `deepmodule`, `surgeon`,
`sentinel`, `obvious`, `lexicon` — always active in every session and non-disableable;
this is the product's killer feature. The single source of truth is `CORE_MODE_IDS` in
`engine/core/src/ma/modes.ts`. The other four (`grill`, `entropy`, `reshape`, `debug`)
are **optional**, toggled per session via `settings.modes.active` (optional ids only,
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
  record per line: `message`, `system_prompt`, `permission`, `compaction`, `meta`),
  `sessions/subagents/` (child-session transcripts), `settings.json`, `tasks/`
  (persisted task lists + background task output), `plans/`, `worktrees/`, `skills/`,
  `modes/` (workspace styles), `missions/` (+ `missions/out/` run reports and logs),
  `team/` (crew files, `docs/`, `backpacks/`, `experience/`), `debug/` (repro
  scripts), `tmp/`, `scheduled_tasks.json`, `ATLAS.md`, `LEXICON.md`.
- `~/.magentra/`: global `settings.json`, global `skills/`.
- Env vars override file config; project settings override global; zod-validated with
  warn-on-unknown-keys.

## Tool inventory (implementation status in docs/TOOLS.md)

Every tool is one module exporting
`{name, description, inputSchema (zod), permissionClass, execute(input, ctx, signal)}`.
Permission classes: `read` | `mutate` | `execute` | `network` | `interact`. Read-only
calls in one assistant turn run concurrently; mutating ones run sequentially in call
order. Field names match the reference schemas exactly.

Currently shipped (registered in `createDefaultRegistry` in `engine/tools/src/index.ts`):
everything below except the team tools. Per-tool field tables and behavior live in
`docs/TOOLS.md`.

- **Phase 1** (shipped): Read, Write, Edit, Glob, Grep, Bash (+ background tasks),
  TaskCreate/TaskUpdate/TaskList/TaskGet, AskUserQuestion.
- **Phase 2** (shipped): Agent (subagents: `general-purpose`, `explore`, `plan`; no
  recursion in v1), WebFetch, WebSearch, EnterPlanMode/ExitPlanMode, Monitor,
  TaskStop/TaskOutput.
- **Phase 3** (shipped): Skill (+ skills loader + built-in slash commands), hooks
  (PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/Stop), MCP stdio client
  (`mcp__<server>__<tool>`, wired in `engine/core/src/integrations/mcp.ts`),
  EnterWorktree/ExitWorktree, CronCreate/Delete/List, ScheduleWakeup, PushNotification.
- **Phase 4**: Workflow (node:vm sandbox, journal + resume — shipped), plus the crew
  tools CrewRun, BackpackSearch, GraphQuery (shipped). SendMessage and
  TeamCreate/TeamDelete remain unbuilt.

## Dependencies (one-line justifications)

- `@anthropic-ai/sdk` — official client; streaming, retries, token counting.
- `zod` — runtime validation of tool inputs, settings, and protocol frames.
- `fast-glob` — battle-tested glob engine for the Glob tool.
- `@vscode/ripgrep` — ships a prebuilt `rg` binary so Grep works with zero user setup.
- `typescript`, `@types/node` — build/type tooling only.
- `electron`, `electron-builder`, `esbuild` — desktop app shell and packaging (app/ only).

Everything else (NDJSON framing, diffing, REPL, process management, cron parsing,
JSONL store) is hand-rolled: small, boring, dependency-free.

## Testing strategy

Loop logic is designed to run against `FakeProvider` (scripted turns, no network) + a
temp-dir workspace. No engine test framework is wired up yet; the only automated tests
in the tree today cover the version tool (`npm run test:version`). Per-feature test
status is tracked honestly in `FEATURES.md`.

Development happens on Windows but Linux/macOS are the support targets; Windows-specific
gaps are documented, not engineered around.

## Phase plan (historical — phases 1–3 have landed; of phase 4, the team tools remain)

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

Tool contracts and behaviors follow external reference schemas studied during design
(the reference files themselves are not kept in this repo). Their prose is another
vendor's — no verbatim text from them ships in Magentra prompts, tool descriptions, or
docs.
