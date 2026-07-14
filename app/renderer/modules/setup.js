// First-run setup wizard and the connection settings card.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// First-run setup wizard
// ---------------------------------------------------------------------------

// Each preset knows its endpoint, provider, a suggested model, and whether it
// is a keyless local server (Ollama, LM Studio) that also sets a context size.
const WIZ_PRESETS = {
  deepinfra: { url: "https://api.deepinfra.com/v1/openai", provider: "openai-compat", model: "deepseek-ai/DeepSeek-V4-Flash", local: false },
  anthropic: { url: "https://api.anthropic.com", provider: "anthropic", model: "", local: false },
  ollama: { url: "http://localhost:11434/v1", provider: "openai-compat", model: "qwen3:8b", local: true },
  lmstudio: { url: "http://localhost:1234/v1", provider: "openai-compat", model: "", local: true },
  custom: { url: "", provider: "openai-compat", model: "", local: false },
};

let currentWizPreset = "deepinfra";

function applyWizPreset(preset) {
  const meta = WIZ_PRESETS[preset] || WIZ_PRESETS.custom;
  currentWizPreset = preset;
  wizBaseUrlEl.value = meta.url;
  if (meta.model) wizModelEl.value = meta.model;
  // Local servers need no key and expose a context-size field instead.
  if (wizApiKeyFieldEl) wizApiKeyFieldEl.hidden = meta.local;
  if (wizContextFieldEl) wizContextFieldEl.hidden = !meta.local;
  if (wizNoteEl) {
    wizNoteEl.textContent = meta.local
      ? "No API key needed. Magentra writes the connection to .magentra/settings.json and talks to your local server."
      : "The key is written to .env beside your code and never leaves this machine.";
  }
  if (preset === "custom") wizBaseUrlEl.focus();
}

wizPresetEls.forEach((btn) => {
  btn.addEventListener("click", () => {
    wizPresetEls.forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    applyWizPreset(btn.dataset.preset);
  });
});

/** Open the setup wizard on demand (also the fallback if auto-setup misfires). */
function openSetupWizard() {
  if (!setupWizardEl) return;
  setupWizardEl.classList.remove("hidden");
  const meta = WIZ_PRESETS[currentWizPreset] || WIZ_PRESETS.custom;
  if (meta.local) wizBaseUrlEl.focus();
  else wizApiKeyEl.focus();
}

if (window.magentra.onSetupRequired && setupWizardEl) {
  window.magentra.onSetupRequired(openSetupWizard);
}

/** Build the writeEnv/testConnection payload from the wizard's current state. */
function wizPayload() {
  const meta = WIZ_PRESETS[currentWizPreset] || WIZ_PRESETS.custom;
  const payload = {
    baseUrl: wizBaseUrlEl.value.trim(),
    apiKey: wizApiKeyEl.value,
    model: wizModelEl.value.trim(),
    provider: meta.provider,
  };
  if (meta.local && wizContextEl && wizContextEl.value) payload.contextWindow = wizContextEl.value;
  return payload;
}

if (wizTestBtnEl) {
  wizTestBtnEl.addEventListener("click", async () => {
    wizStatusEl.textContent = "testing…";
    wizStatusEl.className = "";
    if (!window.magentra.testConnection) return;
    let result = null;
    try {
      result = await window.magentra.testConnection(wizPayload());
    } catch {
      result = null;
    }
    if (result && result.ok) {
      wizStatusEl.textContent = "link established";
      wizStatusEl.className = "ok";
    } else {
      wizStatusEl.textContent = "no response — check the URL (is the local server running?)";
      wizStatusEl.className = "err";
    }
  });
}

if (wizStartBtnEl) {
  wizStartBtnEl.addEventListener("click", async () => {
    const meta = WIZ_PRESETS[currentWizPreset] || WIZ_PRESETS.custom;
    if (!meta.local && !wizApiKeyEl.value.trim()) {
      wizStatusEl.textContent = "key required";
      wizStatusEl.className = "err";
      return;
    }
    if (!window.magentra.writeEnv) return;
    let result = null;
    try {
      result = await window.magentra.writeEnv(wizPayload());
    } catch (err) {
      wizStatusEl.textContent = (err && err.message) || "failed to save connection";
      wizStatusEl.className = "err";
      return;
    }
    if (result && result.ok) {
      setupWizardEl.classList.add("hidden");
      wizApiKeyEl.value = "";
    } else {
      wizStatusEl.textContent = (result && result.error) || "failed to save connection";
      wizStatusEl.className = "err";
    }
  });
}

// ---------------------------------------------------------------------------
// Settings: connection card
// ---------------------------------------------------------------------------

function inferProvider(baseUrl) {
  return (baseUrl || "").includes("anthropic.com") ? "anthropic" : "openai-compat";
}

/** A loopback endpoint (Ollama, LM Studio) — keyless. */
function isLocalUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

if (setKeyRevealEl) {
  setKeyRevealEl.addEventListener("click", () => {
    setApiKeyEl.type = setApiKeyEl.type === "password" ? "text" : "password";
  });
}

if (setTestBtnEl) {
  setTestBtnEl.addEventListener("click", async () => {
    setConnStatusEl.textContent = "testing…";
    setConnStatusEl.className = "";
    if (!window.magentra.testConnection) return;
    const baseUrl = setBaseUrlEl.value.trim();
    let result = null;
    try {
      result = await window.magentra.testConnection({
        baseUrl,
        apiKey: setApiKeyEl.value,
        model: setModelDefaultEl.value.trim(),
        provider: inferProvider(baseUrl),
      });
    } catch {
      result = null;
    }
    if (result && result.ok) {
      setConnStatusEl.textContent = "link established";
      setConnStatusEl.className = "ok";
    } else {
      setConnStatusEl.textContent = "no response — check key/url";
      setConnStatusEl.className = "err";
    }
  });
}

if (setSaveBtnEl) {
  setSaveBtnEl.addEventListener("click", async () => {
    const apiKey = setApiKeyEl.value;
    const baseUrl = setBaseUrlEl.value.trim();
    const local = isLocalUrl(baseUrl);
    if (!apiKey.trim() && !local) {
      setConnStatusEl.textContent = "key required";
      setConnStatusEl.className = "err";
      return;
    }
    if (!window.magentra.writeEnv) return;
    let result = null;
    try {
      result = await window.magentra.writeEnv({
        baseUrl,
        apiKey,
        model: setModelDefaultEl.value.trim(),
        provider: inferProvider(baseUrl),
        ...(setContextEl && setContextEl.value ? { contextWindow: setContextEl.value } : {}),
      });
    } catch (err) {
      setConnStatusEl.textContent = (err && err.message) || "failed to save connection";
      setConnStatusEl.className = "err";
      return;
    }
    if (result && result.ok) {
      setApiKeyEl.value = "";
      setConnStatusEl.textContent = local ? "saved to workspace settings" : "written to workspace .env";
      setConnStatusEl.className = "ok";
    } else {
      setConnStatusEl.textContent = (result && result.error) || "failed to write .env";
      setConnStatusEl.className = "err";
    }
  });
}
