// Skills view: every discipline (toggleable, none locked) and on-demand action
// skill in the workspace, with Recommended badges, "?" explainers, a one-click
// recommended set, and the describe-to-install create-skill wizard.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// On-demand action skills, from session_started / skills_updated.
let actionSkills = [];

// ---------------------------------------------------------------------------
// Skills view
// ---------------------------------------------------------------------------

function activeSkillIds() {
  return modes.filter((m) => m.active).map((m) => m.id);
}

/** One shared toggle path: desired active set → engine set_modes. */
function setSkillActive(id, on) {
  const desired = on ? [...new Set([...activeSkillIds(), id])] : activeSkillIds().filter((x) => x !== id);
  pendingModesNote = true;
  window.magentra.setModes(desired);
  // Optimistic paint; the next modes_updated confirms or corrects.
  const mode = modes.find((m) => m.id === id);
  if (mode) mode.active = on;
  renderSkillsSurfaces();
}

function renderSkillCard(mode) {
  const card = document.createElement("div");
  card.className = "skill-card" + (mode.active ? " on" : "");

  const head = document.createElement("div");
  head.className = "skill-card-head";

  const name = document.createElement("span");
  name.className = "skill-name";
  name.textContent = mode.name;
  head.appendChild(name);

  if (mode.recommended) {
    const badge = document.createElement("span");
    badge.className = "skill-badge";
    badge.textContent = "★ Recommended";
    head.appendChild(badge);
  }
  if (!mode.builtin) {
    const src = document.createElement("span");
    src.className = "skill-source";
    src.textContent = "workspace";
    head.appendChild(src);
  }

  const whyBtn = document.createElement("button");
  whyBtn.className = "skill-why-btn";
  whyBtn.textContent = "?";
  whyBtn.title = "Why enable this skill";
  whyBtn.setAttribute("aria-label", `Why enable ${mode.name}`);
  whyBtn.setAttribute("aria-expanded", "false");
  head.appendChild(whyBtn);

  const toggle = document.createElement("button");
  toggle.className = "skill-toggle" + (mode.active ? " on" : "");
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", mode.active ? "true" : "false");
  toggle.setAttribute("aria-label", `${mode.name} skill`);
  toggle.title = mode.active ? "Disable" : "Enable";
  const knob = document.createElement("span");
  knob.className = "skill-toggle-knob";
  toggle.appendChild(knob);
  toggle.addEventListener("click", () => setSkillActive(mode.id, !mode.active));
  head.appendChild(toggle);

  card.appendChild(head);

  const desc = document.createElement("p");
  desc.className = "skill-desc";
  desc.textContent = mode.description || mode.id;
  card.appendChild(desc);

  const why = document.createElement("div");
  why.className = "skill-why hidden";
  why.textContent = mode.why || mode.description || "No further notes for this skill.";
  card.appendChild(why);
  whyBtn.addEventListener("click", () => {
    const opening = why.classList.contains("hidden");
    why.classList.toggle("hidden", !opening);
    whyBtn.setAttribute("aria-expanded", opening ? "true" : "false");
  });

  if (mode.conflicts && mode.conflicts.length > 0) {
    const conflicts = document.createElement("div");
    conflicts.className = "skill-conflicts";
    conflicts.textContent = `Conflicts with ${mode.conflicts.join(", ")} — enabling this switches those off.`;
    card.appendChild(conflicts);
  }

  const foot = document.createElement("div");
  foot.className = "skill-foot";
  const idEl = document.createElement("code");
  idEl.textContent = mode.id;
  const kindEl = document.createElement("span");
  kindEl.className = "skill-kind";
  kindEl.textContent = mode.active ? "discipline · shaping every turn" : "discipline";
  foot.append(idEl, kindEl, makeSkillExportButton(mode.id, mode.name || mode.id));
  card.appendChild(foot);

  return card;
}

/** The engine's slug rule, mirrored so an action card (which carries only a
 * name) can name its file for export the same way install_skill wrote it. */
function skillSlug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

// Export is a round-trip: the button asks the engine for the skill's .md text
// (export_skill → skill_export), then main saves it via a dialog. The engine
// sources the text — including built-ins — so EVERY skill exports, not only
// on-disk ones (the old file-only path failed on built-ins). Pending buttons
// are tracked by id so the reply lands back on the right one.
const pendingSkillExports = new Map();

/** A "⇩ Export" button that saves the skill's .md to a location the user picks. */
function makeSkillExportButton(id, label) {
  const btn = document.createElement("button");
  btn.className = "skill-export-btn";
  btn.textContent = "⇩ Export";
  btn.title = `Save ${label} as a .md file`;
  btn.setAttribute("aria-label", `Export ${label}`);
  btn.addEventListener("click", () => {
    if (!window.magentra.send) return;
    btn.disabled = true;
    btn.dataset.original = "⇩ Export";
    btn.textContent = "…";
    pendingSkillExports.set(id, btn);
    window.magentra.send({ type: "export_skill", id });
  });
  return btn;
}

async function onSkillExport(event) {
  const btn = pendingSkillExports.get(event.id);
  if (!btn) return;
  pendingSkillExports.delete(event.id);
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
    appendSysNote(`export failed for ${event.id}: ${event.error || "unknown error"}`);
    settle("Failed");
    return;
  }
  let res = null;
  try {
    res = await window.magentra.saveSkillExport({ filename: event.filename, text: event.text });
  } catch {
    res = null;
  }
  if (res && res.canceled) {
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  if (res && res.ok) {
    announce(`Exported ${event.id}.`);
    settle("Exported ✓");
  } else {
    announce(`Export failed: ${(res && res.error) || "error"}`);
    settle("Failed");
  }
}

function renderActionSkillCard(skill) {
  const card = document.createElement("div");
  card.className = "skill-card action";
  const head = document.createElement("div");
  head.className = "skill-card-head";
  const name = document.createElement("span");
  name.className = "skill-name";
  name.textContent = skill.name;
  const tag = document.createElement("span");
  tag.className = "skill-kind-tag";
  tag.textContent = "on-demand";
  head.append(name, tag);
  card.appendChild(head);
  const desc = document.createElement("p");
  desc.className = "skill-desc";
  desc.textContent = skill.description || skill.name;
  card.appendChild(desc);
  const foot = document.createElement("div");
  foot.className = "skill-foot";
  const hint = document.createElement("span");
  hint.className = "skill-kind";
  hint.textContent = "invoked by the agent when the task calls for it";
  foot.append(hint, makeSkillExportButton(skillSlug(skill.name), skill.name));
  card.appendChild(foot);
  return card;
}

function renderSkillsView() {
  if (!skillsListEl) return;
  skillsListEl.textContent = "";

  const activeCount = modes.filter((m) => m.active).length;
  if (skillsSubEl) {
    const parts = [`${activeCount} of ${modes.length} disciplines active`];
    if (actionSkills.length > 0) parts.push(`${actionSkills.length} on-demand`);
    skillsSubEl.textContent = modes.length === 0 && actionSkills.length === 0 ? "no skills yet" : parts.join(" · ");
  }

  // One-click recommended set: shown until the whole set is already on.
  if (skillsRecommendBtnEl) {
    const recommended = modes.filter((m) => m.recommended);
    const missing = recommended.filter((m) => !m.active);
    skillsRecommendBtnEl.classList.toggle("hidden", recommended.length === 0 || missing.length === 0);
  }

  if (modes.length > 0) {
    const headRec = document.createElement("div");
    headRec.className = "skills-group-title";
    headRec.textContent = "DISCIPLINES — shape every turn while enabled";
    skillsListEl.appendChild(headRec);
    const grid = document.createElement("div");
    grid.className = "skills-grid";
    const ordered = [...modes].sort(
      (a, b) => Number(b.recommended || false) - Number(a.recommended || false) || a.name.localeCompare(b.name),
    );
    for (const mode of ordered) grid.appendChild(renderSkillCard(mode));
    skillsListEl.appendChild(grid);
  }

  if (actionSkills.length > 0) {
    const headAct = document.createElement("div");
    headAct.className = "skills-group-title";
    headAct.textContent = "ACTIONS — the agent runs these on demand";
    skillsListEl.appendChild(headAct);
    const grid = document.createElement("div");
    grid.className = "skills-grid";
    for (const skill of actionSkills) grid.appendChild(renderActionSkillCard(skill));
    skillsListEl.appendChild(grid);
  }
}

/** Dock badge + view + chips together — call after any skills state change. */
function renderSkillsSurfaces() {
  const activeCount = modes.filter((m) => m.active).length;
  if (dockSkillsCountEl) {
    dockSkillsCountEl.textContent = String(activeCount);
    dockSkillsCountEl.classList.toggle("hidden", activeCount === 0);
  }
  renderModeChips();
  renderSkillsView();
}

if (skillsRecommendBtnEl) {
  skillsRecommendBtnEl.addEventListener("click", () => {
    const recommendedIds = modes.filter((m) => m.recommended).map((m) => m.id);
    pendingModesNote = true;
    window.magentra.setModes([...new Set([...activeSkillIds(), ...recommendedIds])]);
    for (const m of modes) if (m.recommended) m.active = true;
    renderSkillsSurfaces();
  });
}
if (navSkillsEl) navSkillsEl.addEventListener("click", () => showView("skills"));
if (skillsCloseBtnEl) skillsCloseBtnEl.addEventListener("click", () => showView("console"));

// ---------------------------------------------------------------------------
// Create-skill wizard: describe → engine generates + validates → editable
// preview → install (engine re-validates, writes, reloads, enables).
// ---------------------------------------------------------------------------

let skillWizardKind = "discipline";
let skillWizardWaiting = false;
let skillDraftFilename = "skill.md";

/** Fill the wizard's "Author with" picker: the current connection's models
 * (default = the session model, upgradeable for a better draft), then any saved
 * connection profiles — choosing one authors with that different provider. */
function populateSkillModelSelect() {
  if (!skillModelSelectEl || !modelSelectEl) return;
  const current = activeModel || modelSelectEl.value;
  skillModelSelectEl.textContent = "";
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
  skillModelSelectEl.appendChild(modelGroup);
  if (current) skillModelSelectEl.value = current;
  void appendSkillProfileOptions();
}

/** Append saved connection profiles to the picker (each = a different provider),
 * and tune the hint depending on whether any exist. */
async function appendSkillProfileOptions() {
  let profiles = [];
  if (window.magentra.listProfiles) {
    try {
      profiles = (await window.magentra.listProfiles()) || [];
    } catch {
      profiles = [];
    }
  }
  if (skillModelSelectEl && profiles.length) {
    const group = document.createElement("optgroup");
    group.label = "Saved profiles — different provider";
    for (const p of profiles) {
      const o = document.createElement("option");
      o.value = `profile:${p.id}`;
      o.textContent = `${p.name} · ${p.model || "—"}`;
      group.appendChild(o);
    }
    skillModelSelectEl.appendChild(group);
  }
  if (skillModelHintEl) {
    skillModelHintEl.textContent = profiles.length
      ? "Author with your workspace's model, or pick a saved profile to use a different provider."
      : "Uses your workspace connection. Save a connection profile (⇆ Connect) to author with a different provider.";
  }
}

function syncSkillKindUi() {
  if (skillKindHintEl) skillKindHintEl.textContent = SKILL_KIND_HINTS[skillWizardKind];
}

// Kept in step with the inline #skillKindHint in index.html (the discipline text
// there is this one). Both explain the kind in plain terms + a concrete example,
// since "discipline vs action" is not self-evident to someone building one.
const SKILL_KIND_HINTS = {
  discipline:
    'Always-on while enabled: it shapes every turn — rules the agent follows, reminders it gets, even tool gates the engine enforces. e.g. "investigate before editing," or "always write a failing test before the fix."',
  action:
    'On-demand only: a named recipe the agent runs when a task calls for it, out of the way otherwise. e.g. a "cut a release" checklist, or "how to add a database migration in this repo."',
};

function openSkillWizard() {
  if (!skillWizardEl) return;
  skillWizStep1El.classList.remove("hidden");
  skillWizStep2El.classList.add("hidden");
  skillWizStatusEl.textContent = "";
  skillWizStatus2El.textContent = "";
  if (skillContextInputEl) skillContextInputEl.value = "";
  syncSkillKindUi();
  populateSkillModelSelect();
  skillWizardEl.classList.remove("hidden");
  openModalA11y(skillWizardEl, skillDescInputEl);
}

function closeSkillWizard() {
  if (!skillWizardEl) return;
  skillWizardEl.classList.add("hidden");
  closeModalA11y();
}

function setSkillWizardWaiting(waiting) {
  skillWizardWaiting = waiting;
  skillWizGenerateEl.disabled = waiting;
  skillWizStatusEl.textContent = waiting ? "generating… (the engine is writing your skill)" : "";
}

function onSkillDraft(event) {
  if (!skillWizardWaiting) return; // stale/unsolicited draft
  setSkillWizardWaiting(false);
  if (!event.ok) {
    skillWizStatusEl.textContent = event.error || "Generation failed — try a more specific description.";
    return;
  }
  skillDraftFilename = event.suggestedFilename || "skill.md";
  skillWizFileEl.textContent = skillDraftFilename;
  skillWizEnableNoteEl.classList.toggle("hidden", skillWizardKind !== "discipline");
  skillDraftTextEl.value = event.text || "";
  skillWizStep1El.classList.add("hidden");
  skillWizStep2El.classList.remove("hidden");
  skillDraftTextEl.focus();
}

if (skillCreateBtnEl) skillCreateBtnEl.addEventListener("click", openSkillWizard);
// Also reachable from Settings, so the feature is discoverable without first
// finding the Skills view (which only appears once a workspace is open).
if (settingsBuildSkillBtnEl) settingsBuildSkillBtnEl.addEventListener("click", openSkillWizard);
if (skillWizCancelEl) skillWizCancelEl.addEventListener("click", closeSkillWizard);
if (skillWizBackEl) {
  skillWizBackEl.addEventListener("click", () => {
    skillWizStep2El.classList.add("hidden");
    skillWizStep1El.classList.remove("hidden");
  });
}
if (skillKindSegEl) {
  skillKindSegEl.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      skillKindSegEl.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      skillWizardKind = btn.dataset.skillkind;
      syncSkillKindUi();
    });
  });
}
if (skillWizGenerateEl) {
  skillWizGenerateEl.addEventListener("click", async () => {
    const description = skillDescInputEl.value.trim();
    if (!description) {
      skillWizStatusEl.textContent = "Describe the skill first.";
      return;
    }
    if (!engineLinked) {
      skillWizStatusEl.textContent = "Engine not linked — open a workspace / set up a connection first.";
      return;
    }
    setSkillWizardWaiting(true);
    const payload = { description, kind: skillWizardKind };
    const context = skillContextInputEl && skillContextInputEl.value.trim();
    if (context) payload.context = context;
    // "profile:<id>" authors with that saved profile's provider (main resolves
    // the key); a bare value is a model on the current connection.
    const sel = skillModelSelectEl && skillModelSelectEl.value;
    if (sel && sel.startsWith("profile:")) payload.profileId = sel.slice("profile:".length);
    else if (sel) payload.model = sel;
    let res = null;
    try {
      res = await window.magentra.generateSkill(payload);
    } catch {
      res = null;
    }
    // A refusal (no engine, no profile) comes back synchronously; a success is
    // followed asynchronously by the skill_draft event that clears waiting.
    if (res && res.ok === false) {
      setSkillWizardWaiting(false);
      skillWizStatusEl.textContent = res.error || "could not start generation";
    }
  });
}
if (skillWizInstallEl) {
  skillWizInstallEl.addEventListener("click", () => {
    const text = skillDraftTextEl.value;
    if (!text.trim()) {
      skillWizStatus2El.textContent = "The draft is empty.";
      return;
    }
    window.magentra.send({ type: "install_skill", filename: skillDraftFilename, text });
    closeSkillWizard();
    showView("skills");
    announce(`Installing the ${skillDraftFilename} skill.`);
  });
}
