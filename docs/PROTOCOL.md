# Magentra Protocol (v1)

The protocol is the single, versioned contract between the Magentra engine and any
frontend that drives it. The desktop app uses it today; a VS Code extension or other IDE
integration is expected to use the exact same contract tomorrow. Everything a frontend can
make the engine do, and everything the engine tells a frontend, travels as one of the typed
messages defined here. There is no side channel.

The types in this document are the source of truth in
`engine/protocol/src/types.ts`. The framing helpers live in
`engine/protocol/src/ndjson.ts`, and product/branding constants in
`engine/protocol/src/branding.ts`.

## Versioning

The protocol carries a single integer version, `PROTOCOL_VERSION`, currently `1`. It is
surfaced to the frontend in the `session_started` event as the field `v`. A frontend should
read `v` on connect and refuse to proceed against a major version it does not understand.

```ts
export const PROTOCOL_VERSION = 1;
```

## Transports

The same message objects flow over two interchangeable transports. Nothing in the message
shape depends on which transport is in use.

### 1. In-process Engine API

A frontend embedded in the same Node process talks to an `Engine` instance directly:

- `engine.events` is an async-iterable stream (an `AsyncQueue`) of `CoreEvent` objects.
  Consume it with `for await (const event of engine.events) { ... }`.
- `engine.send(request)` accepts a single `FrontendRequest` and returns immediately; the
  engine processes it and pushes any resulting events onto `engine.events`.
- `engine.start()` emits the initial `session_started` event.
- `engine.idle()` resolves when the currently running turn (if any) has completed; a REPL
  awaits it after sending a `user_message` before prompting again.

This is the primitive transport. The stdio transport below is a thin framing layer on top of
these same two operations.

### 2. NDJSON over stdio (the `engine/host` binary)

The host process (`engine --cwd <workspace> [--mode …] [--dangerously-bypass]`) is a
newline-delimited-JSON server — the desktop app spawns exactly this per open workspace:

- Each `CoreEvent` is written to **stdout** as one JSON object followed by `\n`.
- Each line read from **stdin** is parsed as one `FrontendRequest`.

Messages are the bare tagged-union objects — discriminated by their `type` field — with no
envelope. Framing rules (`engine/protocol/src/ndjson.ts`):

- `encodeFrame(obj)` = `JSON.stringify(obj) + "\n"`.
- `decodeFrames(stream)` splits the incoming byte/string stream on `\n`, tolerates a
  trailing `\r` (so CRLF pipes work), and skips blank lines.
- A line that fails to parse does **not** kill the transport: it is surfaced as an
  `{ type: "error", message: "unparseable frame: …", fatal: false }` object so one bad frame
  cannot take down the connection.
- On the request side, the host additionally rejects any decoded frame that is not an object
  with a string `type`, replying with `{ type: "error", message: "invalid request frame",
  fatal: false }`.

When stdin closes (the frontend exits or the pipe breaks), the server tears down.

## Supporting types

These structured types appear as fields inside events and requests.

| Type | Definition |
| --- | --- |
| `PermissionMode` | `"default" \| "acceptEdits" \| "bypass"` |
| `PermissionDecision` | `"allow_once" \| "allow_session" \| "deny"` |
| `TaskStatus` | `"pending" \| "in_progress" \| "completed"` |
| `TaskItem` | `{ id, subject, description, activeForm?, status: TaskStatus, owner?, blocks: string[], blockedBy: string[], metadata? }` |
| `Usage` | `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` (all numbers) |
| `QuestionOption` | `{ label, description, preview? }` |
| `Question` | `{ question, header, options: QuestionOption[], multiSelect: boolean }` |
| `AllowedPrompt` | `{ tool, prompt }` |
| `SessionSummary` | `{ id, createdAt, updatedAt, cwd, firstUserMessage?, model?, label? }` — `label` is the user-assigned name (`rename_session`), shown instead of `firstUserMessage` |
| `SlashCommandInfo` | `{ cmd, args, desc }` — one slash command the engine understands |
| `RestoredToolCall` | `{ tool, input, result, isError }` |
| `RestoredMessage` | `{ role: "user" \| "assistant", text, thinking?, toolCalls?: RestoredToolCall[] }` |

## Core → frontend events (`CoreEvent`)

Every event carries a `type` discriminator. Fields marked optional may be absent from the
JSON entirely.

### `session_started`

Emitted once when a session begins (on `start()`, after `/clear`, and after a resume).

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"session_started"` | |
| `v` | number | Protocol version (`1`). |
| `sessionId` | string | Stable id; also the transcript filename stem. |
| `cwd` | string | Absolute working directory. |
| `model` | string | Configured model id. |
| `mode` | `PermissionMode` | Active permission mode. |
| `commands` | `SlashCommandInfo[]` | The engine's slash-command registry, so the frontend palette can never drift. |
| `rateCard` | `Record<string, { input, output, cacheRead?, cacheWrite?, contextWindow }>` | Per-model $/1M rates + context windows — the built-in table with user `pricing` overrides applied. The frontend's single source for model hints; it must keep no pricing copy of its own. |

```json
{"type":"session_started","v":1,"sessionId":"s_lz4k2h_9a1f0c","cwd":"/home/me/proj","model":"deepseek-ai/DeepSeek-V4-Flash","mode":"default","commands":[{"cmd":"/help","args":"","desc":"show this help"},{"cmd":"/settings","args":"[global] [k v]","desc":"show settings, or set one (add global to save to ~/.magentra)"}],"rateCard":{"deepseek-ai/DeepSeek-V4-Flash":{"input":0.09,"output":0.18,"cacheRead":0.018,"contextWindow":160000}}}
```

### `turn_started`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"turn_started"` | |
| `turnId` | string | Correlates with the matching `turn_finished`. |

```json
{"type":"turn_started","turnId":"t_1"}
```

### `tool_output_delta`

Throttled incremental output from a running tool call — lets the UI tail e.g. a build log
live. Foreground Bash streams its combined output this way (one delta per ~250ms interval);
Workflow streams its `log()`/phase lines.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"tool_output_delta"` | |
| `id` | string | The tool-use id from `tool_call_started` this output belongs to. |
| `text` | string | The next chunk; append in arrival order. |

```json
{"type":"tool_output_delta","id":"toolu_01","text":"PASS src/parse.test.ts\n"}
```

### `retry_status`

A provider call hit a retryable failure and is backing off — the UI shows why the spinner
is waiting.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"retry_status"` | |
| `attempt` | number | Which retry attempt is about to run. |
| `delayMs` | number | How long the engine waits before that attempt. |
| `reason` | string | Short human-readable cause, e.g. `"rate limited"`, `"provider server error (503)"`. |

```json
{"type":"retry_status","attempt":2,"delayMs":8000,"reason":"rate limited"}
```

### `text_delta`

Streamed assistant prose. Concatenate deltas in arrival order to reconstruct the message.

```json
{"type":"text_delta","text":"I'll rename the function across the repo.\n"}
```

### `thinking_delta`

Streamed extended-thinking content, same shape as `text_delta`. Frontends typically render it
dimmed or hidden.

```json
{"type":"thinking_delta","text":"The call sites are in three files…"}
```

### `tool_call_started`

Emitted when a tool call has passed validation and permission and is about to run.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"tool_call_started"` | |
| `id` | string | Tool-use id; pairs with `tool_call_finished`. |
| `tool` | string | Tool name, e.g. `"Edit"`. |
| `input` | unknown | The validated input object. |
| `description` | string? | Human one-liner (from the tool's `describeInput`). |
| `subagent` | boolean? | True when this call belongs to a subagent's nested session, not the top-level turn. |
| `agentId` | string? | Stable id of the subagent this call belongs to (e.g. `"ag_1"`). Only set on subagent events. |
| `agentDesc` | string? | The spawning `description` for that subagent. Only set on subagent events. |
| `agentColor` | string? | Crew agent's color, stamped when the subagent is a crew specialist. |
| `agentEmoji` | string? | Crew agent's emoji, stamped when the subagent is a crew specialist. |

```json
{"type":"tool_call_started","id":"toolu_01","tool":"Bash","input":{"command":"npm test","description":"Run the test suite"},"description":"Run the test suite"}
```

### `tool_call_finished`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"tool_call_finished"` | |
| `id` | string | Matches the `tool_call_started` id. |
| `tool` | string | Tool name. |
| `resultPreview` | string | Truncated preview of the result (~400 chars). |
| `isError` | boolean | Whether the tool reported an error. |
| `subagent` | boolean? | True when this call belongs to a subagent's nested session. |
| `agentId` | string? | Stable id of the subagent this call belongs to. Only set on subagent events. |
| `agentDesc` | string? | The spawning `description` for that subagent. Only set on subagent events. |
| `agentColor` | string? | Crew agent's color, when the subagent is a crew specialist. |
| `agentEmoji` | string? | Crew agent's emoji, when the subagent is a crew specialist. |

```json
{"type":"tool_call_finished","id":"toolu_01","tool":"Bash","resultPreview":"12 passed, 0 failed","isError":false}
```

### `agent_spawned`

Emitted when a subagent is dispatched — before its first model turn, so the frontend can
show the agent immediately instead of waiting for its first tool call.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"agent_spawned"` | |
| `agentId` | string | Stable subagent id, e.g. `"ag_1"`; matches later tool-call events. |
| `agentDesc` | string | The spawning `description`. |
| `background` | boolean? | True when the agent runs detached as a background task. |
| `agentColor` | string? | Crew agent's color, when the subagent is a crew specialist. |
| `agentEmoji` | string? | Crew agent's emoji, when the subagent is a crew specialist. |

```json
{"type":"agent_spawned","agentId":"ag_1","agentDesc":"Explore the parser module"}
```

### `agent_finished`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"agent_finished"` | |
| `agentId` | string | Matches the `agent_spawned` id. |
| `isError` | boolean? | Whether the subagent ended in error. |

```json
{"type":"agent_finished","agentId":"ag_1"}
```

### `permission_request`

Emitted when a tool call needs the user's approval (see the round-trip below).

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"permission_request"` | |
| `id` | string | Echo this id back in the `permission_response`. |
| `tool` | string | Tool name. |
| `input` | unknown | The call input, for display. |
| `description` | string? | Human one-liner. |

```json
{"type":"permission_request","id":"perm_3b9d","tool":"Bash","input":{"command":"rm -rf build","description":"Remove build output"},"description":"Remove build output"}
```

### `question_request`

Emitted by the `AskUserQuestion` tool (see round-trip below).

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"question_request"` | |
| `id` | string | Echo back in `question_response`. |
| `questions` | `Question[]` | 1–4 multiple-choice questions. |

```json
{"type":"question_request","id":"q_7f21","questions":[{"question":"Which package manager should I use?","header":"Pkg mgr","options":[{"label":"npm","description":"Use the bundled npm"},{"label":"pnpm","description":"Use pnpm workspaces"}],"multiSelect":false}]}
```

### `task_list_updated`

Fires whenever the session task list changes (or on `/tasks`).

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"task_list_updated"` | |
| `tasks` | `TaskItem[]` | The full current list. |

```json
{"type":"task_list_updated","tasks":[{"id":"1","subject":"Rename symbol","description":"…","status":"in_progress","blocks":[],"blockedBy":[]}]}
```

### `file_edited`

Emitted by `Write` and `Edit` after a successful change.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"file_edited"` | |
| `path` | string | Absolute path of the changed file. |
| `diff` | string | Unified diff of the change. |

```json
{"type":"file_edited","path":"/home/me/proj/src/a.ts","diff":"--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-const x = 1\n+const x = 2\n"}
```

### `background_notification`

Emitted immediately when a background task launches or ends. Every background launch —
`run_in_background` Bash commands, monitors, background subagents, the atlas build —
announces itself with `kind: "start"`, so the UI never has to infer background work from
side effects.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"background_notification"` | |
| `taskId` | string | Background task id (also `"atlas"` for the atlas build). |
| `kind` | string | `"start"` on launch, `"exit"` when the task ends or is stopped. |
| `payload` | unknown | Kind-specific detail — see below. |

Payloads: a `"start"` carries `{ kind, description }` (the task kind, e.g. `"bash"`); a
natural `"exit"` carries `{ code, description, outputFile }`; a task stopped via
`stop_background` (or the TaskStop tool) emits `"exit"` with `{ stopped: true, description }`.

```json
{"type":"background_notification","taskId":"bash_a1b2c3d4","kind":"exit","payload":{"code":0,"description":"Run the test suite","outputFile":"/home/me/proj/.magentra/tasks/bash_a1b2c3d4.output"}}
```

### `mode_changed`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"mode_changed"` | |
| `mode` | `PermissionMode` | The new mode. |

```json
{"type":"mode_changed","mode":"acceptEdits"}
```

### `command_output`

Free-form text emitted by slash commands and `!` shell passthrough.

```json
{"type":"command_output","text":"Conversation compacted."}
```

### `session_list`

Reply to `list_sessions` / `/sessions`.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"session_list"` | |
| `sessions` | `SessionSummary[]` | Newest first. |

```json
{"type":"session_list","sessions":[{"id":"s_lz4k2h_9a1f0c","createdAt":"2026-07-04T10:00:00.000Z","updatedAt":"2026-07-04T10:12:00.000Z","cwd":"/home/me/proj","firstUserMessage":"Fix the parser","model":"deepseek-ai/DeepSeek-V4-Flash","label":"Parser fix"}]}
```

### `turn_finished`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"turn_finished"` | |
| `turnId` | string | Matches `turn_started`. |
| `stopReason` | string | e.g. `end_turn`, `max_iterations`, `aborted`, `error`. |
| `usage` | `Usage` | Tokens **billed** for the turn — the sum over every model call it made (cumulative cost, not context size). |
| `contextTokens` | number | Tokens currently **in** the context window (whole prompt of the last request + the reply). Point-in-time — this is what a context meter must show; `usage.inputTokens` under-reports whenever prompt caching is on. |
| `totalCostUsd` | number? | Whole-session cost so far in USD, priced engine-side per model (crew runs on other models included). Absent when no used model has a rate card — show nothing rather than a fake $0. |

```json
{"type":"turn_finished","turnId":"t_1","stopReason":"end_turn","usage":{"inputTokens":8123,"outputTokens":412,"cacheReadTokens":0,"cacheWriteTokens":0},"contextTokens":8535,"totalCostUsd":0.0031}
```

### `error`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"error"` | |
| `message` | string | Human-readable error. |
| `fatal` | boolean | `true` means the session cannot continue. |

```json
{"type":"error","message":"provider request failed: 503","fatal":false}
```

### `modes_updated`

Full repaint of the discipline-skill surfaces: emitted after a `set_modes` request or a
`/skills on|off` toggle, carrying every discipline's summary.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"modes_updated"` | |
| `modes` | array | One entry per discipline skill: `{ id, name, description, why?, active, builtin, recommended?, conflicts? }`. |

Per entry: `recommended` marks the advisory recommended set (badged in frontends, never forced —
nothing is locked); `why` powers the per-skill "?" explainers.

```json
{"type":"modes_updated","modes":[{"id":"surgeon","name":"Surgeon","description":"Minimal-diff discipline","why":"Enable for focused fixes in mature code.","active":false,"builtin":true,"recommended":true,"conflicts":[]},{"id":"entropy","name":"Entropy","description":"Strategic over tactical","active":true,"builtin":true,"conflicts":["surgeon"]}]}
```

### `team_updated`

Full crew roster repaint: emitted when the team loads, reloads, or a member's state
changes.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"team_updated"` | |
| `agents` | array | One entry per crew member — fields below. |

Per agent:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Member id (team filename stem). |
| `name` | string | Display name. |
| `role` | string | Role line from the team file. |
| `model` | string? | Member's own model, when set. |
| `provider` | string? | Dedicated-endpoint members: the API kind (`"anthropic"` \| `"openai-compatible"`). |
| `baseUrl` | string? | Dedicated-endpoint members: the base URL they run on. |
| `emoji` | string? | |
| `color` | string? | |
| `docCount` | number | How many docs feed the member's backpack. |
| `ready` | boolean | Backpack readiness: a distilled brief exists, or every doc reached at least the "noted" phase. |
| `spend` | string? | Ledger spend summary (`"12.3k in / 4.1k out over 7 runs"`); absent when the member has never run. |
| `lessonsPromoted` | number | Durable lessons earned through verified work. |
| `lessonsCandidate` | number | Lessons still on probation. |
| `tasksCompleted` | number | Verified completed tasks from the hash-chained service record. |

```json
{"type":"team_updated","agents":[{"id":"scout","name":"Scout","role":"Fast Researcher","model":"deepseek-ai/DeepSeek-V4-Flash","emoji":"🔎","docCount":1,"ready":true,"spend":"3.1k in / 420 out over 1 run","lessonsPromoted":0,"lessonsCandidate":2,"tasksCompleted":1}]}
```

### `backpack_progress`

Streams a crew member's backpack build phases so the frontend can show readiness.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"backpack_progress"` | |
| `agentId` | string | Crew member id. |
| `phase` | string | One of `"raw"` \| `"noted"` \| `"embedded"` \| `"brief"`. |
| `done` | number | Docs finished in this phase. |
| `total` | number | Docs in this phase. |

```json
{"type":"backpack_progress","agentId":"scout","phase":"noted","done":1,"total":3}
```

### `session_restored`

The full prior conversation, render-ready, sent once on a resume so the frontend can
repaint the chat. Flat by design: the frontend cannot read the transcript file
(sandboxed) and the wire has no user-message event, so the engine reconstructs a paint
list here — tool calls already paired with their results, harness scaffolding stripped.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"session_restored"` | |
| `sessionId` | string | The resumed session's id. |
| `messages` | `RestoredMessage[]` | In conversation order. |

```json
{"type":"session_restored","sessionId":"s_lz4k2h_9a1f0c","messages":[{"role":"user","text":"Fix the parser"},{"role":"assistant","text":"Done — the off-by-one is fixed.","toolCalls":[{"tool":"Edit","input":{"file_path":"src/parse.ts"},"result":"ok","isError":false}]}]}
```

### `model_catalog`

The model ids the configured endpoint actually serves (`GET /models`, fetched best-effort
at startup) — the UI rebuilds its model picker from this instead of a hardcoded list. When
the configured model is missing from the catalog the engine additionally raises a
non-fatal `error` so a typo warns at startup, not on the first turn. A catalog-less
endpoint never emits this event.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"model_catalog"` | |
| `models` | `string[]` | The endpoint's real model list. |

```json
{"type":"model_catalog","models":["deepseek-ai/DeepSeek-V4-Flash","Qwen/Qwen3-14B"]}
```

### `cwd_changed`

The session's working directory moved (EnterWorktree/ExitWorktree).

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"cwd_changed"` | |
| `cwd` | string | The new absolute working directory. |
| `worktree` | boolean | True while operating somewhere other than the workspace root. |

```json
{"type":"cwd_changed","cwd":"/home/me/proj/.magentra/worktrees/wt_1","worktree":true}
```

### `missions_updated`

Full repaint of the mission list (`.magentra/missions/*.md`): emitted when missions
load or their run/schedule state changes.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"missions_updated"` | |
| `missions` | array | One entry per mission — fields below. |
| `warnings` | `string[]` | Malformed mission files, reported instead of silently dropped. |

Per mission:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Mission id (filename stem). |
| `name` | string | Display name from the frontmatter. |
| `description` | string? | |
| `keywords` | `string[]` | The web-sweep keywords. |
| `schedule` | string? | 5-field cron expression from the mission file, when present. |
| `scheduled` | boolean | A durable cron job is currently armed for this mission. |
| `continuous` | boolean | The mission is marked continuous-capable in its file. |
| `running` | boolean | The continuous loop is currently active. |
| `deliverable` | string | Workspace-relative report path (explicit deliverable or the default). |
| `lastRunAt` | string? | Last time the deliverable was written, when it exists. |

```json
{"type":"missions_updated","missions":[{"id":"radar","name":"Field radar","keywords":["open source agent frameworks"],"schedule":"0 7 * * *","scheduled":true,"continuous":true,"running":false,"deliverable":"radar.md","lastRunAt":"2026-07-15T07:02:11.000Z"}],"warnings":[]}
```

## Frontend → core requests (`FrontendRequest`)

Every request carries a `type` discriminator.

### `user_message`

Starts a turn with the user's text.

| Field | Type |
| --- | --- |
| `type` | `"user_message"` |
| `text` | string |

```json
{"type":"user_message","text":"Rename getUser to fetchUser across the repo."}
```

### `permission_response`

Answer to a `permission_request`.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"permission_response"` | |
| `id` | string | The id from the `permission_request`. |
| `decision` | `PermissionDecision` | `allow_once`, `allow_session`, or `deny`. |
| `message` | string? | Optional note shown to the model on denial. |

```json
{"type":"permission_response","id":"perm_3b9d","decision":"allow_once"}
```

### `question_response`

Answer to a `question_request`.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"question_response"` | |
| `id` | string | The id from the `question_request`. |
| `answers` | `Record<string, string[]>` | Keyed positionally as `"q:<idx>"` (preferred — duplicate question texts cannot collide); the question's exact text still works as a fallback. Values are selected option labels (or free text). |

```json
{"type":"question_response","id":"q_7f21","answers":{"q:0":["pnpm"]}}
```

### `interrupt`

Aborts the in-flight turn. No fields beyond `type`. The abort propagates through the provider
call, every running tool, and any subagent.

```json
{"type":"interrupt"}
```

### `set_mode`

Changes the permission mode; the engine echoes a `mode_changed` event.

| Field | Type |
| --- | --- |
| `type` | `"set_mode"` |
| `mode` | `PermissionMode` |

```json
{"type":"set_mode","mode":"acceptEdits"}
```

### `set_deletion_guard`

Toggles the always-ask deletion guard (`true` = guard active, the default).

| Field | Type |
| --- | --- |
| `type` | `"set_deletion_guard"` |
| `enabled` | boolean |

```json
{"type":"set_deletion_guard","enabled":false}
```

### `slash_command`

Runs a built-in command (`help`, `atlas`, `clear`, `compact`, `session`, `tasks`, `skills`,
`lab`, `build-crew`, `crew`, `team`, `mission`, `mode`, `styles`, `debug`, `settings`,
`resume`, `sessions`). The full registry — with argument hints and descriptions — ships to
the frontend in `session_started.commands`.

`settings` with no args emits the effective config (each key's value and originating layer) as
`command_output`; `settings <key> <value>` validates the value against the settings schema, persists it
to the project or global `settings.json`, and applies it live where the running session allows.

`skills` with no args lists every skill as `command_output` — disciplines with their on/off state
(★ marking the recommended set), then the on-demand actions; `skills on|off <id>` toggles a discipline
through the same path as the `set_modes` request (nothing is locked; enabling a skill switches off
anything it `conflicts:` with, with an advisory message), then emits `modes_updated`. `/styles` is a
deprecated alias. Toggles are session-only and are not persisted to settings.

`build-crew` bootstraps a workspace crew: if `.magentra/team/*.md` already holds valid (or malformed)
specialist files it reports the roster as `command_output` and stops; otherwise it dispatches a
general-purpose subagent to design 2-4 specialists and write their team files, validates the result
through the team loader, and reports each file's `✓`/`✗` outcome. Safe and idempotent — a second call
while a build is in flight, or once a crew exists, does not start another.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"slash_command"` | |
| `command` | string | Without the leading `/`. |
| `args` | string? | Remaining argument text. |

```json
{"type":"slash_command","command":"mode","args":"acceptEdits"}
```

### `bang_command`

Runs a shell command directly; output is emitted as `command_output` and injected into the
conversation as context (not treated as a user request).

| Field | Type |
| --- | --- |
| `type` | `"bang_command"` |
| `cmd` | string |

```json
{"type":"bang_command","cmd":"git status"}
```

### `resume_session`

Replays a saved transcript into a fresh session. On success the engine emits a
`session_restored` event carrying the render-ready conversation.

| Field | Type |
| --- | --- |
| `type` | `"resume_session"` |
| `id` | string |

```json
{"type":"resume_session","id":"s_lz4k2h_9a1f0c"}
```

### `list_sessions`

Requests a `session_list` event. No fields beyond `type`.

```json
{"type":"list_sessions"}
```

### `delete_session`

Deletes a saved top-level transcript and its matching persisted task list. The active
session cannot be deleted. A successful deletion emits a refreshed `session_list`.

| Field | Type |
| --- | --- |
| `type` | `"delete_session"` |
| `id` | string |

```json
{"type":"delete_session","id":"s_lz4k2h_9a1f0c"}
```

### `stop_background`

Stops one running background task (bash job, monitor, or background agent). The engine
confirms with a `command_output` line either way (stopped, or no such running task), and a
stopped task emits `background_notification` kind `"exit"` with
`{ stopped: true, description }`.

| Field | Type |
| --- | --- |
| `type` | `"stop_background"` |
| `taskId` | string |

```json
{"type":"stop_background","taskId":"bash_a1b2c3d4"}
```

### `rename_session`

Names a saved session (the active one included). The label is appended to the transcript
as a `meta` record, so it travels with the file; `listSessions` prefers it over the
first-message label. A successful rename emits a refreshed `session_list`.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"rename_session"` | |
| `id` | string | |
| `label` | string | Trimmed and capped at 120 chars; an empty label is refused with an error. |

```json
{"type":"rename_session","id":"s_lz4k2h_9a1f0c","label":"Parser fix"}
```

### `archive_session`

Moves a saved session's transcript to `.magentra/sessions/archive/`, out of the resumable
listing (move the file back to restore it). The active session cannot be archived. A
successful archive emits a refreshed `session_list`.

| Field | Type |
| --- | --- |
| `type` | `"archive_session"` |
| `id` | string |

```json
{"type":"archive_session","id":"s_lz4k2h_9a1f0c"}
```

### `set_modes`

Sets the active discipline skills (all optional, none locked —
a request omitting them is refused with a `command_output` message). The engine replies
with a full `modes_updated` repaint.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"set_modes"` | |
| `active` | `string[]` | The optional style ids that should be active. |

```json
{"type":"set_modes","active":["entropy"]}
```

### `reload_team`

Re-reads `.magentra/team/*.md` and emits a fresh `team_updated`. No fields beyond `type`.

```json
{"type":"reload_team"}
```

## Round-trip sequences

### Permission round-trip

1. The model requests a tool whose permission class and the active mode require approval
   (see `docs/TOOLS.md` for the mode matrix).
2. The engine emits `permission_request` with a fresh `id` and blocks that tool call.
3. The frontend prompts the user and replies with `permission_response` echoing the same `id`:
   - `allow_once` — run this one call.
   - `allow_session` — run it and remember the approval for the rest of the session; a
     session-scoped allow rule is recorded so identical calls are not asked again.
   - `deny` — refuse; the optional `message` is passed back to the model so it can adjust.
4. The engine resolves the pending call and either runs the tool (emitting
   `tool_call_started` → `tool_call_finished`) or returns the denial as an error tool result.

```
core → { "type":"permission_request","id":"perm_3b9d","tool":"Bash","input":{"command":"rm -rf build","description":"Remove build output"} }
front→ { "type":"permission_response","id":"perm_3b9d","decision":"allow_session" }
core → { "type":"tool_call_started","id":"toolu_9","tool":"Bash","input":{"command":"rm -rf build","description":"Remove build output"} }
core → { "type":"tool_call_finished","id":"toolu_9","tool":"Bash","resultPreview":"(no output)","isError":false }
```

Resolution order for any tool call is **deny rules > allow rules > mode default**; only when
the mode default resolves to "ask" does a `permission_request` reach the frontend.

### Question round-trip

1. The model calls `AskUserQuestion`.
2. The engine emits `question_request` with 1–4 `Question` objects and blocks.
3. The frontend collects answers and replies with `question_response`, echoing the `id` and
   supplying `answers` keyed positionally as `"q:<idx>"` (each question's exact text is
   also accepted, as a fallback for older frontends); values are the chosen option labels,
   or free text for the always-available "Other" choice.
4. The tool call resolves with the user's selections and the turn continues.

```
core → { "type":"question_request","id":"q_7f21","questions":[ … ] }
front→ { "type":"question_response","id":"q_7f21","answers":{"q:0":["pnpm"]} }
```

## No back doors

The engine is the only integration surface. The host holds no private references into engine
internals: the NDJSON server consumes `engine.events` and calls `engine.send(...)`, and
nothing else — the desktop app in turn sees only that stdio stream. Any capability the
desktop frontend has, a future IDE frontend gets for free by speaking the same events and
requests over stdio. Conversely, a
capability that is not expressible as a `CoreEvent`/`FrontendRequest` pair does not exist as
far as frontends are concerned — which is exactly what makes this contract a stable seam to
build a VS Code (or other) integration against.
