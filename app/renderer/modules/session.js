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
  showFirstUseHint();
}

// ---------------------------------------------------------------------------
// First-use hint — the console must never open as an unexplained blank page
// ---------------------------------------------------------------------------

const FIRST_HINT_KEY = "magentra-first-hint-done";
let firstHintEl = null;

/** One-time starter block after the first workspace open: example prompts to
 * click, and the three keys worth knowing. Gone forever after the first send
 * (or its ✕) — regulars never see it again. */
function showFirstUseHint() {
  if (!streamEl || firstHintEl) return;
  try {
    if (localStorage.getItem(FIRST_HINT_KEY)) return;
  } catch {
    return; // no storage — skip rather than nag on every launch
  }

  const el = document.createElement("div");
  el.className = "first-hint";

  const title = document.createElement("div");
  title.className = "first-hint-title";
  title.textContent = "WORKSPACE LINKED — TRY:";
  el.appendChild(title);

  const row = document.createElement("div");
  row.className = "first-hint-row";
  for (const suggestion of [
    "describe this repository",
    "fix the failing build",
    "/atlas",
  ]) {
    const btn = document.createElement("button");
    btn.className = "q-opt";
    btn.textContent = suggestion;
    btn.addEventListener("click", () => {
      promptInputEl.value = suggestion;
      promptInputEl.focus();
      promptInputEl.dispatchEvent(new Event("input"));
    });
    row.appendChild(btn);
  }
  el.appendChild(row);

  const foot = document.createElement("div");
  foot.className = "first-hint-foot";
  foot.textContent = "type / for commands · Ctrl+L clears the chat · Esc stops the agent";
  el.appendChild(foot);

  const close = document.createElement("button");
  close.className = "first-hint-close";
  close.title = "Dismiss";
  close.textContent = "✕";
  close.addEventListener("click", dismissFirstUseHint);
  el.appendChild(close);

  firstHintEl = el;
  streamEl.appendChild(el);
}

function dismissFirstUseHint() {
  if (!firstHintEl) return;
  firstHintEl.remove();
  firstHintEl = null;
  try {
    localStorage.setItem(FIRST_HINT_KEY, "1");
  } catch {
    // storage unavailable — it will show again next launch, harmless
  }
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
    const p = modelRateCard[id];
    opt.textContent = p ? `${shortModelLabel(id)} — $${p.input} / $${p.output}` : shortModelLabel(id);
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
  const cached = p.cacheRead !== undefined ? `$${p.cacheRead} cached · ` : "";
  const ctx = p.contextWindow >= 1_000_000
    ? `${(p.contextWindow / 1_000_000).toFixed(0)}M`
    : `${Math.round(p.contextWindow / 1000)}K`;
  return `${model} · ${cached}$${p.input} in · $${p.output} out /1M · ${ctx} ctx`;
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
// Whole-session cost, PRICED BY THE ENGINE (turn_finished.totalCostUsd) — it
// bills every model in the tree at its own rate, so crew runs on other models
// attribute correctly. null until the engine reports a priced figure.
let sessionCostUsd = null;

function formatTokensShort(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatUsdShort(d) {
  if (d === 0) return "$0.00";
  return d < 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
}

function updateSessionMeter() {
  if (!hintUsageEl) return;
  const parts = [];
  if (contextTokens > 0) parts.push(`ctx ${formatTokensShort(contextTokens)}`);
  if (sessionCostUsd !== null) parts.push(formatUsdShort(sessionCostUsd));
  hintUsageEl.textContent = parts.join(" · ");
  hintUsageEl.classList.toggle("hidden", parts.length === 0);
  syncWorkbenchContext();
}

function resetSessionMeter() {
  contextTokens = 0;
  sessionCostUsd = null;
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

// The model the engine is actually running now. Guards against no-op restarts
// (re-selecting the same model) and destructive mid-turn restarts.
let activeModel = null;

async function applyModelChange(model) {
  if (!model || model === activeModel) return; // nothing changed — no restart
  // Changing model restarts the engine and drops the current conversation. If
  // a turn is mid-flight (or any context has built up), make that explicit
  // rather than silently discarding it.
  if (busy && !window.confirm(`Switch to ${model}? This restarts the engine and ends the current turn, losing its context.`)) {
    applyModel(activeModel); // revert the dropdown to the running model
    return;
  }
  activeModel = model;
  await window.magentra.setModel(model);
  hintModelEl.textContent = modelHintText(model);
  appendSysNote(`model set to ${model} — session restarted`);
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
