# Area: engine/core  (~11,600 lines) + host + providers

## Runtime

**Turn loop** (`runtime/session.ts`, 3,151L — the hub, imports most of the
engine). Members worth naming: remind, runInference, describeImage, spawnAgent,
runTurn, streamAssistantTurn, executeToolCalls. Exports `isSelfVerifyDone`,
`addonNamedIn`, `Session`.

**Slash-command registry** — ONE array in `runtime/engine.ts` (`SLASH_COMMANDS`).
`/help` renders from it and `session_started` ships it to the frontend palette,
so the two cannot drift. 10 commands:
/help /clear /compact /session /tasks /addons /overdrive /settings /resume /sessions
`/settings` is worded "open" so it is true of both a UI frontend (opens the form)
and a headless one (prints the listing).

**SETTING_TIMING** — 24 settings keys, each mapped to when a change takes
effect: session | nextTurn | restart | clear. The note it prints is the ONLY
thing telling the user whether their change took, so a wrong entry is a lie:
  session:   provider, visionConnection, baseUrl, apiKeyEnv, apiKey, retention,
             pricing, allowInsecureTls
  nextTurn:  model, smallModel, vision, maxTokensPerResponse, maxTokensPerTurn,
             maxIterationsPerTurn, contextWindow, reasoningEffort,
             compactionThreshold, clarify, search
  restart:   hooks, mcpServers
  clear:     permissions, worktree, reuseCheck
(The 5 connection keys say "session" because applySettingLive rebuilds the
provider on the spot — they used to say "restart", which became a lie.)

**FINISHING LADDER** (`runtime/finishing.ts`, 257L — pure functions, imports
nothing from session or permissions, so it is checkable in isolation):
- Order matters absolutely: the end-of-turn rungs sit AHEAD of self-verify,
  because a self-verify answering DONE breaks the loop and nothing after it runs.
- `codeFilesAmong` — 48 executable suffixes. Docs/config/data deliberately
  EXCLUDED: editing a README is not a behaviour change.
- `looksLikeTestDouble` — 19 markers (unittest.mock, MagicMock, mock.patch,
  jest.mock(, vi.fn(, sinon.stub(, class Fake/Mock/Stub/Dummy, def fake_/mock_/
  stub_ …). Tuned for PRECISION not coverage: a miss costs nothing, a false
  positive teaches the model to skim past reminders.
- `runtimeEvidenceText` — fires ONCE at the end of a turn that edited source and
  ran no command. A reminder, never a block. 5-step ladder; step 3 says put a
  throwaway harness in the system temp dir and delete it the same turn.
  Vision clause swaps on `settings.vision`. The closing paragraph is
  load-bearing: "I could not run this, here is what stays unverified" is
  declared a FULLY correct ending — otherwise the rung manufactures the very
  failure it exists to catch.
- DOUBLE_CLAUSE — appended only when the turn's checking leaned on self-written
  stand-ins. "A passing check against your own stand-in proves your code is
  self-consistent and nothing more."
- `selfVerifyText` — fires only in OVERDRIVE, only on a turn with ≥1 tool call,
  at most once per turn. Answer is the literal ASCII `DONE` (never translated,
  never shown to the user) or continued work. Closing clause flips on whether
  code changed. Emptying the prompt returns undefined, which CANCELS the whole
  inference round rather than sending a blank message.
- MAX_NAMED_FILES = 8, then it counts instead of listing.

**PERMISSION ENGINE** (`runtime/permissions.ts`, 421L).
Resolution order, exactly: **deny rules > protected-path guard > deletion guard
> allow rules > stance default.**
- Stance default has been ALLOW for every class since 2026-07-26. The friction
  bought little, because what is worth confirming is not a class of TOOL but a
  class of TARGET — hence the two target guards ahead of the stance.
- `protectedEditPath` — an edit into any `.magentra` path SEGMENT, or a file
  named `.env` / `.env.*`, confirms EVERY time. Beats allow rules and the
  stance. Satisfied only by a deliberate narrow grant (explicit `Tool(path)`
  rule, or an earlier always-allow on that exact path); broad grants and
  OVERDRIVE never satisfy it.
- Deletion guard — default ON, both stances. Overridden ONLY by an explicit
  subject-scoped literal allow rule (`Bash(rm -rf ./tmp/*)`). Broad grants,
  `Tool(*)` and session allows never override it. It never adds a session
  allow, so it re-fires on every other matching call. A DERIVED command-shape
  grant must never let a later destructive variant skip it (benign `git push`
  approval must not cover `git push --force`).
- Deleting a `.magentra` target asks in every mode EXCEPT OVERDRIVE.
- OVERDRIVE turns both guards off — "nothing asks" literally. Deny rules are
  the one thing it does not override.
- `deriveAlwaysGrant` — an always-allow on an execute call remembers the command
  SHAPE, not the exact text: `mkdir -p a/b` → `mkdir`; `git push origin main` →
  `git push`. 21 MULTI_COMMAND_CLIS keep two tokens (git, gh, npm, npx, pnpm,
  yarn, docker, kubectl, cargo, go, dotnet, pip, pip3, apt, apt-get, brew,
  systemctl, terraform, gcloud, aws, az). Script runners keep THREE
  (`npm run build`, never all of `npm run`). Returns undefined — grant stays
  exact — for compound/substituted commands (`|;&`$><\'"`) or a head token that
  is not a plain program name. Deletion-guard approvals never pass through here.

**Other runtime**: `sessionStats.ts` (317L, ContextBreakdown + SessionStats —
the /session report), `fileState.ts` (48L, read-before-write freshness).

## Knowledge layer

- `graph.ts` (1,247L) — the import graph: buildGraph, loadOrBuildGraph,
  pagerank (personalized), blastRadius, dependencies, articulationPoints,
  slice, graphStats. MAX_FILE_BYTES, SCAN_EXTS, langOf, shouldSkipDir,
  normalizeToId. **GraphData.version must be bumped on any extraction change**
  — entries are reused when mtime+size are unchanged, so a scanner fix is
  invisible on workspaces holding a `.magentra/graph.json`.
- `symbols.ts` (442L) — symbol index: extractSymbolSites, extractSymbols,
  buildSymbolIndex, loadOrBuildSymbolIndex, tokensOf, findSimilarSymbols.
- `docs.ts` (889L) — hand-rolled extractors for PDF, DOCX, PPTX, XLSX, RTF,
  ODT, EPUB. No dependency.
- `reuseGate.ts` (156L) — `evaluateReuseGate` over a SearchLog. Reminds, never
  blocks: a would-be new-file Write becomes a reminder so the signal survives
  but the refusal does not.
- `standards.ts` — STANDARDS_FILENAMES loaded into the system prompt.
- `seeds.ts`, `workspace.ts` (workspaceLooksNonTrivial, projectName).

## Agent layer

- `prompts.ts` (277L) — the whole system prompt as 9 SECTION_* exports composed
  by `behaviorCore()`: IDENTITY, HARNESS, COMMUNICATION, ACTION_CARE, GIT,
  CODE_STYLE, TASKS, WORKING_METHOD, AUTONOMY. Plus environmentBlock,
  addonsBlock, buildSystemPrompt. Editing prose here changes every session's
  prompt and nothing tests it.
- `addons.ts` (221L) — loadAddons; two layouts (flat `<name>.md` and
  `<name>/ADDON.md`); a directory without ADDON.md is skipped. Precedence:
  builtin → `~/.magentra/addons/` → workspace, later replaces earlier.
- `builtinAddons.ts` (109L) — BUILTIN_ADDONS stored in-code so they exist
  however the app is packaged. A built-in is text ONLY: no sibling files or
  scripts, because it has no directory. Includes `magentron`.
- `agents.ts` (101L) — AGENT_TYPES, resolveAgentType, agentToolNames,
  SUBAGENT_RESULT_ID. Only types with a non-empty blurb are spawnable.
- `hooks.ts` (134L) — HookRunner, HookConfig, HookOutcome, HookSummary.
- `tool.ts` (280L) — PermissionClass, ToolDefinition, ToolRegistry,
  SessionServices, ToolContext, FileStateStore, TaskStoreApi, BackgroundApi,
  registerToolPrompt, toolDescriptionText, isToolDisabled.

## Config

- `settings.ts` (665L) — settingsSchema (24 keys), global + project layering
  (project merges OVER global), loadSettings, describeSettings, setSetting /
  setSettingPath / deleteSettingPath / coerceSettingValue, addExactPermission,
  resolveApiKeySource / resolveApiKey (ordered: pinned apiKeyEnv → standard env
  names → stored key; blank env vars do not count; a dangling pin warns),
  resolveVisionApiKey, VISION_API_KEY_ENV.
- `providerFactory.ts` (107L) — isLocalBaseUrl (MIRRORED in app/main/config.js,
  unguarded since the test reset), endpointSpecFromSettings,
  createProviderForEndpoint.
- `pricing.ts` (84L) — MODEL_PRICING, pricingFor, contextWindowFor,
  formatDuration. No rate card ⇒ no cost shown, never a fabricated $0.00.
- `frontmatter.ts` (66L) — hand-parsed `---` frontmatter, no YAML dep, every
  value a string, ONE PHYSICAL LINE per value. **Splits at the FIRST colon**, so
  `description: Use when X: then Y` is one key. `entries` preserves order and
  repeats so a strict caller can name the offending line.

## Scheduling

- `cron.ts` (348L) — parseCron, matchesCron, nextCronMatch, CronScheduler.
- `workflow.ts` (328L) — WorkflowRunner: ParsedMeta (pure-literal meta),
  concurrency cap 4, 100-call cap, enforced output-token budget.
- `background.ts` (102L) — BackgroundManager.

## State

- `transcript.ts` (225L) — stripSystemReminders, unansweredToolUseIds,
  syntheticToolResults, **repairToolPairing** (every dangling tool_use must get
  a tool_result or the provider rejects the next request and /resume replays the
  wound forever), Transcript/TranscriptRecord.
- `taskStore.ts` (126L) — TaskStore.

## Integrations

- `mcp.ts` (323L) — McpClient, createMcpTools, mcpServerConfigSchema,
  McpToolInfo/McpToolError. External MCP servers become tools.

## Util

- `fsAtomic.ts` — writeFileAtomic (write-then-rename + chmod). The one
  implementation behind settings.json, profiles.json, graph.json, symbols.json,
  config.json. **This is what the gateway must reuse for its own writes.**
- `asyncQueue.ts` — unbounded push/pull queue bridging emitters to async
  iteration. **The event queue has ONE consumer** — a second concurrent
  consumer silently steals events, which is why multi-workspace is a process
  pool.
- `zodToJsonSchema.ts`.

## Host (370L)

serve.ts, main.ts, bootstrap.ts, env.ts, stdout.ts, index.ts — the NDJSON
stdio process boundary.

## Providers (~1,500L)

- `openai-compat.ts` (575L) — OpenAICompatProvider, ThinkTagSplitter,
  OpenAICompatOptions. Field negotiation: a 400 naming stream_options /
  max_tokens (→ max_completion_tokens) / num_ctx drops or renames that field and
  re-sends ONCE, then remembers for the provider's life. `tools` is never
  dropped. Multimodal user content array for images.
- `anthropic.ts` (272L), `ollama.ts` (292L), `effort.ts` (125L, EffortClamp +
  WireEffort + looksLikeUnknownField + mentionsReasoningEffort),
  `think.ts` (92L, ThinkTagSplitter), `retry.ts` (230L, ProviderHttpError,
  looksLikeContextOverflow, parseRetryAfter, withRetry),
  `fake.ts` (84L, FakeProvider/FakeTurn/FakeToolCall — scripted turns, no
  network, no key: **the seam the new suite is built on**),
  `types.ts` (107L).
