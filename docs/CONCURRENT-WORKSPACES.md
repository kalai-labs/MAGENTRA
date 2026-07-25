# Magentra — Concurrent Workspace Tabs

Status: **designed 2026-07-23, implementation in progress.** This is the alignment
artifact for the multi-workspace feature; it is the "grill-with-docs" output of the
design session that agreed it. Kept current as the phase lands (see ROADMAP.md Phase W).

Today Magentra runs exactly one workspace: opening a new one, or leaving the current
one, kills the running engine and drops any in-flight work. This document defines the
model, the architecture decision, and the plan for running **several workspaces at once,
each with its own live session that keeps working in the background.**

---

## Revision — 2026-07-23 (UX pass)

Superseding parts of the original design below, after using it:

- **No "Follow mode" toggle.** Multiple open tabs **auto-tile** — the split is simply how
  multi-tab looks (single tab = one console). The term "Follow mode" is retired.
- **Per-pane chat.** Each tiled pane has **its own message input** wired to that pane's engine
  (steer while busy, else a new message); the shared bottom composer hides when tiled, so you
  type into a workspace directly instead of selecting one first.
- **Opening is explicit via right-click.** Right-click a workspace in the sidebar → a menu:
  "open as new tab" (this window), "open in new window" (a separate OS window), focus, close —
  instead of a single implicit behaviour.
- **Multiple OS windows.** "Open in new window" spawns a second full window with its own
  independent set of tabs. The main process now tracks a **per-window active tab**
  (`win.mgActiveTabId`), stamps each tab with its window (`tab.win`), routes every engine event
  to `tab.win`, and resolves untagged requests to the *sender* window's active tab — so several
  windows each drive their own workspaces. The same-folder rule and the cap of 4 are global
  across windows. Single-window behaviour is unchanged (everything defaults to the main window).
- **Linux gets a native window frame** (macOS/Windows unchanged): a frameless window extended
  under the desktop's top panel and clipped the app's top-row icons; a real frame lets the WM
  place it correctly.

## Glossary

The ubiquitous language for this feature. These terms are used verbatim in code and docs.

- **Workspace** — a folder Magentra operates on. Has exactly one `cwd`, one `.magentra/`,
  one git repo. Unchanged from today.
- **Session** (a.k.a. **Chat**) — one conversation/transcript within a workspace, keyed by
  id and persisted at `.magentra/sessions/<id>.jsonl`. The UI word "chat" and the code
  word "session" are the **same thing**. A workspace may have many sessions on disk, but
  **at most one is live at a time** (see Same-folder rule).
- **Engine** — one OS subprocess (`engine/host`) bound to one workspace `cwd`, hosting one
  live session. Unchanged internally.
- **Tab** — a live workspace: its engine process + its focused session + its slice of
  renderer state. The unit of concurrency. Identified by a **`tabId`** the main process
  mints. Because of the Same-folder rule, a Tab maps 1:1 to an open workspace.
- **Focused** vs **Background** — the Tab whose console is on screen is *focused*; the
  others are *background* Tabs whose engines keep running.
- **Follow mode** (a.k.a. **Split view**) — a toggle that tiles 2–4 Tabs side-by-side
  (tmux-style, up to quadrants) so several live consoles can be watched at once.

---

## The model (what we agreed)

- **Tabs + keep-alive.** A browser-tab model: one focused console at a time; switching Tabs
  leaves the others fully alive — a background Tab's turn keeps running to completion and
  notifies when done. This directly fixes the pain: leaving a workspace no longer kills it.
- **Fully concurrent.** Each Tab runs its turns independently and in parallel — separate
  processes, separate API calls. You can start a turn in one Tab and switch to drive
  another while the first runs.
- **Same-folder rule: at most one live session per folder.** The concurrency unit is the
  *workspace*. Opening a folder that is already open **focuses its existing Tab** rather
  than spawning a second one. This eliminates by construction any shared-folder / shared-git
  race — two engines never write the same `.magentra/` or the same repo. (Within a Tab you
  can still resume an older session from disk; that swaps the one live session, as today.)
- **Bounded: max 4 live Tabs.** A fifth open is refused with "close a tab first" — no
  eviction, no silent sleeping. Closing a Tab (its ✕) stops that engine. Simple and
  predictable; memory tops out at four engines.
- **Follow mode tiles up to 4.** A button splits the console area into 2–4 panes. In a
  multi-pane split the per-pane inspector is hidden to make room (accepted trade-off).

### Out of scope (explicit no-s)

- **Two live sessions in one folder.** Dropped by the Same-folder rule (was considered,
  then cut to remove the git-race surface entirely).
- **Cross-tab awareness.** Tabs do not know about each other; no shared engine, no shared
  state, no cross-tab messaging.
- **Tab eviction / LRU sleep / idle timeout.** The cap is a hard 4 with manual close.
- **Protocol/session-id multiplexing on the wire** (see the rejected alternative below).

---

## Architecture decision

**Decision: one engine process per Tab. The engine core and the wire protocol do not
change. Concurrency lives entirely in the main process (an engine *pool*) and the renderer
(per-Tab state).**

### Context

The engine is hard single-session by design (verified in `engine/core/src/runtime/engine.ts`):
a single `this.session` field (replaced, not registered, on resume/clear), a
**single-consumer** `AsyncQueue` event stream (its header comment: "a second concurrent
consumer silently steals events from the first"), and one engine-level `busy`/`turnPromise`
that serialises turns. The wire protocol (`engine/protocol/src/types.ts`) carries **no
workspace id**, and `sessionId` appears only as a *current-session announcement*, never as a
routing channel. The renderer (`app/renderer/modules`) is fully singular: one `streamEl`,
one `currentSessionId`, one `busy`, one `contextTokens`, and a `handleEngineEvent` switch
with zero per-session routing. The only existing multi-session concurrency is **subagents
within one top-level turn** (parent stays `busy`), which is not two independent chats.

### Considered options

1. **One engine process per Tab (chosen).** The main process runs a pool
   `Map<tabId, engine>`; it tags every engine's stdout events with its `tabId` before
   forwarding to the renderer, and routes each renderer request to the right engine's stdin
   by `tabId`. The engine binary and the protocol are untouched — a `tabId` exists only on
   the main↔renderer IPC, never on the engine's stdio.
2. **One engine per workspace, multiplex N sessions inside it (rejected).** Would require
   rewriting the engine's most load-bearing invariants: `this.session` → a registry,
   per-session `busy`/`turnPromise`, a `sessionId` on **every** frame (a protocol break),
   and a multi-consumer fan-out replacing the single-consumer event queue. High risk, large
   blast radius — and multi-*workspace* would still need a pool of these engines, so it buys
   both complexities. With the Same-folder rule (one session per folder) it also buys
   nothing the process-per-Tab model doesn't already give.

### Consequences

- **Low engine risk.** The engine and protocol are unchanged, so no existing engine
  behaviour can regress from this feature — the whole change is confined to `app/`.
- **Parallel turns are free.** Independent processes already run in parallel; a crash in one
  Tab cannot take down another.
- **Memory cost.** Up to four engines, each loading its graph/symbols/atlas/tools/MCP. The
  hard cap of 4 bounds this deliberately.
- **The main process becomes a router.** It gains a pool, `tabId` tagging on the way out,
  and `tabId` routing on the way in — the bulk of the non-UI work.
- **The renderer's singletons become per-Tab.** The largest change: today's module-level
  singular state (`streamEl`, `currentSessionId`, `busy`, `contextTokens`, `backgroundJobs`,
  permission queue, changes, crew view, mission rail…) is lifted into a per-Tab `TabState`,
  and event dispatch routes by `tabId`.

---

## Implementation plan (three controlled steps)

Each step is independently testable and preserves single-Tab behaviour — the existing
main-process and UI test suites must stay green after every step.

### Step 1 — Main process: engine pool + `tabId` routing (no UI change)

`app/main.js`, `app/preload.js`. Replace the single `engineChild`/`dyingEngine` pair with a
pool keyed by `tabId`. Every `sendToRenderer("engine:event", …)` gains the originating
`tabId`; every inbound `engine:send` names its `tabId`. Backward-compatible default: with a
single Tab and no explicit `tabId`, behaviour is byte-for-byte what it is today, so the
current renderer keeps working while Step 2 lands.

### Step 2 — Renderer: per-Tab state + a tab bar (single-view multi-Tab)

`app/renderer/modules/*`. Lift the module-level singletons into a `TabState` object, one per
Tab; route `handleEngineEvent` by `event.tabId` to the owning `TabState`; add a tab bar
(workspace name + live / running / needs-attention badge, ✕ to close, `+` to open, click to
focus). One pane visible at a time; switching focus swaps which `TabState`'s DOM is mounted.

**Tab-bar placement (decided 2026-07-23): the left sidebar, not a top strip.** The existing
"WORKSPACES" list becomes the live-tab bar. Rationale: Follow mode splits the console into up
to four panes, so vertical screen space is scarce — a horizontal top strip would waste it.

**Renderer approach (decided 2026-07-23): one renderer, per-Tab `TabState` — NOT a
view/iframe per Tab.** Rejected iframe/`WebContentsView`-per-Tab: it isolates cleanly but
duplicates the whole renderer per Tab (heavy — on top of up to four engine processes) and
still forces splitting the sidebar chrome out of `index.html`. Instead, one renderer owns a
`Map<tabId, TabState>` where each `TabState` bundles that Tab's console state **and its own
detached `streamEl`** (transcript DOM subtree). The fixed chrome (sidebar, composer, topbar,
inspector) is shared and always reflects the **focused** Tab.

*The load-bearing technique — a state bundle, swapped per event.* The console handlers today
read/write a set of module-level singletons (`streamEl`, `busy`, `currentSessionId`,
`contextTokens`, `toolRows`, `backgroundJobs`, the live-turn DOM pointers, the permission
queue, …). Rather than rewrite every handler to take a Tab argument, bundle exactly those
singletons into `TabState` and, around each dispatch, **swap the bundle in and out**:
`applyTabState(tabs[event.tabId]); handleEngineEvent(event); captureTabState(...)`. Handlers
stay unchanged. Two rules make it correct:
1. **Enumerate the bundle completely** — any per-conversation singleton left out leaks across
   Tabs. The bundle is the single source of truth for "what is per-Tab".
2. **Suppress shared-chrome writes for a non-focused Tab.** Chrome updaters
   (`syncActivityUi`, `updateSessionMeter`, `setStatusLed`) must no-op (or touch only the
   Tab's sidebar badge) when the event's Tab is not focused, so a background Tab's turn cannot
   repaint the focused Tab's composer/LED/meter. On focus change, the chrome is re-rendered
   once from the newly-focused `TabState`.

Because this is all-or-nothing for the multi-Tab case (two live Tabs require per-Tab state to
exist), Step 2 lands as one coherent, `test:ui`-verified change; it is built additively
(bundle + tab bar wired with a single Tab first, identical to today) and only then does
"open workspace" mint a *new* Tab instead of reusing the active one.

### Step 3 — Split layout: tile 2–4 Tabs

A layout manager mounts the live `TabState` consoles into a CSS grid over the console area.
**Geometry, by number of visible Tabs (decided 2026-07-23):**

- **1 Tab** — one full pane (today).
- **2 Tabs** — two equal columns, each full height (split down the middle):
  `grid: 1fr / 1fr 1fr`.
- **3 Tabs** — two equal panes on top, one **full-width "big" pane on the bottom** (double the
  width of a top pane): `grid: 1fr 1fr / 1fr 1fr; areas "a b" / "c c"`. **The user can choose
  which Tab is the big (bottom) one** — the featured Tab is a selectable property, not fixed to
  open-order.
- **4 Tabs** — a 2×2 grid of equal quadrants; the 4th opens into the bottom-right and all four
  return to equal size: `grid: 1fr 1fr / 1fr 1fr; areas "a b" / "c d"`.

**Inspector (right panel) auto-hides once more than one Tab is open** — the panes need the
width. It stays **reopenable by the user** (the toggle is not disabled, just defaulted off in
multi-Tab); reopening it in multi-Tab is the user's explicit choice.

**Non-negotiables for this step:** think through side effects (focus, the now-line/liveness
strip per pane vs. shared, the composer target in split, resize); leave **no UI bug**; and
**style every state across all three themes** (light / workbench / matrix) — no theme left with
an unstyled grid, seam, or pane border. The grid, pane chrome, the active-pane ring, and the
"which Tab is big" control all get tokens in each theme block.

---

## Guardrails

- **Break nothing.** Every step keeps the existing main + UI test suites green; single-Tab
  usage stays identical to today.
- **Same-folder rule is enforced in the main process** (open → focus existing Tab if the
  folder is already open), so the one-live-session-per-folder invariant cannot be violated
  from the UI.
- **The cap of 4 is enforced in the main process**, so the renderer can never spawn a fifth
  engine.

### Per-Tab correctness (decided 2026-07-23) — these are the side effects that must be right

- **Workspaces are fully independent (for now).** No cross-Tab state, no shared session, no
  relationship graph — a later addition, explicitly out of scope now. Each Tab's engine,
  transcript, tasks, permissions, and model stand alone.
- **Questions/approvals route to the Tab that asked.** `permission_request` and
  `question_request` arrive stamped with their `tabId`; the card renders into **that Tab's**
  console (its own `streamEl`), and the reply (`permission_response` / `question_response`)
  is sent back to **that Tab's engine** via `writeToEngine(frame, tabId)` — never the focused
  Tab's. In Split view two Tabs can have a pending question at once; each answers its own
  engine. So `permissionQueue` / `activePermission` / the pending-question state are part of
  the per-Tab bundle, and every reply carries its Tab's id.
- **Each Tab may run a different model.** The model is per-Tab (`sessionModel` / `activeModel`
  live in the bundle; `startEngine` already takes a per-Tab model). The shared composer model
  picker shows and edits the **focused** Tab's model; `set_model` targets that Tab's engine.
  `currentConfig.model` in main is only the *default* a newly-opened Tab starts on.
- **Every user→engine frame carries its Tab's id.** `user_message`, `steer_message`,
  `interrupt`, `slash_command`, `set_modes`, `set_deletion_guard`, `set_overdrive`,
  `set_compact_limit`, `resume_session`, etc. route to the intended Tab's engine — the focused
  Tab for composer actions, the owning Tab for a per-pane control in Split view.
