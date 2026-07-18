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
  foot.append(idEl, kindEl);
  card.appendChild(foot);

  return card;
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
  foot.appendChild(hint);
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

const SKILL_KIND_HINTS = {
  discipline: "A discipline shapes every turn while enabled — rules, reminders, even tool gates the engine enforces.",
  action: "An action is a procedure the agent invokes on demand — a recipe for a specific job, out of the way otherwise.",
};

function openSkillWizard() {
  if (!skillWizardEl) return;
  skillWizStep1El.classList.remove("hidden");
  skillWizStep2El.classList.add("hidden");
  skillWizStatusEl.textContent = "";
  skillWizStatus2El.textContent = "";
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
      skillKindHintEl.textContent = SKILL_KIND_HINTS[skillWizardKind];
    });
  });
}
if (skillWizGenerateEl) {
  skillWizGenerateEl.addEventListener("click", () => {
    const description = skillDescInputEl.value.trim();
    if (!description) {
      skillWizStatusEl.textContent = "Describe the skill first.";
      return;
    }
    if (!engineLinked) {
      skillWizStatusEl.textContent = "Engine not linked — set up a connection first (Settings → Connection).";
      return;
    }
    setSkillWizardWaiting(true);
    window.magentra.send({ type: "generate_skill", description, kind: skillWizardKind });
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
