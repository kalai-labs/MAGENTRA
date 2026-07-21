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
  resetTeamView();
  resetLabView();
  resetSessionMeter();
  sessionSummaries = [];
  currentSessionId = null;
  sessionModel = "";
  renderSessions();
  engineErrorBannerShown = false;
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
  navLabEl.classList.remove("hidden");
  navMissionEl.classList.remove("hidden");
  if (navSkillsEl) navSkillsEl.classList.remove("hidden");
  if (navHomeEl) navHomeEl.classList.remove("hidden");
  sidebarSessionsRefreshEl.classList.remove("hidden");
  sidebarMissionNewEl.classList.remove("hidden");
  inspectorToggleEl.classList.remove("hidden");
  void loadConnectionCard();
  sendBtnEl.disabled = false;
  clearBtnEl.disabled = false;
  syncActivityUi();
  renderSidebarWorkspaces();
  renderSidebarSessions();
  renderSidebarMissions();
  syncWorkbenchContext();
  openInspector("tasks");
  requestSessionList();
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
// Live session meter: context now + running cost
//
// CONTEXT is read straight from turn_finished.contextTokens — the engine's own
// measure of how full the window is (last prompt incl. cached tokens + reply).
// It is deliberately shown as an absolute count with no "% of window": the real
// limit varies per model and endpoint, so a percentage would be confidently
// wrong more often than right.
//
// COST accumulates turn_finished.usage per model (that one IS cumulative) and
// bills each token class at its own rate. `/session` in the engine is the
// authoritative bill (packages/core/src/pricing.ts is the canonical rate card);
// this is the at-a-glance version of the same numbers.
// ---------------------------------------------------------------------------

let contextTokens = 0;
let sessionModel = ""; // the model this session runs on (from session_started)
// True once the engine reports the context has grown past the "run /compact"
// warn threshold (turn_finished.contextWarn). Tints the context counter.
let contextWarn = false;

// Context is an ESTIMATE (our count and a provider's can differ), so it always
// carries a "~". Values are rounded coarsely for the same reason — a precise
// figure would imply a precision we don't have.
function formatTokensShort(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function updateSessionMeter() {
  if (!hintUsageEl) return;
  const parts = [];
  if (contextTokens > 0) parts.push(`ctx ~${formatTokensShort(contextTokens)}`);
  hintUsageEl.textContent = parts.join(" · ");
  hintUsageEl.classList.toggle("hidden", parts.length === 0);
  hintUsageEl.classList.toggle("warn", contextWarn);
  syncWorkbenchContext();
}

function resetSessionMeter() {
  contextTokens = 0;
  contextWarn = false;
  updateSessionMeter();
}

function applyModel(model) {
  activeModel = model;
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
