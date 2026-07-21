// First-run setup wizard and the connection settings card.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// First-run setup wizard
// ---------------------------------------------------------------------------

// Three connection shapes, all OpenAI-compatible — no provider branding. CUSTOM
// is any endpoint you type a base URL for (a hosted API, a LAN box, a gateway);
// OLLAMA and LM STUDIO are the two common local servers, pre-filled with their
// default ports and auto-detected on the machine (a missing one grays out).
// `detect` names the key openConnectionsWizard's local-server probe reports on.
const WIZ_PRESETS = {
  custom: { url: "", provider: "openai-compat", model: "", models: [], keyUrl: "", local: false },
  ollama: {
    url: "http://localhost:11434/v1",
    provider: "openai-compat",
    model: "",
    models: ["qwen3:8b", "qwen2.5-coder:7b", "llama3.1:8b"],
    keyUrl: "",
    local: true,
    detect: "ollama",
  },
  lmstudio: {
    url: "http://localhost:1234/v1",
    provider: "openai-compat",
    model: "",
    models: [],
    keyUrl: "",
    local: true,
    detect: "lmstudio",
  },
};

let currentWizPreset = "custom";

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
      ? "No API key needed for a local server. Saved as a profile in ~/.magentra (owner-only); connecting also writes .magentra/settings.json in the workspace."
      : "Key optional — leave it empty for keyless servers, or paste one for a hosted endpoint. Saved to the profile in ~/.magentra (owner-only), and to the workspace .env on connect.";
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

// The connections wizard runs in two modes. "apply" — a workspace is open, so
// a saved profile can be applied to it (USE) and a fresh build both saves and
// connects. "manage" — no workspace (the welcome page), so profiles can only be
// built/saved; nothing to connect to yet.
let wizMode = "apply";
let wizProfiles = []; // sanitized profiles from main (never the raw key)
let wizEditingId = null; // id of the profile loaded into the form, or null for a fresh build

/** Reflect a preset choice in both the button row and the fields. Extracted so
 * loading a saved profile can drive the same path a preset click does. */
function selectWizPreset(preset) {
  wizPresetEls.forEach((b) => b.classList.toggle("on", b.dataset.preset === preset));
  applyWizPreset(preset);
}

/** Back to a blank "new profile" build form. */
function resetWizForm() {
  wizEditingId = null;
  if (wizNameEl) wizNameEl.value = "";
  if (wizBuildHeadEl) wizBuildHeadEl.textContent = "＋ NEW PROFILE";
  if (wizApiKeyEl) wizApiKeyEl.placeholder = "paste your key — kept in the profile and this workspace";
}

/** Load a saved profile into the build form for editing / re-saving. */
function loadProfileIntoForm(p) {
  wizEditingId = p.id;
  // Anthropic keeps its preset; anything else opens as custom so the saved base
  // URL and the self-signed opt-in it may need are both visible/editable.
  selectWizPreset(p.provider === "anthropic" ? "anthropic" : "custom");
  if (wizNameEl) wizNameEl.value = p.name;
  if (p.baseUrl) wizBaseUrlEl.value = p.baseUrl;
  if (p.model) wizModelEl.value = p.model;
  if (wizContextEl) wizContextEl.value = p.contextWindow || "";
  if (wizInsecureEl) wizInsecureEl.checked = p.allowInsecureTls === true;
  if (wizApiKeyEl) {
    wizApiKeyEl.value = "";
    wizApiKeyEl.placeholder = p.hasKey ? "leave empty to keep the saved key" : "no key — add one if the endpoint needs it";
  }
  if (wizBuildHeadEl) wizBuildHeadEl.textContent = `EDIT — ${p.name}`;
  wizConnectionChanged();
  if (wizNameEl) wizNameEl.focus();
}

/** Draw the saved-profile list. USE is offered only in apply mode; delete and
 * click-to-edit are always available. */
function renderWizProfiles() {
  if (!wizProfilesListEl || !wizProfilesEl) return;
  wizProfilesListEl.textContent = "";
  if (!wizProfiles.length) {
    wizProfilesEl.hidden = true;
    return;
  }
  wizProfilesEl.hidden = false;
  for (const p of wizProfiles) {
    const row = document.createElement("div");
    row.className = "wiz-profile-row";
    const info = document.createElement("button");
    info.type = "button";
    info.className = "wiz-profile-info";
    info.title = "Edit this profile";
    const name = document.createElement("span");
    name.className = "wiz-profile-name";
    name.textContent = p.name;
    const meta = document.createElement("span");
    meta.className = "wiz-profile-meta";
    const endpoint = p.baseUrl
      ? p.baseUrl.replace(/^https?:\/\//, "")
      : (p.provider === "anthropic" ? "anthropic.com" : "deepinfra");
    meta.textContent = `${p.model || "—"} · ${endpoint}${p.hasKey ? "" : " · keyless"}`;
    info.append(name, meta);
    info.addEventListener("click", () => loadProfileIntoForm(p));
    row.appendChild(info);
    if (wizMode === "apply") {
      const use = document.createElement("button");
      use.type = "button";
      use.className = "wiz-profile-use";
      use.textContent = "USE ▸";
      use.addEventListener("click", () => void useProfile(p.id));
      row.appendChild(use);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "wiz-profile-del";
    del.title = "Delete profile";
    del.setAttribute("aria-label", `Delete profile ${p.name}`);
    del.textContent = "🗑";
    del.addEventListener("click", () => void deleteProfileRow(p.id));
    row.appendChild(del);
    wizProfilesListEl.appendChild(row);
  }
}

async function refreshWizProfiles() {
  if (!window.magentra.listProfiles) {
    wizProfiles = [];
    renderWizProfiles();
    return;
  }
  try {
    wizProfiles = (await window.magentra.listProfiles()) || [];
  } catch {
    wizProfiles = [];
  }
  renderWizProfiles();
}

/** Gray out the OLLAMA / LM STUDIO presets that are not present on the machine,
 * with a hover note saying so. A disabled button cannot be clicked, so the user
 * can never pick a local server that is not there. `custom` is always enabled. */
function applyLocalDetection(detection) {
  wizPresetEls.forEach((btn) => {
    const meta = WIZ_PRESETS[btn.dataset.preset];
    if (!meta || !meta.detect) return; // custom — always available
    const info = detection && detection[meta.detect];
    const available = Boolean(info && info.available);
    btn.disabled = !available;
    btn.classList.toggle("wiz-preset-off", !available);
    btn.title = available ? "" : (info && info.reason) || "not found on this PC";
  });
}

async function refreshLocalDetection() {
  if (!window.magentra.detectLocalServers) return;
  let detection = null;
  try {
    detection = await window.magentra.detectLocalServers();
  } catch {
    detection = null;
  }
  applyLocalDetection(detection);
}

/** Sync the copy and the primary button to the active mode. */
function applyWizModeUi() {
  const manage = wizMode === "manage";
  if (wizSubEl) {
    wizSubEl.textContent = manage
      ? "Build reusable connection profiles. They're offered whenever you open a workspace that has no connection yet."
      : "Pick a saved profile to connect this workspace, or build a new one below.";
  }
  // Nothing to connect to in manage mode — only saving makes sense there.
  if (wizStartBtnEl) wizStartBtnEl.hidden = manage;
}

/** Open the connections wizard. `mode` defaults to apply when a workspace is
 * open (connect it) and manage otherwise (welcome page). Also the fallback the
 * failure banner and the dock button use. */
async function openConnectionsWizard(mode) {
  if (!setupWizardEl) return;
  wizMode = mode || (activeWorkspace ? "apply" : "manage");
  resetWizForm();
  applyWizModeUi();
  await refreshWizProfiles();
  await refreshLocalDetection();
  if (wizStatusEl) {
    wizStatusEl.textContent = "";
    wizStatusEl.className = "";
  }
  setupWizardEl.classList.remove("hidden");
  openModalA11y(setupWizardEl, wizNameEl || wizBaseUrlEl);
}

// Preserved name: the engine-failure banner (events.js) opens the wizard to
// connect the current workspace.
function openSetupWizard() {
  void openConnectionsWizard("apply");
}

if (navSetupConnEl) navSetupConnEl.addEventListener("click", () => void openConnectionsWizard());
if (welcomeSetupConnBtnEl) welcomeSetupConnBtnEl.addEventListener("click", () => void openConnectionsWizard("manage"));

/** Apply a saved profile to the current workspace and connect. */
async function useProfile(id) {
  if (!window.magentra.applyProfile || !wizStatusEl) return;
  wizStatusEl.textContent = "connecting…";
  wizStatusEl.className = "";
  let res = null;
  try {
    res = await window.magentra.applyProfile(id);
  } catch {
    res = null;
  }
  if (res && res.ok) {
    // The engine is restarting on the new connection; session_started relinks.
    engineLinked = false;
    syncActivityUi();
    setupWizardEl.classList.add("hidden");
    closeModalA11y();
    maybeStartTour();
  } else {
    wizStatusEl.textContent = (res && res.error) || "failed to connect";
    wizStatusEl.className = "err";
  }
}

/** Save the build form as a global profile. Returns the profile id, or null on
 * validation/save failure (status already shown). */
async function saveWizProfile() {
  if (!wizNameEl || !window.magentra.saveProfile) return null;
  const name = wizNameEl.value.trim();
  if (!name) {
    wizStatusEl.textContent = "profile name required";
    wizStatusEl.className = "err";
    wizNameEl.focus();
    return null;
  }
  const payload = { ...wizPayload(), name, ...(wizEditingId ? { id: wizEditingId } : {}) };
  let res = null;
  try {
    res = await window.magentra.saveProfile(payload);
  } catch {
    res = null;
  }
  if (res && res.ok) {
    wizProfiles = res.profiles || [];
    renderWizProfiles();
    wizStatusEl.textContent = "profile saved";
    wizStatusEl.className = "ok";
    // Return to a blank "new profile" form so the NEXT save creates another
    // profile instead of silently overwriting the one just saved — the bug
    // where a second save made the first disappear. Editing an existing one is
    // a deliberate act (click its row); it should not persist across saves.
    resetWizForm();
    return res.id;
  }
  wizStatusEl.textContent = (res && res.error) || "failed to save profile";
  wizStatusEl.className = "err";
  return null;
}

async function deleteProfileRow(id) {
  if (!window.magentra.deleteProfile) return;
  let res = null;
  try {
    res = await window.magentra.deleteProfile(id);
  } catch {
    res = null;
  }
  if (res && res.ok) {
    wizProfiles = res.profiles || [];
    renderWizProfiles();
    if (wizEditingId === id) resetWizForm();
  }
}

if (wizSaveProfileBtnEl) wizSaveProfileBtnEl.addEventListener("click", () => void saveWizProfile());

// A fresh preset click means "build something new" — drop any profile being
// edited so the next save creates a profile instead of overwriting one.
wizPresetEls.forEach((btn) => btn.addEventListener("click", () => {
  wizEditingId = null;
  if (wizBuildHeadEl) wizBuildHeadEl.textContent = "＋ NEW PROFILE";
}));

if (window.magentra.onSetupRequired && setupWizardEl) {
  window.magentra.onSetupRequired(() => {
    // No credentials: the composer stays locked (a prompt would go into a
    // dead engine) until session_started proves the connection works.
    engineLinked = false;
    syncActivityUi();
    void openConnectionsWizard("apply");
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
    // Every shape is key-optional (a server that needs one rejects with a 401
    // the user sees). Custom needs a base URL — a local preset already has one.
    if (!meta.local && !wizBaseUrlEl.value.trim()) {
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
      wizStatusEl.textContent = "untested — click TEST first, or SAVE & CONNECT again to proceed anyway";
      wizStatusEl.className = "err";
      return;
    }

    // Save the profile globally, then apply that exact profile to the workspace
    // — so what connects is always what was saved.
    const id = await saveWizProfile();
    if (!id || !window.magentra.applyProfile) return;
    let result = null;
    try {
      result = await window.magentra.applyProfile(id);
    } catch (err) {
      wizStatusEl.textContent = (err && err.message) || "failed to connect";
      wizStatusEl.className = "err";
      return;
    }
    if (result && result.ok) {
      engineLinked = false;
      syncActivityUi();
      setupWizardEl.classList.add("hidden");
      closeModalA11y();
      if (wizApiKeyEl) wizApiKeyEl.value = "";
      wizConnectionChanged();
      maybeStartTour();
    } else {
      wizStatusEl.textContent = (result && result.error) || "failed to connect";
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
