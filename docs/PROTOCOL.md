# Magentra Protocol (v1)

The protocol is the single, versioned contract between the Magentra engine and any
frontend that drives it. A terminal REPL uses it today; a VS Code extension or other IDE
integration is expected to use the exact same contract tomorrow. Everything a frontend can
make the engine do, and everything the engine tells a frontend, travels as one of the typed
messages defined here. There is no side channel.

The types in this document are the source of truth in
`packages/protocol/src/types.ts`. The framing helpers live in
`packages/protocol/src/ndjson.ts`, and product/branding constants in
`packages/protocol/src/branding.ts`.

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

### 2. NDJSON over stdio (`magentra --serve`)

Running the CLI with `--serve` turns the process into a newline-delimited-JSON server:

- Each `CoreEvent` is written to **stdout** as one JSON object followed by `\n`.
- Each line read from **stdin** is parsed as one `FrontendRequest`.

Messages are the bare tagged-union objects — discriminated by their `type` field — with no
envelope. Framing rules (`packages/protocol/src/ndjson.ts`):

- `encodeFrame(obj)` = `JSON.stringify(obj) + "\n"`.
- `decodeFrames(stream)` splits the incoming byte/string stream on `\n`, tolerates a
  trailing `\r` (so CRLF pipes work), and skips blank lines.
- A line that fails to parse does **not** kill the transport: it is surfaced as an
  `{ type: "error", message: "unparseable frame: …", fatal: false }` object so one bad frame
  cannot take down the connection.
- On the request side, `--serve` additionally rejects any decoded frame that is not an object
  with a string `type`, replying with `{ type: "error", message: "invalid request frame",
  fatal: false }`.

When stdin closes (the frontend exits or the pipe breaks), the server tears down.

## Supporting types

These structured types appear as fields inside events and requests.

| Type | Definition |
| --- | --- |
| `PermissionMode` | `"default" \| "acceptEdits" \| "plan" \| "bypass"` |
| `PermissionDecision` | `"allow_once" \| "allow_session" \| "deny"` |
| `TaskStatus` | `"pending" \| "in_progress" \| "completed"` |
| `TaskItem` | `{ id, subject, description, activeForm?, status: TaskStatus, owner?, blocks: string[], blockedBy: string[], metadata? }` |
| `Usage` | `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` (all numbers) |
| `QuestionOption` | `{ label, description, preview? }` |
| `Question` | `{ question, header, options: QuestionOption[], multiSelect: boolean }` |
| `AllowedPrompt` | `{ tool, prompt }` |
| `SessionSummary` | `{ id, createdAt, updatedAt, cwd, firstUserMessage? }` |

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

```json
{"type":"session_started","v":1,"sessionId":"s_lz4k2h_9a1f0c","cwd":"/home/me/proj","model":"deepseek-ai/DeepSeek-V4-Flash","mode":"default"}
```

### `turn_started`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"turn_started"` | |
| `turnId` | string | Correlates with the matching `turn_finished`. |

```json
{"type":"turn_started","turnId":"t_1"}
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

```json
{"type":"tool_call_finished","id":"toolu_01","tool":"Bash","resultPreview":"12 passed, 0 failed","isError":false}
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

### `plan_ready`

Emitted when plan mode has produced a plan awaiting the user's decision.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"plan_ready"` | |
| `planPath` | string | Path to the written plan file. |
| `plan` | string | The plan text. |
| `allowedPrompts` | `AllowedPrompt[]` | Tool/prompt pairs pre-approved for execution. |

```json
{"type":"plan_ready","planPath":"/home/me/proj/.magentra/plans/p_1.md","plan":"1. Rename symbol\n2. Update imports\n3. Run tests","allowedPrompts":[{"tool":"Bash","prompt":"npm test"}]}
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

Emitted immediately when a background task (e.g. a `run_in_background` Bash command) reports
progress or completion.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"background_notification"` | |
| `taskId` | string | Background task id. |
| `kind` | string | Task kind, e.g. `"bash"`. |
| `payload` | unknown | Kind-specific detail (exit code, etc.). |

```json
{"type":"background_notification","taskId":"bg_2","kind":"bash","payload":{"status":"completed","exitCode":0}}
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
{"type":"session_list","sessions":[{"id":"s_lz4k2h_9a1f0c","createdAt":"2026-07-04T10:00:00.000Z","updatedAt":"2026-07-04T10:12:00.000Z","cwd":"/home/me/proj"}]}
```

### `turn_finished`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"turn_finished"` | |
| `turnId` | string | Matches `turn_started`. |
| `stopReason` | string | e.g. `end_turn`, `max_iterations`, `aborted`, `error`. |
| `usage` | `Usage` | Token accounting for the turn. |

```json
{"type":"turn_finished","turnId":"t_1","stopReason":"end_turn","usage":{"inputTokens":8123,"outputTokens":412,"cacheReadTokens":0,"cacheWriteTokens":0}}
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
| `answers` | `Record<string, string[]>` | Keyed by each question's text; values are selected option labels (or free text). |

```json
{"type":"question_response","id":"q_7f21","answers":{"Which package manager should I use?":["pnpm"]}}
```

### `plan_decision`

Response to `plan_ready`.

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"plan_decision"` | |
| `approve` | boolean | Approve and exit plan mode, or reject. |
| `editedPlan` | string? | An edited plan to use in place of the emitted one. |

```json
{"type":"plan_decision","approve":true}
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
{"type":"set_mode","mode":"plan"}
```

### `slash_command`

Runs a built-in command (`help`, `clear`, `compact`, `tasks`, `build-crew`, `mode`, `styles`, `settings`, `resume`, `sessions`).

`settings` with no args emits the effective config (each key's value and originating layer) as
`command_output`; `settings <key> <value>` validates the value against the settings schema, persists it
to the project or global `settings.json`, and applies it live where the running session allows.

`styles` with no args lists the .ma styles as `command_output` — core quality styles (locked always on)
and the optional ones with their on/off state; `styles on|off <id>` toggles an optional style through the
same path as the `set_modes` request (core styles cannot be turned off, and a style that `@conflicts` a
core one is refused with the mode engine's message), then emits `modes_updated`. Toggles are session-only
and are not persisted to settings.

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

Replays a saved transcript into a fresh session.

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
   supplying `answers` keyed by each question's exact text (values are the chosen option
   labels, or free text for the always-available "Other" choice).
4. The tool call resolves with the user's selections and the turn continues.

```
core → { "type":"question_request","id":"q_7f21","questions":[ … ] }
front→ { "type":"question_response","id":"q_7f21","answers":{"Which package manager should I use?":["pnpm"]} }
```

### Plan round-trip

1. In plan mode, only read-only tools run; the agent researches and drafts a plan.
2. The engine emits `plan_ready` with the plan text, its file path, and any `allowedPrompts`
   the agent proposes to run during execution.
3. The frontend shows the plan and replies with `plan_decision`:
   - `approve: true` (optionally with an `editedPlan`) — leave plan mode and execute.
   - `approve: false` — stay in plan mode / discard.

```
core → { "type":"plan_ready","planPath":"…/plans/p_1.md","plan":"1. …","allowedPrompts":[{"tool":"Bash","prompt":"npm test"}] }
front→ { "type":"plan_decision","approve":true }
```

## No back doors

The engine is the only integration surface. The CLI holds no private references into engine
internals: the REPL and the `--serve` server both consume `engine.events` and call
`engine.send(...)`, and nothing else. Any capability the terminal frontend has, a future IDE
frontend gets for free by speaking the same events and requests over stdio. Conversely, a
capability that is not expressible as a `CoreEvent`/`FrontendRequest` pair does not exist as
far as frontends are concerned — which is exactly what makes this contract a stable seam to
build a VS Code (or other) integration against.
