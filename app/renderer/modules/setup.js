// First-run setup wizard and the connection settings card.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// First-run setup wizard
// ---------------------------------------------------------------------------

// Each preset knows its endpoint, provider, a suggested default model, the
// models worth offering in the picker, where to obtain an API key, and whether
// it is a keyless local server (Ollama, LM Studio) that also sets a context
// size. The model list and the key link MUST match the chosen provider — a
// blank model with another provider's ids in the picker is how a first-run
// user gets stuck.
const WIZ_PRESETS = {
  deepinfra: {
    url: "https://api.deepinfra.com/v1/openai",
    provider: "openai-compat",
    model: "deepseek-ai/DeepSeek-V4-Flash",
    models: [
      "deepseek-ai/DeepSeek-V4-Flash",
      "openai/gpt-oss-120b",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
      "zai-org/GLM-5.2",
      "moonshotai/Kimi-K2.6",
      "deepseek-ai/DeepSeek-V4-Pro",
    ],
    keyUrl: "https://deepinfra.com/dash/api_keys",
    local: false,
  },
  anthropic: {
    url: "https://api.anthropic.com",
    provider: "anthropic",
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
    keyUrl: "https://console.anthropic.com/settings/keys",
    local: false,
  },
  ollama: {
    url: "http://localhost:11434/v1",
    provider: "openai-compat",
    model: "qwen3:8b",
    models: ["qwen3:8b", "qwen2.5-coder:7b", "llama3.1:8b"],
    keyUrl: "",
    local: true,
  },
  lmstudio: {
    url: "http://localhost:1234/v1",
    provider: "openai-compat",
    model: "",
    models: [],
    keyUrl: "",
    local: true,
  },
  custom: { url: "", provider: "openai-compat", model: "", models: [], keyUrl: "", local: false },
};

let currentWizPreset = "deepinfra";

function applyWizPreset(preset) {
  const meta = WIZ_PRESETS[preset] || WIZ_PRESETS.custom;
  currentWizPreset = preset;
  wizBaseUrlEl.value = meta.url;
  // Always replace the model: a leftover id from another preset points the
  // engine at a model this endpoint does not serve.
  wizModelEl.value = meta.model;
  wizModelEl.placeholder = preset === "lmstudio" ? "the model id shown in LM Studio" : "";
  if (wizModelsEl) {
    wizModelsEl.textContent = "";
    for (const id of meta.models) {
      const opt = document.createElement("option");
      opt.value = id;
      wizModelsEl.appendChild(opt);
    }
  }
  // Local servers need no key and expose a context-size field instead.
  if (wizApiKeyFieldEl) wizApiKeyFieldEl.hidden = meta.local;
  if (wizContextFieldEl) wizContextFieldEl.hidden = !meta.local;
  if (wizKeyHintEl) {
    wizKeyHintEl.hidden = !meta.keyUrl;
    if (meta.keyUrl) wizKeyHintEl.textContent = `get an API key → ${meta.keyUrl.replace(/^https:\/\//, "")}`;
  }
  if (wizNoteEl) {
    wizNoteEl.textContent = meta.local
      ? "No API key needed. Magentra writes the connection to .magentra/settings.json and talks to your local server."
      : "The key is written to .env beside your code and never leaves this machine.";
  }
  wizConnectionChanged();
  if (preset === "custom") wizBaseUrlEl.focus();
}

if (wizKeyHintEl) {
  wizKeyHintEl.addEventListener("click", () => {
    const meta = WIZ_PRESETS[currentWizPreset] || WIZ_PRESETS.custom;
    if (meta.keyUrl && window.magentra.openExternal) window.magentra.openExternal(meta.keyUrl);
  });
}

// The datalist and key hint are preset-driven — populate them for the default
// preset now, not only after the first preset click.
applyWizPreset(currentWizPreset);

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
  openModalA11y(setupWizardEl, meta.local ? wizBaseUrlEl : wizApiKeyEl);
}

if (window.magentra.onSetupRequired && setupWizardEl) {
  window.magentra.onSetupRequired(() => {
    // No credentials: the composer stays locked (a prompt would go into a
    // dead engine) until session_started proves the connection works.
    engineLinked = false;
    syncActivityUi();
    openSetupWizard();
  });
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

/** Turn a testConnection result into a message that names the actual problem
 * instead of one catch-all guess. */
function describeTestFailure(result) {
  if (result && result.error) return result.error;
  const status = result && result.status;
  if (status === 401 || status === 403) return `key rejected by the provider (${status})`;
  if (status === 404) return "endpoint not found (404) — check the base URL";
  if (typeof status === "number") return `provider returned ${status}`;
  return "no response — check the URL (is the local server running?)";
}

// IGNITE without a successful TEST commits an unverified connection — the
// engine then fails on the first prompt instead. Track whether the current
// field values have passed TEST; the first untested IGNITE warns, a second
// deliberately proceeds anyway (offline setup stays possible).
let wizTestedOkFor = null;
let wizIgniteArmed = false;

function wizPayloadKey(payload) {
  return JSON.stringify([payload.baseUrl, payload.apiKey, payload.model, payload.provider]);
}

function wizConnectionChanged() {
  wizTestedOkFor = null;
  wizIgniteArmed = false;
}
[wizBaseUrlEl, wizApiKeyEl, wizModelEl].forEach((el) => {
  if (el) el.addEventListener("input", wizConnectionChanged);
});

if (wizTestBtnEl) {
  wizTestBtnEl.addEventListener("click", async () => {
    wizStatusEl.textContent = "testing…";
    wizStatusEl.className = "";
    if (!window.magentra.testConnection) return;
    const payload = wizPayload();
    let result = null;
    try {
      result = await window.magentra.testConnection(payload);
    } catch {
      result = null;
    }
    if (result && result.ok) {
      wizTestedOkFor = wizPayloadKey(payload);
      wizStatusEl.textContent = "link established";
      wizStatusEl.className = "ok";
      // The endpoint just told us its real catalog — replace the preset's
      // static suggestion list (an Ollama user sees their local models).
      if (Array.isArray(result.models) && result.models.length > 0 && wizModelsEl) {
        wizModelsEl.textContent = "";
        for (const id of result.models.slice(0, 100)) {
          const opt = document.createElement("option");
          opt.value = id;
          wizModelsEl.appendChild(opt);
        }
        if (!wizModelEl.value.trim()) wizModelEl.value = result.models[0];
      }
    } else {
      wizStatusEl.textContent = describeTestFailure(result);
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
    if (currentWizPreset === "custom" && !wizBaseUrlEl.value.trim()) {
      wizStatusEl.textContent = "base URL required";
      wizStatusEl.className = "err";
      return;
    }
    if (!wizModelEl.value.trim()) {
      wizStatusEl.textContent = "model required — pick one from the list or type an id";
      wizStatusEl.className = "err";
      return;
    }

    const payload = wizPayload();
    if (wizTestedOkFor !== wizPayloadKey(payload) && !wizIgniteArmed) {
      wizIgniteArmed = true;
      wizStatusEl.textContent = "untested — click TEST first, or IGNITE again to proceed anyway";
      wizStatusEl.className = "err";
      return;
    }

    if (!window.magentra.writeEnv) return;
    let result = null;
    try {
      result = await window.magentra.writeEnv(payload);
    } catch (err) {
      wizStatusEl.textContent = (err && err.message) || "failed to save connection";
      wizStatusEl.className = "err";
      return;
    }
    if (result && result.ok) {
      setupWizardEl.classList.add("hidden");
      closeModalA11y();
      wizApiKeyEl.value = "";
      wizConnectionChanged();
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
      setConnStatusEl.textContent = describeTestFailure(result);
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
