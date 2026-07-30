// Addons view: every installed addon, what it is for, and how to invoke it,
// plus the describe-to-install create-addon wizard.
//
// There is nothing to toggle. An addon is always available; only its name and
// description sit in the system prompt, and its body is loaded when the agent
// invokes it (or the user types /<name>). So this view is a catalogue, not a
// control panel.
//
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Addons view
// ---------------------------------------------------------------------------

/** The engine's slug rule, mirrored so a card can name its export file the same
 * way install_addon wrote it. */
function addonSlug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

// Export is a round-trip: the button asks the engine for the addon's .md text
// (export_addon → addon_export), then main saves it via a dialog. The engine
// sources the text — including built-ins — so EVERY addon exports, not only
// on-disk ones. Pending buttons are tracked by name so the reply lands back on
// the right one.
const pendingAddonExports = new Map();

/** A "⇩ Export" button that saves the addon's .md to a location the user picks. */
function makeAddonExportButton(name, label) {
  const btn = document.createElement("button");
  btn.className = "addon-export-btn";
  btn.textContent = "⇩ Export";
  btn.title = `Save ${label} as a .md file`;
  btn.setAttribute("aria-label", `Export ${label}`);
  btn.addEventListener("click", () => {
    if (!window.magentra.send) return;
    btn.disabled = true;
    btn.dataset.original = "⇩ Export";
    btn.textContent = "…";
    pendingAddonExports.set(name, btn);
    window.magentra.send({ type: "export_addon", name });
  });
  return btn;
}

async function onAddonExport(event) {
  const btn = pendingAddonExports.get(event.name);
  if (!btn) return;
  pendingAddonExports.delete(event.name);
  const original = btn.dataset.original || "⇩ Export";
  const settle = (text) => {
    btn.disabled = false;
    btn.textContent = text;
    setTimeout(() => {
      btn.textContent = original;
    }, 2200);
  };
  if (!event.ok) {
    announce(`Export failed: ${event.error || "error"}`);
    appendSysNote(`export failed for ${event.name}: ${event.error || "unknown error"}`);
    settle("Failed");
    return;
  }
  let res = null;
  try {
    res = await window.magentra.saveAddonExport({ filename: event.filename, text: event.text });
  } catch {
    res = null;
  }
  if (res && res.canceled) {
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  if (res && res.ok) {
    announce(`Exported ${event.name}.`);
    settle("Exported ✓");
  } else {
    announce(`Export failed: ${(res && res.error) || "error"}`);
    settle("Failed");
  }
}

function renderAddonCard(addon) {
  const card = document.createElement("div");
  card.className = "addon-card";

  const head = document.createElement("div");
  head.className = "addon-card-head";
  const name = document.createElement("span");
  name.className = "addon-name";
  name.textContent = `/${addon.name}`;
  head.appendChild(name);
  if (addon.builtin) {
    const src = document.createElement("span");
    src.className = "addon-badge";
    src.textContent = "built-in";
    head.appendChild(src);
  } else {
    const src = document.createElement("span");
    src.className = "addon-source";
    src.textContent = "workspace";
    head.appendChild(src);
  }
  card.appendChild(head);

  const desc = document.createElement("p");
  desc.className = "addon-desc";
  desc.textContent = addon.description || addon.name;
  card.appendChild(desc);

  const foot = document.createElement("div");
  foot.className = "addon-foot";
  const hint = document.createElement("span");
  hint.className = "addon-hint";
  hint.textContent = `the agent loads this on demand — or type /${addon.name}`;
  foot.append(hint, makeAddonExportButton(addonSlug(addon.name), addon.name));
  card.appendChild(foot);

  return card;
}

function renderAddonsView() {
  if (!addonsListEl) return;
  addonsListEl.textContent = "";

  if (addonsSubEl) {
    addonsSubEl.textContent =
      addons.length === 0 ? "no addons installed" : `${addons.length} installed · always available`;
  }

  if (addons.length === 0) return;

  const grid = document.createElement("div");
  grid.className = "addons-grid";
  for (const addon of [...addons].sort((a, b) => a.name.localeCompare(b.name))) {
    grid.appendChild(renderAddonCard(addon));
  }
  addonsListEl.appendChild(grid);
}

/** Dock badge + chip + view together — call after any addon state change. */
function renderAddonsSurfaces() {
  if (dockAddonsCountEl) {
    dockAddonsCountEl.textContent = String(addons.length);
    dockAddonsCountEl.classList.toggle("hidden", addons.length === 0);
  }
  renderAddonChip();
  renderAddonsView();
}

if (navAddonsEl) navAddonsEl.addEventListener("click", () => showView("addons"));
if (addonsCloseBtnEl) addonsCloseBtnEl.addEventListener("click", () => showView("console"));

// ---------------------------------------------------------------------------
// Create-addon wizard: describe → engine generates + validates → editable
// preview → install (engine re-validates, writes, reloads the roster).
// ---------------------------------------------------------------------------

let addonWizardWaiting = false;
let addonDraftFilename = "addon.md";

/** Fill the wizard's "Author with" picker: the current connection's models
 * (default = the session model, upgradeable for a better draft), then any saved
 * connection profiles — choosing one authors with that different provider. */
function populateAddonModelSelect() {
  if (!addonModelSelectEl || !modelSelectEl) return;
  const current = activeModel || modelSelectEl.value;
  addonModelSelectEl.textContent = "";
  const seen = new Set();
  const modelGroup = document.createElement("optgroup");
  modelGroup.label = "This workspace's connection";
  for (const opt of modelSelectEl.options) {
    if (opt.value === "__custom__" || seen.has(opt.value)) continue;
    seen.add(opt.value);
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.textContent;
    modelGroup.appendChild(o);
  }
  if (current && !seen.has(current)) {
    const o = document.createElement("option");
    o.value = current;
    o.textContent = shortModelLabel(current);
    modelGroup.appendChild(o);
    seen.add(current);
  }
  addonModelSelectEl.appendChild(modelGroup);
  if (current) addonModelSelectEl.value = current;
  void appendAddonProfileOptions();
}

/** Append saved connection profiles to the picker (each = a different provider),
 * and tune the hint depending on whether any exist. */
async function appendAddonProfileOptions() {
  let profiles = [];
  if (window.magentra.listProfiles) {
    try {
      profiles = (await window.magentra.listProfiles()) || [];
    } catch {
      profiles = [];
    }
  }
  if (addonModelSelectEl && profiles.length) {
    const group = document.createElement("optgroup");
    group.label = "Saved profiles — different provider";
    for (const p of profiles) {
      const o = document.createElement("option");
      o.value = `profile:${p.id}`;
      o.textContent = `${p.name} · ${p.model || "—"}`;
      group.appendChild(o);
    }
    addonModelSelectEl.appendChild(group);
  }
  if (addonModelHintEl) {
    addonModelHintEl.textContent = profiles.length
      ? "Author with your workspace's model, or pick a saved profile to use a different provider."
      : "Uses your workspace connection. Save a connection profile (⇆ Connect) to author with a different provider.";
  }
}

function openAddonWizard() {
  if (!addonWizardEl) return;
  addonWizStep1El.classList.remove("hidden");
  addonWizStep2El.classList.add("hidden");
  addonWizStatusEl.textContent = "";
  addonWizStatus2El.textContent = "";
  if (addonContextInputEl) addonContextInputEl.value = "";
  populateAddonModelSelect();
  addonWizardEl.classList.remove("hidden");
  openModalA11y(addonWizardEl, addonDescInputEl);
}

function closeAddonWizard() {
  if (!addonWizardEl) return;
  addonWizardEl.classList.add("hidden");
  closeModalA11y();
}

function setAddonWizardWaiting(waiting) {
  addonWizardWaiting = waiting;
  addonWizGenerateEl.disabled = waiting;
  addonWizStatusEl.textContent = waiting ? "generating… (the engine is writing your addon)" : "";
}

function onAddonDraft(event) {
  if (!addonWizardWaiting) return; // stale/unsolicited draft
  setAddonWizardWaiting(false);
  if (!event.ok) {
    addonWizStatusEl.textContent = event.error || "Generation failed — try a more specific description.";
    return;
  }
  addonDraftFilename = event.suggestedFilename || "addon.md";
  addonWizFileEl.textContent = addonDraftFilename;
  addonDraftTextEl.value = event.text || "";
  addonWizStep1El.classList.add("hidden");
  addonWizStep2El.classList.remove("hidden");
  addonDraftTextEl.focus();
}

if (addonCreateBtnEl) addonCreateBtnEl.addEventListener("click", openAddonWizard);
if (addonWizCancelEl) addonWizCancelEl.addEventListener("click", closeAddonWizard);
if (addonWizBackEl) {
  addonWizBackEl.addEventListener("click", () => {
    addonWizStep2El.classList.add("hidden");
    addonWizStep1El.classList.remove("hidden");
  });
}
if (addonWizGenerateEl) {
  addonWizGenerateEl.addEventListener("click", async () => {
    const description = addonDescInputEl.value.trim();
    if (!description) {
      addonWizStatusEl.textContent = "Describe the addon first.";
      return;
    }
    if (!engineLinked) {
      addonWizStatusEl.textContent = "Engine not linked — open a workspace / set up a connection first.";
      return;
    }
    setAddonWizardWaiting(true);
    const payload = { description };
    const context = addonContextInputEl && addonContextInputEl.value.trim();
    if (context) payload.context = context;
    // "profile:<id>" authors with that saved profile's provider (main resolves
    // the key); a bare value is a model on the current connection.
    const sel = addonModelSelectEl && addonModelSelectEl.value;
    if (sel && sel.startsWith("profile:")) payload.profileId = sel.slice("profile:".length);
    else if (sel) payload.model = sel;
    let res = null;
    try {
      res = await window.magentra.generateAddon(payload);
    } catch {
      res = null;
    }
    // A refusal (no engine, no profile) comes back synchronously; a success is
    // followed asynchronously by the addon_draft event that clears waiting.
    if (res && res.ok === false) {
      setAddonWizardWaiting(false);
      addonWizStatusEl.textContent = res.error || "could not start generation";
    }
  });
}
if (addonWizInstallEl) {
  addonWizInstallEl.addEventListener("click", () => {
    const text = addonDraftTextEl.value;
    if (!text.trim()) {
      addonWizStatus2El.textContent = "The draft is empty.";
      return;
    }
    window.magentra.send({ type: "install_addon", filename: addonDraftFilename, text });
    closeAddonWizard();
    showView("addons");
    announce(`Installing the ${addonDraftFilename} addon.`);
  });
}
