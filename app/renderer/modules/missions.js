// Task rail (live task list) and .ma style chips.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Task rail: live task list
// ---------------------------------------------------------------------------

const TASK_GLYPHS = { pending: "○", in_progress: "◐", completed: "●" };

function onTaskListUpdated(event) {
  const tasks = event.tasks || [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed").length;
  const progressText = `${done}/${total}`;

  taskProgressEl.textContent = progressText;
  taskTabCountEl.textContent = progressText;
  taskBarFillEl.style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;

  const notCompleted = total - done;
  dockMissionCountEl.textContent = String(notCompleted);
  dockMissionCountEl.classList.toggle("hidden", notCompleted === 0);
  navMissionEl.classList.remove("hidden");

  // detect tasks that just flipped to in_progress, to feed the now-line
  for (const task of tasks) {
    const prevStatus = taskStatusById.get(task.id);
    if (task.status === "in_progress" && prevStatus !== "in_progress" && nowVerb === "thinking") {
      setNowActivity("task", task.subject);
    }
  }
  taskStatusById = new Map(tasks.map((t) => [t.id, t.status]));

  // rebuild the list, preserving engine order
  taskListEl.textContent = "";
  let inProgressEl = null;
  for (const task of tasks) {
    const itemEl = document.createElement("div");
    itemEl.className = `task-item ${task.status}`;
    if (task.description) itemEl.title = task.description;

    const glyphEl = document.createElement("span");
    glyphEl.className = "t-glyph";
    glyphEl.textContent = TASK_GLYPHS[task.status] || "○";

    const subjectEl = document.createElement("span");
    subjectEl.className = "t-subject";
    subjectEl.textContent = task.subject;

    itemEl.appendChild(glyphEl);
    itemEl.appendChild(subjectEl);
    taskListEl.appendChild(itemEl);

    if (task.status === "in_progress") inProgressEl = itemEl;
  }
  if (inProgressEl) inProgressEl.scrollIntoView({ block: "nearest" });

  if (!railCollapsed && workspaceOpen) openInspector(activeInspectorTab);
}

navMissionEl.addEventListener("click", () => {
  openInspector("tasks");
});

// ---------------------------------------------------------------------------
// .ma style chips
// ---------------------------------------------------------------------------

function renderModeChips() {
  modeChipsEl.textContent = "";

  for (const heroId of HERO_MODE_IDS) {
    const mode = modes.find((m) => m.id === heroId);
    if (!mode) continue;
    const chipEl = document.createElement("button");
    chipEl.className = "mode-chip hero" + (mode.active ? " active" : "");
    chipEl.textContent = HERO_MODE_LABELS[heroId];
    chipEl.title = `${mode.name} — ${mode.description}`;
    chipEl.addEventListener("click", () => toggleMode(mode.id));
    modeChipsEl.appendChild(chipEl);
  }

  const activeCount = modes.filter((m) => m.active).length;
  const summaryEl = document.createElement("button");
  summaryEl.id = "stylesSummary";
  summaryEl.className = "mode-chip";
  summaryEl.textContent = `◈ ${activeCount} styles`;
  summaryEl.title = "All styles";
  summaryEl.addEventListener("click", (e) => {
    e.stopPropagation();
    stylesPanelOpen = !stylesPanelOpen;
    renderModeChips();
  });
  modeChipsEl.appendChild(summaryEl);

  if (stylesPanelOpen) renderStylesPanel();
}

function createStyleRow(mode) {
  const frag = document.createDocumentFragment();

  // Core quality modes are always on and cannot be toggled: render them locked.
  let conflictWithId = null;
  if (!mode.core && !mode.active && mode.conflicts) {
    for (const cid of mode.conflicts) {
      const other = modes.find((m) => m.id === cid);
      if (other && other.active) {
        conflictWithId = cid;
        break;
      }
    }
  }
  const conflictOther = conflictWithId ? modes.find((m) => m.id === conflictWithId) : null;
  const blockedByCore = Boolean(conflictOther && conflictOther.core);

  // A core mode is "suspended" while a conflicting optional style is active:
  // still locked, but pushed off (active:false) until that optional turns off.
  const suspended = Boolean(mode.core && mode.suspendedBy);

  const rowEl = document.createElement("div");
  rowEl.className =
    "style-row" +
    (mode.active ? " on" : "") +
    (mode.core ? " locked" : "") +
    (suspended ? " suspended" : "") +
    (conflictWithId ? " conflicted" : "");

  const toggleEl = document.createElement("span");
  toggleEl.className = "style-toggle";
  toggleEl.textContent = mode.core ? "🔒" : mode.active ? "◉" : "○";

  const nameEl = document.createElement("span");
  nameEl.className = "style-name";
  nameEl.textContent = mode.id;

  const descEl = document.createElement("span");
  descEl.className = "style-desc";
  descEl.textContent = mode.description;

  rowEl.appendChild(toggleEl);
  rowEl.appendChild(nameEl);
  rowEl.appendChild(descEl);
  if (mode.core) {
    rowEl.title = suspended ? `core quality mode — suspended by ${mode.suspendedBy}` : "core quality mode — always on";
  } else {
    // Keyboard-reachable toggle: styles must be manageable without a mouse.
    rowEl.tabIndex = 0;
    rowEl.setAttribute("role", "switch");
    rowEl.setAttribute("aria-checked", mode.active ? "true" : "false");
    rowEl.setAttribute("aria-label", `${mode.id} style`);
    rowEl.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMode(mode.id);
    });
    rowEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        toggleMode(mode.id);
      }
    });
  }

  frag.appendChild(rowEl);

  if (conflictWithId) {
    const noteEl = document.createElement("div");
    noteEl.className = "style-conflict-note";
    noteEl.textContent = blockedByCore
      ? `activating suspends core mode ${conflictWithId}`
      : `activating disables ${conflictWithId}`;
    frag.appendChild(noteEl);
  }

  return frag;
}

function renderStylesPanel() {
  const panelEl = document.createElement("div");
  panelEl.id = "stylesPanel";
  panelEl.addEventListener("click", (e) => e.stopPropagation());

  const campaignsTitleEl = document.createElement("div");
  campaignsTitleEl.className = "panel-group-title";
  campaignsTitleEl.textContent = "FEATURED STYLES";
  panelEl.appendChild(campaignsTitleEl);

  for (const heroId of HERO_MODE_IDS) {
    const mode = modes.find((m) => m.id === heroId);
    if (mode) panelEl.appendChild(createStyleRow(mode));
  }

  const disciplinesTitleEl = document.createElement("div");
  disciplinesTitleEl.className = "panel-group-title";
  disciplinesTitleEl.textContent = "ALL STYLES";
  panelEl.appendChild(disciplinesTitleEl);

  for (const mode of modes) {
    if (HERO_MODE_IDS.includes(mode.id)) continue;
    panelEl.appendChild(createStyleRow(mode));
  }

  modeChipsEl.appendChild(panelEl);
}

function closeStylesPanel() {
  if (!stylesPanelOpen) return;
  stylesPanelOpen = false;
  renderModeChips();
}

function toggleMode(id) {
  const mode = modes.find((m) => m.id === id);
  if (!mode) return;
  mode.active = !mode.active; // optimistic; next modes_updated confirms/corrects
  renderModeChips();
  const activeIds = modes.filter((m) => m.active).map((m) => m.id);
  pendingModesNote = true;
  window.magentra.setModes(activeIds);
}

function onModesUpdated(event) {
  const isInitial = !modesReceived;
  modesReceived = true;
  modes = event.modes || [];
  renderModeChips();
  if (pendingModesNote && !isInitial) {
    const activeIds = modes.filter((m) => m.active).map((m) => m.id);
    appendSysNote(`styles: ${activeIds.join(" + ")}`);
  }
  pendingModesNote = false;
}

// ---------------------------------------------------------------------------
// Missions view (research lab): list mission files with live state, and run
// them without knowing the slash syntax — every button routes through the
// exact /mission handlers the terminal uses.
// ---------------------------------------------------------------------------

let labMissions = [];
let labWarnings = [];

function sendMissionCommand(args) {
  window.magentra.send({ type: "slash_command", command: "mission", args });
}

function missionActionButton(label, title, args, opts = {}) {
  const btn = document.createElement("button");
  btn.className = "lab-btn" + (opts.danger ? " danger" : "");
  btn.textContent = label;
  btn.title = title;
  btn.disabled = Boolean(opts.disabled);
  btn.addEventListener("click", () => {
    sendMissionCommand(args);
    if (opts.toConsole) showView("console");
  });
  return btn;
}

function renderMissions() {
  if (!labListEl) return;
  labListEl.textContent = "";
  const runningCount = labMissions.filter((m) => m.running).length;
  labEmptyEl.classList.toggle("hidden", labMissions.length > 0 || labWarnings.length > 0);
  labSubEl.textContent = `${labMissions.length} mission${labMissions.length === 1 ? "" : "s"}${runningCount ? ` · ${runningCount} running` : ""}`;
  dockLabCountEl.textContent = String(runningCount);
  dockLabCountEl.classList.toggle("hidden", runningCount === 0);

  for (const m of labMissions) {
    const row = document.createElement("div");
    row.className = "lab-row" + (m.running ? " running" : "");

    const main = document.createElement("div");
    main.className = "lab-main";

    const title = document.createElement("div");
    title.className = "lab-title";
    title.textContent = `🧪 ${m.name}`;
    const idEl = document.createElement("span");
    idEl.className = "lab-id";
    idEl.textContent = m.id;
    title.appendChild(idEl);
    main.appendChild(title);

    if (m.description) {
      const desc = document.createElement("div");
      desc.className = "lab-desc";
      desc.textContent = m.description;
      main.appendChild(desc);
    }

    const meta = document.createElement("div");
    meta.className = "lab-meta";
    meta.textContent = [
      m.keywords.length ? `keywords: ${m.keywords.join(", ")}` : null,
      m.schedule ? `cron ${m.schedule} ${m.scheduled ? "· scheduled ✓" : "· not scheduled"}` : null,
      m.running ? "🔁 running continuously" : m.continuous ? "continuous-capable" : null,
      m.lastRunAt ? `last run ${formatSessionDate(m.lastRunAt)}` : "never run",
      `→ ${m.deliverable}`,
    ].filter(Boolean).join("  ·  ");
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "lab-actions";
    actions.appendChild(missionActionButton("RUN", "Run this mission now (streams into the console)", `run ${m.id}`, { disabled: busy, toConsole: true }));
    if (m.continuous) {
      actions.appendChild(
        m.running
          ? missionActionButton("STOP", "Halt the continuous loop", `stop ${m.id}`, { danger: true })
          : missionActionButton("START", "Loop this mission: run, cool down, run again", `start ${m.id}`, { disabled: busy, toConsole: true }),
      );
    }
    if (m.schedule) {
      actions.appendChild(
        m.scheduled
          ? missionActionButton("UNSCHEDULE", "Remove the cron schedule", `unschedule ${m.id}`)
          : missionActionButton("SCHEDULE", `Arm the cron schedule (${m.schedule})`, `schedule ${m.id}`),
      );
    }

    row.appendChild(main);
    row.appendChild(actions);
    labListEl.appendChild(row);
  }

  for (const warning of labWarnings) {
    const w = document.createElement("div");
    w.className = "lab-warning";
    w.textContent = `✗ ${warning}`;
    labListEl.appendChild(w);
  }
  renderSidebarMissions();
}

function onMissionsUpdated(event) {
  labMissions = Array.isArray(event.missions) ? event.missions : [];
  labWarnings = Array.isArray(event.warnings) ? event.warnings : [];
  renderMissions();
}

function resetLabView() {
  labMissions = [];
  labWarnings = [];
  navLabEl.classList.add("hidden");
  navLabEl.classList.remove("active");
  renderMissions();
}

navLabEl.addEventListener("click", () => showView("lab"));
labCloseBtnEl.addEventListener("click", () => showView("console"));
labNewBtnEl.addEventListener("click", async () => {
  const id = await showPromptModal({
    title: "NEW MISSION",
    hint: "Mission id — becomes .magentra/missions/<id>.md (lowercase letters, digits, - or _).",
    placeholder: "lit-scan",
  });
  if (!id || !id.trim()) return;
  const trimmed = id.trim();
  if (!/^[a-z0-9_-]+$/.test(trimmed)) {
    appendSysNote(`mission: "${trimmed}" is not a valid id (lowercase letters, digits, - or _)`);
    return;
  }
  sendMissionCommand(`new ${trimmed}`);
});
