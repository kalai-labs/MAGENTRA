// Mission rail (live task list) and .ma style chips.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Mission rail: live task list
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
  navMissionEl.classList.toggle("hidden", total === 0);

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

  // visibility state machine
  if (total === 0) {
    taskRailEl.classList.add("hidden");
    document.body.classList.remove("rail-open");
    taskTabEl.classList.add("hidden");
    return;
  }
  if (railCollapsed) {
    taskTabEl.classList.remove("hidden");
    return;
  }
  taskRailEl.classList.remove("hidden");
  document.body.classList.add("rail-open");
  taskTabEl.classList.add("hidden");
}

function collapseMissionRail() {
  railCollapsed = true;
  taskRailEl.classList.add("hidden");
  document.body.classList.remove("rail-open");
  if (taskListEl.children.length > 0) taskTabEl.classList.remove("hidden");
}

function expandMissionRail() {
  railCollapsed = false;
  taskTabEl.classList.add("hidden");
  taskRailEl.classList.remove("hidden");
  document.body.classList.add("rail-open");
}

taskCollapseEl.addEventListener("click", collapseMissionRail);
taskTabEl.addEventListener("click", expandMissionRail);

navMissionEl.addEventListener("click", () => {
  if (railCollapsed) expandMissionRail();
  else collapseMissionRail();
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
    rowEl.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMode(mode.id);
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
  campaignsTitleEl.textContent = "CAMPAIGNS";
  panelEl.appendChild(campaignsTitleEl);

  for (const heroId of HERO_MODE_IDS) {
    const mode = modes.find((m) => m.id === heroId);
    if (mode) panelEl.appendChild(createStyleRow(mode));
  }

  const disciplinesTitleEl = document.createElement("div");
  disciplinesTitleEl.className = "panel-group-title";
  disciplinesTitleEl.textContent = "DISCIPLINES";
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
