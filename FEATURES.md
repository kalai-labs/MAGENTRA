# Features — and the tests they still need

Every feature MAGENTRA ships. No tests were carried over from the previous
repository: this file is the backlog for writing them from scratch.

A box is ticked **only** when a test exists that would actually fail if the
feature broke. A test that asserts a mock returned what the mock was told to
return is not a test — leave the box empty.

## How to read the columns

| Column | Meaning |
| --- | --- |
| **Test kind** | What a real test for this needs. |
| `pure` | Deterministic logic. No model, no network. Assert on inputs/outputs. |
| `fs` | Touches the filesystem. Use a temp workspace; assert on what lands on disk. |
| `proc` | Spawns a real process (shell, ripgrep, MCP server, git). |
| `net` | Needs the network, but not an LLM (web search/fetch). |
| **`llm`** | **Needs a real model behind a real API key.** A fake provider proves the plumbing, never the behaviour: the feature exists to change what a model *does*. Both are worth having — the `llm` one is what the tick depends on. |
| `ui` | Electron: launch the app and drive it (`npm run smoke` is the seed of this). |

`llm` tests are slow, cost money, and are non-deterministic. Assert on the
*mechanism* they drive (was the tool called? did the gate fire? did the file
land?), not on the model's prose.

---

## Runtime — the turn loop

- [ ] **Turn loop** — user message → streamed thinking/text → tool calls → turn end. `llm`
- [ ] **Interrupt** — a running turn stops promptly, including pending question rounds. `llm`
- [ ] **Interactive turns run uncapped** — no iteration cap, no per-turn token budget, unlimited signal-driven recovery nudges (failed batch, length cutoff, open tasks); the wrap-up nudge keeps its cap and the stall detector is the brake. `pure`
- [ ] **Bounded runs stay bounded** — unattended (mission) runs and explicitly capped children respect `maxIterationsPerTurn`/`maxTokensPerTurn`, with the final-round warning. `pure` + `llm`
- [ ] **Self-verify rung** — the first clean end-attempt injects the completeness+economy self-check (query-shaped evidence, no invented rituals); a silent DONE ends the turn with one visible reply; fires once per turn, re-armed by steering. `llm`
- [ ] **Stall detector** — three consecutive identical rounds (same calls, same results) force a strategy pivot; after two pivots, the model must ask the user one concrete question. `pure` + `llm`
- [ ] **Reuse gate reminds, never blocks** — a would-be new-file Write block becomes a reminder; the signal survives, the refusal doesn't. `pure`
- [ ] **Mid-run steering (both stances)** — typing while a turn runs sends `steer_message`: the text joins the running turn at its next message boundary, re-arms self-verify, refunds pivots; when the turn already ended, it becomes a normal user turn. Slash/bang commands still queue for turn end. `llm`
- [ ] **Context accounting** — `contextTokens` is the *last* request's whole prompt (input + cacheRead + cacheWrite) plus its reply, and does NOT accumulate across rounds. `pure`
- [ ] **Usage accounting** — billed usage DOES accumulate, per model, across the session and every subagent. `pure`
- [ ] **Provider usage normalization** — OpenAI-compatible `prompt_tokens` (whole prompt) minus `cached_tokens` (a subset) yields disjoint classes; Anthropic already reports them disjoint. Getting this wrong double-counts cache. `pure`
- [ ] **Cost estimate** — four token classes billed at four different rates; no rate card ⇒ no cost shown (never a fabricated `$0.00`). `pure`
- [ ] **`/session` report** — cost, API vs wall time, code churn, context now, usage per model. `pure`
- [ ] **Compaction** — the oldest span is summarized when context crosses the threshold; the summary replaces it and context resets. `llm`
- [ ] **Permission stances** — exactly two: normal (reads/interactions/file edits allowed, commands ask with once/session/always grants) and OVERDRIVE (everything allowed); deny-rule beats allow-rule beats stance. `pure`
- [ ] **Approval note** — the approval card takes an optional note with ANY decision: on deny it becomes the refusal reason the model reads; on allow it reaches the model as a reminder with that round's results. `pure` + `llm`
- [ ] **Command-shape always-allow** — "Always allow" on an ordinary command remembers its shape (`mkdir …` covers all mkdir; `git push`/`npm run build` keep the subcommand/script; compound or substituted commands stay literal); the card states the scope; shape grants persist across sessions and never override the deletion guard. `pure`
- [ ] **Clarify pre-layer** — a genuinely open-ended request ("build a game", "improve this app") triggers up to three shape-defining multiple-choice questions BEFORE any work, judged by the main model; concrete/trivial/follow-up requests never trigger it; fail-open on any error; root attended turns only; `clarify: false` disables. `llm`
- [ ] **Deletion guard** — destructive Bash always asks, *in both stances*, until explicitly disabled. Covers `rm`, `mv`, force-push, `DROP TABLE`, … `pure` + `proc`
- [ ] **Protected state dir** — deleting a folder *named* `.magentra` (or a glob/unparseable command that could hit one) always asks, in both stances; it beats the "allow deletions" setting, explicit allow rules, OVERDRIVE, and never offers "always allow". Deeper paths like `.magentra/worktrees/foo` stay routine. `pure`
- [ ] **File freshness** — Edit/Write on a file changed on disk since it was read is refused. `fs`

## OVERDRIVE — fully-autonomous stance

When ON (composer toggle, `/overdrive on`, or `set_overdrive`), nothing asks: the permission stance flips to allow-all and the shell shifts identity. The turn loop itself (uncapped, self-verify, stall detector, reuse-gate reminders) is identical in both states. State is session-scoped, survives `/clear` within the run, and `/resume` restores it from the transcript meta.

- [ ] **Allow-all stance** — commands, network, everything runs unprompted; only the deletion guard and the `.magentra` protection still ask. `pure`
- [ ] **Deletion scope-split** — deletions provably inside the workspace skip the guard (rm/del/find/mv with analyzable paths, judged against Bash's tracked cwd); history rewrites, substitution, `~`, root wildcards, out-of-tree paths, and `.magentra` state dirs still ask. `pure`
- [ ] **Pre-turn snapshot** — a `git stash create` ref is parked before each root turn and reported as `overdriveSnapshot` on `turn_finished` (tracked files only; absent on a clean tree). `fs`
- [ ] **Prompt contract** — the OVERDRIVE system-prompt section (plan-first, consequence-thinking, query-shaped evidence, ask-rubric, cleanup license) is present exactly while ON. `pure`

## CAREFUL MODE — the OVERDRIVE modifier

A modifier of OVERDRIVE, not a third stance (composer pill, `/careful on`, or the `careful` field on `set_overdrive`). OVERDRIVE removes approval from every *action*; CAREFUL adds it back at exactly one *decision* — which direction to take. What the user approves is a **proposal of direction, never a plan** (ADR 0003), and the approved proposal then becomes the brief the work runs on. Armed independently of OVERDRIVE and inert while it is off; session-scoped, and `/resume` restores it from the transcript meta.

- [ ] **Predictor** — one main-model inference before the turn decides whether the request needs several tool-driven steps, or one irreversible step. Size and reversibility only, never clarity. Strictly fail-open: a thrown call or malformed verdict runs the turn normally. Root attended sessions only — never children, never unattended missions. `llm`
- [ ] **Scout hold** — while held, only `Read`/`Grep`/`Glob`/`GraphQuery`/`BackpackSearch`/`Skill` run; everything else is refused with a teaching message. Beats allow rules, `allow_always` grants, session allows, and OVERDRIVE itself; a user's own deny rule still refuses first. Children inherit it via the shared `PermissionEngine`. Lifted unconditionally by the turn's `finally`. `pure`
- [ ] **Scout map** — before its first round the scout is handed the atlas (or an import-graph skeleton) plus a slice of the repository seeded from the request itself, so it starts from where the work lands instead of discovering it. Graph-derived, so it is a repository fact and not a model's guess. `pure`
- [ ] **Silent deliberation** — assistant text and thinking are suppressed for the whole held phase, so the user sees tool activity but no prose until the proposal. Phase edges are marked with `▶ ` banners. `pure`
- [ ] **Stop test, not a cap** — the scout prompt carries a checkable stop condition ("can you answer all four without guessing?"), and after 4 rounds one soft warn repeats it. Nothing is ever cut mid-read: a scout stopped early proposes from a half-formed picture (ADR 0005). `llm`
- [ ] **Review pass** — one silent look at its own draft before the user sees it; leaving the draft unchanged is a correct outcome, and it reads nothing new. A revision gets none — the user has supplied the judgement it substitutes for. `llm`
- [ ] **Open questions first** — after scouting and before the proposal exists, the agent surfaces anything only the user can decide as a question round (same JSON contract and validator as the clarify pre-layer). Usually empty, since the scout has just read the repository; when empty it costs no round trip. A revision gets no new round — the user's own words are the answer. `llm`
- [ ] **Proposal** — four fixed H1 sections (objective, solution, consequences, unclear), written in Plain Speech in the user's own language. Consequences carries **what changes for you** first, then **where it lands** — the area from the import graph, never a promised file manifest. `llm`
- [ ] **Path check** — the proposal is written muted; every path it names is checked against the workspace, and unknown ones are sent back to be corrected or declared new (max 2 rounds) before it is ever shown. `pure`
- [ ] **Approval gate** — reuses `question_request`; `Start work` lifts the hold, `Cancel — change nothing` ends the turn, and any free text is a revision that re-scouts with the hold still on and a fresh map seeded from what the user said. Unlimited revisions. An unanswered or interrupted gate reads as cancel, never as approval. `pure`
- [ ] **Post-approval** — the approved proposal is injected as the working brief and work starts immediately; no further question round, because everything the user could settle was settled before the proposal. Plans with `TaskCreate` and works with full OVERDRIVE autonomy; the self-verify rung is unchanged. `llm`

## Agent

- [ ] **System prompt assembly** — env, skills, standards, atlas, skill sections compose in the right order. `pure`
- [ ] **Subagent types** — each type gets its declared toolset and role; a role override replaces the role without touching the toolset. `pure`
- [ ] **Subagent spawn** — a child runs, streams tagged events, and returns its final text to the parent. `llm`
- [ ] **Skills** — a markdown skill in `.magentra/skills/` is discovered and its body reaches the model through the `Skill` tool. `fs` + `llm`
- [ ] **Hooks** — `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` fire, and a blocking hook actually blocks. `proc`

## Tools

- [ ] **Read / Write / Edit** — including absolute-path enforcement, image reads, unique-match rules, and the `file_edited` diff. `fs`
- [ ] **Glob / Grep** — Grep shells out to the real ripgrep binary. `proc`
- [ ] **Bash** — persistent cwd across calls, timeout kills the process tree, background jobs stream to a file. `proc`
- [ ] **Bash cwd vs session cwd** — a tracked `cd` is discarded when the session cwd moves (worktree enter/exit), so Bash never runs in a stale tree. `proc`
- [ ] **Task list** — create/update/list/get, and `task_list_updated` fires per mutation. `pure`
- [ ] **Background task manager** — non-blocking launch, partial-output polling, real termination on stop. `proc`
- [ ] **Agent / Workflow tools** — dispatch subagents; workflow scripts run `agent()` / `pipeline()` / `parallel()` with a concurrency cap. `llm`
- [ ] **Worktree isolation** — Enter creates a real git worktree and moves the session cwd; Exit restores it. `proc`
- [ ] **Web search / fetch** — a real query returns real results; `htmlToText` extracts real text. `net`
- [ ] **Push notification** — fires an OS toast. Note: unrelated to the `background_notification` *event*, despite the name. `proc`
- [ ] **Cron / ScheduleWakeup** — a scheduled job actually fires later, with no user message to trigger it. `llm` (it re-enters the turn loop)
- [ ] **MCP client** — an external MCP server's tools appear namespaced (`mcp__<server>__<tool>`) and are callable. `proc`
- [ ] **AskUserQuestion** — blocks for an answer; refuses in unattended runs. `pure`

## Knowledge

- [ ] **Codebase atlas** — `/atlas` produces a real `ATLAS.md` that passes its own shape check. **This is the regression that matters**: the build sub-agent must not reach for a tool it does not have. `llm`
- [ ] **Atlas freshness** — a hand-edited atlas is never clobbered without `force`. `fs`
- [ ] **Import graph** — built lazily on first query; `blast` finds importers, `deps` finds dependencies. `fs`
- [ ] **Symbol index** — updates incrementally as files change, with no explicit rebuild. `fs`
- [ ] **Reuse check** — a new file whose symbols resemble existing code (with no related search/read this session) gets a reminder listing the closest matches — firm wording for near-duplicates — alongside the allowed Write; it never refuses. `fs` + `llm`
- [ ] **STANDARDS.md** — re-read every turn (not cached at boot), capped at 16 KB with a truncation notice. `fs` + `llm`
- [ ] **Backpack RAG — build** — the ladder `raw → noted → embedded → brief` runs, caches on file signature, and reports progress. `llm` (embeddings are a real API call)
- [ ] **Backpack RAG — retrieval** — `BackpackSearch` returns the chunk that actually answers the question, and the agent uses it. `llm`

## Crew

- [ ] **Roster** — specialists load from `.magentra/team/*.md`; the roster hot-reloads when a file changes. `fs`
- [ ] **Parallel dispatch** — two `CrewRun` calls in one turn genuinely overlap, and results are attributed to the right specialist. `llm`
- [ ] **Per-member endpoints** — a member's declared model/baseUrl/apiKeyEnv is used; the key resolves from the env var **or** the settings file (declaring `apikeyenv:` must never resolve *worse* than omitting it). `pure` + `llm`
- [ ] **Endpoint fail-soft** — an unresolvable endpoint warns and falls back to the session provider, never a silent 404 on the wrong host. `pure`
- [ ] **Cost ledger** — per-member usage accumulates (`+=`, never overwrite) across runs. `fs`
- [ ] **Experience / lessons** — a lesson is promoted at exactly 3 confirmations across ≥2 distinct tasks with 0 contradictions. Not before, not after. `fs`
- [ ] **Service record** — the audit log is hash-chained; each entry's `prev` is the previous entry's hash. Verify the chain independently, do not trust the writer. `fs`
- [ ] **Crew pack export/import** — a clean member round-trips byte-identically; a member carrying a secret **fails closed** (no file written at all) unless `redact` is passed. `fs`
- [ ] **`/build-crew`** — designs a crew from the project when none exists. `llm`

## Discipline skills

- [ ] **Mode toggle** — `/styles on|off <id>`; `modes_updated` reflects it. `pure`
- [ ] **Conflicts** — enabling a skill switches off any active skill it `conflicts:` with (most-recent-wins), with an advisory message. `pure`
- [ ] **Mode gates** — a mode can forbid a tool outright, or require tasks to exist first. `pure`
- [ ] **Oracle-script debugging (the `debug` skill)** — edits stay locked until a repro script has been *observed failing*; writes into the debug dir are exempt so the script can be authored; a later pass marks the fix verified. `proc` + `llm`
- [ ] **Custom skill files** — a user-authored `.magentra/skills/*.md` discipline loads and applies. `fs`

## Scheduling

- [ ] **Standing missions** — a mission file runs, writes its deliverable, and honours its token budget. `llm`
- [ ] **Mission scheduling** — a cron schedule fires it; `continuous: true` re-arms with a cooldown. `llm`
- [ ] **Unattended safety** — a scheduler-fired run forces bypass and auto-denies what it must, while an attended `/mission run` still asks. `pure` + `llm`
- [ ] **Malformed mission file** — is skipped *loudly* (a warning at startup), never silently. `fs`

## State

- [ ] **Transcript** — every message/permission/compaction is appended; replay reconstructs history exactly. `fs`
- [ ] **Resume** — `/resume <id>` restores real conversational context, not just metadata, and continues the *same* transcript. `llm`
- [ ] **Session list** — sessions are listed with a human-readable label (the first real user message), not just a timestamp. `fs`

## Config

- [ ] **Layered settings** — project overrides global overrides defaults; each key reports where it came from. `fs`
- [ ] **Setting timing** — a change takes effect when `SETTING_TIMING` says it does (live / next turn / restart / needs clear). `pure`
- [ ] **Secret handling** — an API key is only ever written to the *global* file (0600), never the shareable project file. `fs`
- [ ] **Slash-command input guard** — a malformed frame (e.g. array `args`) produces a readable protocol error, not a raw `TypeError`. `pure`

## Protocol & host

- [ ] **Wire round-trip** — every `CoreEvent` and `FrontendRequest` survives NDJSON encode → decode. `pure`
- [ ] **Engine host** — spawns, serves NDJSON over stdio, drains in-flight work on stdin close, and exits cleanly. `proc`
- [ ] **Single-consumer events** — `Engine.events` has exactly one consumer by design; a second one silently steals events. Either enforce it or document it in a test. `pure`
- [ ] **Bootstrap** — settings, provider, registry, MCP tools and skills assemble; a missing API key raises `MissingApiKeyError` rather than exiting. `pure`

## Desktop app

- [ ] **Boots** — window opens, renderer loads, no crash. (`npm run smoke` already does this — grow it.) `ui`
- [ ] **Engine lifecycle** — the child engine spawns on workspace open, restarts on model change, and is killed on quit. `ui` + `proc`
- [ ] **Permission prompt** — a `permission_request` surfaces a dialog, and the decision reaches the engine. `ui` + `llm`
- [ ] **Clear** — the CLEAR button / Ctrl+L clears the chat *and* the engine's context (a fresh session), and is refused mid-turn. `ui`
- [ ] **Session meter** — the hint line shows the true context size and running cost. `ui`
- [ ] **Setup wizard** — first-run credential entry writes `.env` and tests the connection. `ui` + `net`
- [ ] **Crew designer** — the CREW view lists agents and can add a doc to a backpack by drag-and-drop. `ui`
- [ ] **Changes panel** — accumulated `file_edited` diffs render. `ui`
- [x] **Streaming Markdown** — each block renders as soon as it is complete, not when the turn ends; a half-streamed fence, table or formula stays plain text until its closing delimiter arrives, so nothing flickers through a partial parse. `ui`
- [x] **Markdown before a question card** — a `question_request` closes the streaming message first, so the text above an approval card is rendered while the user is deciding on it rather than after. `ui`
- [x] **Mathematics** — `$…$`/`\(…\)` inline and `$$…$$`/`\[…\]` display LaTeX render as native **MathML**: no library, no CDN, no extra web font, and nothing the strict CSP has to be relaxed for. Symbols, sub/superscripts, fractions, roots, big operators with limits, delimiters, text runs and matrix/cases environments; anything unparsed falls back to its own source. Prices (`$5, not $7`) and backticked `` `$x$` `` stay text. `ui`
- [x] **Fully local assets** — `default-src 'none'` with `style-src`/`script-src`/`font-src` all `'self'`: nothing is fetched from the web at runtime, so the app works offline and in an air-gapped environment. Both bundled fonts are SIL OFL 1.1 with the licence text and copyright notices shipped alongside them (`app/renderer/fonts/`). `ui`

## Packaging

- [ ] **Linux artifact** — AppImage/tar.gz launches on a clean machine, with a working Grep (the bundled `rg`). `ui`
- [ ] **Windows artifact** — the portable `.exe` launches, with a working Grep (the bundled `rg.exe`). `ui`
- [ ] **No `node_modules` at runtime** — the packaged engine is one self-contained file. `proc`

---

## Suggested order

1. **`pure` first.** Most of the engine's correctness lives here, it is fast, and
   it needs no key. Context/usage accounting, permissions, modes, settings, and
   the protocol are all in this bucket.
2. **`fs` next.** A temp workspace and assertions on what lands on disk covers
   most of knowledge/, crew/, and state/.
3. **`proc`.** Bash, ripgrep, git worktrees, MCP.
4. **`llm` last, and keep them few.** They are the only tests that prove the
   product *works*, so do not skip them — but one solid test per feature beats
   ten flaky ones. Gate them behind an env var so the `pure`/`fs` suite still
   runs everywhere in seconds.
