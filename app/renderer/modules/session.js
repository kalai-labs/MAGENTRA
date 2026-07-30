// Workspace/model wiring and the live session meter (context + cost).
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Workspace / model / composer wiring
// ---------------------------------------------------------------------------

function resetWorkspaceState() {
  busy = false;
  backgroundJobs.clear();
  backgroundJobMeta.clear();
  renderBackgroundJobs();
  stopNowLine();
  clearPermissionState();
  resetLocalViewForClear();
  resetChanges();
  resetSessionMeter();
  sessionSummaries = [];
  currentSessionId = null;
  sessionModel = "";
  renderSessions();
  hideEngineErrorBanner();
  fatalErrorReported = false;
  promptInputEl.value = "";
  promptInputEl.style.height = "auto";
  closeReviewDrawer();
  closeInspector();
  setWorkbenchTitle();
  showView("console");
}

function enterActiveState(workspace) {
  const workspaceChanged = activeWorkspace !== workspace;
  if (activeWorkspace !== null && workspaceChanged) resetWorkspaceState();
  activeWorkspace = workspace;
  if (!streamEl) {
    if (emptyStateEl && emptyStateEl.parentNode) {
      emptyStateEl.parentNode.removeChild(emptyStateEl);
    }
    streamEl = document.createElement("div");
    streamEl.className = "stream";
    transcriptEl.appendChild(streamEl);
  }
  workspacePathEl.textContent = pathLeaf(workspace);
  workspacePathEl.title = workspace;
  workspaceOpen = true;
  navSessionsEl.classList.remove("hidden");
  navMissionEl.classList.remove("hidden");
  if (navSkillsEl) navSkillsEl.classList.remove("hidden");
  if (navHomeEl) navHomeEl.classList.remove("hidden");
  sidebarSessionsRefreshEl.classList.remove("hidden");
  inspectorToggleEl.classList.remove("hidden");
  if (revealWorkspaceBtnEl) revealWorkspaceBtnEl.classList.remove("hidden");
  void loadConnectionCard();
  sendBtnEl.disabled = false;
  clearBtnEl.disabled = false;
  syncActivityUi();
  renderSidebarWorkspaces();
  renderSidebarSessions();
  syncWorkbenchContext();
  // Multi-tab defaults the inspector closed (the panes need the width); a single
  // workspace opens it on Tasks as before.
  if (typeof tabs === "undefined" || tabs.size < 2) openInspector("tasks");
  requestSessionList();
  // Place this tab's console (single view, or into its pane in Follow mode).
  if (typeof applyLayout === "function") applyLayout();
  // The teaching tour replaced the old one-shot hint card: it fires once on
  // the first workspace open (deferring while the setup wizard is up).
  maybeStartTour();
}

// The engine ships its rate card ($/1M) + context windows in session_started —
// the renderer keeps NO pricing copy of its own (it drifted when it did).
let modelRateCard = {};

/** Rebuild the model picker from the endpoint's real catalog (model_catalog
 * event). The hardcoded options in index.html are only the pre-catalog
 * default; an Ollama user then sees their local models here. */
function onModelCatalog(event) {
  if (typeof chromeIsFocused === "function" && !chromeIsFocused()) return; // background tab: don't rebuild the focused picker
  const models = Array.isArray(event.models) ? event.models : [];
  if (models.length === 0 || !modelSelectEl) return;
  const current = customModelEl && !customModelEl.classList.contains("hidden")
    ? "__custom__"
    : modelSelectEl.value;
  modelSelectEl.textContent = "";
  for (const id of models) {
    const opt = document.createElement("option");
    opt.value = id;
    // Price intentionally omitted — the catalog shows model ids only.
    opt.textContent = shortModelLabel(id);
    modelSelectEl.appendChild(opt);
  }
  // The active model may be absent from the catalog (typo, gated model):
  // keep it selectable rather than silently switching the session.
  const active = sessionModel || current;
  if (active && active !== "__custom__" && !models.includes(active)) {
    const opt = document.createElement("option");
    opt.value = active;
    opt.textContent = `${shortModelLabel(active)} (not in catalog)`;
    modelSelectEl.appendChild(opt);
  }
  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "Custom…";
  modelSelectEl.appendChild(customOpt);
  modelSelectEl.value = current === "__custom__" ? "__custom__" : active || models[0];
}

function shortModelLabel(id) {
  const idx = id.indexOf("/");
  return idx === -1 ? id : id.slice(idx + 1);
}

function modelHintText(model) {
  const p = modelRateCard[model];
  if (!p) return model;
  // Price is intentionally not shown (our token counting and a provider's
  // billing can diverge). The window size is a published capacity spec, so it
  // stays exact — only the live context estimate is prefixed "~".
  const ctx = p.contextWindow >= 1_000_000
    ? `${(p.contextWindow / 1_000_000).toFixed(0)}M`
    : `${Math.round(p.contextWindow / 1000)}K`;
  return `${model} · ${ctx} ctx`;
}

// ---------------------------------------------------------------------------
// Live token meters — see modules/tokens.js for the definitions.
//
// Both figures come from the engine; the renderer never computes either one, and
// never adds them together. They answer different questions:
//
//   contextTokens  B(t)  "how full is the window right now" — the INPUT of the
//                        latest request. Point-in-time. Shown as an absolute
//                        count with no "% of window": the real limit varies per
//                        model and endpoint, so a percentage would be
//                        confidently wrong more often than right.
//
//   outputTokens   D(t)  "how much has this turn generated so far" — every
//                        output token of the running turn, subagents included.
//                        Resets to 0 at turn_started and climbs from there.
//
// Where they live: the context counter sits under the composer with one
// workspace open, and moves to the top bar (summed over every console) once
// several are tiled. The output counter rides the liveness strip in each chat,
// because it is a property of that turn rather than of the window.
// ---------------------------------------------------------------------------

let contextTokens = 0;
// D(t) for THIS tab's turn. Per-tab (swapped by tabs.js) so each workspace
// counts its own work.
let outputTokens = 0;
let sessionModel = ""; // the model this session runs on (from session_started)
// True once the engine reports the context has grown past the "run /compact"
// warn threshold (turn_finished.contextWarn). Tints the context counter.
let contextWarn = false;

/** The context reading as text. It carries a "~" because our count and a
 *  provider's can differ, and it is rounded coarsely for the same reason. */
function contextLabel(tokens) {
  return `ctx ~${formatTokens(tokens)}`;
}

function updateSessionMeter() {
  updateContextMeter(); // the top-bar total spans every tab, focused or not
  // Tiled: the owning pane draws its own liveness strip, so repaint it here
  // rather than waiting on the ~8/s ticker — the figure it shows just moved.
  if (typeof renderPaneNowLine === "function" && typeof tabs !== "undefined") {
    const owner = tabs.get(typeof liveTabId === "function" ? liveTabId() : focusedTabId);
    if (owner) renderPaneNowLine(owner);
  }
  if (typeof chromeIsFocused === "function" && !chromeIsFocused()) return; // background tab: leave the focused meter alone
  renderNowTokens(); // the chat's own output counter, independent of the composer strip
  if (hintUsageEl) {
    const show = contextTokens > 0;
    hintUsageEl.textContent = show ? contextLabel(contextTokens) : "";
    hintUsageEl.classList.toggle("hidden", !show);
    hintUsageEl.classList.toggle("warn", contextWarn);
  }
  syncWorkbenchContext();
}

/**
 * The top bar's context meter: the input context of every open workspace added
 * up. Shown only when several are tiled — with one console the composer's own
 * counter already says it, and two copies of one number is just noise.
 */
function updateContextMeter() {
  if (!ctxMeterEl || !ctxMeterValueEl) return;
  const tiled = document.body.classList.contains("tiled");
  if (!tiled || typeof tabs === "undefined" || tabs.size === 0) {
    ctxMeterEl.classList.add("hidden");
    return;
  }
  // Exactly one tab's state is live in the globals at any moment — the one being
  // dispatched, else the focused one. Every other tab's is the copy captured on
  // its TabState, so read each from wherever it actually is (see tabs.js).
  const live = typeof liveTabId === "function" ? liveTabId() : focusedTabId;
  let total = 0;
  let warn = false;
  for (const ts of tabs.values()) {
    total += (ts.id === live ? contextTokens : ts.contextTokens) || 0;
    if (ts.id === live ? contextWarn : ts.contextWarn) warn = true;
  }
  ctxMeterEl.classList.toggle("hidden", total <= 0);
  ctxMeterValueEl.textContent = `~${formatTokens(total)}`;
  ctxMeterEl.classList.toggle("warn", warn);
  ctxMeterEl.title = `Input context across ${tabs.size} open workspaces`;
}

function resetSessionMeter() {
  contextTokens = 0;
  outputTokens = 0;
  contextWarn = false;
  updateSessionMeter();
}

function applyModel(model) {
  activeModel = model; // per-tab: keep even for a background tab
  // The shared picker only reflects the focused tab.
  if (typeof chromeIsFocused === "function" && !chromeIsFocused()) return;
  const options = Array.from(modelSelectEl.options).map((o) => o.value);
  if (options.includes(model)) {
    modelSelectEl.value = model;
    customModelEl.classList.add("hidden");
  } else {
    modelSelectEl.value = "__custom__";
    customModelEl.value = model;
    customModelEl.classList.remove("hidden");
  }
  hintModelEl.textContent = modelHintText(model);
  syncWorkbenchContext();
}

async function handleChooseWorkspace() {
  const cfg = await window.magentra.chooseWorkspace();
  if (cfg && cfg.workspace) {
    enterActiveState(cfg.workspace);
    applyModel(cfg.model);
  }
}

// The model the engine is actually running now. Guards against no-op changes
// (re-selecting the same model).
let activeModel = null;

async function applyModelChange(model) {
  if (!model || model === activeModel) return; // nothing changed
  // Changing the model now updates the LIVE session (main sends set_model) — it
  // no longer restarts the engine, so the conversation is kept and it takes
  // effect on the next turn. Safe mid-turn: the current turn finishes on the
  // model it started with.
  activeModel = model;
  await window.magentra.setModel(model);
  hintModelEl.textContent = modelHintText(model);
  appendSysNote(`model set to ${model} — applies to your next message`);
}

function commitCustomModel() {
  const val = customModelEl.value.trim();
  if (val) applyModelChange(val);
}

async function boot() {
  const config = await window.magentra.getConfig();
  // Always land on the start page (logo + recent folders); the user opens a
  // workspace explicitly. `did-finish-load` pushes the recent list.
  renderRecentList(config && config.recentWorkspaces);
  applyModel((config && config.model) || modelSelectEl.value);
  if (config && config.model && setModelDefaultEl) {
    setModelDefaultEl.value = config.model;
  }

  if (window.magentra.getAppInfo) {
    try {
      const info = await window.magentra.getAppInfo();
      if (info && info.version && setVersionEl) {
        setVersionEl.textContent = "v" + info.version;
        if (sidebarVersionEl) sidebarVersionEl.textContent = "v" + info.version;
        // The commit replaced the old fourth version part as the thing that says
        // exactly which source a build came from. A packaged build has one.
        if (info.commit) {
          const built = `v${info.version} (${info.commit})`;
          setVersionEl.title = built;
          if (sidebarVersionEl) sidebarVersionEl.title = built;
        }
      }
    } catch {
      // ignore — version display is best-effort
    }
  }
}

if (openLogsBtnEl && window.magentra.openLogs) {
  openLogsBtnEl.addEventListener("click", () => {
    window.magentra.openLogs().catch(() => {});
  });
}

// Source-code link/button → open the repo in the user's real browser. In-app
// navigation is blocked (will-navigate), so intercept the click and hand the URL
// to the shell. The URL lives once, on the link's href.
if (window.magentra.openExternal && (sourceCodeLinkEl || sourceCodeBtnEl)) {
  const repoUrl =
    (sourceCodeLinkEl && sourceCodeLinkEl.getAttribute("href")) || "https://github.com/kalai-labs/MAGENTRA";
  const openRepo = (e) => {
    if (e) e.preventDefault();
    window.magentra.openExternal(repoUrl);
  };
  if (sourceCodeLinkEl) sourceCodeLinkEl.addEventListener("click", openRepo);
  if (sourceCodeBtnEl) sourceCodeBtnEl.addEventListener("click", openRepo);
}
