# MAGENTRA — Product, Usability & UI/UX Audit

*Date: 2026-07-15. Method: full first-party source inspection (app/, engine/, tools/, docs/) by six parallel subsystem audits, cross-checked and synthesized. Every finding cites file:line evidence; items that could not be verified are marked ASSUMPTION.*

---

## 1. Executive summary

**Overall maturity.** MAGENTRA is an engine with a prototype face. The engine (`engine/core`) is remarkably deep — layered permissions with a destructive-deletion guard, append-only transcripts with compaction, per-model cost accounting, a crew system with hash-chained service records and RAG backpacks, a codebase atlas, an import graph, 11 `.ma` behavioral disciplines, missions/cron scheduling, MCP, and 31 registered tools. The desktop app exposes perhaps a third of it, defaults to the least safe configuration, and has never been shipped: the release workflow publishes tags and notes but **never builds or uploads a binary** (`.github/workflows/release.yml`), and CI tests only the version tool. There are **zero tests** in the repo (FEATURES.md: 0 of 82 boxes ticked; `find engine -name '*.test.ts'` = 0).

**Strongest parts.**
- The engine architecture: clean protocol (`engine/protocol/src/types.ts`), disciplined settings layering with per-key timing (`engine/core/src/config/settings.ts`, `engine.ts:84-108`), rigorous context-vs-usage accounting (`sessionStats.ts`), and the crew/experience/service-record system — genuinely novel and coherently designed.
- The design-token system in `app/renderer/styles.css` (4 themes over one token set, `color-mix()` alpha variants, geometry tokens) is well organized.
- The composer micro-UX (Enter/Shift+Enter, slash palette, Esc-to-stop, Ctrl+L, draft preservation on clear) is thoughtful.
- FEATURES.md itself — an honest, precise test backlog — is a rare asset.

**Most serious problems (all confirmed in code).**
1. **The app runs the agent with permissions bypassed by default, twice over.** The Electron main process hardcodes `--dangerously-bypass` on every engine spawn (`app/main.js:154`), and the renderer's own default safety setting maps "auto" → bypass (`state.js:81,152`). The entire permission-approval UI is near-dead code; only the deletion guard ever fires. A first-run user gets an agent executing arbitrary shell commands unsupervised.
2. **Long sessions self-destruct.** Compaction can sever a `tool_use`/`tool_result` pair (fixed 6-message tail, `session.ts:1495-1497`), after which every provider request is rejected until `/clear`. Interrupts and crashes leave dangling `tool_use` blocks that `/resume` replays verbatim (`transcript.ts:91-105`) — a resumed crashed session can fail on its first request.
3. **Failure is silent or misdiagnosed everywhere.** A missing API key kills the engine with stderr text and no protocol frame (`engine/host/src/main.ts:19-21`); signal deaths show no banner and permanently lock the composer (`landing.js:491-496`, `83`); provider errors surface as raw HTTP JSON; every fatal banner says "SET UP ENGINE" regardless of cause; there is no retry in the turn loop.
4. **Users cannot see what the agent does.** Default "cinematic" detail mode hides all tool detail with no click-through (`stream.js:116-137`); no markdown/code rendering in a coding tool; no live output for running commands; permission dialogs show no diff for edits; the changes panel keeps only the last diff per file.
5. **The product's best features are undiscoverable.** Six command families (`/atlas`, `/debug`, `/crew`, `/team`, `/lab`, `/mission`) are absent from the palette (`state.js:251-263`); missions, packs, lessons, records, MCP, skills, and hooks have no UI at all.
6. **Nobody can install it.** No release binaries, no installers, no code signing, no auto-update; packaged AppImages die silently on Ubuntu 23.10+/24.04 (sandbox probe exists only in the dev launcher, `app/main.js:30-33` vs `scripts/launch.js:25-44`).

**Highest-impact opportunities.** Fix the safety default and the two transcript-corruption bugs (all Small effort); render markdown; build a sessions UI with real replay; ship binaries from CI; make the hidden engine visible. The gap between engine capability and app surface means most of the "missing product" already exists — it needs windows, not foundations.

---

## 2. Architecture and feature map

### Modules

```
app/  (Electron, no framework, no bundler at dev time)
  main.js            Window (fixed 1240x820), engine child process, all IPC handlers
  main/config.js     userData/config.json (recents, model) — non-atomic writes
  main/logging.js    <workspace>/.magentra/logs/desktop-*.log, RAM ring pre-workspace
  preload.js         contextBridge surface
  renderer/          13 classic scripts, one shared global scope, load-order coupled
    state.js         localStorage UI prefs, slash registry (hardcoded), safety settings
    landing.js       recents, event switchboard, permission/question/plan cards
    stream.js        transcript DOM, tool rows, agent fleet cards, 2400-node trim
    composer.js      input, palette, send/stop/clear, Escape handlers
    session.js       model catalog+pricing (hardcoded copy), meter, workspace open
    events.js        changes panel, engine banner
    setup.js         first-run wizard, connection card
    crew.js          team cards, drag-drop docs, context menu
    missions.js      task rail (misnamed), .ma style chips
    views.js         dock navigation, now-line
    atmosphere.js    canvas rain/snow/stars (ignores reduced-motion)

engine/
  protocol/          CoreEvent (20) / FrontendRequest (13), NDJSON framing
  providers/         anthropic (SDK, maxRetries:4), openai-compat (default DeepInfra),
                     fake, retry.ts (silent backoff)
  core/
    runtime/         engine.ts (endpoint + slash router), session.ts (turn loop,
                     compaction, nudges), permissions.ts, sessionStats.ts, fileState.ts
    agent/           prompts, tool contract, 3 subagent types, skills, hooks
    config/          settings.ts (global→project→env layering), pricing.ts (15 models)
    knowledge/       atlas, import graph, symbol index, reuse gate, STANDARDS.md,
                     docs extraction (PDF/DOCX/…), backpack RAG (BM25+embeddings)
    crew/            team.ts, packs, ledger, experience/lessons, hash-chained records,
                     per-member endpoints (providerFactory)
    ma/              11 builtin disciplines, oracle-script debugging
    scheduling/      cron (7-day expiry!), missions, background jobs, workflows
    state/           transcript.ts (JSONL, replay), taskStore.ts (non-atomic)
    integrations/    mcp.ts (stdio JSON-RPC, silent failures)
  host/              headless stdio host; fatal boot errors go to stderr, not protocol
  tools/             31 tools, all registered (index.ts:70-108)
```

### Key data flows
- **UI ⇄ engine:** renderer → preload IPC → main → child stdin (NDJSON `FrontendRequest`) → engine; `CoreEvent`s stream back the same path. Malformed engine stdout lines are silently dropped (`main.js:198-201`); malformed stdin frames are silently dropped by the engine (`serve.ts:22` + no `default` case in `engine.send`).
- **Engine lifecycle:** spawned on workspace open; **restarted (session killed) on model change and web-search toggle** (`main.js:740-753, 801-803`) with no mid-turn guard; SIGTERM only, no kill escalation.
- **Persistence:** transcripts in `<workspace>/.magentra/sessions/*.jsonl` (subagents pollute the list — every child writes its own); tasks in `.magentra/tasks/`; UI prefs in localStorage; recents/model in `userData/config.json`; secrets in workspace `.env` (0644!) and/or `~/.magentra/settings.json`.

### Platform architecture
- **Windows:** portable `.exe` only, unsigned, runs `--no-sandbox` (portable temp-dir extraction, `main.js:25-27`); Bash tool requires Git Bash (3 probed paths, else hazardous bare-`bash` fallback → WSL/ENOENT, `bash.ts:242-254`); toast notifications need an AppUserModelID that is never registered (ASSUMPTION: fails silently).
- **Linux:** AppImage + tar.gz; sandbox-usability probe exists only in the dev launcher; no `.desktop` file, no icon; ripgrep shim chmod self-heals except on read-only AppImage mounts (correct).
- **macOS:** dead lifecycle boilerplate with no build target (`main.js:894-909`).

---

## 3. Complete feature inventory

Grouped by the 20 audit areas. **Disc.** = discoverability 1–5.

### 3.1 Installation & first launch
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Build from source | README, root package.json | `npm install && npm run build && npm run app` | 3 | Only working install path; README covers nothing else |
| Packaging (portable exe, AppImage, tar.gz) | app/package.json:20-76 | `npm run dist:*` (maintainer, local) | — | No installers, no signing, no icon, no publish config |
| Release workflow | .github/workflows/release.yml | push to main | — | Tags + notes only; **no binaries built or uploaded** |
| Dev sandbox probe (Linux) | app/scripts/launch.js:25-57 | `npm start` | — | Packaged AppImage lacks it → silent death on Ubuntu 24.04 |
| `--smoke` boot check | app/main.js:512-527 | manual flag | 1 | Exists, wired into no CI job |

### 3.2 Environment & dependency setup
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Bundled engine (single .cjs) + ripgrep | app/scripts/bundle-engine.js, shims/ripgrep-shim.cjs | automatic | — | Missing rg at bundle time = WARN not failure (bundle-engine.js:60-63) |
| Bash shell resolution | engine/tools/src/bash.ts:242-254 | automatic | 1 | Windows without Git Bash → broken tool, no boot warning; `MAGENTRA_BASH` override undocumented |
| Credential detection | app/main.js:103-145 | on workspace open | — | Regex `.env` scan + env fallback; two overlapping gate mechanisms (main.js:238-244 vs 814-819) |

### 3.3 API keys & provider configuration
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Setup wizard (presets, TEST, IGNITE) | index.html:293-338, setup.js:11-117 | pushed on `setup:required` | 4 | No key-signup links; Anthropic preset → blank model + wrong datalist; IGNITE allowed untested; `result.error` discarded (setup.js:82-88) |
| Connection settings card | setup.js:123-204 | Settings → CONNECTION | 3 | Provider inferred from URL substring; LAN Ollama must fake a key (loopback-only keyless) |
| `.env` write | app/main.js:648 | wizard | — | Plain writeFileSync → 0644, world-readable, inside agent-readable tree |
| Settings-file key | settings.ts:356-375 | `/settings global apiKey …` | 2 | 0600 only on file creation; env var silently outranks stored key |
| Provider retry | providers/retry.ts:29-49, anthropic.ts:24 | automatic | — | Up to 4 silent backoffs (a 429 `retry-after: 60` = frozen minute); **no retry at all in the session turn loop** (session.ts:1146) |
| Model selection | index.html:51-70, session.js:26-43,123-153 | topbar select | 4 | 16 hardcoded DeepInfra models+prices duplicated in 2 renderer spots; free-text model never validated (typo → raw 404 on first turn); change restarts session without confirm |
| Anthropic prompt caching | — (absent) | — | — | No `cache_control` anywhere → ~10x cost inflation on long Anthropic sessions |

### 3.4 Project & workspace selection
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Workspace picker + recents | main.js:809-845, landing.js:9-47 | landing button / topbar pill | 5 | Switching doesn't clear old transcript/changes/crew (session.js:9-23) |
| Single instance | — (absent) | — | — | Two instances can open one workspace = two engines editing one tree; config.json last-writer-wins, non-atomic |

### 3.5–3.6 Chat flows & history
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| New chat / clear | composer.js:239-255, engine.ts:658 | CLEAR, Ctrl+L, `/clear` | 4 | No way back; `/clear` re-runs Engine.start() → duplicate startup noise |
| Session list | engine.ts:716-723,1563-1587 | `/sessions` (text dump) | 1 | `session_list` event **unhandled by UI**; subagent transcripts pollute the list, mostly unlabeled |
| Resume | engine.ts:750,1589-1602 | `/resume <id>` (hand-typed id) | 1 | **Chat area stays blank** (no replay events); stats/mode/allows not restored → `/session` reports $0; dangling tool_use replayed verbatim |
| Rename / search / archive / delete | — (absent) | — | — | Nothing exists; no GC of `.magentra/sessions/` either |
| Transcript trim | stream.js:59-74 | automatic @2400 nodes | — | Oldest 400+ nodes destroyed silently, unrecoverable in-app |

### 3.7 Prompt composition
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Composer (auto-grow, Enter/Shift+Enter) | composer.js:31-34,161-206 | always | 5 | Fully disabled while busy — no queueing or steering; no prompt history; no @file refs; no paste-image |
| Slash palette | composer.js:40-103, state.js:251-263 | type `/` | 4 | Hardcoded 11 commands; 6 engine families missing; prefix-only match; drifts from engine registry |
| `!` shell passthrough | engine.ts:1552-1561 | **unreachable** — composer never sends `bang_command` | 0 | Also un-gated (mid-turn context corruption) and un-truncated (5MB injection) |

### 3.8 Agent planning & execution
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Streaming text | landing.js:134-152 | automatic | — | Raw text nodes — **no markdown/code rendering** |
| Thinking | anthropic.ts:74, openai-compat.ts:139 | — | — | `thinking_delta` silently dropped by UI; Anthropic re-sends thinking as `text` in history (anthropic.ts:140-141), OpenAI-compat drops it — inconsistent context semantics |
| Tool rows | stream.js:101-169 | click to expand (technical mode only) | 2 | Default "cinematic" hides all detail, non-clickable, errors masked as "hit a snag"; no live output during a run; detail-mode switch not retroactive |
| Now-line | views.js:39-118 | automatic | 5 | Good; lies ("thinking") during reasoning |
| Subagent fleet cards | stream.js:175-273 | automatic | 4 | `background:true` agents force-finalized at turn end; agentEmoji never rendered; missing agentId merges into one "agent-solo" card |
| Plan mode | planMode.ts, landing.js:358-423 | `/mode plan` (typed only) | 1 | Plan card OK (editable) but markdown unrendered; **approving allowedPrompts session-allows the whole tool `"*"`** (planMode.ts:90-92); EnterPlanMode prompts to enter a *safer* mode |
| Turn outcome | landing.js:111-132 | — | — | `stopReason` ignored — completed/interrupted/error turns look identical |
| Auto-nudges, iteration caps | session.ts:1000-1114 | automatic | — | Solid engine design; invisible to user |

### 3.9 File editing, diff review & approval
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Edit/Write + freshness check | engine/tools/src/edit.ts, write.ts, fileState.ts | automatic | — | Good engine behavior; edits apply immediately — review is post-hoc |
| Changes panel | events.js:14-116 | dock ± (hidden until first edit) | 3 | **Only last diff per file kept** (events.js:34-39) — counts misleading; no syntax highlight; click-only divs; no undo/rollback/open-in-editor |
| Permission dialog | landing.js:241-267, index.html:280-290 | modal | — | Renamed deletion dialog serving all requests ("The agent wants to run:"); **no diff for edits**; no allow-session button (protocol supports it); queue survives engine restart (stale modals); **Escape both denies and hard-kills the turn** (composer.js:227-233 vs 270-287) |

### 3.10 Terminal commands & processes
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Bash tool | bash.ts | automatic | — | No streaming (output only at exit); 2-min `npm install` = static spinner; Grep 20MB maxBuffer errors instead of truncating; `mv` always trips deletion guard |
| Background jobs | scheduling/background.ts, tool.ts:204-213 | automatic | 2 | `list()`/`stop(id)` exist; **no command or UI exposes them** — only global interrupt |
| Monitor | monitor.ts | agent-facing | — | 60-lines/min noise auto-stop too aggressive for build logs |

### 3.11 Permissions & safety
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Permission modes | permissions.ts:85-165 | `/mode`; settings seg maps only ask→default, auto→bypass | 2 | **Default is bypass** (main.js:154 + state.js:81); acceptEdits/plan only by typing; `mode_changed` event unhandled → stale hint |
| Deletion guard | bash.ts:29, permissions.ts:104 | settings toggle | 4 | Fires even in bypass (good) but **outranks explicit allow rules** (cleanup missions can never delete own temp files); gaps: `find -delete`, `> file`, `git stash drop` |
| Session allows | permissions.ts:145-153 | approval button (never offered by UI) | 0 | Tool-wide grants (approving `ls -la` = all Bash for session + subagents); no inspection/revocation surface |
| Unattended missions | engine.ts:1301, missions.ts:30 | `/mission start`/cron | — | **Default to bypass mode** unattended; only deletions auto-denied |

### 3.12 Models, providers & runtime settings
Covered in 3.3; plus: `/settings` (engine.ts:861) shows layered values with source + timing — good; `SETTING_TIMING.modes` labeled "clear" but actually needs restart (engine.ts:107 vs 182); `contextWindow` default 160k applied to any model (128k models overflow before the 0.8 compaction threshold).

### 3.13 Context & token management
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Session meter (ctx+cost) | session.js:26-121 | hint line | 4 | Renderer's own pricing copy; unknown models silently show no cost; all usage billed to session model (wrong under crew); no context-limit warning |
| Compaction | session.ts:1161,1492-1517 | automatic + `/compact` | 3 | **Boundary can sever tool pairs (session-bricking)**; post-turn only (no mid-turn); summary itself can overflow the summarizer; `<8 messages` refusal regardless of size |
| `/session` report | engine.ts:706 | typed | 2 | Good report; zeroed after `/resume` |

### 3.14 Notifications & background activity
`PushNotification` OS toast (Windows AppId likely unregistered — ASSUMPTION); `background_notification.payload` ignored by UI; any `kind !== "start"` treated as terminal (landing.js:107); workflow `phase()`/`log()` progress batched to the end (workflow.ts:59-68).

### 3.15 Errors, recovery, logs & diagnostics
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| Fatal boot errors | host/main.ts:19-21,65-71 | stderr only | — | No protocol frame; app must pattern-match stderr |
| Engine crash surfacing | main.js:221-234, landing.js:491-496 | banner | — | Signal deaths (code null) → **no banner + composer locked forever**; banner always says "SET UP ENGINE"; every stderr line becomes a red transcript error |
| Provider errors | openai-compat.ts:65-69, session.ts:1146 | raw in transcript | — | `provider returned 401: {...json...}` verbatim; no 401/404/ECONNREFUSED classification |
| Logs | main/logging.js | `<workspace>/.magentra/logs/` | 1 | Nothing until a workspace opens (landing-page crashes lose the RAM ring); no "Open logs" menu; shallow redaction (top-level keys only) |
| Pre-workspace errors | stream.js:31 | — | — | appendSysError no-ops when streamEl null — setup/boot errors invisible |

### 3.16 Keyboard & power-user
Full shortcut map: Enter/Shift+Enter, palette Arrows/Tab/Esc, Esc stop/deny (conflicting), Ctrl+L clear, Enter in custom-model/question inputs. Missing: prompt history (Up), focus-composer key, view-switch keys, keyboard approve, shortcut help. Interactive rows (tool/diff/style) are unfocusable divs; crew actions are right-click-only (crew.js:157-159).

### 3.17 Settings, themes, accessibility, customization
| Feature | Where | Access | Disc. | Problems |
|---|---|---|---|---|
| 4 themes + atmosphere + fonts + text size | index.html:148-209, state.js:72-207 | Settings | 4 | No OS theme detection (`prefers-color-scheme` unused); Cascadia fonts absent on Linux (ASSUMPTION: all four options collapse); glacier accent 4.0:1 |
| Motion setting | styles.css:1480-1494, atmosphere.js:102-117 | Settings | 3 | CSS honors CALM + reduced-motion; **canvas ignores both** |
| Accessibility | — | — | — | **Zero ARIA attributes in the codebase**; no live region for streamed text; modals lack role/focus-trap; `--text-dim` fails WCAG AA in all 4 themes (3.9/3.9/2.8/3.1:1); 1px focus outline; color-only LEDs |
| Skills / hooks / .ma overrides | agent/skills.ts, hooks.ts, ma/modes.ts:346 | file conventions / settings JSON | 1 | Fully functional, invisible; no listing of loaded skills; hooks only via hand-edited JSON |

### 3.18 Windows & Linux integration
See §2 platform architecture. Additionally: fixed window size, no bounds persistence; no tray; no custom menu; Unicode-glyph icons may tofu on minimal Linux (ASSUMPTION); `pwd -W` msys handling correct; process-tree kill correct on both (Windows fire-and-forget).

### 3.19 Updates & release management
No auto-update, no publish config, no update check. Versioning discipline (commit-driven 4-part) is solid and CI-enforced — for the version tool only.

### 3.20 Documentation & in-product guidance
8 docs files. PROTOCOL.md and LOCAL-MODELS.md are good and current. **ARCHITECTURE.md describes a previous product** (packages/ + CLI/TUI, "Phase-1 tools", auto-atlas); SCENARIOS.md launches a nonexistent binary; MA-FORMAT.md says ten builtins (there are eleven), omits `debug` and the `repro-failed` gate; HIRABLE-CREW.md links a missing PRD; `mcpServers`, STANDARDS.md, and the reuse gate are documented nowhere. In-product guidance = `/help` text dump only; post-workspace console is blank with no hints.

### Advanced engine subsystems (engine-complete, UI-absent)
Atlas (disc. 2), import graph (1), symbol index (1), reuse gate (1), STANDARDS.md (1), backpack RAG (4 — the crew card progress bar is the best-exposed advanced feature), crew (4), per-member endpoints (3), lessons (1), service records (1), cost ledger (2), crew packs (1), team packs incl. URL hire (1), lab blueprint (1), .ma styles (4), oracle debugging (1), missions (1), cron (1), background jobs (3), workflows (1), MCP (1).

---

## 4. User journey audit

### First-time user
1. **Download/install — blocked.** No binaries exist on any release. Must clone + `npm install && npm run build && npm run app`. On Ubuntu 24.04 a future AppImage would die silently (no packaged sandbox probe). Windows portable exe would trip SmartScreen (unsigned) and run unsandboxed.
2. **First launch.** Dark phosphor screen, Matrix rain, ASCII logo (screen-reader garbage), one button. Composer visible but disabled with no explanation. The topbar already shows an active DeepInfra model dropdown with prices — before any workspace; changing it emits feedback into a stream element that doesn't exist yet (silently lost, stream.js:21).
3. **Understanding the product.** Tagline "autonomous agent harness" + six invented nouns (CREW, MISSION, styles, IGNITE…) and no tour, glossary, or example prompts.
4. **Workspace.** Native dialog — fine. Then the empty state is removed and replaced by nothing: a blank console with no hint that `/` opens a palette.
5. **Credentials.** Wizard appears if needed. Stuck points: no "where do I get a key" link; ANTHROPIC preset leaves MODEL blank with a DeepInfra/Ollama datalist (user must know `claude-*` ids by heart); TEST failure shows a generic message (`result.error` discarded); IGNITE commits untested config; dismissing the wizard leaves the composer enabled → first prompt guaranteed to fail with a red banner.
6. **First task.** Agent starts working in **bypass mode** — commands execute with no approval. In cinematic default the user sees "◆ scanning · file.js" verbs with no way to inspect what ran. Output arrives as unrendered text soup (code fences unstyled).
7. **Reviewing changes.** Edits are already applied; the changes panel (hidden until the first edit) shows the last diff per file.
8. **Error recovery.** A provider 401 prints raw JSON; the banner says "SET UP ENGINE" (correct here by luck); an engine crash by signal shows nothing and locks the composer permanently.
9. **Returning to a conversation.** Restart the app → transcript gone; `/resume` requires hand-typing an id from a `/sessions` text dump and then shows an empty screen.

### Returning user
- **Reopen project:** recents work well. Active workspace deliberately not restored (defensible, but not communicated).
- **Find a conversation:** text dump + hand-typed ids; most listed sessions are unlabeled subagent transcripts.
- **Continue work:** resume restores engine memory only — blank chat, $0 `/session` report, permission mode and session-allows reset silently.
- **Switch model/provider:** dropdown change **restarts the session destroying context** with only a sys-note; web-search toggle does the same with a footnote warning.
- **Review changes:** last-diff-per-file only; nothing survives app restart.
- **Agent status:** now-line good during a turn; after it, completed/interrupted/failed are indistinguishable.
- **Troubleshoot:** logs exist per-workspace but nothing points there; devtools disabled in packaged builds.

### Power user
- **Keyboard-only:** composing and stopping work; approving (except Esc-deny), expanding tool rows, viewing diffs, toggling styles, and all crew management (right-click-only) do not.
- **Multiple tasks:** engine supports 8 concurrent subagents, crews, workflows, background jobs — the UI can display fleet cards but offers no control (no per-job stop, no background-agent tracking past turn end).
- **Permissions control:** `acceptEdits`/`plan` modes exist but only by typing `/mode`; allow-rules only by hand-editing settings JSON; no way to inspect or revoke session allows.
- **Customizing behavior:** skills, hooks, `.ma` overrides, STANDARDS.md, crew endpoints — all functional, all folklore (no listing, no docs, no UI).
- **Context management:** `/compact`, `/session` good; no mid-turn compaction; no warning approaching the limit.
- **Logs/output:** no live tool output; Grep errors on huge outputs; workflow progress batched to end.
- **Interrupted recovery:** the weakest area — see Critical findings C3/C4.

**Cross-journey patterns:** risky defaults (bypass, untested IGNITE); missing feedback (silent drops everywhere: stdin frames, stdout frames, pre-workspace errors, mode changes, retries); inconsistent terminology (mission×2, crew/team, styles/modes/disciplines/campaigns); hidden functionality (15+ subsystems); destructive actions without confirmation (model change, web-search toggle, transcript trim).

---

## 5. UI/UX consistency audit

**Design system.** Token architecture is good (4 themes over one set, semantic amber/red, geometry tokens). Weaknesses: legacy aliases (`--green`, `--cyan`) invite drift; `rgba(255,77,77,…)` hardcoded ~8× instead of `--red` (styles.css:578, 700, 902-905, 1170-1171) — won't retheme; modal scrim phosphor-tinted on light themes (:1313); `--radius` bypassed with 4px in ~10 places.

**Contrast (measured).** `--text` on `--bg` strong (phosphor 11.7:1). `--text-dim` fails AA in all four themes at the small sizes it's used for: phosphor 3.9:1, dusk 3.9:1, glacier 2.8:1, paper 3.1:1. Glacier accent `#0e7fa5` on `#eaf1f6` = 4.0:1. hintAuto amber ≈3.8:1. Focus outline 1px (WCAG 2.2 wants 2px equivalent).

**Typography.** Mono-only, user-scalable base (12–17px) — coherent; but 0.55rem dock labels ≈ 6.6px at the S setting — illegible. Cascadia fonts unavailable on Linux (no bundled fonts).

**Dead CSS hooks (JS writes classes with no rules — verified absent):** `body.rail-open` (mission rail never reflows layout → overlay occludes transcript), `.q-opt.recommended` (recommendation signal destroyed — label suffix is also stripped, landing.js:303-309), `body[data-view]`, `body.busy`.

**Component consistency.** Dock buttons: 3 of 5 start hidden; MISSION toggles an overlay while siblings switch views and never gets `.active`. Modals: one dialog (`#deleteModal`, with deletion-specific copy) serves all permission types. Truncation notices phrased differently across 6 tools. Two settings surfaces (wizard vs connection card) with different validation.

**States.** Empty states exist for landing/changes/crew; missing for post-workspace console. Loading: backpack progress bar good; engine boot has none. Errors: red banner (one message for all causes), red stderr lines (noisy).

**Accessibility.** Zero ARIA. No live regions (streamed reply invisible to screen readers). Unfocusable interactive divs. Right-click-only crew actions. Canvas animation ignores `prefers-reduced-motion` and the app's own CALM setting. Color-only status LEDs. ASCII-art logo unlabeled.

**Responsive.** One media query (920px); horizontal clipping below ~700px; settings grid overflows.

**Recommendation:** keep the token system, fix the dim/accent tokens, derive all reds from `--red`, add the four missing CSS rules, adopt a single dialog component with per-tool bodies (diff preview for edits, command for bash), and a single truncation affordance.

---

## 6. Prioritized improvement backlog

Format: **Title** [Priority | Effort | Risk] — problem → solution. Evidence in §3–5. QW = quick win.

### A. Critical blockers
- **A1. Stop defaulting to bypass** [Critical | S | Low, behavior change] — `--dangerously-bypass` hardcoded (main.js:154) + UI default "auto" (state.js:81). Spawn in `default` mode; make bypass an explicit, scary opt-in. Acceptance: fresh install prompts before first mutating tool; permission dialog actually appears. QW.
- **A2. Ship binaries from CI** [Critical | M | Low] — release.yml uploads nothing; ci.yml tests only tools/version. Add ubuntu+windows build matrix (`npm ci && npm run build && npm run dist:*`), upload artifacts, run `--smoke` in CI. Acceptance: a GitHub release carries .exe + AppImage; CI fails if the app doesn't boot. QW.
- **A3. Fix compaction tool-pair severing** [Critical | S | Low] — session.ts:1495-1497 fixed 6-message tail. Walk the boundary to a clean user-text message. Acceptance: compaction never produces a tail starting with `tool_result`. QW.
- **A4. Repair dangling tool_use on abort/crash/resume** [Critical | S | Low] — session.ts:1139-1143, transcript.ts:91-105. Synthesize `tool_result: "(interrupted)"` on abort and during replay. Acceptance: interrupt → next message succeeds; resume of a crashed session succeeds. QW.
- **A5. Surface fatal boot errors in-band** [Critical | S | Low] — host/main.ts:19-21 stderr+exit. Emit `{type:"error",fatal:true}` frame first; renderer shows cause-specific banner. Acceptance: missing API key produces a "key missing → open setup" banner, not a dead process. QW.
- **A6. Engine death must never lock the composer** [Critical | S | Low] — landing.js:491-496 ignores `code===null`; busy never cleared. Pass `signal` through; treat any unexpected exit as turn end + distinct banner ("engine crashed — restart" vs "check connection"). Acceptance: `kill -9` the engine mid-turn → banner + usable composer. QW.
- **A7. Secure API key at rest** [Critical→High | S now, L later | Low] — `.env` written 0644 into the agent-readable tree (main.js:648); settings.json 0600 only on create (settings.ts:356). Now: `{mode:0o600}` both paths + chmod existing. Later: move to `userData`/safeStorage, inject via engine env. QW (first half).

### B. High-impact usability
- **B1. Render markdown + code blocks** [High | L | Med] — landing.js:134-152 raw text. Incremental renderer w/ highlighting; largest single polish gap in a coding tool.
- **B2. Sessions UI with real replay** [High | L | Med] — handle `session_list`; sessions drawer (label, date, resume/delete); engine emits replay event stream on resume; restore stats via transcript `meta` records (declared, never written — transcript.ts:7,17). Exclude subagent transcripts from listing (session.ts:240-241).
- **B3. Approval dialog worth trusting** [High | M | Low] — per-tool bodies (diff for Edit/Write, command for Bash), add "Allow for session" (protocol has `allow_session`), scope Bash session-allows by prefix not tool-wide (permissions.ts:145-153), show plan pre-auth's *real* scope (planMode.ts:90-92), fix Escape dual-handler (composer.js:227-233 vs 270-287, QW), clear stale queue on restart (state.js:49-50, QW).
- **B4. Classify provider errors + visible retries** [High | M | Low] — map 401/404/429/ECONNREFUSED to human messages (openai-compat.ts:65-69); add bounded retry in the turn loop (session.ts:1146); emit a retry-status event so the spinner explains itself (retry.ts:29-49). Partial QW.
- **B5. Fix the setup wizard** [High | M | Low] — per-preset model suggestions (Anthropic ids!), key-signup links, surface `result.error`, require TEST-or-confirm before IGNITE, disable composer while unconfigured.
- **B6. Unhide the engine: palette + missions view + crew depth** [High | S+M | Low] — add `/atlas /debug /crew /team /lab /mission` to SLASH_COMMANDS (QW); missions view fed by a `missions_updated` event; ledger/record/lessons summaries on crew cards (data exists in `/crew` handler).
- **B7. Default detail mode → technical (or expandable cinematic)** [High | S | Low] — stream.js:116-137. Transparency is the trust mechanism. QW.
- **B8. Composer stays usable during a turn** [High | M | Med] — queue typed messages; send on turn end (or steer if engine grows support).
- **B9. Guard destructive session restarts** [High→Med | M | Low] — model change / web-search toggle mid-turn (main.js:740-753, 801-803): confirm or defer to turn end; no-op custom-model blur when unchanged (composer.js:29, QW).
- **B10. Unattended missions default acceptEdits, not bypass** [High | S | Low] — engine.ts:1301, missions.ts:30; require explicit `mode: bypass` in the mission file. QW.

### C. UI & visual polish
- **C1. Fix the four dead CSS hooks + contrast tokens** [High | S | Low] — `.rail-open` layout shift, `.recommended` badge (stop stripping the suffix), lift `--text-dim` ≥4.5:1 in all themes, glacier accent, 2px focus outline. QW.
- **C2. Turn outcome on the separator** [Med | S | Low] — render `stopReason` ("stopped by you", "error", "max tokens"). QW.
- **C3. Post-workspace hint block** [Med | S | Low] — example prompts + "type `/` for commands". QW.
- **C4. Reduced-motion in the canvas** [Med | S | Low] — atmosphere.js honors `prefers-reduced-motion` + CALM. QW.
- **C5. Consistent theming** [Med | S | Low] — derive reds from `--red`, theme-aware scrim, consolidate radii, OS theme detection via `nativeTheme`.
- **C6. Changes panel honesty** [Med | M | Low] — accumulate diffs per file (or engine-side cumulative diff vs turn start); then rollback (L).
- **C7. Scroll-escape pill** [Low | S | Low] — "↓ latest" when scrolled up mid-stream. QW.
- **C8. App icon + .desktop file** [Low | S | Low] — QW.

### D. Power-user improvements
- **D1. Keyboard everywhere** [High | M | Low] — focusable tool/diff/style rows, keyboard approve/deny (e.g. Y/N), prompt history (Up), view-switch keys (Ctrl+1..4), shortcut cheat-sheet (`?`).
- **D2. Crew actions out of the context menu** [Med | S | Low] — visible "⋯" on cards. QW.
- **D3. `/permissions` inspect/revoke** [Med | S | Low] — list session allows + deletion-guard state.
- **D4. Background-job control** [Med | M | Low] — list/stop via UI; keep `background:true` agent cards live past turn end (landing.js:126).
- **D5. Wire `!` bang commands in the composer** [Med | S | Low] — send `bang_command`; engine side: queue until idle + truncate to 40KB (engine.ts:1552-1561). QW.
- **D6. Live tool output** [Med | L | Med] — `tool_output_delta` CoreEvent + throttled Bash emission + workflow `log()` passthrough.
- **D7. Model catalog from the endpoint** [Med | M | Low] — `GET /models` on openai-compat; kill both renderer copies (session.js:26-43, index.html:51-69); boot-time model validation.
- **D8. Skills/hooks visibility** [Low | S | Low] — `/skills` listing; loaded-skills line in `/session`.

### E. Reliability & recovery
- **E1. Provider retry in turn loop** [High | M] — see B4.
- **E2. Mid-turn compaction + model-aware windows** [High | M] — check inside the iteration loop (session.ts:1161); derive window per model.
- **E3. Kill escalation + single-instance** [Med | S/M] — SIGTERM→wait→SIGKILL (main.js:77-94); `requestSingleInstanceLock`; atomic config writes (config.js:68). Partial QW.
- **E4. Atomic task persistence** [Med | S] — use existing `writeFileAtomic` (taskStore.ts:111-118); warn on corrupt load. QW.
- **E5. Engine interrupts on stdin EOF/SIGTERM** [Med | S/M] — serve.ts currently `await engine.idle()` — orphaned turns burn tokens headless.
- **E6. Diagnostics reachable** [Med | S] — always mirror sys/renderer log channels to `userData/logs/`; Help→"Open logs"; recursive redaction (logging.js:32-41). QW.
- **E7. Don't drop malformed frames silently** [Med | S] — log stdout parse failures (main.js:198-201); engine replies to unknown frame types (serve.ts:22); `writeToEngine` no-op should surface "engine not running" (main.js:96-101). QW.
- **E8. Anthropic prompt caching** [High (cost) | M] — `cache_control` on system prompt + last message; the 4-class pricing plumbing already exists.
- **E9. Session/task GC + trim notice** [Low | S] — cap `.magentra/sessions/`; sys-note when the DOM trim fires (stream.js:59-74).
- **E10. Test foundation** [High | XL, incremental] — seed the `pure` bucket from FEATURES.md (permissions table, accounting, compaction boundary from A3, cron matcher, protocol round-trip); wire `--smoke` into CI.

### F. Accessibility
- **F1. ARIA pass** [High | M] — `aria-live="polite"` transcript region; `role="dialog"`+`aria-modal`+focus trap on all modals (delete modal never moves focus); labels on icon buttons; hide ASCII logo (`aria-hidden`).
- **F2. Focusable interactive rows** [High | M] — buttons/tabindex+keydown for tool/diff/style rows (with D1).
- **F3. Contrast + focus tokens** [High | S] — with C1. QW.
- **F4. Canvas reduced-motion** [Med | S] — with C4. QW.
- **F5. Non-color status signals** [Low | S] — glyph/text beside LEDs.
- **F6. Legibility floor** [Low | S] — no computed size below ~10px at the S text setting.

### G. Platform-specific
**Windows.** G1: Git Bash detection at bootstrap + clear guidance (`MAGENTRA_BASH` documented) [High|S, QW]; PowerShell fallback [L]. G2: NSIS installer + signing + auto-update [High|L/XL]. G3: register AppUserModelID for toasts [Low|S]. G4: fail `dist` when rg.exe absent (bundle-engine.js:60-63) [Med|S, QW].
**Linux.** G5: packaged sandbox probe (AppRun wrapper) or .deb with setuid helper [High|M]. G6: .desktop file + icon for tar.gz/AppImage [Med|S]. G7: bundle a mono font (Cascadia options are Windows-only) [Low|S].
**Both.** G8: window bounds/maximize persistence [Med|S]; G9: remove dead macOS lifecycle code (main.js:894-909) [Low|S, QW].

---

## 7. Phased implementation roadmap

**Phase 0 — Stop the bleeding (A1, A3–A7, B10, E4, E7).** Goal: safe by default; long sessions and crashes no longer corrupt or lock anything; failures speak. All S-effort engine/UI fixes; no dependencies. Success: kill-the-engine, 429-storm, interrupt-mid-tool, and 60-turn-compaction scenarios all recover visibly. *Order: A1 → A6 → A5 → A3 → A4 → A7 → B10 → E4/E7.*

**Phase 1 — First-run & configuration (A2, B5, G1, G4, G5, C8, part of D7).** Goal: download → working first task without reading source. Depends on Phase 0 (a safe default is part of first-run). Success: a new user on Win11 (no Git Bash) and Ubuntu 24.04 each get either a working app or an actionable message at every step; releases carry binaries.

**Phase 2 — Core chat & agent workflow (B1, B3, B4, B7, B8, C2, C6-display, D5).** Goal: the turn loop is transparent and trustworthy. Success: user can always answer "what is it doing / what changed / why did it stop"; approvals show diffs; errors are human.

**Phase 3 — History, projects, navigation (B2, B6, B9, E9, workspace-switch reset, C3).** Goal: continuity. Depends on Phase 2 renderer work (replay reuses the markdown renderer). Success: quit → reopen → resume shows the full conversation with correct cost; missions/atlas/crew reachable from the UI.

**Phase 4 — Visual consistency & design system (C1, C4, C5, C7, F3, F6, G8, terminology renames: MISSION rail→TASKS, one word for crew/team, one word for styles).** Goal: professional, coherent, honest visuals. Success: all text ≥AA; one dialog component; no dead CSS hooks; a glossary exists.

**Phase 5 — Reliability, recovery, diagnostics (E1–E3, E5, E6, E8, E10 seed, G2 auto-update).** Goal: predictable under failure; costs sane. Success: pull the network mid-turn → visible retry → recovery; `pure` test suite running in CI.

**Phase 6 — Accessibility & keyboard (F1, F2, F5, D1, D2).** Goal: screen-reader usable core loop; keyboard-only operation. Success: NVDA/Orca can follow a full task; no mouse required end-to-end.

**Phase 7 — Advanced & power-user (D3, D4, D6, D7, D8, mission designer UI, pack import/export UI, MCP status, workflow live progress, cron expiry fix).** Goal: the hidden engine becomes the differentiator. Success: a user can discover and operate missions, packs, and MCP without reading engine source.

---

## 8. Top 10 quick wins
1. Spawn engine in `default` mode; bypass = explicit opt-in (main.js:154, state.js:81).
2. Engine exit always clears busy + cause-specific banner incl. signals (landing.js:491-496, main.js:221-226).
3. Add the 4 missing CSS rules + lift `--text-dim`/focus tokens (styles.css; landing.js:303-309; missions.js:71-86).
4. Classify provider errors 401/404/ECONNREFUSED → human messages (openai-compat.ts:65-69).
5. Fatal boot error as a protocol frame (host/main.ts:19-21).
6. Compaction boundary repair + synthesized `(interrupted)` tool results (session.ts:1495, 1139; transcript.ts:91).
7. Add `/atlas /debug /crew /team /lab /mission` to the palette; surface `result.error` in wizard TEST (state.js:251-263; setup.js:82-88).
8. `chmod 0600` on `.env` and settings.json writes (main.js:648; settings.ts:356).
9. Fix Escape dual-handler so denying a dialog doesn't kill the turn (composer.js:227-287).
10. Render `turn_finished.stopReason` + "Allow for session" button (landing.js:111-132, 252-258).

## 9. Top 10 strategic improvements
1. **Trust & permissions overhaul** — safe default, scoped session allows, diff-bearing approvals, plan pre-auth honesty, `/permissions` (A1+B3+D3).
2. **Markdown/code rendering** in the transcript (B1).
3. **Session continuity** — sessions drawer, replay-on-resume, persisted stats, subagent-transcript exclusion (B2).
4. **Ship it** — CI builds, release artifacts, installers, auto-update, signing (A2+G2).
5. **Reliability layer** — turn-loop retry with visible status, mid-turn + model-aware compaction (E1+E2).
6. **First-run redesign** — coupled provider/model presets, validation, key links, guided first task (B5).
7. **Unhide the engine** — missions view, atlas status, crew depth (ledger/records/lessons), MCP status, pack UI (B6+Phase 7).
8. **Live tool output** — `tool_output_delta` protocol event, streaming Bash, workflow progress (D6).
9. **Accessibility program** — ARIA live regions, dialog semantics, keyboard-complete operation (F1+F2+D1).
10. **Test foundation** — FEATURES.md `pure` bucket + CI smoke; it protects everything above (E10).

---

## 10. Unfinished & suspicious implementation report

**No TODO/FIXME/XXX/HACK markers exist in first-party source** (grep-verified). The debt is unmarked:

*Declared-but-dead:* transcript record kinds `system_prompt`/`meta` never written (transcript.ts:7,17); `@auto` mode metadata parsed, never consumed (modes.ts:134); `reload_team` request never sent; `session_list` event never handled; `thinking_delta`, `mode_changed`, `stopReason`, `agent_spawned.background`, `agentEmoji`, `question_request.header/multiSelect`, `plan_ready.planPath`, `background_notification.payload` — all emitted, all ignored by the renderer; `--serve` flag accepted and ignored (documented shim).

*Honest stubs:* pack/record `signature: null` "unimplemented in v1" (pack.ts:47, teamPack.ts:36, serviceRecord.ts:16) — but `/crew hire` prints "chain verified ✓" from an unsigned chain (overstated guarantee); Workflow `budget` hook is a no-op the model is told about (workflow.ts:36); workflow journal exists, resume does not.

*Bugs-in-waiting:* scheduler slash regex case-insensitive vs case-sensitive switch (engine.ts:174 vs 620); `SETTING_TIMING.modes` mislabeled "clear" (engine.ts:107); CrewRun bypasses `resolveTaskId` leniency (crewRun.ts:29); AskUserQuestion answers keyed by question text — duplicates collide (types.ts:225); recurring cron jobs silently expire after 7 days incl. scheduled missions (cron.ts:243); backpack embedder posts Anthropic keys to DeepInfra when provider=anthropic and no baseUrl (engine.ts:568-575); WebFetch force-upgrades http→https, breaking localhost dev servers (webFetch.ts:35); `team:addDoc` skips the `AGENT_ID_RE` validation its siblings apply (main.js:339-344); Glob `dot:false` hardcoded (dotfiles invisible); no binary detection in Read.

*Silent error paths:* engine stdout parse failures (main.js:198-201); unknown stdin frames (serve.ts:22 + no default case); `writeToEngine` no-op when engine down (main.js:96-101); config write failures (config.js:70); MCP connect failures skipped without warning + fixed 10s tool timeout (mcp.ts:258-269, :14); TaskStore corruption swallowed as "fresh session" (taskStore.ts:129); pre-workspace `appendSysError` no-op (stream.js:31).

*Stale references:* worktree.ts:99 and mcp.ts:251 cite nonexistent `INTEGRATION-phase3a.md`; ARCHITECTURE.md describes `packages/` + CLI/TUI (gone), `core_markdowns/` (absent), "Phase-1 tools only" (31 shipped); SCENARIOS.md launches `packages/cli/bin/magentra.js` (absent); HIRABLE-CREW.md links a missing PRD; MA-FORMAT.md says ten builtins (eleven), omits `debug` and `repro-failed`; "Phase A/B" crew scaffolding lives only in comments (session.ts:130-133, tool.ts:33-39); macOS lifecycle code with no macOS target (main.js:894-909).

*Structural debt:* zero tests (0/82 in FEATURES.md); renderer duplicates engine canon (pricing session.js:26-43, slash registry state.js:251-263 — both self-admitted); `resetLocalViewForClear` duplicates `onTurnStarted` logic (composer.js:109-121); permission modal is a renamed deletion dialog (index.html:280-290); no GC for sessions/tasks; `.magentra/worktrees` may be indexed by search tools while active (ASSUMPTION: ignore-injection unverified).

---

## 11. Proposed first implementation batch

**Batch: "Safe, honest, and unstuck" — Phase 0 in one PR series (~2–3 days).** Highest user-risk reduction per line changed; no feature depends on it, everything benefits.

| # | Change | Files | Acceptance criteria |
|---|---|---|---|
| 1 | Default permission mode `default`; bypass only via explicit setting/flag | `app/main.js` (:154 spawn args), `app/renderer/modules/state.js` (:81 default, :152 mapping) | Fresh profile: first Bash/Write triggers the approval modal; settings seg shows ASK active; bypass reachable but labeled dangerous |
| 2 | Engine exit/crash always surfaces + unlocks | `app/main.js` (:221-234 pass `signal`, track expected exits), `app/renderer/modules/landing.js` (:491-496 clear busy, cause-specific banner), `app/renderer/modules/events.js` (:134 banner action = restart vs setup) | `kill -9` engine mid-turn → banner "engine crashed — RESTART ▸", composer usable; model-change restart shows no crash banner |
| 3 | Fatal boot errors in-band | `engine/host/src/main.ts` (:19-21, 65-71 emit `{type:"error",fatal:true}` before exit) | Missing API key → wizard opens with the real message; no stderr pattern-matching needed |
| 4 | Compaction boundary repair | `engine/core/src/runtime/session.ts` (:1495-1497) | Property: for any message sequence, post-compaction history never begins its tail with `tool_result`; add the first `pure` test |
| 5 | Synthesize tool_results on interrupt + replay repair | `engine/core/src/runtime/session.ts` (:1139-1143), `engine/core/src/state/transcript.ts` (:91-105) | Interrupt during a tool call → next user message succeeds; resume of a mid-turn-killed transcript succeeds; `pure` test each |
| 6 | Key permissions 0600 | `app/main.js` (:648), `engine/core/src/config/settings.ts` (:356-358 chmod existing) | New and pre-existing files land 0600 on POSIX |
| 7 | Provider error classification | `engine/providers/src/openai-compat.ts` (:65-69), `engine/providers/src/anthropic.ts` (error mapping), `engine/providers/src/types.ts` | 401→"API key rejected by <host>"; 404→"model '<m>' not found on this endpoint"; ECONNREFUSED→"can't reach <host> — is the server running?"; detail preserved in a collapsed line |
| 8 | Escape priority fix | `app/renderer/modules/composer.js` (:227-233, 270-287 merge into one prioritized handler) | Esc on an open approval modal denies only; second Esc stops the turn |
| 9 | Dead CSS + contrast tokens | `app/renderer/styles.css` (add `.rail-open` stage offset, `.q-opt.recommended`, 2px focus outline; lift `--text-dim` per theme), `app/renderer/modules/landing.js` (:303-309 keep the badge) | Rail no longer overlaps text; recommended option visibly badged; `--text-dim` ≥4.5:1 in all four themes (verify with a contrast checker) |
| 10 | Palette completion + wizard error detail | `app/renderer/modules/state.js` (:251-263), `app/renderer/modules/setup.js` (:82-88) | Typing `/mi` suggests `/mission`; failed TEST shows the provider's actual error |

Risk: item 1 changes default behavior — release-note it prominently. Items 4–5 are the only engine-logic changes; both come with the repo's first unit tests, seeding E10.

*After this batch:* Phase 1 (ship binaries + wizard redesign) or Phase 2 (markdown rendering) depending on whether distribution or daily-driver quality is the nearer goal.
