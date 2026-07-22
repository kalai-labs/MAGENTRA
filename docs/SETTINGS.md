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
| `baseUrl` | *(unset)* | Endpoint override. The openai-compatible provider defaults to DeepInfra (`https://api.deepinfra.com/v1/openai`); point this at any compatible server (e.g. Ollama's `http://localhost:11434/v1`). |
| `apiKeyEnv` | *(unset)* | Name of the env var holding the API key. When unset, the provider default applies (`ANTHROPIC_API_KEY`, or `DEEPINFRA_API_KEY`/`OPENAI_API_KEY`). |
| `apiKey` | *(unset)* | The key itself, stored in `~/.magentra/settings.json`. A **secret**: never printed by `/settings`, and any matching env var always wins over it. |
| `allowInsecureTls` | `false` | Skip TLS certificate verification for provider requests — the `verify=False` escape hatch for self-signed certificates on servers you own. The engine warns loudly at boot while this is on; never enable it for endpoints you don't control. Set via the wizard/Settings "Allow self-signed certificate" checkbox. |

## Turn and context limits

| Key | Default | Effect |
| --- | --- | --- |
| `maxTokensPerResponse` | `8192` | `max_tokens` for a single model response. |
| `maxTokensPerTurn` | `200000` | Output-token budget per turn. Applies only to unattended (mission) runs and children — interactive root turns run uncapped (the stall detector is the brake). Mission `budget:` overrides it per run. |
| `clarify` | `true` | Clarify pre-layer: on a genuinely open-ended request ("build a game", "improve this app"), the main model asks up to three shape-defining multiple-choice questions before any work starts. Concrete or trivial requests never trigger it; fail-open on any error; root attended sessions only. |
| `maxIterationsPerTurn` | `50` | Loop-safety cap on model↔tool round-trips. Same scope: unattended runs and explicitly capped children only. |
| `contextWindow` | *(unset)* | Explicit context-size override — **for local servers only**. |
| `compactionThreshold` | `0.8` | Fraction of the effective context window (0.1–1) at which the conversation is compacted (oldest span summarized, recent tail kept verbatim). |

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
| `embeddings.model` | `"BAAI/bge-m3"` | Embedding model used to build crew backpacks (hosted, over the OpenAI-compatible `/embeddings` endpoint). |
| `embeddings.enabled` | `true` | When `false`, no embedding calls are made; backpack BM25 search keeps working. |

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

## Skills

| Key | Default | Effect |
| --- | --- | --- |
| `modes.active` | `[]` | Discipline skills to activate at session start (e.g. `prover`, `sentinel`, `grill`). Every skill is optional and OFF unless listed here or toggled in-session — nothing is locked on. See `docs/SKILLS.md`. |

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
| `MAGENTRA_MAX_ITERATIONS` | `maxIterationsPerTurn` |
| `MAGENTRA_MAX_TOKENS_PER_TURN` | `maxTokensPerTurn` |

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
| `sessions/subagents/` | Transcripts of subagent/crew child sessions. |
| `tasks/` | Persisted task lists (per session) and background-task output. |
| `worktrees/` | Git worktrees created by EnterWorktree. |
| `skills/` | Workspace skills (global ones live in `~/.magentra/skills/`). |
| `skills/` | Workspace skill files — disciplines and on-demand actions (`docs/SKILLS.md`). |
| `missions/` | Mission files (`<id>.md`), `continuous.json` (running loops), and `out/<id>/` with the default `report.md` plus `log.jsonl` (one JSON line per run). |
| `team/` | Crew member files (`<id>.md`), plus `docs/`, `backpacks/`, and `experience/` (`<id>.json` lessons, `<id>.record.jsonl` service records). |
| `debug/` | The `/debug` repro oracle scripts (`repro.sh` / `repro.ps1`). |
| `tmp/` | Engine scratch space. |
| `logs/` | Desktop-app launch logs (secrets redacted, old logs pruned). |
| `scheduled_tasks.json` | Durable cron jobs. |
| `ATLAS.md` | The whole-design codebase map (auto-built on first visit). |
| `LEXICON.md` | The shared-vocabulary file the `lexicon` style maintains. |
| `DECISIONS.md` | The decision log the `grill` style appends to. |
| `graph.json`, `symbols.json` | The import graph and symbol index behind GraphQuery. |

`~/.magentra/` holds the global `settings.json` and global `skills/`.
