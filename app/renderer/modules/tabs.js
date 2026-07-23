// Per-tab state — the heart of concurrent workspaces (docs/CONCURRENT-WORKSPACES.md).
//
// The renderer was built single-tab: ~55 module-level variables across the other
// modules hold one workspace's live console (its transcript DOM, turn flags,
// session, permissions, model, changes, crew, missions…). To run several
// workspaces at once WITHOUT rewriting every handler, we bundle exactly those
// variables into a TabState and, when the focused tab changes, swap the bundle
// out and the target tab's bundle in. Handlers keep reading/writing the same
// globals; they simply operate on whichever tab is currently applied.
//
// SAFETY: with a single tab, `focusedTabId` never changes, so the swap NEVER
// fires — the globals stay exactly as they were and behaviour is identical to
// before this module existed. The swap machinery is dormant until a second tab
// opens (the W.2 flip), so single-tab usage cannot regress.
//
// This module loads AFTER every state-owning module and before composer.js
// (which registers the event listener), so all the globals it swaps already
// exist by the time any function here runs. Access is via get/set closures — the
// per-tab variables are classic-script lexical bindings (not on `window`), and
// the app's strict CSP forbids eval, so each field names its own accessor.

// The exact set of globals that make up one tab's console, as
// [name, get, set, makeDefault] rows. Anything omitted here would leak across
// tabs, so this table is the single source of truth for "what is per-tab".
const TAB_ACCESSORS = [
  // live-turn transcript DOM
  ["streamEl", () => streamEl, (v) => { streamEl = v; }, () => null],
  ["currentAssistantEl", () => currentAssistantEl, (v) => { currentAssistantEl = v; }, () => null],
  ["currentThinkingEl", () => currentThinkingEl, (v) => { currentThinkingEl = v; }, () => null],
  ["compactingCardEl", () => compactingCardEl, (v) => { compactingCardEl = v; }, () => null],
  ["currentAgentsRow", () => currentAgentsRow, (v) => { currentAgentsRow = v; }, () => null],
  ["currentWorkGroup", () => currentWorkGroup, (v) => { currentWorkGroup = v; }, () => null],
  ["agentCards", () => agentCards, (v) => { agentCards = v; }, () => new Map()],
  ["toolRows", () => toolRows, (v) => { toolRows = v; }, () => new Map()],
  ["runningToolRows", () => runningToolRows, (v) => { runningToolRows = v; }, () => new Set()],
  ["toolTickerId", () => toolTickerId, (v) => { toolTickerId = v; }, () => null],
  ["toolCountThisTurn", () => toolCountThisTurn, (v) => { toolCountThisTurn = v; }, () => 0],
  // turn / engine link
  ["busy", () => busy, (v) => { busy = v; }, () => false],
  ["engineLinked", () => engineLinked, (v) => { engineLinked = v; }, () => true],
  ["workspaceOpen", () => workspaceOpen, (v) => { workspaceOpen = v; }, () => false],
  // workspace + session identity
  ["activeWorkspace", () => activeWorkspace, (v) => { activeWorkspace = v; }, () => null],
  ["workspaceWorktree", () => workspaceWorktree, (v) => { workspaceWorktree = v; }, () => null],
  ["currentSessionId", () => currentSessionId, (v) => { currentSessionId = v; }, () => null],
  ["sessionSummaries", () => sessionSummaries, (v) => { sessionSummaries = v; }, () => []],
  // background (non-turn) work
  ["backgroundJobs", () => backgroundJobs, (v) => { backgroundJobs = v; }, () => new Set()],
  ["backgroundJobMeta", () => backgroundJobMeta, (v) => { backgroundJobMeta = v; }, () => new Map()],
  // permissions / questions
  ["permissionQueue", () => permissionQueue, (v) => { permissionQueue = v; }, () => []],
  ["activePermission", () => activePermission, (v) => { activePermission = v; }, () => null],
  // now-line (liveness strip)
  ["nowSpinnerIdx", () => nowSpinnerIdx, (v) => { nowSpinnerIdx = v; }, () => 0],
  ["nowSpinnerIntervalId", () => nowSpinnerIntervalId, (v) => { nowSpinnerIntervalId = v; }, () => null],
  ["nowTickIntervalId", () => nowTickIntervalId, (v) => { nowTickIntervalId = v; }, () => null],
  ["nowTurnStart", () => nowTurnStart, (v) => { nowTurnStart = v; }, () => null],
  ["nowActivityStart", () => nowActivityStart, (v) => { nowActivityStart = v; }, () => null],
  ["nowVerb", () => nowVerb, (v) => { nowVerb = v; }, () => "thinking"],
  ["nowDetail", () => nowDetail, (v) => { nowDetail = v; }, () => ""],
  ["nowOverrideText", () => nowOverrideText, (v) => { nowOverrideText = v; }, () => null],
  ["nowOverrideTimeoutId", () => nowOverrideTimeoutId, (v) => { nowOverrideTimeoutId = v; }, () => null],
  // mission rail
  ["taskStatusById", () => taskStatusById, (v) => { taskStatusById = v; }, () => new Map()],
  ["taskTimes", () => taskTimes, (v) => { taskTimes = v; }, () => new Map()],
  ["taskTickerId", () => taskTickerId, (v) => { taskTickerId = v; }, () => null],
  ["labMissions", () => labMissions, (v) => { labMissions = v; }, () => []],
  ["labWarnings", () => labWarnings, (v) => { labWarnings = v; }, () => []],
  // model + context meter
  ["modelRateCard", () => modelRateCard, (v) => { modelRateCard = v; }, () => ({})],
  ["contextTokens", () => contextTokens, (v) => { contextTokens = v; }, () => 0],
  ["contextWarn", () => contextWarn, (v) => { contextWarn = v; }, () => false],
  ["sessionModel", () => sessionModel, (v) => { sessionModel = v; }, () => ""],
  ["activeModel", () => activeModel, (v) => { activeModel = v; }, () => null],
  // skills / modes
  ["modes", () => modes, (v) => { modes = v; }, () => []],
  ["modesReceived", () => modesReceived, (v) => { modesReceived = v; }, () => false],
  ["pendingModesNote", () => pendingModesNote, (v) => { pendingModesNote = v; }, () => false],
  ["actionSkills", () => actionSkills, (v) => { actionSkills = v; }, () => []],
  // crew
  ["teamAgents", () => teamAgents, (v) => { teamAgents = v; }, () => []],
  ["teamProgress", () => teamProgress, (v) => { teamProgress = v; }, () => new Map()],
  ["teamSeenFirstUpdate", () => teamSeenFirstUpdate, (v) => { teamSeenFirstUpdate = v; }, () => false],
  // changes review
  ["sessionChanges", () => sessionChanges, (v) => { sessionChanges = v; }, () => new Map()],
  ["activeReviewPath", () => activeReviewPath, (v) => { activeReviewPath = v; }, () => null],
  ["inlineChangesCardEl", () => inlineChangesCardEl, (v) => { inlineChangesCardEl = v; }, () => null],
  ["inlineChangesExpanded", () => inlineChangesExpanded, (v) => { inlineChangesExpanded = v; }, () => false],
  // engine-failure banner
  ["engineErrorBannerShown", () => engineErrorBannerShown, (v) => { engineErrorBannerShown = v; }, () => false],
  ["engineBannerEl", () => engineBannerEl, (v) => { engineBannerEl = v; }, () => null],
  ["fatalErrorReported", () => fatalErrorReported, (v) => { fatalErrorReported = v; }, () => false],
  // overdrive cinematic
  ["overdriveCinematicTimer", () => overdriveCinematicTimer, (v) => { overdriveCinematicTimer = v; }, () => null],
];

/** A fresh tab's console state — every field at its module default. */
function createTabState(id, workspace) {
  const ts = { id, workspace: workspace ?? null };
  for (const [name, , , makeDefault] of TAB_ACCESSORS) ts[name] = makeDefault();
  return ts;
}

/** Read the live globals into a TabState (before swapping another tab in). */
function captureInto(ts) {
  for (const [name, get] of TAB_ACCESSORS) ts[name] = get();
}

/** Write a TabState back into the live globals (after making it focused). */
function applyFrom(ts) {
  for (const [name, , set] of TAB_ACCESSORS) set(ts[name]);
}

// Registry of open tabs and which one the shared chrome (composer, sidebar,
// inspector) reflects. `dispatchTabId` names the tab an in-flight event belongs
// to, so chrome-updaters can no-op for a non-focused tab (see chromeIsFocused).
const tabs = new Map(); // tabId -> TabState
let focusedTabId = null;
let dispatchTabId = null;

/** True when the event currently being dispatched belongs to the focused tab —
 * the guard shared-chrome updaters use so a background tab's turn never repaints
 * the focused tab's composer / LED / meter / model picker. With one tab this is
 * always true, so nothing changes. */
function chromeIsFocused() {
  return dispatchTabId === null || dispatchTabId === focusedTabId;
}

/**
 * The single entry point the IPC bridge calls for every engine event. Routes the
 * event to its tab: if it targets a tab other than the focused one, the focused
 * tab's globals are captured and the target's applied first, so the handler
 * writes into the right tab's DOM/state. With one tab, `id === focusedTabId`
 * always, so this is a straight passthrough to handleEngineEvent.
 */
function routeEngineEvent(event) {
  const id = event && event.tabId ? event.tabId : focusedTabId;
  // Single-tab / untargeted event, or the event's tab is already applied: no
  // swap. This is the dormant path for single-tab usage.
  if (id === null || id === focusedTabId || !tabs.has(id)) {
    dispatchTabId = focusedTabId;
    handleEngineEvent(event);
    dispatchTabId = null;
    return;
  }
  // Multi-tab: temporarily make the target tab's state live for this event, so
  // the handler renders into that tab's console, then restore the focused tab.
  const focused = tabs.get(focusedTabId);
  if (focused) captureInto(focused);
  applyFrom(tabs.get(id));
  dispatchTabId = id;
  handleEngineEvent(event);
  captureInto(tabs.get(id));
  dispatchTabId = null;
  if (focused) applyFrom(focused);
  // A background tab's event may have changed its running / needs-attention
  // state — refresh the tab bar so its badge updates without stealing focus.
  renderSidebarWorkspaces();
}

// --- Renderer-side tab management ------------------------------------------
// Main owns the engine pool and drives tab lifecycle over IPC; here we keep the
// matching per-tab console state and mount the focused tab's transcript. NONE of
// this runs unless main sends tab:* events — the mock UI-test harness never does,
// so `tabs` stays empty there and the single-tab path is unchanged.

/** Detach the focused tab's transcript from the view (its DOM is kept in the
 * tab's state, so re-focusing re-mounts it). */
function unmountFocusedStream() {
  if (streamEl && streamEl.parentNode === transcriptEl) transcriptEl.removeChild(streamEl);
}

/** Mount the (already swapped-in) focused tab's transcript into the view. */
function mountFocusedStream() {
  if (streamEl && streamEl.parentNode !== transcriptEl) transcriptEl.appendChild(streamEl);
}

// --- Follow (split) layout (W.3) -------------------------------------------
// Off: one focused console. On (with >=2 tabs): every tab's console is tiled
// into a grid — 2 = equal columns, 3 = two on top + the FOCUSED one full-width on
// the bottom (focus another pane to promote it), 4 = 2x2 equal quadrants. Click a
// pane to focus it (its questions/composer become active).
let followMode = false;

function tabStreamPanes() {
  return [...tabs.keys()].slice(0, 4).map((id) => ({ id, ts: tabs.get(id) })).filter((x) => x.ts.streamEl);
}

/** Place the tab consoles: a single focused stream, or (Follow mode, >=2 tabs) a
 * grid of all tabs' streams. The single source of truth for what is mounted. */
function applyLayout() {
  // Detach every stream first (moving DOM nodes preserves their content) and
  // clear layout classes, so the placement below is authoritative.
  for (const ts of tabs.values()) {
    if (ts.streamEl && ts.streamEl.parentNode) ts.streamEl.parentNode.removeChild(ts.streamEl);
    if (ts.streamEl) ts.streamEl.classList.remove("tab-focused", "pane-big");
  }
  const panes = tabStreamPanes();
  if (!followMode || panes.length < 2) {
    transcriptEl.classList.remove("console-grid");
    transcriptEl.removeAttribute("data-panes");
    mountFocusedStream();
    return;
  }
  transcriptEl.classList.add("console-grid");
  transcriptEl.setAttribute("data-panes", String(panes.length));
  // In the 3-pane layout the focused pane is the big (bottom, full-width) one;
  // focusing another pane promotes it. Default: the 3rd/newly-opened tab.
  const bigId = panes.length === 3 ? (panes.some((p) => p.id === focusedTabId) ? focusedTabId : panes[2].id) : null;
  for (const { id, ts } of panes) {
    if (id === focusedTabId) ts.streamEl.classList.add("tab-focused");
    if (id === bigId) ts.streamEl.classList.add("pane-big");
    if (!ts.streamEl.dataset.paneWired) {
      ts.streamEl.addEventListener("mousedown", () => {
        if (id !== focusedTabId && window.magentra.focusTab) window.magentra.focusTab(id);
      });
      ts.streamEl.dataset.paneWired = "1";
    }
    transcriptEl.appendChild(ts.streamEl);
  }
  if (typeof updateFollowToggle === "function") updateFollowToggle();
}

/** Toggle Follow (split) mode. */
function setFollowMode(on) {
  followMode = on === undefined ? !followMode : !!on;
  applyLayout();
  if (typeof updateFollowToggle === "function") updateFollowToggle();
}

function updateFollowToggle() {
  const btn = document.getElementById("followToggle");
  if (!btn) return;
  // Only meaningful with >=2 tabs; hidden otherwise.
  btn.classList.toggle("hidden", tabs.size < 2);
  btn.classList.toggle("on", followMode);
  btn.setAttribute("aria-pressed", followMode ? "true" : "false");
}

/** Repaint the shared chrome (composer, sidebar, meter, model, inspector) from
 * whatever tab's state is currently applied — called after a focus swap. */
function repaintChromeFromFocusedTab() {
  if (typeof activeWorkspace === "string" && activeWorkspace) {
    workspacePathEl.textContent = pathLeaf(activeWorkspace);
    workspacePathEl.title = activeWorkspace;
  }
  if (typeof applyModel === "function") applyModel(activeModel || sessionModel || (modelSelectEl ? modelSelectEl.value : ""));
  syncActivityUi();
  updateSessionMeter();
  renderSidebarWorkspaces();
  renderSidebarSessions();
  renderSidebarMissions();
  renderMissions();
  renderSessions();
  syncWorkbenchContext();
}

/** main → tab:opened: a workspace opened as its own tab. Save the current tab,
 * install a fresh console for the new one, and focus it. The workspace_changed
 * that follows builds this tab's streamEl (enterActiveState). */
function onTabOpenedFromMain(tabId, workspace) {
  if (focusedTabId && tabs.has(focusedTabId)) captureInto(tabs.get(focusedTabId));
  // Detach whatever console is currently shown (the previous focused tab's, or a
  // pre-tab single console) so the new tab's transcript can take the view.
  unmountFocusedStream();
  const ts = createTabState(tabId, workspace);
  tabs.set(tabId, ts);
  applyFrom(ts); // fresh, empty globals for the new tab (streamEl = null)
  focusedTabId = tabId;
  // Reaching two tabs: hide the inspector by default to give the panes room.
  // It stays reopenable — this is a one-shot default, not a lock.
  if (tabs.size === 2 && typeof closeInspector === "function") closeInspector();
  applyLayout();
  renderSidebarWorkspaces();
  updateFollowToggle();
}

/** main → tab:focused: focus an already-open tab. */
function onTabFocusedFromMain(tabId) {
  if (tabId === focusedTabId || !tabs.has(tabId)) return;
  if (focusedTabId && tabs.has(focusedTabId)) captureInto(tabs.get(focusedTabId));
  applyFrom(tabs.get(tabId));
  focusedTabId = tabId;
  applyLayout();
  repaintChromeFromFocusedTab();
}

/** main → tab:closed: drop the tab's console. main focuses the next tab (a
 * following tab:focused repaints), or none remain. */
function onTabClosedFromMain(tabId, nextFocus) {
  const ts = tabs.get(tabId);
  if (ts && ts.streamEl && ts.streamEl.parentNode) ts.streamEl.parentNode.removeChild(ts.streamEl);
  tabs.delete(tabId);
  if (focusedTabId === tabId) focusedTabId = null;
  // Closing the last workspace returns to a clean landing page (the same
  // self-reload the home button uses). Otherwise main focuses `nextFocus` with a
  // tab:focused that repaints — nothing more to do here.
  if (tabs.size === 0 && !nextFocus) {
    window.location.reload();
    return;
  }
  applyLayout();
  renderSidebarWorkspaces();
  updateFollowToggle();
}

(() => {
  const btn = document.getElementById("followToggle");
  if (btn) {
    btn.addEventListener("click", () => setFollowMode());
    updateFollowToggle();
  }
})();

if (window.magentra && window.magentra.onTabOpened) {
  window.magentra.onTabOpened((d) => onTabOpenedFromMain(d.tabId, d.workspace));
  window.magentra.onTabFocused((d) => onTabFocusedFromMain(d.tabId));
  window.magentra.onTabClosed((d) => onTabClosedFromMain(d.tabId, d.focus));
  window.magentra.onTabCap((d) => {
    if (typeof appendSysNote === "function") appendSysNote(`Close a tab first — up to ${d.max} workspaces can run at once.`);
  });
}
