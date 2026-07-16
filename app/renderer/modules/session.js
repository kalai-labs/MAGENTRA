// Workspace/model wiring and the live session meter (context + cost).
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Workspace / model / composer wiring
// ---------------------------------------------------------------------------

function enterActiveState(workspace) {
  if (!streamEl) {
    if (emptyStateEl && emptyStateEl.parentNode) {
      emptyStateEl.parentNode.removeChild(emptyStateEl);
    }
    streamEl = document.createElement("div");
    streamEl.className = "stream";
    transcriptEl.appendChild(streamEl);
  }
  workspacePathEl.textContent = workspace;
  workspaceOpen = true;
  sendBtnEl.disabled = false;
  clearBtnEl.disabled = false;
  syncActivityUi();
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

// $/1M tokens: [cached, in, out], ctx = context window label.
const MODEL_PRICING = {
  "openai/gpt-oss-120b": { in: 0.039, out: 0.17, ctx: "128K" },
  "deepseek-ai/DeepSeek-V4-Flash": { cached: 0.018, in: 0.09, out: 0.18, ctx: "1M" },
  "Qwen/Qwen3-14B": { in: 0.12, out: 0.24, ctx: "40K" },
  "google/gemma-4-26B-A4B-it": { in: 0.07, out: 0.34, ctx: "256K" },
  "google/gemma-4-31B-it": { in: 0.13, out: 0.38, ctx: "256K" },
  "deepseek-ai/DeepSeek-V3.2": { cached: 0.13, in: 0.26, out: 0.38, ctx: "160K" },
  "Qwen/Qwen3.6-35B-A3B": { in: 0.15, out: 0.95, ctx: "256K" },
  "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo": { cached: 0.1, in: 0.3, out: 1.0, ctx: "262K" },
  "MiniMaxAI/MiniMax-M2.5": { cached: 0.03, in: 0.15, out: 1.15, ctx: "192K" },
  "XiaomiMiMo/MiMo-V2.5": { cached: 0.08, in: 0.4, out: 2.0, ctx: "256K" },
  "zai-org/GLM-5": { cached: 0.12, in: 0.6, out: 2.08, ctx: "198K" },
  "moonshotai/Kimi-K2.5": { cached: 0.07, in: 0.45, out: 2.25, ctx: "256K" },
  "deepseek-ai/DeepSeek-V4-Pro": { cached: 0.1, in: 1.3, out: 2.6, ctx: "1M" },
  "zai-org/GLM-5.2": { cached: 0.18, in: 0.93, out: 3.0, ctx: "1M" },
  "moonshotai/Kimi-K2.7-Code": { cached: 0.15, in: 0.74, out: 3.5, ctx: "256K" },
  "moonshotai/Kimi-K2.6": { cached: 0.15, in: 0.75, out: 3.5, ctx: "256K" },
};

function modelHintText(model) {
  const p = MODEL_PRICING[model];
  if (!p) return model;
  const cached = p.cached !== undefined ? `$${p.cached} cached · ` : "";
  return `${model} · ${cached}$${p.in} in · $${p.out} out /1M · ${p.ctx} ctx`;
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
const usageByModel = new Map(); // model -> {input, output, cacheRead, cacheWrite}

function recordTurnUsage(model, usage) {
  const e = usageByModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  e.input += usage.inputTokens ?? 0;
  e.output += usage.outputTokens ?? 0;
  e.cacheRead += usage.cacheReadTokens ?? 0;
  e.cacheWrite += usage.cacheWriteTokens ?? 0;
  usageByModel.set(model, e);
}

/** Session cost so far, or null when no model used has a rate card (never a fake $0). */
function sessionCost() {
  let total = 0;
  let priced = false;
  for (const [model, u] of usageByModel) {
    const p = MODEL_PRICING[model];
    if (!p) continue;
    priced = true;
    // Cache classes fall back to the input rate when unpriced by the provider.
    const cacheRate = p.cached ?? p.in;
    total +=
      (u.input * p.in + u.output * p.out + u.cacheRead * cacheRate + u.cacheWrite * cacheRate) / 1_000_000;
  }
  return priced ? total : null;
}

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
  const cost = sessionCost();
  if (cost !== null) parts.push(formatUsdShort(cost));
  hintUsageEl.textContent = parts.join(" · ");
  hintUsageEl.classList.toggle("hidden", parts.length === 0);
}

function resetSessionMeter() {
  contextTokens = 0;
  usageByModel.clear();
  updateSessionMeter();
}

function applyModel(model) {
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
}

async function handleChooseWorkspace() {
  const cfg = await window.magentra.chooseWorkspace();
  if (cfg && cfg.workspace) {
    enterActiveState(cfg.workspace);
    applyModel(cfg.model);
  }
}

async function applyModelChange(model) {
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
      }
    } catch {
      // ignore — version display is best-effort
    }
  }
}
