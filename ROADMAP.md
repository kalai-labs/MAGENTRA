# MAGENTRA — Implementation Roadmap

Derived from `AUDIT.md` (2026-07-15). Work top to bottom: phases are ordered by priority, items inside a phase are ordered by suggested implementation sequence. Tick a box only when its **Done when** criterion is verified by actually running the app/engine (not by reading the diff).

Testing policy for this roadmap: **no test-writing until Phase 10.** Features first; once every feature exists and behaves, tests are added one by one against FEATURES.md. One standing exception: `tools/version` has a pre-existing suite that gates every release in CI — that suite stays maintained (regression tests added as its bugs are fixed); it is release infrastructure, not product features.

Platform note (2026-07-16): **macOS is now a build target** (arm64 .dmg in the release matrix). Later phases were written for Windows+Linux; mac-specific follow-ups live in Phase 9 and are flagged inline elsewhere.

Line numbers are from the 2026-07-15 audit snapshot — re-verify before editing.

---

## Phase 0 — Session-corruption & silent-failure blockers

The app must stop corrupting its own sessions and stop locking up silently. Everything else builds on this.

> **Decision (2026-07-16):** running with all permissions bypassed is intentional for now. All permission-mode/approval-hardening work lives in the deferred **Phase P** near the end of this file and is out of scope until the product is ready.

- [x] **0.1 Engine death never locks the composer, and always says why**
  Files: `app/main.js` (~:221-234 — include `signal` in the exit event; track "expected exit" around stopEngine/restart), `app/renderer/modules/landing.js` (~:491-496 — clear `busy` on any unexpected exit, banner regardless of exit code), `app/renderer/modules/events.js` (~:134 — banner action: RESTART ENGINE for crashes vs SET UP ENGINE for credential issues).
  Done when: `kill -9` on the engine mid-turn shows a crash banner with a restart action and the composer stays usable; a model-change restart shows no crash banner.

- [x] **0.2 Fatal boot errors travel in-band**
  Files: `engine/host/src/main.ts` (~:19-21, :65-71).
  Emit a `{type:"error", fatal:true, message}` NDJSON frame to stdout before exiting (keep stderr as backup); renderer routes credential-shaped fatals to the setup wizard with the real message.
  Done when: deleting the API key and restarting produces the wizard with the engine's actual error text, not a dead process.

- [x] **0.3 Compaction never severs a tool_use/tool_result pair**
  Files: `engine/core/src/runtime/session.ts` (~:1495-1497).
  Walk the keep-boundary back until the tail starts at a clean user-text message.
  Done when: a long session compacts and the very next turn succeeds (manually drive a 60+ turn session or lower the threshold temporarily to reproduce).

- [x] **0.4 Interrupt/crash leaves a resumable transcript**
  Files: `engine/core/src/runtime/session.ts` (~:1139-1143), `engine/core/src/state/transcript.ts` (~:91-105).
  On abort, synthesize `tool_result: "(interrupted)"` for dangling tool_use blocks; apply the same repair during transcript replay (`Transcript.replay`) so old crashed transcripts also resume.
  Done when: interrupting mid-tool-call then sending a new message works; `/resume` of a mid-turn-killed session works on its first request.

- [x] **0.5 API keys stored 0600**
  Files: `app/main.js` (~:648 — `writeFileSync(..., { mode: 0o600 })`), `engine/core/src/config/settings.ts` (~:356-358 — chmod pre-existing global file, not just on create).
  Done when: both fresh and pre-existing key files show `-rw-------` on Linux after a write.

- [x] **0.6 Escape priority: deny ≠ kill the turn**
  Files: `app/renderer/modules/composer.js` (~:227-233 and ~:270-287 — merge into one prioritized handler: styles panel → wizard → deletion-guard modal → interrupt). Even in bypass mode the deletion guard raises this modal, so the fix matters now. Also clear the stale permission queue on engine restart (`state.js` ~:49-50) so a dead request can't be answered.
  Done when: Esc with a deletion-guard modal open denies only; a second Esc stops the turn; no stale modal after a restart.

- [x] **0.7 No more silent frame drops**
  Files: `app/main.js` (~:198-201 log stdout parse failures; ~:96-101 `writeToEngine` surfaces "engine not running" to the renderer instead of no-op), `engine/host/src/serve.ts` (~:22 reply with a readable error for unknown frame types — engine `send` switch has no default case).
  Done when: sending garbage to the engine's stdin produces an error event; typing after a dead engine shows feedback instead of nothing.

- [x] **0.8 Atomic task persistence**
  Files: `engine/core/src/state/taskStore.ts` (~:111-118 use existing `writeFileAtomic` from `util/fsAtomic.ts`; ~:129 warn on unparseable file instead of silently starting fresh).
  Done when: task file writes go through temp+rename; a corrupted file logs a warning.

---

## Phase 1 — Install, first launch & configuration

Goal: download → configured → first successful task, without reading source code.

- [x] **1.1 CI builds and releases actual binaries** *(+ mac .dmg; electron-builder rejected the 4-part version — scripts/dist.js swaps in the semver prefix for the build and keeps the 4-part in artifact names)*
  Files: `.github/workflows/release.yml`, `.github/workflows/ci.yml`.
  Add ubuntu + windows jobs: `npm ci && npm run build && npm run dist:linux|dist:win`; upload artifacts to the GitHub release. Add an app boot check to CI using the existing `--smoke` flag (`app/main.js` ~:512-527) — this is a build gate, not a "test" in the Phase-10 sense.
  Done when: a push to main produces a release carrying `.exe` + AppImage + tar.gz, and CI fails if the app cannot boot.

- [x] **1.2 Fail `dist` when the target ripgrep binary is missing**
  Files: `app/scripts/bundle-engine.js` (~:60-63 — WARN → hard error for the target OS).
  Done when: `npm run dist:win` on a machine without `rg.exe` staged fails loudly.

- [x] **1.3 Setup wizard: provider/model coupling + key guidance + real errors**
  Files: `app/renderer/modules/setup.js` (~:11-117), `app/renderer/index.html` (~:293-338).
  Per-preset model suggestions (Anthropic presets suggest `claude-*` ids; datalist switches per provider); a "get an API key →" hint/link per provider; surface `result.error` on failed TEST (~setup.js:82-88); require TEST-or-explicit-confirm before IGNITE; validate MODEL/BASE URL non-empty per preset.
  Done when: choosing ANTHROPIC yields a sensible default model; a wrong key shows the provider's actual error; IGNITE with blank model is blocked.

- [x] **1.4 Composer disabled (with explanation) while unconfigured**
  Files: `app/renderer/modules/composer.js` (~:266 area), `app/renderer/modules/setup.js`.
  Dismissing the wizard leaves the composer disabled with an inline "engine not linked — SET UP ▸" affordance instead of letting the first prompt fail.
  Done when: no prompt can be sent into a credential-less engine; one click reopens the wizard.

- [x] **1.5 Windows: Git Bash detection at boot with actionable guidance**
  Files: `engine/host/src/bootstrap.ts` or `engine/tools/src/bash.ts` (~:242-254).
  At startup on win32, probe for a usable bash; if absent, emit a warning event: "install Git for Windows or set MAGENTRA_BASH". Never fall back to bare `bash` (WSL hazard) silently.
  Done when: on Windows without Git Bash, the user sees the guidance before the first Bash call fails cryptically.

- [x] **1.6 Linux: packaged sandbox probe** *(afterPack shell wrapper — verified: packaged tar.gz boots on a userns-restricted machine that previously FATALed)*
  Files: new AppRun wrapper / launcher script in `app/build-resources` config, `app/package.json` (electron-builder `linux` section); mirror logic from `app/scripts/launch.js` (~:25-57).
  Done when: the AppImage launches on Ubuntu 24.04 (userns-restricted) instead of dying silently — or shows a clear message with the `--no-sandbox` remedy.

- [x] **1.7 App icon + .desktop metadata** *(generated from source — app/scripts/make-icon.js)*
  Files: `app/build-resources` (icon assets), `app/package.json` (electron-builder icon/desktop config).
  Done when: packaged builds show a MAGENTRA icon in taskbar/dock; AppImage carries desktop metadata.

- [x] **1.8 Post-workspace hint block (first-use guidance)**
  Files: `app/renderer/modules/session.js` (~:11-17).
  After opening a workspace into an empty console, show a dismissible hint: 2–3 example prompts + "type `/` for commands".
  Done when: a fresh workspace shows the hint; it never reappears after first send (or after dismissal).

- [x] **1.9 Single-instance lock + atomic config writes**
  Files: `app/main.js` (`app.requestSingleInstanceLock`, focus existing window), `app/main/config.js` (~:68 temp+rename).
  Done when: second launch focuses the first window; config.json can't be truncated by a crash mid-write.

### Unplanned work landed during Phases 0–1 (2026-07-16)

- [x] **Version monotonicity** — `makePlan` bumped from the VERSION file at HEAD, which lags the tags on a stale checkout; v0.2.0.0 existed and a `fix` released v0.1.1.0. The bump base is now max(VERSION file, highest tag) (`tools/version/lib/plan.mjs`, + regression test). Latest release manually corrected to v0.2.1.0.
- [x] **Packaging was entirely broken** — electron-builder rejects the 4-part version and cannot resolve the hoisted electron range; `app/scripts/dist.js` now swaps in the semver prefix for the build (restoring after), keeps the 4-part in artifact names via `${env.MAGENTRA_VERSION}`, and pins `electronVersion`.
- [x] **macOS target added** (user request): `dist:mac`, mac build config, darwin ripgrep, release-matrix dmg. The "dead" macOS lifecycle code in main.js is now live code.

---

## Phase 2 — Core chat & agent transparency

Goal: during any task the user can always answer "what is it doing, what changed, why did it stop".

- [x] **2.1 Markdown + code rendering in the transcript** *(new markdown.js — dependency-free, DOM-built so no XSS; live text streams, re-renders on finalize)*
  Files: `app/renderer/modules/landing.js` (~:134-152), new renderer module, `app/renderer/styles.css`.
  Incremental rendering during streaming (or re-render per message on finalize); fenced code blocks styled + syntax highlighted; lists/headings/inline code. Must stay dependency-light (classic-script constraint) or introduce the app's first vendored lib deliberately.
  Done when: a reply containing a fenced diff/code block renders as a distinct, readable block.

- [x] **2.2 Human-readable provider errors** *(friendlyProviderError in providers/retry.ts; session classifies at emit with the endpoint host)*
  Files: `engine/providers/src/openai-compat.ts` (~:65-69), `engine/providers/src/anthropic.ts`, `engine/providers/src/types.ts`.
  Classify 401/403 ("API key rejected by <host>"), 404 ("model '<m>' not found on this endpoint"), 429 ("rate limited"), ECONNREFUSED/ENOTFOUND ("can't reach <host> — is the server running?"). Keep original detail available (collapsed).
  Done when: a wrong key, a typo'd model, and a stopped local server each produce a distinct plain-English error in the transcript.

- [x] **2.3 Default detail mode = technical; cinematic rows expandable** *(every row now click-to-expand incl. cinematic; "hit a snag" euphemism removed — real error shown)*
  Files: `app/renderer/modules/stream.js` (~:116-137), `app/renderer/modules/state.js`.
  Flip the default; make cinematic rows click-to-expand too; apply mode switches retroactively to existing rows; stop masking tool errors as "hit a snag — recovering" (~stream.js:154-158).
  Done when: a new user can click any tool row and see the command/result; switching modes restyles history.

- [x] **2.4 Turn outcome on the separator**
  Files: `app/renderer/modules/landing.js` (~:111-132).
  Render `turn_finished.stopReason`: completed silently, but "stopped by you" / "error" / "max tokens" / "iteration cap" labeled.
  Done when: an interrupted turn and an errored turn are visually distinct from a completed one.

- [x] **2.5 Composer usable during a turn (queue)** *(messages typed mid-turn queue with removable chips, flush one per turn end)*
  Files: `app/renderer/modules/composer.js`, `app/renderer/modules/landing.js` (~:83).
  Keep the input enabled while busy; Enter queues the message and sends it on `turn_finished` (visible "queued" chip; Esc-clearable).
  Done when: you can type and queue the next instruction while the agent works.

- [x] **2.6 Render `thinking_delta`** *(collapsible dim reasoning block; last line feeds the now-line)*
  Files: `app/renderer/modules/landing.js` (~:497 default case), `app/renderer/modules/stream.js`.
  Collapsible dim "reasoning" block (collapsed by default) and/or rolling snippet in the now-line.
  Done when: a reasoning model shows live thinking instead of a static "thinking · 45s".

- [x] **2.7 Handle `mode_changed`** *(all four modes worded in the footer hint; commands segment synced where it maps)*
  Files: `app/renderer/modules/landing.js`, `app/renderer/modules/state.js` (~:156-160).
  Drive the safety hint + settings segment from engine truth; covers `/mode` and plan-mode flows.
  Done when: typing `/mode acceptEdits` updates the footer hint and settings UI.

- [x] **2.8 Question cards: honor `multiSelect` + `header`** *(toggle options + SUBMIT for multi; per-question header)*
  Files: `app/renderer/modules/landing.js` (~:271-356).
  Done when: a multi-select question accepts multiple options; the header chip renders.

- [x] **2.9 Pre-workspace errors are visible** *(appendSysError falls back to the transcript container before a stream exists)*
  Files: `app/renderer/modules/stream.js` (~:31), `app/renderer/modules/landing.js`.
  Buffer sys-errors until the stream exists, or show a toast/banner on the landing page.
  Done when: a boot error occurring before workspace open is readable somewhere.

- [x] **2.10 Model change guarded; no phantom restarts** *(no-op on unchanged; select disabled mid-turn; confirm when a change would end a running turn)*
  Files: `app/renderer/modules/session.js` (~:144-148), `app/renderer/modules/composer.js` (~:29), `app/main.js` (~:740-753, :801-803).
  No-op when custom-model blur value unchanged; disable model select while busy; confirm (or defer to turn end) any engine-restarting change mid-turn, incl. web-search toggle.
  Done when: clicking into and out of the custom-model field does nothing; changing model mid-turn asks first.

---

## Phase 3 — Continuity: sessions, resume, workspaces

Goal: quitting the app or switching contexts loses nothing.

- [x] **3.1 Engine: resume replays the conversation to the UI** *(new `session_restored` CoreEvent — unavoidable: no engine→frontend event carries a user message, and the renderer can't read the transcript file. `reconstructForDisplay` pairs tool calls with results and strips scaffolding; the painter reuses renderMarkdown + createToolRow/finishToolRow + appendUserMessage. Swapped the old command_output note; minimal diff to resumeSession.)*
  Files: `engine/core/src/runtime/engine.ts`, `engine/protocol/src/types.ts`, `app/renderer/modules/landing.js`.
  Done when: `/resume <id>` repaints the full prior conversation in the chat area (reusing the 2.1 renderer).

- [x] **3.2 Engine: persist session stats/mode in the transcript**
  Files: `engine/core/src/state/transcript.ts` (use the declared-but-unwritten `meta` record kind, ~:7,17), `engine/core/src/runtime/session.ts`, `sessionStats.ts`.
  Snapshot stats + permission mode at turn end; restore on resume.
  Done when: `/session` after `/resume` shows yesterday's real cost, not $0.00.
  *Done: root sessions append a `meta` record (stats snapshot + mode) after every `turn_finished`; `Transcript.replay` (renamed from `replayMessages`, now also returns the latest meta) feeds `SessionStats.fromSnapshot` + a validated `setMode` (+`mode_changed` emit) in `resumeSession`. Pre-meta/corrupt transcripts degrade to fresh stats + config mode. Verified end-to-end on a real Session + FakeProvider.*

- [x] **3.3 Engine: exclude subagent transcripts from the session list**
  Files: `engine/core/src/runtime/session.ts` (~:240-241 mark child transcripts — subdir or record flag), `engine/core/src/runtime/engine.ts` (~:1563-1587 filter listing + refuse resume of children).
  Done when: `/sessions` lists only top-level sessions, each with a human label.
  *Done: new `SessionOptions.child` flag (set at the single spawn site) routes child transcripts to `sessions/subagents/`; the non-recursive listing and resume path exclude them with no filtering logic, and children skip the 3.2 meta snapshot (root owns the shared ledger). Resume of an unknown/child id now says "no such session" instead of a raw ENOENT. Limitation: subagent transcripts written before this change remain in `sessions/` (no reliable marker) — 3.7 GC is the place to age them out.*

- [ ] **3.4 Sessions drawer in the UI**
  Files: `app/renderer/modules/landing.js` (handle the currently-unhandled `session_list` event), new UI on the landing page + dock, `app/main.js`/`preload.js` if new IPC is needed.
  List (label, date, model), click-to-resume (sends `resume_session`), delete with confirm. Rename/search can follow later in Phase 8.
  Done when: reopening the app → two clicks to a fully repainted previous conversation.

- [ ] **3.5 Workspace switch resets the console**
  Files: `app/renderer/modules/session.js` (~:9-23), `app/renderer/modules/events.js`, `app/renderer/modules/crew.js`.
  Clear stream, changes, crew, mission rail, and permission queue when the workspace changes.
  Done when: opening workspace B never shows workspace A's transcript or diffs.

- [ ] **3.6 Transcript trim notice**
  Files: `app/renderer/modules/stream.js` (~:59-74).
  When trimming, insert a sys-note: "older messages trimmed — full log in `.magentra/sessions/<id>.jsonl`".
  Done when: the trim is announced instead of silent.

- [ ] **3.7 Session/task file GC**
  Files: `engine/core/src/runtime/engine.ts` or state layer.
  Cap/rotate `.magentra/sessions/` and `.magentra/tasks/` (e.g. keep newest N, configurable).
  Done when: old files are pruned; setting documented in `/settings`.

---

## Phase 4 — Discoverability & terminology

Goal: the engine's power is findable; words mean one thing each.

- [ ] **4.1 Complete the slash palette from the engine**
  Files: `app/renderer/modules/state.js` (~:251-263), ideally `engine/core/src/runtime/engine.ts` (emit the command registry in `session_started` so the palette can never drift).
  Add `/atlas /debug /crew /team /lab /mission` (+ subcommand hints); prefer engine-fed registry over the hardcoded list.
  Done when: typing `/mi` suggests `/mission`; palette content comes from (or is verified against) the engine.

- [ ] **4.2 Rename the task rail: MISSION → TASKS**
  Files: `app/renderer/modules/missions.js`, `app/renderer/index.html` (~:267-277), `engine/core/src/ma/builtin.ts` (~:133 lexicon "mission: the current task list").
  Resolves the worst naming collision (UI "mission" = task list vs engine missions subsystem).
  Done when: the rail and dock say TASKS; "mission" refers only to `.magentra/missions/`.

- [ ] **4.3 One noun for crew vs team**
  Files: `engine/core/src/runtime/engine.ts` (`/crew`, `/team` handlers), renderer CREW view labels, docs.
  Pick "crew" as the user-facing noun; keep `/team` as alias; label export scopes explicitly ("export member" vs "export whole crew").
  Done when: UI + /help use one consistent noun with clear member/whole-crew distinction.

- [ ] **4.4 One noun for styles/modes/disciplines/campaigns**
  Files: `app/renderer/modules/missions.js` (~:205,215 panel group headers), docs, `/styles` help text.
  Pick "styles" user-facing (avoid clashing with permission *modes*); rename panel headers.
  Done when: the styles panel, chips, and /help use one word.

- [ ] **4.5 Missions view (read-only first)**
  Files: new renderer module or section, `engine/protocol/src/types.ts` (+ `missions_updated` event), `engine/core/src/runtime/engine.ts`/`scheduling/missions.ts` (emit on load/change).
  List mission files, schedule state, last-run summary, run/stop buttons wired to existing `/mission` handlers.
  Done when: a user can see and run missions without knowing the slash syntax.

- [ ] **4.6 Crew cards show depth**
  Files: `app/renderer/modules/crew.js` (~:104 area).
  Cost ledger total, lesson count, service-record length on each card (data already flows through `/crew` handlers — may need a small event extension); visible "⋯" menu button replacing right-click-only actions.
  Done when: a crew card answers "what has this member done and cost" at a glance, mouse-free path exists.

- [ ] **4.7 `/skills` listing + loaded-extensions visibility**
  Files: `engine/core/src/runtime/engine.ts`, `engine/core/src/agent/skills.ts`.
  List discovered skills; add loaded skills/hooks/MCP-server count lines to `/session`.
  Done when: extension points are discoverable in-product.

- [ ] **4.8 Documentation truth pass**
  Files: `docs/ARCHITECTURE.md` (rewrite against engine/+app/ layout), `docs/SCENARIOS.md` (retarget from nonexistent `packages/cli`), `docs/MA-FORMAT.md` (eleven builtins, `debug` row, `repro-failed` gate, fix paths), `docs/HIRABLE-CREW.md` (drop dead PRD link), new `docs/SETTINGS.md` or section covering `mcpServers`, STANDARDS.md convention, reuse gate (`reuseCheck.mode`), `.magentra/` directory reference; remove stale `INTEGRATION-phase3a.md` references in `engine/tools/src/worktree.ts` (~:99) and `engine/core/src/integrations/mcp.ts` (~:251). Also `README.md`: releases now carry binaries — add an install section for all three artifacts (`dist:mac` beside the others; unsigned dmg needs right-click → Open; unsigned exe trips SmartScreen) so "clone and build" stops being the only documented path.
  Done when: no doc references a nonexistent path; every settings key that changes behavior is documented somewhere; a new user can install from the README without building.

- [ ] **4.9 In-app glossary / help**
  Files: renderer (help overlay or settings section).
  One screen defining crew, backpack, atlas, mission, styles, plan mode, deletion guard — linked from `/help` and the dock.
  Done when: every invented noun has a one-line in-product definition.

---

## Phase 5 — Visual consistency & design polish

- [ ] **5.1 Fix dead CSS hooks**
  Files: `app/renderer/styles.css`, `app/renderer/modules/landing.js` (~:303-309), `app/renderer/modules/missions.js` (~:71-86).
  Add `body.rail-open` stage offset (rail stops occluding text); `.q-opt.recommended` badge (and stop stripping the "(Recommended)" suffix); remove or implement `body[data-view]` / `body.busy` writers.
  Done when: rail open reflows layout; recommended options are visibly marked; no JS writes a class no CSS reads.

- [ ] **5.2 Contrast tokens meet AA**
  Files: `app/renderer/styles.css` (~:12-133 theme blocks).
  Lift `--text-dim` to ≥4.5:1 in all four themes (phosphor 3.9 → ≥4.5, dusk 3.9, glacier 2.8, paper 3.1); fix glacier accent (4.0:1); fix hintAuto amber alpha; 2px focus outline (~:166-169).
  Done when: measured ratios pass for every theme (record them in the commit message).

- [ ] **5.3 Theme hygiene**
  Files: `app/renderer/styles.css`.
  Derive all reds from `--red` (kill ~8 hardcoded `rgba(255,77,77,…)`); theme-aware modal scrim (~:1313); consolidate radii on `--radius`; retire legacy `--green`/`--cyan` aliases.
  Done when: switching themes recolors every error/danger surface correctly.

- [ ] **5.4 OS theme detection**
  Files: `app/main.js` (`nativeTheme` IPC), `app/renderer/modules/state.js` (~:104-115).
  Default (until user picks a theme) follows OS dark/light; quick toggle in settings.
  Done when: first launch on a light-mode OS opens a light theme.

- [ ] **5.5 Reduced motion respected by the canvas**
  Files: `app/renderer/modules/atmosphere.js` (~:102-117).
  Honor `prefers-reduced-motion` and the app's CALM setting in `frame()`.
  Done when: CALM (or the OS setting) freezes rain/snow/stars.

- [ ] **5.6 Changes panel: cumulative per-file diffs**
  Files: `app/renderer/modules/events.js` (~:34-39), possibly engine support for cumulative-diff-vs-turn-start.
  Accumulate (or clearly label "latest edit"); correct +/− counts; basic diff syntax coloring.
  Done when: a file edited five times shows all five (or a true cumulative) — never a misleading fragment.

- [ ] **5.7 Scroll-escape pill**
  Files: `app/renderer/modules/util.js` (~:17), `stream.js`.
  "↓ latest" pill when scrolled up during streaming.
  Done when: scrolling up mid-stream shows a one-click return.

- [ ] **5.8 Responsive floor**
  Files: `app/renderer/styles.css` (~:1474-1478), `index.html`.
  Usable at 700px width (settings grid wraps, chips wrap); set a sane `minWidth` on the BrowserWindow.
  Done when: no horizontal clipping at the minimum window size.

- [ ] **5.9 Legibility floor + Linux fonts**
  Files: `app/renderer/styles.css` (0.55rem dock labels etc.), `index.html` (~:154-155 font options), possibly bundle a mono font.
  No computed text below ~10px at the smallest base size; font options that exist on Linux.
  Done when: the S text setting is legible everywhere; Linux font picker options actually differ.

- [ ] **5.10 Consistent truncation affordance**
  Files: `engine/tools/src/*` (six different truncation notice phrasings), `stream.js`.
  One phrasing convention ("[truncated — N more lines; how to get the rest]"), one UI affordance.
  Done when: Bash/Grep/Glob/Read/GraphQuery/WebFetch truncations read the same way.

---

## Phase 6 — Reliability, recovery & cost

- [ ] **6.1 Provider retry in the turn loop, visible**
  Files: `engine/core/src/runtime/session.ts` (~:1146), `engine/providers/src/retry.ts` (~:29-49 add onRetry callback), `engine/protocol/src/types.ts` (retry-status event), renderer now-line.
  Bounded exponential retry on retryable classes (429/5xx/network); now-line shows "rate-limited — retrying in Ns".
  Done when: pulling the network mid-turn shows retries then recovery; the spinner never freezes unexplained.

- [ ] **6.2 Mid-turn compaction + model-aware context windows**
  Files: `engine/core/src/runtime/session.ts` (~:1161 check inside the iteration loop), `engine/core/src/config/settings.ts` (window per known model; keep override).
  Also: `/compact` size-based (drop the `<8 messages` gate, ~:1492); chunk the summarizer input so the summary call can't itself overflow (~:1501-1517).
  Done when: a 50-iteration tool loop on a 128k model compacts mid-turn instead of dying on a provider context error.

- [ ] **6.3 Anthropic prompt caching**
  Files: `engine/providers/src/anthropic.ts`.
  `cache_control` on the system prompt and conversation prefix; verify `cacheReadTokens` flow into the existing 4-class accounting.
  Done when: a long Anthropic session shows nonzero cache reads in `/session` and materially lower cost.

- [ ] **6.4 Engine process hygiene**
  Files: `app/main.js` (~:77-94 stopEngine: SIGTERM → wait → SIGKILL; never spawn a replacement while the old child lives), `engine/host/src/serve.ts` (interrupt the session on stdin EOF / SIGTERM instead of `await engine.idle()`).
  Done when: restart never yields two engines in one tree; closing the app aborts an in-flight turn instead of letting it run headless.

- [ ] **6.5 Diagnostics reachable**
  Files: `app/main/logging.js` (~:32-41 recursive redaction with depth cap; mirror sys/renderer channels to `userData/logs/` even before a workspace opens), `app/main.js` (Help → "Open logs folder" menu item or settings button).
  Done when: a crash on the landing page leaves a log file a user can find from the UI.

- [ ] **6.6 Deletion guard fairness + gaps**
  Files: `engine/core/src/runtime/permissions.ts` (~:104), `engine/tools/src/bash.ts` (~:29).
  Explicit non-wildcard allow rules beat the guard (unattended cleanup missions can delete their own temp files); `mv` flagged only when clobbering/leaving cwd or `-f`; extend patterns (`find -delete`, `git stash drop`) or rename the toggle honestly.
  Done when: `permissions.allow: ["Bash(rm -rf ./tmp/*)"]` stops re-prompting; plain renames don't trip the guard.

- [ ] **6.7 Misc engine correctness**
  Files: `engine/core/src/runtime/engine.ts` (~:174 case-insensitive regex vs case-sensitive switch — lowercase before dispatch; ~:107 `SETTING_TIMING.modes` — rebuild ModeEngine in createSession or relabel "restart"; ~:670 `/clear` shouldn't re-run full `Engine.start()` side effects), `engine/tools/src/crewRun.ts` (~:29 use `resolveTaskId`), `engine/core/src/scheduling/cron.ts` (~:243 exempt durable/mission jobs from 7-day expiry or re-arm on load), `engine/tools/src/webFetch.ts` (~:35 exempt loopback from https upgrade), `engine/core/src/runtime/engine.ts` (~:568-575 don't build embedder against DeepInfra when provider=anthropic without baseUrl — warn + disable), `engine/host/src/main.ts` (~:53-55 reject unknown flags).
  Done when: each listed behavior verified by hand (scheduled `/Mission` fires; localhost WebFetch works; weekly mission survives week 2; etc.).

- [ ] **6.8 MCP robustness + visibility**
  Files: `engine/core/src/integrations/mcp.ts` (~:258-269 collect failures into bootstrap warnings; ~:14 configurable/longer tools/call timeout), `/mcp` status slash or `/session` line.
  Done when: a typo'd MCP server produces a visible warning; slow MCP tools don't die at 10s.

- [ ] **6.9 Renderer/engine single source of truth**
  Files: `engine/core/src/runtime/engine.ts` (emit rate card + command registry + per-model usage in events), `app/renderer/modules/session.js` (~:26-43 delete pricing copy), `state.js` (~:251-263 delete registry copy per 4.1), `landing.js` (~:120 per-model cost attribution).
  Done when: no pricing or command list exists in renderer source; crew runs on other models bill correctly in the meter.

---

## Phase 7 — Accessibility & keyboard completeness

- [ ] **7.1 ARIA foundation**
  Files: `app/renderer/index.html`, `landing.js`, `stream.js`.
  `aria-live="polite"` transcript region (batched announcements); `role="dialog"` + `aria-modal` + focus trap + focus restore on all modals (delete/permission modal currently never takes focus); `aria-label` on every icon button; `aria-hidden` on the ASCII logo and decorative canvas.
  Done when: NVDA/Orca announces streamed replies and modal openings; Tab can't wander behind a scrim.

- [ ] **7.2 Focusable interactive rows**
  Files: `stream.js` (~:137 tool rows), `events.js` (~:95 diff rows), `missions.js` (~:178 style rows), `crew.js`.
  Real buttons or `tabindex=0`+keydown; visible focus.
  Done when: keyboard-only users can expand tool output, open diffs, toggle styles, and manage crew.

- [ ] **7.3 Keyboard power layer**
  Files: `composer.js`, new keymap module.
  Prompt history (ArrowUp in empty composer), focus-composer key, Ctrl+1..4 view switching, keyboard approve/deny (e.g. A/D or Y/N with the modal focused), `?` shortcut cheat-sheet overlay. Now that macOS is a target: Cmd variants for every Ctrl shortcut (Ctrl+L etc. — `composer.js` checks `e.ctrlKey` only).
  Done when: a full task — prompt, approve, inspect, switch view — completes mouse-free on all three platforms, and `?` documents it.

- [ ] **7.4 Non-color signals**
  Files: `styles.css`, `views.js`, `crew.js`.
  Status LED + agent LEDs get a glyph/text pairing; keep +/− prefixes in diffs.
  Done when: every state distinguishable in grayscale.

---

## Phase 8 — Power-user & advanced surfaces

- [ ] **8.1 Wire `!` bang commands**
  Files: `app/renderer/modules/composer.js` (~:149 route `!`-prefixed input to `bang_command`), `engine/core/src/runtime/engine.ts` (~:1552-1561 queue until idle — never inject mid-turn; truncate output to the 40KB tool limit).
  Done when: `! git status` works from the composer, mid-turn input is deferred, and a huge output can't torch the context.

- [ ] **8.2 Live tool output streaming**
  Files: `engine/protocol/src/types.ts` (new `tool_output_delta`), `engine/tools/src/bash.ts` (~:202-217 throttled incremental emission), `engine/core/src/scheduling/workflow.ts` (~:59-68 emit `log()`/`phase()` live), `stream.js` (tail rendering in tool rows).
  Done when: `npm install` output scrolls live inside its tool row; workflows show phase progress as they run.

- [ ] **8.3 Background-job control**
  Files: `engine/core/src/runtime/engine.ts` (expose BackgroundManager `list`/`stop` — `agent/tool.ts` ~:204-213), renderer activity UI, `landing.js` (~:126 stop force-finalizing `background:true` agent cards at turn end).
  Done when: running background jobs are listed with individual stop buttons; background agents stay live past turn end.

- [ ] **8.4 Model catalog from the endpoint**
  Files: `engine/providers/src/openai-compat.ts` (`GET /models`), engine event, `session.js`/`index.html` (~:51-70 replace hardcoded catalog), `setup.js` (`WIZ_PRESETS[*].models` — the wizard's static per-preset lists added in 1.3 are a stopgap this item supersedes).
  Populate the picker from the configured endpoint; validate the configured model at boot (clear warning on 404).
  Done when: an Ollama user sees their local models in the dropdown (wizard included); a typo'd model warns at startup, not on first turn.

- [ ] **8.5 Session management extras**
  Files: sessions drawer from 3.4.
  Rename, search/filter, archive.
  Done when: a 50-session history is navigable.

- [ ] **8.6 Crew/team pack UI**
  Files: `crew.js` (+ export button per card, "hire from file/URL" affordance), wired to existing `/crew export` / `/team hire` handlers.
  Done when: pack round-trip works without typing slash commands; hire honestly labels the unsigned chain ("tamper-evident, not forge-proof" — pack.ts signature is null in v1).

- [ ] **8.7 Worktree visibility**
  Files: `engine/tools/src/worktree.ts` (emit a cwd-changed notice event; drop the dead doc reference ~:99), renderer topbar indicator.
  Done when: the UI shows when the session is operating inside a worktree and where.

- [ ] **8.8 Tool paper-cuts**
  Files: `engine/tools/src/glob.ts` (`dot` option), `read.ts` (binary detection + honest error), `grep.ts` (truncate instead of maxBuffer error), `monitor.ts` (relax the 60-lines/min auto-stop for build logs), `askUserQuestion.ts` (key answers by id, not question text), `engine/core/src/runtime/session.ts` (~:405 default `smallModel` sensibly or reword WebFetch's "small model" promise).
  Done when: each verified by hand against its audit finding.

- [ ] **8.9 Workflow budget: enforce or remove**
  Files: `engine/core/src/scheduling/workflow.ts` (~:219), `engine/tools/src/workflow.ts` (~:36).
  Wire `budget` to session token accounting, or delete it from the API + tool description.
  Done when: the model is never told about an API that does nothing.

---

## Phase 9 — Platform & distribution polish

- [ ] **9.1 Windows installer + auto-update**
  Files: `app/package.json` (NSIS target, publish config), electron-updater integration in `app/main.js`.
  Note: auto-update on macOS is impossible without code signing (electron-updater requires a signed app there) — mac auto-update depends on 9.8.
  Done when: users install via a normal installer and receive updates automatically.
- [ ] **9.2 Code signing (Windows at minimum)** — org decision + cert; removes SmartScreen friction and enables a sandboxed non-portable build.
- [ ] **9.3 Windows toast AppUserModelID**
  Files: `app/main.js` (`app.setAppUserModelId`), verify `engine/tools/src/pushNotification.ts` toasts display.
- [ ] **9.4 Linux `.deb` (and/or Flatpak) with proper sandbox helper** — complements 1.6.
- [ ] **9.5 Window state persistence** — bounds/maximize in `userData/config.json` (`app/main.js` ~:487-540).
- [x] **9.6 macOS: dead code or real target — resolved as a real target** (Phase 1: dmg in the release matrix; the lifecycle handlers in `app/main.js` ~:894-909 are now live).
- [ ] **9.7 PowerShell fallback for Bash tool** (large; optional after 1.5's guidance).
- [ ] **9.8 macOS signing + notarization** — the arm64 dmg ships unsigned (Gatekeeper: right-click → Open). Apple Developer cert + notarize step in the release matrix; unblocks mac auto-update (9.1).
- [ ] **9.9 Intel mac (x64) dmg** — needs a second (macos-13/x64) runner in the release matrix so the bundled ripgrep matches; only if someone asks.

---

## Phase P — Permissions & trust hardening (deferred by decision, 2026-07-16)

Running with all permissions bypassed is **intentional** during product development. Revisit this phase when the product is ready (likely alongside Phase 9's distribution work — the point where strangers start running it). Items parked here, in future priority order:

- [ ] **P.1 Default permission mode = `default`, not bypass**
  Files: `app/main.js` (~:154 hardcoded `--dangerously-bypass`), `app/renderer/modules/state.js` (~:81 default, ~:152 mapping).
  Done when: fresh profile prompts before the first mutating tool call; bypass is an explicit, clearly-labeled opt-in.

- [ ] **P.2 Approval dialog worth trusting**
  Files: `app/renderer/modules/landing.js` (~:241-267), `app/renderer/index.html` (~:280-290).
  Per-tool bodies (diff preview for Edit/Write, command for Bash); fix the deletion-dialog copy for non-command tools; add **ALLOW FOR SESSION** (protocol `allow_session` already exists).
  Done when: an edit approval shows the diff; repeat approvals can be promoted to session-wide.

- [ ] **P.3 Scope session allows; honest plan pre-auth**
  Files: `engine/core/src/runtime/permissions.ts` (~:145-153), `engine/tools/src/planMode.ts` (~:90-92).
  Bash session-allows keyed by command prefix, not tool-wide; plan `allowedPrompts` match real subjects or the UI states the true grant.
  Done when: session-allowing `ls -la` does not authorize arbitrary Bash; plan approval shows its real scope.

- [ ] **P.4 Unattended missions default to `acceptEdits`**
  Files: `engine/core/src/runtime/engine.ts` (~:1301), `engine/core/src/scheduling/missions.ts` (~:30).
  Bypass only when the mission file explicitly declares `mode: bypass`.
  Done when: a scheduled mission without a mode line runs in acceptEdits.

- [ ] **P.5 `/permissions` inspect & revoke**
  Files: `engine/core/src/runtime/engine.ts` (new slash), `engine/core/src/runtime/permissions.ts`.
  List active mode, session allows, deletion-guard state; revoke individual grants.
  Done when: every standing grant is inspectable and revocable.

- [ ] **P.6 Surface acceptEdits/plan modes in the settings UI**
  Files: `app/renderer/modules/state.js` (settings segment currently maps only ask→default / auto→bypass).
  Done when: all four modes are selectable without typing `/mode`.

---

## Phase 10 — Tests (final stage, per agreement)

Only after the features above exist and behave. Work through `FEATURES.md` top to bottom, one feature per PR, ticking its box only when the test would fail if the feature broke. Suggested order (from FEATURES.md itself): `pure` → `fs` → `proc` → `llm` (few, env-gated) → `ui` (grow `--smoke`).

- [ ] 10.1 `pure` bucket (permissions table, accounting, compaction boundary incl. 0.4/0.5 repairs, settings timing, protocol round-trip, mode gates, cron matcher…)
- [ ] 10.2 `fs` bucket (transcript replay, atlas freshness, symbol index, crew ledger/lessons/records, packs fail-closed, layered settings, secret perms…)
- [ ] 10.3 `proc` bucket (bash cwd/timeout/kill-tree, ripgrep, worktrees, hooks, MCP)
- [ ] 10.4 `net` bucket (web search/fetch)
- [ ] 10.5 `llm` bucket (turn loop, interrupt, compaction, subagents, plan mode, atlas build, backpack retrieval…) — env-gated
- [ ] 10.6 `ui` bucket (boot, engine lifecycle, permission prompt, plan review, clear, meter, wizard, crew designer, changes panel)
- [ ] 10.7 Packaging checks (clean-machine artifact launch on all three platforms incl. the mac dmg, bundled rg, sandbox wrapper on userns-restricted Linux, no `node_modules` at runtime)
