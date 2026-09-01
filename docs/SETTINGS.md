# Settings

Every behavior-changing knob the engine reads, from the zod schema in
`engine/core/src/config/settings.ts` (`settingsSchema` — the single source of truth;
this document mirrors it).

## Layering

Settings merge in this order, later layers winning per key:

1. **Schema defaults** — every key below has one.
2. **Global file** — `~/.magentra/settings.json`.
3. **Project file** — `<workspace>/.magentra/settings.json`.
4. **Environment variables** — see the table at the end.

Unknown keys warn, never crash; invalid JSON in a file is reported and that file is
skipped. `/settings` with no arguments lists every effective leaf value with the layer
it came from (`default` / `global` / `project` / `env`); the `apiKey` secret is always
redacted in that listing.

Change a setting with `/settings <key> <value>` — dot-path for nested keys, e.g.
`/settings search.enabled false`. The value is validated against the schema before
anything is written; it persists to the **project** file when the workspace has a
`.magentra/` directory, else to the global file. Prefix with `global` to force the
global file: `/settings global apiKey <your-key>`. `apiKey` always goes to the global
file — never the shareable project file — and the file is written mode `0600`.

## Provider and model

| Key | Default | Effect |
| --- | --- | --- |
| `provider` | `"openai-compatible"` | Which API dialect to speak: `"anthropic"` or `"openai-compatible"`. |
| `model` | `"deepseek-ai/DeepSeek-V4-Flash"` | The main model id sent on every turn. |
| `smallModel` | *(unset)* | Cheap model for WebFetch digestion and compaction summaries; falls back to `model` when unset. |
| `baseUrl` | *(unset)* | Endpoint the openai-compatible provider talks to. Point it at any compatible server — a hosted `/v1` API, a gateway, or a local one (e.g. Ollama's `http://localhost:11434/v1`). Left unset, a built-in fallback endpoint applies. |
| `apiKeyEnv` | *(unset)* | Name of the env var holding the API key. When unset, the provider defaults apply: `ANTHROPIC_API_KEY`, or `MAGENTRA_API_KEY`/`OPENAI_API_KEY` for openai-compatible. |
| `apiKey` | *(unset)* | The key itself, stored in `~/.magentra/settings.json`. A **secret**: never printed by `/settings`, and any matching env var always wins over it. |
| `allowInsecureTls` | `false` | Skip TLS certificate verification for provider requests — the `verify=False` escape hatch for self-signed certificates on servers you own. The engine warns loudly at boot while this is on; never enable it for endpoints you don't control. Set via the connection wizard's "Allow self-signed certificate" checkbox. |

## Vision

The model above is **never** sent an image. Images go to a second endpoint — the
vision model — which describes them; that description, plain text, is what enters
the conversation. So the account the agent works from is in the transcript and can
be checked, and the main endpoint never has to accept image parts at all.

Without `visionConnection` there is nothing to send an image to, so `vision`
cannot be switched on: attaching an image is refused, and `Read` on a `.png`
refuses with an explanation rather than returning content the model cannot see.

| Key | Default | Effect |
| --- | --- | --- |
| `vision` | `false` | Whether images can be used at all. Ignored (treated as off) while `visionConnection` is unset. Switched from the workspace menu (right-click a workspace in the sidebar, or a pane). |
| `visionConnection.provider` | `"openai-compatible"` | API dialect of the vision endpoint. |
| `visionConnection.model` | *(required)* | The model that looks at images, e.g. a vision-capable local model under Ollama. |
| `visionConnection.baseUrl` | *(unset)* | Endpoint of the vision model; same rules as `baseUrl`. |
| `visionConnection.apiKey` | *(unset)* | Its key. A **secret**, redacted by `/settings`. `MAGENTRA_VISION_API_KEY` always wins over it — that is where the desktop app puts the key (in the workspace `.env`). |
| `visionConnection.contextWindow` | *(unset)* | Context-size hint, forwarded as `num_ctx` to a local server. |
| `visionConnection.allowInsecureTls` | `false` | Self-signed certificate opt-in for the vision endpoint. TLS verification is process-wide, so enabling it here relaxes it for every provider request. |
| `visionConnection.profileId` | *(unset)* | Which saved app profile it came from. Written and read by the desktop app; the engine ignores it. |

The desktop app never asks for this block directly. A connection **profile**
names another profile as its vision model, and applying that profile writes both
connections at once — so a vision model is set up once, in the connection
wizard, and travels with every workspace that connection is applied to. The key
lands in the workspace `.env` as `MAGENTRA_VISION_API_KEY`, never in the
shareable project settings file.

## Turn and context limits

| Key | Default | Effect |
| --- | --- | --- |
| `maxTokensPerResponse` | `32768` | `max_tokens` for a single model response. A cutoff at this wall triggers the length-continuation path; a higher value makes cutoffs rarer. |
| `maxTokensPerTurn` | `200000` | Output-token budget per turn. Applies only to child sessions — interactive root turns run uncapped (the stall detector is the brake). |
| `clarify` | `true` | Clarify pre-layer: on a genuinely open-ended request ("build a game", "improve this app"), the main model asks up to three shape-defining multiple-choice questions before any work starts. Concrete or trivial requests never trigger it; fail-open on any error; root attended sessions only. |
| `maxIterationsPerTurn` | `50` | Loop-safety cap on model↔tool round-trips. Same scope: unattended runs and explicitly capped children only. |
| `contextWindow` | *(unset)* | The model's context window in tokens. **Entered by the user** in the connection wizard (required there) — the engine never guesses it. Drives auto-compaction (below) and is sent as `num_ctx` to a local server. When unset the engine assumes 128k and warns at session start. |
| `compactionThreshold` | `0.8` | Fraction of `contextWindow` (0.1–1) at which the conversation is compacted automatically (oldest span summarized, recent tail kept verbatim). The desktop app's *Auto-compact at* setting can only lower the resulting limit. On an overflow the engine still compacts and retries the call, at most twice per turn. |

## Retention

Bounds append-only workspace state; pruning runs whenever a root session starts.

| Key | Default | Effect |
| --- | --- | --- |
| `retention.sessions` | `100` | How many transcripts to keep (top-level and legacy/subagent), newest first. |
| `retention.tasks` | `100` | How many persisted task lists and background-task output files to keep, newest first. |

## Pricing

| Key | Default | Effect |
| --- | --- | --- |
| `pricing` | `{}` | Per-model rate card, $ per 1M tokens, overriding the built-in table in `engine/core/src/config/pricing.ts` — so a self-hosted or brand-new model can be priced without a code change. Shape: `{ "<model-id>": { "input": n, "output": n, "cacheRead"?: n, "cacheWrite"?: n } }`. `cacheRead`/`cacheWrite` fall back to the input rate when omitted. A model with no rate card anywhere reports token counts with **no** cost estimate — never a guessed price. |

## Permissions

| Key | Default | Effect |
| --- | --- | --- |
| `permissions.allow` | `[]` | Rule strings matching tool name + argument glob, e.g. `"Bash(git status*)"`. Auto-approve matching calls. |
| `permissions.deny` | `[]` | Same syntax; refuse matching calls. Resolution order is **deny > allow > stance default**. |
| `permissions.allowExact` | `[]` | Grants written by the approval card's "Always allow". For ordinary commands the grant is the command's *shape* (`{tool, subject: "mkdir", prefix: true}` — covers every `mkdir …`; `git push`-style CLIs keep the subcommand, `npm run` keeps the script name; compound/substituted commands stay literal). Deletion-guard approvals always store the literal command, and shape grants never override the deletion guard. |

There is no `permissionMode` setting: the permission stance is the session's OVERDRIVE
toggle alone. Off, file edits and reads are auto-approved and commands prompt; on, nothing
prompts except the deletion guard. (Old settings files that still carry `permissionMode`
load fine — the key is ignored.)

## Hooks

| Key | Default | Effect |
| --- | --- | --- |
| `hooks` | `{}` | Shell commands run at lifecycle events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`. Each event maps to entries of `{ matcher?, hooks: [{ type: "command", command, timeout? }] }` (`timeout` in seconds, max 600). A `PreToolUse` hook that blocks feeds its reason back to the model as an error tool result. |

## MCP servers

| Key | Default | Effect |
| --- | --- | --- |
| `mcpServers` | `{}` | Stdio MCP servers to launch: `{ "<name>": { "command": "...", "args"?: [...], "env"?: {...}, "timeoutMs"?: n } }`. Each server's tools register as `mcp__<name>__<tool>`. `timeoutMs` is the per-call `tools/call` timeout in milliseconds (default `60000`); the startup handshake stays at 10s regardless. Malformed entries are skipped with a warning; a server that fails to start contributes no tools (see `engine/core/src/integrations/mcp.ts`). |

## Worktrees

| Key | Default | Effect |
| --- | --- | --- |
| `worktree.baseRef` | `"fresh"` | What EnterWorktree branches from: `"fresh"` = origin's default branch, `"head"` = the current HEAD. |

## Web search

| Key | Default | Effect |
| --- | --- | --- |
| `search.enabled` | `true` | Master switch for the WebSearch tool; when `false` the tool refuses to run. |
| `search.provider` | *(unset)* | `"duckduckgo"` (the default, no key needed), `"brave"`, or `"tavily"`. |
| `search.apiKeyEnv` | *(unset)* | Env var holding the search provider's API key (Brave/Tavily). |

## Embeddings

| Key | Default | Effect |
| --- | --- | --- |

## Reuse check

Warns when the agent writes a new file that likely duplicates an existing one. It never
blocks the Write — the reminder (with the closest matches) rides along so the agent can
consolidate. (The old refuse-once `"gate"` mode was retired 2026-07-20; a settings file
that still says `"gate"` loads as `"remind"`.)

| Key | Default | Effect |
| --- | --- | --- |
| `reuseCheck.mode` | `"remind"` | `"remind"` nudges with the closest matches, `"off"` disables the check. |
| `reuseCheck.maxHits` | `5` | How many of the closest existing matches to list (max 10). |
| `reuseCheck.blockThreshold` | `0.75` | Similarity at/above which the reminder is worded firmly (near-duplicate). |
| `reuseCheck.remindThreshold` | `0.5` | Similarity at/above which a reminder is queued. |

## Addons

Addons have no settings. Every installed addon is always available and nothing is
injected automatically, so there is nothing to switch on — drop files in
`.magentra/addons/` and they load. See `docs/ADDONS.md`.

## Environment variable overrides

Env vars override both settings files (single source of truth: `ENV_OVERRIDES` in
`engine/core/src/config/settings.ts`):

| Env var | Settings key |
| --- | --- |
| `MAGENTRA_PROVIDER` | `provider` |
| `MAGENTRA_MODEL` | `model` |
| `MAGENTRA_SMALL_MODEL` | `smallModel` |
| `MAGENTRA_BASE_URL` | `baseUrl` |
| `MAGENTRA_API_KEY_ENV` | `apiKeyEnv` |
| `MAGENTRA_VISION` | `vision` |
| `MAGENTRA_MAX_ITERATIONS` | `maxIterationsPerTurn` |
| `MAGENTRA_MAX_TOKENS_PER_TURN` | `maxTokensPerTurn` |

`MAGENTRA_VISION_API_KEY` is not in that table — it is not a settings override
but the vision endpoint's key, resolved the way `MAGENTRA_API_KEY` is for the
main one (env first, then the value stored in `visionConnection.apiKey`).

`contextWindow` deliberately has **no** env override: the window has exactly one
storage (the `contextWindow` settings key) and one resolver, so a stale value in a
second channel can never shadow a model's real window.

## The STANDARDS.md convention

Not a settings key, but workspace configuration all the same: a file named
`STANDARDS.md` at the workspace root (or `.magentra/STANDARDS.md` — root wins) holds
user-provided coding standards. When present it is injected into the system prompt
under a "Coding standards (user-provided — binding)" header: the standards are treated
as rules that win over any default style guidance, and after a turn that wrote or
edited files the wrap-up nudge tells the model to confirm the diff complies and name
any deviation. Content beyond 16KB is truncated at a line boundary with a notice to
condense the file (`engine/core/src/knowledge/standards.ts`).

## The `.magentra/` directory reference

Everything the engine persists in a workspace lives under `.magentra/`:

| Path | Contents |
| --- | --- |
| `settings.json` | Project settings (this document). |
| `sessions/` | Append-only JSONL transcripts, one per session. |
| `sessions/subagents/` | Transcripts of subagent child sessions. |
| `tasks/` | Persisted task lists (per session) and background-task output. |
| `worktrees/` | Git worktrees created by EnterWorktree. |
| `addons/` | Workspace addons — a `name.md` or a `name/ADDON.md` folder (`docs/ADDONS.md`). Global ones live in `~/.magentra/addons/`. |
| `tmp/` | Engine scratch space. |
| `logs/` | Desktop-app launch logs (secrets redacted, old logs pruned). |
| `scheduled_tasks.json` | Durable cron jobs. |
| `graph.json`, `symbols.json` | The import graph and symbol index behind GraphQuery. |

`~/.magentra/` holds the global `settings.json` and global `addons/`.
