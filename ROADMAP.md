# MAGENTRA — Implementation Roadmap

Scope: **multi-tab (tiled) feature parity.** The renderer was built single-tab; the tabs/tiling refactor (`app/renderer/modules/tabs.js`) hides the shared composer and now-line in tiled mode (`styles.css:598` — `body.tiled #composer, body.tiled #nowLine { display: none; }`) and gives each pane only a minimal text box (`buildPaneComposer`, tabs.js:218-266). Many single-tab console features were therefore dropped, and the background-jobs feature is additionally broken even in single/focused mode. This roadmap restores full parity per pane.

Prior roadmap (Phases 0–P, the 2026-07-15 audit) is archived in `ROADMAP_completed.md`.

Work top to bottom: phases are priority-ordered; items inside a phase are in suggested implementation order. Tick a box only when its **Done when** criterion is verified by actually running the app with ≥2 tabs open (not by reading the diff). Line numbers are from the 2026-07-24 snapshot — re-verify before editing.

Testing policy: same as the prior roadmap — features first, no test-writing here; `tools/version` CI suite stays maintained.

---

## Design decisions (settled 2026-07-24 via grilling — do not re-litigate)

1. **Control home = full controls per pane.** Each tiled pane becomes a complete mini-console (its own slash palette, jobs chip + STOP, attach, stop, new-conversation, now-line), not a shared bar that acts on the focused pane. Consistent with the existing per-pane approvals and overdrive.
2. **Slash = full palette per pane.** Each pane input gets the same autocomplete dropdown (`/` → command list, arrows + Tab complete), running against THAT pane's engine.
3. **Model = no inline per-pane dropdown.** Per-pane model/endpoint changes stay in the existing header right-click → SET CONNECTION wizard. Keeps the pane toolbar uncluttered.
4. **Liveness = full now-line per pane** (verb + detail + live timer), inside each pane above its composer.

**Architecture (binding, `/bigboycoding`):** do NOT duplicate `composer.js` into `buildPaneComposer`. Generalize the shared composer's functions (slash palette, dispatch/submit, attach, queue, prompt history, clear, stop) to operate on a **target** = `{ inputEl, tabId, per-tab state }`, and drive both the single-tab shared composer and every pane composer through that one implementation. Per-message state that is currently module-global in composer.js (`pendingAttachments`, `messageQueue`, `promptHistory`, slash palette state) must move into per-tab state (extend `TAB_ACCESSORS`, tabs.js:25-96) or be parameterized by target, so tabs don't cross-contaminate. Every new per-tab field goes in `TAB_ACCESSORS` (the single source of truth for "what is per-tab").

**Responsive rule (proposed default — flag if you disagree):** when a pane is narrow (3-/4-pane layouts), secondary controls (attach, model-less toolbar extras) collapse into a `···` overflow menu; **send + stop are always visible**. The now-line truncates its detail text before the timer.

---

## Phase A — Background tasks: correctness + per-pane surface *(user priority #1)*

The single-tab background-jobs chip (`#jobsChip`, index.html:145, inside the shared composer) shows each running background task (e.g. a dev server on `localhost:PORT`) with an indeterminate bar and a STOP button. Per-tab storage already exists (`backgroundJobs`, `backgroundJobMeta` in `TAB_ACCESSORS`, tabs.js:48-49) and is swapped correctly; the failures are all on the render/route side.

- [ ] **A.1 A background tab must not clobber the focused tab's jobs chip**
  Files: `app/renderer/modules/landing.js` (`renderBackgroundJobs` ~:350; `onBackgroundNotification` ~:343, ~:382).
  Guard `renderBackgroundJobs()` with `chromeIsFocused()` exactly like the task rail does (`missions.js:61` — `if (!chromeIsFocused()) return;`). A background tab's `background_notification` runs inside `runInTab`, so today it paints that tab's jobs into the single shared chip.
  Done when: with 2 tabs open in the single-console (non-tiled) fallback, a background job starting on the unfocused tab does not change the focused tab's chip.

- [ ] **A.2 Switching tabs repaints the jobs chip from the newly-focused tab**
  Files: `app/renderer/modules/tabs.js` (`repaintChromeFromFocusedTab` ~:660-689).
  Add a `renderBackgroundJobs()` call alongside the existing `renderTaskRail(currentTasks)` (tabs.js:674). The focus swap already loads the new tab's `backgroundJobMeta` into the globals; the render just isn't consuming it.
  Done when: focus a tab with a running job, then another with none — the chip updates to match the focused tab immediately, not on the next notification.

- [ ] **A.3 STOP routes to the engine that owns the task**
  Files: `app/renderer/modules/landing.js` (STOP click ~:372).
  Send the owning tab id: `window.magentra.send({ type: "stop_background", taskId }, ownerTabId)`. `writeToEngine` defaults to `activeTab()` when no tabId is given (main.js:293), so today STOP can kill the wrong engine. Track the owning tabId with each job (stamp it into `backgroundJobMeta` from the event's `tabId`, or resolve via the dispatch context).
  Done when: with two tabs each running a background task, pressing one job's STOP stops that task and leaves the other running.

- [ ] **A.4 Per-pane jobs chip + STOP in tiled mode**
  Files: `app/renderer/modules/tabs.js` (`paneFor` ~:271, `buildPaneComposer` ~:218), `app/renderer/modules/landing.js` (`renderBackgroundJobs` — retarget to a pane container when tiled), `app/renderer/styles.css`.
  Render each tab's own jobs (from its `backgroundJobMeta`) into ITS pane (chip above that pane's composer), since `#jobsChip` is hidden with the shared composer in tiled mode. STOP uses the pane's tabId (A.3).
  Done when: with ≥2 tabs, start a dev server in one workspace — its pane shows the job row with a live bar and a STOP that kills only that server.

---

## Phase B — Per-pane commands: slash palette + bang *(user priority #2)*

Today a pane input sends `/clear` or `!cmd` to the model as literal chat (tabs.js:245 routes everything as `user_message`/`steer_message`) — the command silently misfires. Decision: full palette per pane.

- [ ] **B.1 Generalize the slash palette to a target input**
  Files: `app/renderer/modules/composer.js` (`updateSlashPop`/`renderSlashPop`/`completeSlashCommand`/`hideSlashPop` ~:40-103), `app/renderer/modules/tabs.js` (`buildPaneComposer`).
  Parameterize the palette by its input element and its own popup container + selection state (move `slashVisible`/`slashMatches`/`slashSelIdx` off the single global). Mount a palette popup per pane.
  Done when: typing `/` in a pane opens the dropdown; arrows + Tab navigate/complete; it's independent per pane.

- [ ] **B.2 Route slash/bang from a pane to that pane's engine**
  Files: `app/renderer/modules/composer.js` (`dispatch`/`sendSlashCommand` ~:127-147, ~:317-358), `app/renderer/modules/tabs.js` (`buildPaneComposer` submit ~:226-247).
  Detect `/`/`!` in the pane submit and route as `slash_command`/`bang_command` with the pane's tabId (via the generalized dispatch). Local side effects (e.g. `/clear` → `resetLocalViewForClear`) must run against THAT pane's state via `runInTab`.
  Done when: `/clear` in a pane starts a fresh session in that pane only; `/compact`, `/session`, `/atlas` run on the right engine; `! ls` lands its output in that pane's transcript.

- [ ] **B.3 Slash/bang while busy still queues per pane**
  Files: `app/renderer/modules/composer.js` (`messageQueue`/`flushMessageQueue` ~:153, ~:284-367 — move the queue into per-tab state per the architecture note).
  Done when: firing `/compact` in a busy pane queues it (pane shows a queued chip) and it runs at that pane's turn end, without touching other panes.

---

## Phase C — Per-pane composer parity *(user priority #3 + remaining controls)*

- [ ] **C.1 Per-pane STOP (hard interrupt)**
  Files: `app/renderer/modules/tabs.js` (`buildPaneComposer`).
  Add a ■ button shown while the pane is busy: `window.magentra.send({ type: "interrupt" }, tabId)`. Plumbing confirmed — `interrupt` is a per-tab USER_ACTION_FRAME (main.js:270) handled by the engine (engine.ts:726); only the global `engine:interrupt` IPC (main.js:1846) hardcodes `activeTab`, which we bypass by sending the frame with a tabId.
  Done when: a runaway turn in one pane is stopped by its own ■ while other panes keep running.

- [ ] **C.2 Per-pane new-conversation**
  Files: `app/renderer/modules/tabs.js` (`buildPaneComposer`/`paneFor`), reuse `composer.js` `requestClear`/`resetLocalViewForClear`.
  Add a ↺ control to each pane that runs the `/clear` path for that tabId and resets that pane's transcript (`runInTab`). Ctrl+L continues to act on the focused pane.
  Done when: ↺ in a pane clears that workspace to a fresh session, leaving other panes untouched.

- [ ] **C.3 Per-pane attach (＋) + chips**
  Files: `app/renderer/modules/composer.js` (attach block ~:161-282 — generalize to target; move `pendingAttachments` into per-tab state), `app/renderer/modules/tabs.js` (`buildPaneComposer`).
  Done when: attaching a file in one pane shows its chip there only and folds into that pane's next message; other panes' drafts are unaffected.

- [ ] **C.4 Per-pane prompt history (↑ recall)**
  Files: `app/renderer/modules/composer.js` (history block ~:314-476 — per-tab `promptHistory`/`promptHistIdx`).
  Done when: ↑ in an empty pane input recalls that pane's own sent messages.

---

## Phase D — Per-pane liveness (full now-line)

- [ ] **D.1 Render the now-line inside each pane**
  Files: `app/renderer/modules/tabs.js` (`paneFor`), `app/renderer/modules/landing.js` / wherever the now-line is driven (`startNowLine`/now-line updaters), `app/renderer/styles.css` (`#nowLine` is hidden by `.tiled`, styles.css:598 — give panes their own now-line element).
  Per-tab now-line state already exists in `TAB_ACCESSORS` (tabs.js:54-62). Drive a per-pane now-line element (verb + detail + live timer) from that state; ensure the ticker updates the focused and background panes correctly (respect `chromeIsFocused` where the shared strip was assumed).
  Done when: each running pane shows `⠻ <verb> · <detail> · m:ss` ticking live; an idle pane shows nothing; timers are independent.

---

## Phase E — Focus-guard correctness sweep

The task rail was fixed to no-op for background tabs (`missions.js:61`); other shared-chrome writers still leak a background tab's state onto the focused view.

- [ ] **E.1 Engine-failure banner + status LED must respect the focused tab**
  Files: `app/renderer/modules/landing.js` (`error`/`engine_exit` handlers ~:1047-1048, ~:1070-1071 — re-verify lines), using per-tab `engineErrorBannerShown`/`engineBannerEl`/`fatalErrorReported` (tabs.js:91-93).
  Guard shared LED/banner writes with `chromeIsFocused()`; a background tab's crash should surface on its own pane/sidebar row (running/attn state), not as a shared banner over the focused workspace.
  Done when: crash the engine of an unfocused tab (`kill -9`) — the focused workspace's banner/LED are untouched; the crashed tab's sidebar row and pane show the failure.

- [ ] **E.2 Audit every remaining shared-chrome writer for a focus guard**
  Files: `app/renderer/modules/*` (grep the shared-chrome updaters: LED, meter, model picker, toasts, spinner).
  Cross-check each against `chromeIsFocused()` the way `onTaskListUpdated` and (after A.1) `renderBackgroundJobs` do. Record any additional leaks as new items here.
  Done when: driving a turn on a background tab never repaints the focused tab's chrome (verified by watching the focused pane while a background tab works).

---

## Phase F — Layout & polish

- [ ] **F.1 Responsive pane toolbar (overflow menu when narrow)**
  Files: `app/renderer/modules/tabs.js` (`buildPaneComposer`), `app/renderer/styles.css`.
  Per the responsive rule above: collapse secondary controls into a `···` menu in 3-/4-pane layouts; keep send + stop always visible; truncate now-line detail before the timer.
  Done when: at 4 panes (2×2) no toolbar control is clipped or overlaps; send/stop remain one click away.

- [ ] **F.2 Per-pane scroll-to-latest pill** *(nice-to-have)*
  Files: `app/renderer/modules/tabs.js` (`paneFor`), reuse the `#scrollPill` behavior.
  Each pane scrolls independently; give each its own "↓ latest" affordance when scrolled up during a run.
  Done when: scrolling up in a busy pane shows its own jump-to-latest control that the others don't.

---

## Parity matrix (reference — the audit this roadmap closes)

Legend: ✅ done per-pane · ⚠️ partial / by other means · ❌ missing (this roadmap) · 🚫 intentionally shared.

| Single-tab feature | Tiled today | Target | Phase |
|---|---|---|---|
| Type / send / steer | ✅ | ✅ | — |
| Slash palette + commands | ❌ (sent as chat) | ✅ full palette | B |
| Bang `! cmd` | ❌ | ✅ | B |
| Background-jobs chip + STOP | ❌ + buggy | ✅ per-pane, correct routing | A |
| Now-line liveness | ❌ | ✅ full per-pane | D |
| Hard-stop a turn | ❌ | ✅ per-pane ■ | C.1 |
| New conversation / clear | ⚠️ focused only | ✅ per-pane ↺ | C.2 |
| Attach files | ❌ | ✅ per-pane | C.3 |
| Prompt history ↑ | ❌ | ✅ per-pane | C.4 |
| Queue chip (busy commands) | ❌ | ✅ per-pane | B.3 |
| Engine-error banner / LED | ❌ leaks across tabs | ✅ focus-guarded | E.1 |
| Model quick-switch | ⚠️ SET CONNECTION menu | ⚠️ unchanged (decision 3) | — |
| Task list | ⚠️ bubbles + focused rail | ⚠️ unchanged | — |
| Approvals / Overdrive | ✅ | ✅ | — |
| Full-screen OVERDRIVE cinematic | 🚫 shared | 🚫 shared | — |
| Global views (Settings/Skills/Crew/Changes) | 🚫 act on focused | 🚫 unchanged | — |
