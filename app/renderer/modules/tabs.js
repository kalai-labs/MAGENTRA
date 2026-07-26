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
  ["currentTasks", () => currentTasks, (v) => { currentTasks = v; }, () => []],
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
  // This pane's own slash palette popup (positioned above the input by CSS).
  const pop = document.createElement("div");
  pop.className = "pane-slashpop hidden";
  const ta = document.createElement("textarea");
  ta.className = "pane-input";
  ta.rows = 1;
  ta.spellcheck = false;
  ta.placeholder = "Message this workspace…";
  // Full slash palette per pane, bound to THIS input and running against THIS
  // engine (the shared composer's palette logic, retargeted — not duplicated).
  const slash = typeof makeSlashPalette === "function" ? makeSlashPalette(ta, pop, autoGrowInput) : null;

  const tsOf = () => tabs.get(tabId);
  const attachEl = () => { const ts = tsOf(); return ts && ts.paneEl ? ts.paneEl.querySelector(".pane-attach") : null; };
  const paneBusy = () => (tabId === focusedTabId ? busy : Boolean((tsOf() || {}).busy));

  const submit = () => {
    const raw = ta.value;
    const text = raw.trim();
    const ts = tsOf();
    if (!ts) return;
    ts.attachments = ts.attachments || [];
    if (!text && ts.attachments.length === 0) return; // nothing to send
    const isBusy = paneBusy();
    const isCommand = (text.startsWith("/") || text.startsWith("!")) && !raw.includes("\n");
    // History records the raw typed text (commands included); attachment bodies
    // never enter history.
    if (text) {
      ts.paneHistory = ts.paneHistory || [];
      ts.paneHistory.push(raw);
      if (ts.paneHistory.length > 100) ts.paneHistory.shift();
    }
    ts.paneHistIdx = -1;
    if (isCommand) {
      // A command can't steer a running turn — queue it for this tab's turn end
      // (flushed by flushTabCommandQueue); otherwise run it on this engine now.
      if (isBusy) enqueuePaneCommand(tabId, raw);
      else if (typeof runTabCommand === "function") runTabCommand(tabId, text, { inputEl: null, slash: null });
      ta.value = "";
      autoGrowInput(ta);
      if (slash) slash.hide();
      return;
    }
    // Plain text (optionally with attachments): steer a running turn, else a
    // fresh message. Attachment bodies fold into the outgoing text; the transcript
    // shows only the typed text + a note of what was attached. Echoed into THIS
    // tab's transcript (runInTab makes the target tab's stream live even for a
    // background pane), then routed to that engine.
    const names = ts.attachments.map((a) => a.name).join(", ");
    const outgoing = typeof composeWithAttachments === "function" ? composeWithAttachments(text, ts.attachments) : text;
    runInTab(tabId, () => {
      if (isBusy) {
        if (typeof appendSysNote === "function") appendSysNote(`↳ steering — "${(text || `📎 ${names}`).replace(/\s+/g, " ").slice(0, 80)}"`);
      } else if (typeof appendUserMessage === "function") {
        appendUserMessage(text || `📎 ${names}`);
        if (ts.attachments.length && typeof appendSysNote === "function") appendSysNote(`📎 attached ${names}`);
      }
    });
    window.magentra.send({ type: isBusy ? "steer_message" : "user_message", text: outgoing }, tabId);
    if (typeof clearAttachments === "function") clearAttachments(ts.attachments, attachEl());
    ta.value = "";
    autoGrowInput(ta);
  };

  ta.addEventListener("input", () => {
    autoGrowInput(ta);
    if (slash) slash.update();
  });
  ta.addEventListener("focus", () => {
    if (tabId !== focusedTabId && window.magentra.focusTab) window.magentra.focusTab(tabId);
  });
  ta.addEventListener("keydown", (e) => {
    if (slash && slash.handleKeydown(e)) return; // palette consumed the key
    // Per-pane prompt history: ArrowUp from an empty input (or while browsing).
    const ts = tsOf();
    const hist = (ts && ts.paneHistory) || [];
    const browsing = ts && ts.paneHistIdx !== undefined && ts.paneHistIdx !== -1;
    if (e.key === "ArrowUp" && hist.length > 0 && (browsing || ta.value === "")) {
      e.preventDefault();
      ts.paneHistIdx = browsing ? Math.max(0, ts.paneHistIdx - 1) : hist.length - 1;
      ta.value = hist[ts.paneHistIdx];
      autoGrowInput(ta);
      return;
    }
    if (e.key === "ArrowDown" && browsing) {
      e.preventDefault();
      ts.paneHistIdx++;
      if (ts.paneHistIdx >= hist.length) { ts.paneHistIdx = -1; ta.value = ""; }
      else ta.value = hist[ts.paneHistIdx];
      autoGrowInput(ta);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  // The secondary actions, as named handlers so the inline buttons AND the
  // narrow-pane overflow menu invoke the same code.
  const doAttach = () => {
    const ts = tsOf();
    if (!ts) return;
    ts.attachments = ts.attachments || [];
    if (typeof openAttachPicker === "function") void openAttachPicker(ts.attachments, attachEl());
  };
  const doNew = () => {
    if (paneBusy()) return; // don't clear mid-turn (mirrors the shared composer)
    if (typeof sendSlashCommand === "function") sendSlashCommand("/clear", { tabId, inputEl: null, slash: null });
  };

  const attachBtn = document.createElement("button");
  attachBtn.className = "pane-tool";
  attachBtn.textContent = "＋";
  attachBtn.title = "Attach context files";
  attachBtn.addEventListener("click", doAttach);

  const newBtn = document.createElement("button");
  newBtn.className = "pane-tool";
  newBtn.textContent = "↺";
  newBtn.title = "New conversation (clear this workspace)";
  newBtn.addEventListener("click", doNew);

  // Shown only when the pane is too narrow for the inline tools (CSS container
  // query): collapses attach + new-conversation into a menu. Send + stop stay
  // inline always.
  const overflowBtn = document.createElement("button");
  overflowBtn.className = "pane-overflow";
  overflowBtn.textContent = "···";
  overflowBtn.title = "More actions";
  overflowBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openPaneOverflowMenu(overflowBtn, [
      { label: "＋ Attach files", fn: doAttach },
      { label: "↺ New conversation", fn: doNew },
    ]);
  });

  // Per-pane jump-to-latest, shown while this pane's transcript is scrolled up.
  const pill = document.createElement("button");
  pill.className = "pane-scrollpill hidden";
  pill.textContent = "↓ latest";
  pill.title = "Jump to the latest output";
  pill.addEventListener("click", () => {
    const s = tsOf() && tsOf().streamEl;
    if (s) s.scrollTop = s.scrollHeight;
  });

  const sendBtn = document.createElement("button");
  sendBtn.className = "pane-send";
  sendBtn.textContent = "↑";
  sendBtn.title = "Send to this workspace";
  sendBtn.addEventListener("click", submit);

  const stopBtn = document.createElement("button");
  stopBtn.className = "pane-stop hidden";
  stopBtn.textContent = "■";
  stopBtn.title = "Stop this workspace's turn";
  stopBtn.addEventListener("click", () => {
    window.magentra.send({ type: "interrupt" }, tabId);
  });

  box.append(pop, pill, attachBtn, ta, overflowBtn, newBtn, sendBtn, stopBtn);
  return box;
}

/** A small popup anchored above `anchorEl` with the pane's overflow actions.
 * Reuses the shared ctx-menu machinery (crew.js). */
function openPaneOverflowMenu(anchorEl, items) {
  if (typeof closeCtxMenu === "function") closeCtxMenu();
  const menuEl = document.createElement("div");
  menuEl.className = "ctx-menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.className = "ctx-item";
    b.textContent = it.label;
    b.addEventListener("click", () => { it.fn(); closeCtxMenu(); });
    menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);
  const rect = anchorEl.getBoundingClientRect();
  const mrect = menuEl.getBoundingClientRect();
  let top = rect.top - mrect.height - 4;
  if (top < 4) top = rect.bottom + 4;
  menuEl.style.left = `${Math.max(4, rect.right - mrect.width)}px`;
  menuEl.style.top = `${Math.max(4, top)}px`;
  openCtxMenuEl = menuEl;
  const onDocClick = (ev) => { if (!menuEl.contains(ev.target)) closeCtxMenu(); };
  const onKeydown = (ev) => { if (ev.key === "Escape") closeCtxMenu(); };
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("keydown", onKeydown);
  closeOpenCtxMenuListeners = () => {
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKeydown);
  };
}

/** Wire a tab's scroll pill: toggle it from the stream's scroll position, and
 * (re)attach the scroll listener when the stream element is new (e.g. after
 * /clear rebuilds it). */
function wirePaneScrollPill(ts) {
  if (!ts || !ts.paneEl || !ts.streamEl) return;
  const pill = ts.paneEl.querySelector(".pane-scrollpill");
  if (!pill || typeof isNearBottom !== "function") return;
  const stream = ts.streamEl;
  const update = () => pill.classList.toggle("hidden", isNearBottom(stream));
  if (stream.dataset.pillWired !== "1") {
    stream.dataset.pillWired = "1";
    stream.addEventListener("scroll", update);
  }
  update();
}

/** Toggle a tab's pane composer between idle (send visible) and running (stop
 * visible), and mark the pane running. Driven from the per-tab turn lifecycle. */
function syncPaneActivity(tabId, isBusy) {
  const ts = tabId && tabs.get(tabId);
  if (!ts || !ts.paneEl) return;
  const send = ts.paneEl.querySelector(".pane-send");
  const stop = ts.paneEl.querySelector(".pane-stop");
  if (send) send.classList.toggle("hidden", !!isBusy);
  if (stop) stop.classList.toggle("hidden", !isBusy);
  ts.paneEl.classList.toggle("running", !!isBusy);
  renderPaneNowLine(ts);
  ensurePaneNowTicker();
}

// --- Per-pane now-line (liveness strip) ------------------------------------
// The shared #nowLine is hidden in tiled mode, so each pane draws its own from
// its tab's now-line state. The FOCUSED tab's state lives in the module globals
// (nowVerb/nowTurnStart/…, updated live by views.js); a BACKGROUND tab's is the
// values captured on its TabState. One global ticker paints every pane while any
// tab is running — deriving the spinner frame from the clock avoids per-tab
// animation intervals that would fight the state-swap.

// The tab whose state is LIVE in the module globals right now: the tab being
// dispatched during an engine event, else the focused tab. Its now-line/busy live
// in the globals; every other tab's is on its captured TabState.
function liveTabId() {
  return dispatchTabId != null ? dispatchTabId : focusedTabId;
}

function tabIsBusy(ts) {
  return ts.id === liveTabId() ? busy : Boolean(ts.busy);
}

/** The now-line values to render for a tab: live globals when its state is the
 * one currently applied, its captured TabState otherwise. */
function paneNowState(ts) {
  if (ts.id === liveTabId()) {
    return { busy, turnStart: nowTurnStart, activityStart: nowActivityStart, verb: nowVerb, detail: nowDetail, override: nowOverrideText };
  }
  return { busy: ts.busy, turnStart: ts.nowTurnStart, activityStart: ts.nowActivityStart, verb: ts.nowVerb, detail: ts.nowDetail, override: ts.nowOverrideText };
}

/** Paint (or hide) one pane's now-line from its tab's state. */
function renderPaneNowLine(ts) {
  if (!ts || !ts.paneEl) return;
  const el = ts.paneEl.querySelector(".pane-nowline");
  if (!el) return;
  const st = paneNowState(ts);
  el.classList.toggle("hidden", !st.busy);
  if (!st.busy) return;
  const spin = el.querySelector(".pane-now-spin");
  const textEl = el.querySelector(".pane-now-text");
  const timerEl = el.querySelector(".pane-now-timer");
  if (spin) spin.textContent = NOW_SPINNER_FRAMES[Math.floor(Date.now() / 90) % NOW_SPINNER_FRAMES.length];
  if (timerEl) timerEl.textContent = st.turnStart ? formatTurnElapsed(Date.now() - st.turnStart) : "0:00";
  if (textEl) {
    if (st.override != null) {
      textEl.textContent = st.override;
    } else {
      const elapsedSec = st.activityStart ? Math.floor((Date.now() - st.activityStart) / 1000) : 0;
      textEl.textContent = "";
      const verbEl = document.createElement("span");
      verbEl.className = "now-verb";
      verbEl.textContent = st.verb || "thinking";
      textEl.appendChild(verbEl);
      textEl.appendChild(document.createTextNode(st.detail ? ` · ${st.detail} · ${elapsedSec}s` : ` · ${elapsedSec}s`));
    }
  }
}

let paneNowTickId = null;
/** One ticker repaints every pane's now-line ~8×/s; it self-terminates the tick
 * after the last running tab goes idle (one final pass hides the idle strips). */
function paneNowTick() {
  let anyBusy = false;
  for (const ts of tabs.values()) {
    renderPaneNowLine(ts);
    if (tabIsBusy(ts)) anyBusy = true;
  }
  if (!anyBusy && paneNowTickId) {
    clearInterval(paneNowTickId);
    paneNowTickId = null;
  }
}

/** Start the pane now-line ticker if tiled and something is running (idempotent).
 * Stopping is handled by paneNowTick itself once every tab is idle. */
function ensurePaneNowTicker() {
  if (paneNowTickId || !document.body.classList.contains("tiled")) return;
  for (const ts of tabs.values()) {
    if (tabIsBusy(ts)) { paneNowTickId = setInterval(paneNowTick, 120); return; }
  }
}

/** Push a command onto a tab's own queue and repaint its pane queue chip. */
function enqueuePaneCommand(tabId, rawText) {
  const ts = tabs.get(tabId);
  if (!ts) return;
  ts.commandQueue = ts.commandQueue || [];
  ts.commandQueue.push(rawText);
  renderPaneQueue(ts);
}

/** Repaint a tab's pane queue chip from its own command queue (reuses the shared
 * queue-row renderer). */
function renderPaneQueue(ts) {
  if (!ts || !ts.paneEl) return;
  const el = ts.paneEl.querySelector(".pane-queue");
  if (el && typeof renderQueueRows === "function") {
    renderQueueRows(el, ts.commandQueue || [], (idx) => {
      (ts.commandQueue || []).splice(idx, 1);
      renderPaneQueue(ts);
    });
  }
}

/** Flush one queued command for a tab once its turn ends (each command starts a
 * new turn, whose end flushes the next). No-op while the tab is still busy. */
function flushTabCommandQueue(tabId) {
  const ts = tabId && tabs.get(tabId);
  if (!ts || !ts.commandQueue || ts.commandQueue.length === 0) return;
  const stillBusy = tabId === focusedTabId ? busy : Boolean(ts.busy);
  if (stillBusy) return;
  const next = ts.commandQueue.shift();
  renderPaneQueue(ts);
  if (typeof runTabCommand === "function") runTabCommand(tabId, next, { inputEl: null, slash: null });
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
    head.title = ts.workspace || "";
    const nameEl = document.createElement("span");
    nameEl.className = "console-pane-name";
    nameEl.textContent = pathLeaf(ts.workspace || "");
    head.appendChild(nameEl);
    // Per-screen OVERDRIVE toggle: engages the fully-autonomous stance for THIS
    // workspace only (its own engine), scoped to this pane — never full-screen.
    const odBtn = document.createElement("button");
    odBtn.className = "pane-od-btn";
    odBtn.textContent = "⚡";
    odBtn.setAttribute("aria-pressed", "false");
    odBtn.title = "OVERDRIVE — fully autonomous for this workspace";
    odBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleTabOverdrive(id); });
    head.appendChild(odBtn);
    head.addEventListener("contextmenu", (e) => openPaneCtxMenu(e, id));
    pane.appendChild(head);
    pane.appendChild(ts.streamEl);
    // This tab's queued commands, background jobs, then pending attachments —
    // above its composer (the shared chips are hidden in tiled mode). Populated
    // below / on enqueue / on attach.
    const queueEl = document.createElement("div");
    queueEl.className = "pane-queue hidden";
    pane.appendChild(queueEl);
    const jobsEl = document.createElement("div");
    jobsEl.className = "pane-jobs hidden";
    pane.appendChild(jobsEl);
    const attachEl = document.createElement("div");
    attachEl.className = "pane-attach hidden";
    pane.appendChild(attachEl);
    // This tab's own liveness strip (the shared #nowLine is hidden in tiled mode),
    // painted by renderPaneNowLine while the tab's turn runs.
    const nowEl = document.createElement("div");
    nowEl.className = "pane-nowline hidden";
    const nowSpin = document.createElement("span");
    nowSpin.className = "pane-now-spin";
    const nowText = document.createElement("span");
    nowText.className = "pane-now-text";
    const nowTimer = document.createElement("span");
    nowTimer.className = "pane-now-timer";
    nowEl.append(nowSpin, nowText, nowTimer);
    pane.appendChild(nowEl);
    pane.appendChild(buildPaneComposer(id));
    pane.addEventListener("mousedown", () => {
      if (id !== focusedTabId && window.magentra.focusTab) window.magentra.focusTab(id);
    });
    ts.paneEl = pane;
    paintTabBubbles(ts); // restore this tab's task bubbles into the fresh header
    syncTabOverdrive(ts); // restore this tab's overdrive state into the fresh header
  } else if (ts.streamEl && ts.streamEl.parentNode !== ts.paneEl) {
    // Re-seat a rebuilt stream directly after the header, ahead of the chip rows
    // and composer, so the pane order stays head → stream → chips → composer.
    const head = ts.paneEl.querySelector(".console-pane-head");
    ts.paneEl.insertBefore(ts.streamEl, head ? head.nextSibling : ts.paneEl.firstChild);
  }
  // Refresh this tab's own chips from its captured state on every (re)layout, so
  // tiling in — or refocusing — never drops a running job, queued command,
  // pending attachment, or the running/idle button state.
  const paneJobs = ts.paneEl.querySelector(".pane-jobs");
  if (paneJobs && typeof renderJobRows === "function") renderJobRows(paneJobs, ts.backgroundJobMeta, id);
  const paneAttach = ts.paneEl.querySelector(".pane-attach");
  if (paneAttach && typeof renderAttachChips === "function") renderAttachChips(ts.attachments || [], paneAttach);
  renderPaneQueue(ts);
  syncPaneActivity(id, id === focusedTabId ? busy : Boolean(ts.busy));
  wirePaneScrollPill(ts);
  return ts.paneEl;
}

/** The background-jobs chip element inside a tab's pane (tiled mode), or null
 * when that tab has no pane yet (e.g. beyond the visible pane cap). */
function paneJobsContainer(tabId) {
  const ts = tabs.get(tabId);
  return ts && ts.paneEl ? ts.paneEl.querySelector(".pane-jobs") : null;
}

// --- Per-tab task bubbles in the pane header -------------------------------
// Each tab's own task progress, mirrored as a row of dots in its pane header so
// every workspace shows its status at a glance (the shared inspector can only
// reflect the focused tab). One dot per task: hollow = pending, accent-tinted =
// in progress, filled = completed. No tasks → no dots. Statuses are cached on the
// TabState so a pane rebuilt by applyLayout keeps them.

/** Record a tab's task statuses (from a task_list_updated it owns) and repaint
 * its header dots. Safe for any tab, focused or background, and a no-op for an
 * unknown tab or one with no pane yet. */
function setTabTaskBubbles(tabId, tasks) {
  const ts = tabs.get(tabId);
  if (!ts) return;
  ts.taskBubbles = (tasks || []).map((t) => t.status);
  paintTabBubbles(ts);
}

/** Draw the cached bubbles for a tab into its pane header (if mounted). */
function paintTabBubbles(ts) {
  if (!ts || !ts.paneEl) return;
  const head = ts.paneEl.querySelector(".console-pane-head");
  if (!head) return;
  const statuses = ts.taskBubbles || [];
  let box = head.querySelector(".pane-task-bubbles");
  if (statuses.length === 0) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = document.createElement("span");
    box.className = "pane-task-bubbles";
    // Sit between the name and the overdrive button (name … bubbles ⚡).
    head.insertBefore(box, head.querySelector(".pane-od-btn"));
  }
  box.textContent = "";
  const done = statuses.filter((s) => s === "completed").length;
  box.title = `${done}/${statuses.length} tasks done`;
  for (const s of statuses) {
    const dot = document.createElement("span");
    dot.className = "pane-bubble " + (s === "completed" || s === "in_progress" ? s : "pending");
    box.appendChild(dot);
  }
}

// --- Per-tab approval (permission) prompts ---------------------------------
// In the tiled layout each screen answers its OWN approval, so a background
// tab's request is actionable without a full-app modal that only routes to the
// focused engine. The decision is sent to that tab's engine (permission.tabId)
// and its queue advances via runInTab so it stays this tab's business.

function resolvePanePermission(tabId, decision) {
  const ts = tabs.get(tabId);
  const noteEl = ts && ts.paneEl && ts.paneEl.querySelector(".pane-approval-note");
  const note = noteEl ? noteEl.value.trim() : "";
  runInTab(tabId, () => {
    if (!activePermission) return;
    // "Always" only when the engine offered a durable grant, else it's a plain allow.
    let d = decision;
    if (d === "allow_always" && !(typeof activePermission.subject === "string" && activePermission.subject !== "")) d = "allow_once";
    if (typeof sendPermissionDecision === "function") sendPermissionDecision(activePermission, d, note);
    activePermission = null;
    if (typeof showNextPermission === "function") showNextPermission(); // advances THIS tab's queue + repaints its pane
  });
}

/** Build a tab's in-pane approval prompt once; reused for every request. */
function buildPaneApproval(tabId) {
  const box = document.createElement("div");
  box.className = "pane-approval hidden";
  const title = document.createElement("div");
  title.className = "pane-approval-title";
  title.textContent = "⚠ APPROVAL REQUIRED";
  const subject = document.createElement("pre");
  subject.className = "pane-approval-subject";
  const note = document.createElement("textarea");
  note.className = "pane-approval-note";
  note.rows = 1;
  note.spellcheck = false;
  note.placeholder = "Optional note…";
  const actions = document.createElement("div");
  actions.className = "pane-approval-actions";
  const deny = document.createElement("button");
  deny.className = "pa-deny";
  deny.textContent = "DENY (N)";
  deny.addEventListener("click", () => resolvePanePermission(tabId, "deny"));
  const always = document.createElement("button");
  always.className = "pa-always";
  always.textContent = "ALWAYS (A)";
  always.addEventListener("click", () => resolvePanePermission(tabId, "allow_always"));
  const allow = document.createElement("button");
  allow.className = "pa-allow";
  allow.textContent = "ALLOW (Y)";
  allow.addEventListener("click", () => resolvePanePermission(tabId, "allow_once"));
  actions.append(deny, always, allow);
  box.append(title, subject, note, actions);
  return box;
}

/** Show a tab's approval inside its pane. Focuses ALLOW for the focused pane so
 * Y/A/N work at once; a background pane's approval waits for a click/focus. */
function showPaneApproval(tabId, permission) {
  const ts = tabs.get(tabId);
  if (!ts || !ts.paneEl) return;
  let box = ts.paneEl.querySelector(".pane-approval");
  if (!box) {
    box = buildPaneApproval(tabId);
    ts.paneEl.appendChild(box);
  }
  const input = permission.input;
  const subject =
    (input && typeof input === "object" && input.command) ||
    permission.description ||
    (typeof safeStringify === "function" ? safeStringify(input) : String(input));
  box.querySelector(".pane-approval-subject").textContent = subject;
  const grantable = typeof permission.subject === "string" && permission.subject !== "";
  const alwaysBtn = box.querySelector(".pa-always");
  if (alwaysBtn) alwaysBtn.classList.toggle("hidden", !grantable);
  const noteEl = box.querySelector(".pane-approval-note");
  if (noteEl) noteEl.value = "";
  box.classList.remove("hidden");
  ts.paneEl.classList.add("needs-approval");
  if (tabId === focusedTabId) {
    const allowBtn = box.querySelector(".pa-allow");
    if (allowBtn) allowBtn.focus({ preventScroll: true });
  }
}

function hidePaneApproval(tabId) {
  const ts = tabs.get(tabId);
  if (!ts || !ts.paneEl) return;
  const box = ts.paneEl.querySelector(".pane-approval");
  if (box) box.classList.add("hidden");
  ts.paneEl.classList.remove("needs-approval");
}

// --- Per-tab OVERDRIVE -----------------------------------------------------
// OVERDRIVE (the fully-autonomous permission stance) is per-engine, so with
// tiled screens each workspace owns its own. The pane button toggles ITS tab's
// engine and the effect is scoped to that pane (.overdrive) — the full-screen
// cinematic + document shell stay with the single-console shared button.

/** Reflect a tab's overdrive on its pane (glow + button state). */
function syncTabOverdrive(ts) {
  if (!ts || !ts.paneEl) return;
  const on = ts.overdrive === true;
  ts.paneEl.classList.toggle("overdrive", on);
  const btn = ts.paneEl.querySelector(".pane-od-btn");
  if (btn) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on
      ? "OVERDRIVE on for this workspace — click to disengage"
      : "OVERDRIVE — fully autonomous for this workspace";
  }
}

/** Set a tab's overdrive (optionally telling its engine) and repaint its pane. */
function setTabOverdrive(tabId, enabled, sendToEngine, careful) {
  const ts = tabs.get(tabId);
  if (!ts) return;
  ts.overdrive = enabled === true;
  // CAREFUL is per-engine too, so each tab remembers its own. Recorded only
  // when the engine actually reported it — undefined means "this tab has never
  // said", which must not be read as "off".
  if (typeof careful === "boolean") ts.careful = careful;
  if (sendToEngine && window.magentra && window.magentra.send) {
    // No `careful` field: omitting it tells the engine to leave that setting
    // alone, which is right for a pane button that only toggles OVERDRIVE.
    window.magentra.send({ type: "set_overdrive", enabled: ts.overdrive }, tabId);
  }
  syncTabOverdrive(ts);
}

/** Pane button click: flip this workspace's overdrive and tell its engine. No
 * cinematic — the per-pane effect is the glow, not a full-screen sweep. */
function toggleTabOverdrive(tabId) {
  const ts = tabs.get(tabId);
  if (!ts) return;
  setTabOverdrive(tabId, !(ts.overdrive === true), true);
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
  // Detaching a pane from the DOM discards its subtree's layout, resetting the
  // inner stream's scrollTop to 0 on re-attach. Snapshot each pane stream's
  // position (and whether it was pinned to the live edge) BEFORE the detach so
  // the re-attach below doesn't jerk every pane — the out-of-focus ones too —
  // back to the top on each focus change.
  const scrollSnap = new Map();
  for (const { id, ts } of panes) {
    if (ts.streamEl && ts.streamEl.isConnected) {
      scrollSnap.set(id, { top: ts.streamEl.scrollTop, atBottom: isNearBottom(ts.streamEl) });
    }
  }
  document.body.classList.toggle("tiled", tiled);
  // Detach every pane/stream first so the placement below is authoritative.
  for (const ts of tabs.values()) {
    if (ts.paneEl && ts.paneEl.parentNode) ts.paneEl.parentNode.removeChild(ts.paneEl);
    if (ts.streamEl && ts.streamEl.parentNode === transcriptEl) transcriptEl.removeChild(ts.streamEl);
    if (ts.paneEl) ts.paneEl.classList.remove("focused", "pane-big");
  }
  // Sweep out any orphaned stream/pane left by a since-closed tab: after the
  // detach above, every live tab's console is off the DOM, so anything of these
  // classes still under #transcript belongs to no tab and would otherwise linger
  // as a stray grid child (the bug behind re-tiling after a close).
  for (const child of Array.from(transcriptEl.children)) {
    if (child.classList && (child.classList.contains("stream") || child.classList.contains("console-pane"))) {
      transcriptEl.removeChild(child);
    }
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
    // The scroller here is #transcript; keep it at the edge if the stream was.
    const snap = focusedTabId && scrollSnap.get(focusedTabId);
    if (snap && snap.atBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
    // Back to a single console: repaint the shared jobs chip from the focused
    // tab's state, since while tiled its jobs rendered into its pane, not
    // #jobsChip. Covers closing down to one tab with focus unchanged, where no
    // tab:focused repaint fires.
    if (typeof renderBackgroundJobs === "function") renderBackgroundJobs();
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
  // Restore each pane's scroll now that they are re-attached (reading
  // scrollHeight forces the reflow that makes the assignment stick). A pane that
  // was following the live edge stays pinned; the rest keep their exact spot.
  for (const { id, ts } of panes) {
    const snap = scrollSnap.get(id);
    if (snap && ts.streamEl) {
      ts.streamEl.scrollTop = snap.atBottom ? ts.streamEl.scrollHeight : snap.top;
    }
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
  // The shared task rail follows focus: repaint it from THIS tab's own task list
  // (a background tab's update no longer clobbers it — see onTaskListUpdated).
  if (typeof renderTaskRail === "function") renderTaskRail(currentTasks);
  // The shared jobs chip (single console) follows focus too; in tiled mode this
  // repaints the focused pane's own chip. Both routed through renderBackgroundJobs.
  if (typeof renderBackgroundJobs === "function") renderBackgroundJobs();
  // Topbar agent/ops meter follows focus: repaint from the now-focused tab's cards.
  if (typeof updateAgentMeter === "function") updateAgentMeter();
  // Present this tab's pending approval in the right place for the current layout
  // (shared modal when single, in-pane when tiled) — matters when a close drops
  // the tiled layout back to one console with an approval still open.
  if (typeof renderPermissionUi === "function") renderPermissionUi();
  // Keep the shared overdrive chrome (button + document shell) matching the
  // focused tab's own stance, so an untile back to one console isn't stale.
  const focTab = tabs.get(focusedTabId);
  if (focTab && typeof uiSettings !== "undefined") {
    uiSettings.overdrive = focTab.overdrive === true;
    if (typeof lastSentSafety !== "undefined") lastSentSafety.overdrive = uiSettings.overdrive;
    // Only adopt CAREFUL from a tab that has actually reported one — a fresh
    // tab has no opinion yet, and treating that as "off" would silently clear
    // the user's setting just for focusing a new pane.
    if (typeof focTab.careful === "boolean") {
      uiSettings.careful = focTab.careful;
      if (typeof lastSentSafety !== "undefined") lastSentSafety.careful = uiSettings.careful;
    }
    if (typeof applyOverdriveShell === "function") applyOverdriveShell();
  }
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
  if (!ts || !ts.paneEl) return;
  // A pending approval takes precedence: focus its ALLOW so single-key Y/A/N
  // answer it (see composer keydown). Otherwise land in the message input.
  const approve = ts.paneEl.querySelector(".pane-approval:not(.hidden) .pa-allow");
  if (approve) { approve.focus({ preventScroll: true }); return; }
  const input = ts.paneEl.querySelector(".pane-input");
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
  const wasFocused = focusedTabId === tabId;
  tabs.delete(tabId);
  if (wasFocused) focusedTabId = null;
  // Closing the last workspace returns to a clean landing page (the same
  // self-reload the home button uses).
  if (tabs.size === 0 && !nextFocus) {
    window.location.reload();
    return;
  }
  // If the FOCUSED tab was closed, main follows with tab:focused(nextFocus),
  // which applyFrom()s the next tab and re-lays out with correct state. Doing it
  // here — while the closed tab's state is still live in the globals — would
  // re-append its now-dead stream to #transcript (the stray that broke re-tiling).
  // Only re-lay out here when a BACKGROUND tab was closed (focus unchanged, so no
  // tab:focused follows).
  if (!wasFocused) applyLayout();
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
