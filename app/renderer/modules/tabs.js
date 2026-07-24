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
 * Run `fn` with `tabId`'s console state live in the globals, then restore the
 * focused tab's. When `tabId` is the focused, untargeted, or unknown tab, its
 * state is already live and `fn` runs directly (the dormant single-tab path).
 * `dispatchTabId` is set for the duration so chrome-updaters know which tab the
 * work belongs to. Returns true if a swap happened. Shared by engine-event
 * routing and by echoing a pane's own outgoing message into its tab.
 */
function runInTab(tabId, fn) {
  const prevDispatch = dispatchTabId;
  if (tabId === null || tabId === focusedTabId || !tabs.has(tabId)) {
    dispatchTabId = focusedTabId;
    try {
      fn();
    } finally {
      dispatchTabId = prevDispatch;
    }
    return false;
  }
  // Multi-tab: temporarily make the target tab's state live, run, then restore.
  const focused = focusedTabId && tabs.has(focusedTabId) ? tabs.get(focusedTabId) : null;
  if (focused) captureInto(focused);
  applyFrom(tabs.get(tabId));
  dispatchTabId = tabId;
  try {
    fn();
  } finally {
    captureInto(tabs.get(tabId));
    dispatchTabId = prevDispatch;
    if (focused) applyFrom(focused);
  }
  return true;
}

/**
 * The single entry point the IPC bridge calls for every engine event. Routes the
 * event to its tab so the handler writes into the right tab's DOM/state. With one
 * tab this is a straight passthrough to handleEngineEvent.
 */
function routeEngineEvent(event) {
  const id = event && event.tabId ? event.tabId : focusedTabId;
  const swapped = runInTab(id, () => handleEngineEvent(event));
  // A background tab's event may have changed its running / needs-attention
  // state — refresh the tab bar so its badge updates without stealing focus.
  if (swapped) renderSidebarWorkspaces();
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

// --- Split layout: automatic tiling of multiple open workspaces --------------
// One tab: a single focused console with the shared bottom composer. Two or more:
// every tab tiles into a grid, and each pane carries ITS OWN transcript AND its
// own message input (the shared composer hides) so you type into a workspace
// directly instead of selecting one first. Geometry by pane count: 2 = equal
// columns, 3 = two on top + one full-width on the bottom, 4 = 2x2 quadrants.
// Click a pane (or its input) to focus it. Tiling follows the tab count — there
// is no mode toggle. In the 3-pane layout the bottom (big) pane defaults to the
// 3rd/last-opened tab; right-click a top pane's header → "move to bottom" swaps
// which one is big. Focus is independent and does NOT change the big pane.
let bigTabId = null;

function tabStreamPanes() {
  return [...tabs.keys()].slice(0, 4).map((id) => ({ id, ts: tabs.get(id) })).filter((x) => x.ts.streamEl);
}

function autoGrowInput(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

/** A compact message input for one pane — sends straight to THAT pane's engine
 * (steer while it is busy, a fresh message otherwise), so each tiled workspace
 * has its own chat. Built once per tab and reused, so text survives re-layouts. */
function buildPaneComposer(tabId) {
  const box = document.createElement("div");
  box.className = "pane-composer";
  const ta = document.createElement("textarea");
  ta.className = "pane-input";
  ta.rows = 1;
  ta.spellcheck = false;
  ta.placeholder = "Message this workspace…";
  const submit = () => {
    const text = ta.value.trim();
    if (!text) return;
    const ts = tabs.get(tabId);
    const isBusy = tabId === focusedTabId ? busy : Boolean(ts && ts.busy);
    // Echo what was sent into THIS tab's transcript before it goes out — the
    // same bubble/steer note the single-tab composer renders — so the user can
    // see their own message (runInTab makes the target tab's stream live for the
    // append even when it is a background pane). Then route it to that engine.
    runInTab(tabId, () => {
      if (isBusy) {
        if (typeof appendSysNote === "function") appendSysNote(`↳ steering — "${text.replace(/\s+/g, " ").slice(0, 80)}"`);
      } else if (typeof appendUserMessage === "function") {
        appendUserMessage(text);
      }
    });
    // A pane input is plain chat routed to its own engine (steer a running turn,
    // else a new message). Slash/bang commands + rich controls live in the
    // single-tab composer.
    window.magentra.send({ type: isBusy ? "steer_message" : "user_message", text }, tabId);
    ta.value = "";
    autoGrowInput(ta);
  };
  ta.addEventListener("input", () => autoGrowInput(ta));
  ta.addEventListener("focus", () => {
    if (tabId !== focusedTabId && window.magentra.focusTab) window.magentra.focusTab(tabId);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  const btn = document.createElement("button");
  btn.className = "pane-send";
  btn.textContent = "↑";
  btn.title = "Send to this workspace";
  btn.addEventListener("click", submit);
  box.append(ta, btn);
  return box;
}

/** The reusable pane wrapper for a tab: header + its transcript + its own input.
 * Created once per tab; re-seats a rebuilt stream (e.g. after /clear). */
function paneFor(id, ts) {
  if (!ts.paneEl) {
    const pane = document.createElement("div");
    pane.className = "console-pane";
    pane.dataset.tab = id;
    const head = document.createElement("div");
    head.className = "console-pane-head";
    head.textContent = pathLeaf(ts.workspace || "");
    head.title = ts.workspace || "";
    head.addEventListener("contextmenu", (e) => openPaneCtxMenu(e, id));
    pane.appendChild(head);
    pane.appendChild(ts.streamEl);
    pane.appendChild(buildPaneComposer(id));
    pane.addEventListener("mousedown", () => {
      if (id !== focusedTabId && window.magentra.focusTab) window.magentra.focusTab(id);
    });
    ts.paneEl = pane;
  } else if (ts.streamEl && ts.streamEl.parentNode !== ts.paneEl) {
    ts.paneEl.insertBefore(ts.streamEl, ts.paneEl.querySelector(".pane-composer"));
  }
  return ts.paneEl;
}

/** Right-click a pane's header: move it to the big (bottom) slot in the 3-pane
 * layout, and pick this workspace's OWN skills (checkboxes) without leaving the
 * pane you're in. Reuses the shared ctx-menu machinery (crew.js). */
function openPaneCtxMenu(e, tabId) {
  e.preventDefault();
  if (typeof closeCtxMenu === "function") closeCtxMenu();
  const menuEl = document.createElement("div");
  menuEl.className = "ctx-menu";

  // Move-to-bottom — only in the 3-pane layout, and only for a top pane.
  const panes = tabStreamPanes();
  if (panes.length === 3) {
    const currentBig = bigTabId && panes.some((p) => p.id === bigTabId) ? bigTabId : panes[2].id;
    if (tabId !== currentBig) {
      const mv = document.createElement("button");
      mv.className = "ctx-item";
      mv.textContent = "⤓ MOVE TO BOTTOM";
      mv.addEventListener("click", () => {
        bigTabId = tabId;
        applyLayout();
        closeCtxMenu();
      });
      menuEl.appendChild(mv);
    }
  }

  // Set connection for THIS workspace only — focus the tab first (so the shared
  // connection wizard, which acts on the focused workspace, targets it), then
  // open it in apply mode. Reuses the whole wizard/profile machinery; the
  // resulting engine restart lands on this tab's workspace, not the others'.
  if (typeof openConnectionsWizard === "function") {
    const conn = document.createElement("button");
    conn.className = "ctx-item";
    conn.textContent = "SET CONNECTION";
    conn.addEventListener("click", () => {
      if (tabId !== focusedTabId && window.magentra.focusTab) window.magentra.focusTab(tabId);
      closeCtxMenu();
      void openConnectionsWizard("apply");
    });
    menuEl.appendChild(conn);
  }

  // Close this tab — also available on the sidebar row's ✕; here too for reach.
  if (window.magentra.closeTab) {
    const close = document.createElement("button");
    close.className = "ctx-item danger";
    close.textContent = "✕ CLOSE TAB";
    close.addEventListener("click", () => {
      window.magentra.closeTab(tabId);
      closeCtxMenu();
    });
    menuEl.appendChild(close);
  }

  // This workspace's skills as checkboxes — routed to THIS tab's engine, so each
  // session can run its own set. (The sidebar Skills view stays the overall one.)
  const tabModes = tabId === focusedTabId ? modes : (tabs.get(tabId) && tabs.get(tabId).modes) || [];
  if (Array.isArray(tabModes) && tabModes.length > 0) {
    if (menuEl.children.length > 0) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menuEl.appendChild(sep);
    }
    const hint = document.createElement("div");
    hint.className = "ctx-hint";
    hint.textContent = "Skills — this workspace only";
    menuEl.appendChild(hint);
    const send = () => {
      const active = [];
      menuEl.querySelectorAll("input[data-skill]").forEach((c) => {
        if (c.checked) active.push(c.dataset.skill);
      });
      window.magentra.send({ type: "set_modes", active }, tabId);
    };
    for (const m of tabModes) {
      const row = document.createElement("label");
      row.className = "ctx-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!m.active;
      cb.dataset.skill = m.id;
      cb.addEventListener("change", send);
      const label = document.createElement("span");
      label.textContent = m.name || m.id;
      row.append(cb, label);
      menuEl.appendChild(row);
    }
  }

  if (menuEl.children.length === 0) return; // nothing to offer here

  document.body.appendChild(menuEl);
  const rect = menuEl.getBoundingClientRect();
  let left = e.clientX || 8;
  let top = e.clientY || 8;
  if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 4;
  if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 4;
  menuEl.style.left = `${Math.max(4, left)}px`;
  menuEl.style.top = `${Math.max(4, top)}px`;
  openCtxMenuEl = menuEl;
  // Clicks INSIDE the menu (toggling checkboxes) keep it open; only an outside
  // click or Escape closes it.
  const onDocClick = (ev) => { if (!menuEl.contains(ev.target)) closeCtxMenu(); };
  const onKeydown = (ev) => { if (ev.key === "Escape") closeCtxMenu(); };
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("keydown", onKeydown);
  closeOpenCtxMenuListeners = () => {
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKeydown);
  };
}

/** Place the tab consoles: a single focused stream (shared composer), or — with
 * >=2 tabs — a grid of panes each with their own transcript + input. The single
 * source of truth for what is mounted. */
function applyLayout() {
  // The focused tab's live console lives in the globals, not yet in its
  // TabState — sync it so tabStreamPanes() sees its real (current) streamEl.
  if (focusedTabId && tabs.has(focusedTabId)) captureInto(tabs.get(focusedTabId));
  const panes = tabStreamPanes();
  const tiled = panes.length >= 2;
  document.body.classList.toggle("tiled", tiled);
  // Detach every pane/stream first so the placement below is authoritative.
  for (const ts of tabs.values()) {
    if (ts.paneEl && ts.paneEl.parentNode) ts.paneEl.parentNode.removeChild(ts.paneEl);
    if (ts.streamEl && ts.streamEl.parentNode === transcriptEl) transcriptEl.removeChild(ts.streamEl);
    if (ts.paneEl) ts.paneEl.classList.remove("focused", "pane-big");
  }
  if (!tiled) {
    transcriptEl.classList.remove("console-grid");
    transcriptEl.removeAttribute("data-panes");
    // Single view: the focused tab's stream returns to the transcript directly
    // (pulling it out of its pane wrapper if it was tiled).
    if (streamEl) {
      if (streamEl.parentNode && streamEl.parentNode !== transcriptEl) streamEl.parentNode.removeChild(streamEl);
      if (streamEl.parentNode !== transcriptEl) transcriptEl.appendChild(streamEl);
    }
    return;
  }
  transcriptEl.classList.add("console-grid");
  transcriptEl.setAttribute("data-panes", String(panes.length));
  // In the 3-pane layout the bottom (big, full-width) pane defaults to the
  // 3rd/last-opened tab; the header's "move to bottom" sets `bigTabId`. Focus
  // does NOT affect it.
  const bigId = panes.length === 3 ? (bigTabId && panes.some((p) => p.id === bigTabId) ? bigTabId : panes[2].id) : null;
  for (const { id, ts } of panes) {
    const pane = paneFor(id, ts);
    if (id === focusedTabId) pane.classList.add("focused");
    if (id === bigId) pane.classList.add("pane-big");
    transcriptEl.appendChild(pane);
  }
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
}

/** Put keyboard focus in a tab's own message input, so selecting a workspace is
 * enough to start typing (no second click). Skipped while a modal is open so it
 * never steals focus from, e.g., the connection wizard the pane menu just
 * opened. */
function focusPaneInput(tabId) {
  if (typeof modalTrapEl !== "undefined" && modalTrapEl) return;
  const ts = tabs.get(tabId);
  const input = ts && ts.paneEl && ts.paneEl.querySelector(".pane-input");
  if (input) input.focus({ preventScroll: true });
}

/** main → tab:focused: focus an already-open tab. */
function onTabFocusedFromMain(tabId) {
  if (tabId === focusedTabId || !tabs.has(tabId)) return;
  if (focusedTabId && tabs.has(focusedTabId)) captureInto(tabs.get(focusedTabId));
  applyFrom(tabs.get(tabId));
  focusedTabId = tabId;
  applyLayout();
  repaintChromeFromFocusedTab();
  focusPaneInput(tabId);
}

/** main → tab:closed: drop the tab's console. main focuses the next tab (a
 * following tab:focused repaints), or none remain. */
function onTabClosedFromMain(tabId, nextFocus) {
  const ts = tabs.get(tabId);
  if (ts && ts.paneEl && ts.paneEl.parentNode) ts.paneEl.parentNode.removeChild(ts.paneEl);
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
}

if (window.magentra && window.magentra.onTabOpened) {
  window.magentra.onTabOpened((d) => onTabOpenedFromMain(d.tabId, d.workspace));
  window.magentra.onTabFocused((d) => onTabFocusedFromMain(d.tabId));
  window.magentra.onTabClosed((d) => onTabClosedFromMain(d.tabId, d.focus));
  window.magentra.onTabCap((d) => {
    // A soft top-navbar notice, not a system note dropped into the chat.
    if (typeof showTopToast === "function") showTopToast(`Close a tab first — up to ${d.max} workspaces can run at once.`);
  });
}
