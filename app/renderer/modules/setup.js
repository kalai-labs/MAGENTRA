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
  // Custom endpoints: full-URL paste hint + the self-signed TLS opt-in.
  if (wizBaseUrlHintEl) wizBaseUrlHintEl.hidden = preset !== "custom";
  if (wizInsecureRowEl) {
    wizInsecureRowEl.hidden = preset !== "custom";
    if (preset !== "custom" && wizInsecureEl) wizInsecureEl.checked = false;
  }
  if (wizKeyHintEl) {
    wizKeyHintEl.hidden = !meta.keyUrl;
    if (meta.keyUrl) wizKeyHintEl.textContent = `get an API key → ${meta.keyUrl.replace(/^https:\/\//, "")}`;
  }
  if (wizNoteEl) {
    wizNoteEl.textContent = meta.local
      ? "No API key needed. Magentra writes the connection to .magentra/settings.json and talks to your local server."
      : preset === "custom"
        ? "Key optional — leave it empty for keyless servers. TEST fetches the server's model list when it has one."
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

// TEST-before-IGNITE state. Declared BEFORE the load-time applyWizPreset call
// below: applyWizPreset runs wizConnectionChanged, and touching these while
// still in their temporal dead zone threw at script load — killing every
// listener declared after it (TEST, SAVE, IGNITE all went dead).
let wizTestedOkFor = null;
let wizIgniteArmed = false;

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
  if (currentWizPreset === "custom" && wizInsecureEl && wizInsecureEl.checked) payload.insecureTls = true;
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
// engine then fails on the first prompt instead. wizTestedOkFor/wizIgniteArmed
// (declared above the load-time applyWizPreset call) track whether the current
// field values have passed TEST; the first untested IGNITE warns, a second
// deliberately proceeds anyway (offline setup stays possible).
function wizPayloadKey(payload) {
  return JSON.stringify([payload.baseUrl, payload.apiKey, payload.model, payload.provider, payload.insecureTls === true]);
}

function wizConnectionChanged() {
  wizTestedOkFor = null;
  wizIgniteArmed = false;
}
[wizBaseUrlEl, wizApiKeyEl, wizModelEl].forEach((el) => {
  if (el) el.addEventListener("input", wizConnectionChanged);
});
if (wizInsecureEl) wizInsecureEl.addEventListener("change", wizConnectionChanged);

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
      // TEST probes the normalized base (a pasted ".../chat/completions" is
      // reduced) — reflect what will actually be saved, and keep the tested-ok
      // marker valid for the updated field value.
      if (result.baseUrl && wizBaseUrlEl.value.trim() !== result.baseUrl) {
        wizBaseUrlEl.value = result.baseUrl;
      }
      wizTestedOkFor = wizPayloadKey(wizPayload());
      // A note flags a reachable-but-quirky endpoint (e.g. no /models catalog).
      wizStatusEl.textContent = result.note || "link established";
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
    // A key is mandatory only where it cannot work without one: Anthropic and
    // the default hosted preset. Custom endpoints are key-optional — a server
    // that wants one will reject TEST/the first turn with a 401 the user sees.
    if (!meta.local && currentWizPreset !== "custom" && !wizApiKeyEl.value.trim()) {
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
      maybeStartTour();
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

// The card reflects what is saved, refreshed every time settings opens (the
// wizard or another surface may have changed the connection meanwhile).
if (navSettingsEl) {
  navSettingsEl.addEventListener("click", () => void loadConnectionCard());
}

// Whether the current workspace has a key saved in .env (connection:info).
// The key field itself stays empty until revealed — SAVE/TEST with an empty
// field then mean "keep/use the saved key", never "wipe it".
let savedKeyExists = false;

/** Fill the connection card from what is actually saved for this workspace. */
async function loadConnectionCard() {
  if (!window.magentra.connectionInfo || !setBaseUrlEl) return;
  let info = null;
  try {
    info = await window.magentra.connectionInfo();
  } catch {
    return;
  }
  if (!info) return;
  savedKeyExists = info.hasKey === true;
  if (info.baseUrl && !setBaseUrlEl.value) setBaseUrlEl.value = info.baseUrl;
  if (info.model && setModelDefaultEl && !setModelDefaultEl.value) setModelDefaultEl.value = info.model;
  if (info.contextWindow && setContextEl && !setContextEl.value) setContextEl.value = info.contextWindow;
  if (setInsecureEl) setInsecureEl.checked = info.allowInsecureTls === true;
  setApiKeyEl.placeholder = savedKeyExists ? "●●●●●●●● saved — ◉ reveals" : "no key saved yet";
}

if (setKeyRevealEl) {
  setKeyRevealEl.addEventListener("click", async () => {
    // Reveal means reveal: an empty field pulls the actual saved key first
    // (it is the user's own workspace .env), then the button toggles masking.
    if (setApiKeyEl.value === "" && window.magentra.revealKey) {
      try {
        const res = await window.magentra.revealKey();
        if (res && res.key) {
          setApiKeyEl.value = res.key;
          setApiKeyEl.type = "text";
          return;
        }
        setConnStatusEl.textContent = "no key saved for this workspace yet";
        setConnStatusEl.className = "";
        return;
      } catch {
        // fall through to the plain toggle
      }
    }
    setApiKeyEl.type = setApiKeyEl.type === "password" ? "text" : "password";
  });
}

if (setTestBtnEl) {
  setTestBtnEl.addEventListener("click", async () => {
    setConnStatusEl.textContent = "testing…";
    setConnStatusEl.className = "";
    if (!window.magentra.testConnection) return;
    const baseUrl = setBaseUrlEl.value.trim();
    const typedKey = setApiKeyEl.value.trim();
    setTestBtnEl.disabled = true;
    let result = null;
    try {
      result = await window.magentra.testConnection({
        baseUrl,
        apiKey: typedKey,
        model: setModelDefaultEl.value.trim(),
        provider: inferProvider(baseUrl),
        ...(setInsecureEl && setInsecureEl.checked ? { insecureTls: true } : {}),
        // Empty field + saved key = "test the connection I have".
        ...(typedKey === "" && savedKeyExists ? { useSavedKey: true } : {}),
      });
    } catch {
      result = null;
    } finally {
      setTestBtnEl.disabled = false;
    }
    if (result && result.ok) {
      setConnStatusEl.textContent = result.note || "link established ✓";
      setConnStatusEl.className = "ok";
    } else {
      setConnStatusEl.textContent = describeTestFailure(result);
      setConnStatusEl.className = "err";
    }
  });
}

if (setSaveBtnEl) {
  setSaveBtnEl.addEventListener("click", async () => {
    const apiKey = setApiKeyEl.value.trim();
    const baseUrl = setBaseUrlEl.value.trim();
    const keepSaved = apiKey === "" && savedKeyExists;
    // Key requirements live in one place — the main process validator; its
    // error ("apiKey is required for the default hosted endpoint") shows below.
    if (!window.magentra.writeEnv) return;
    let result = null;
    try {
      result = await window.magentra.writeEnv({
        baseUrl,
        apiKey,
        model: setModelDefaultEl.value.trim(),
        provider: inferProvider(baseUrl),
        ...(setInsecureEl && setInsecureEl.checked ? { insecureTls: true } : {}),
        ...(keepSaved ? { useSavedKey: true } : {}),
        ...(setContextEl && setContextEl.value ? { contextWindow: setContextEl.value } : {}),
      });
    } catch (err) {
      setConnStatusEl.textContent = (err && err.message) || "failed to save connection";
      setConnStatusEl.className = "err";
      return;
    }
    if (result && result.ok) {
      setApiKeyEl.value = "";
      setApiKeyEl.type = "password";
      // A key only lands in .env when one was typed; keyless saves (local or
      // custom endpoints) live entirely in settings.json.
      savedKeyExists = savedKeyExists || apiKey !== "";
      setApiKeyEl.placeholder = savedKeyExists ? "●●●●●●●● saved — ◉ reveals" : "no key saved yet";
      setConnStatusEl.textContent = keepSaved
        ? "saved (existing key kept) — engine restarted"
        : apiKey === ""
          ? "saved to workspace settings — engine restarted"
          : "written to workspace .env — engine restarted";
      setConnStatusEl.className = "ok";
    } else {
      setConnStatusEl.textContent = (result && result.error) || "failed to write .env";
      setConnStatusEl.className = "err";
    }
  });
}
