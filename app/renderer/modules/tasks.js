// Task rail (live task list) and .ma style chips.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Task rail: live task list
// ---------------------------------------------------------------------------

const TASK_GLYPHS = { pending: "○", in_progress: "◉", completed: "✓" };

// One shared ticker keeps the in-progress task's duration chip live; it stops
// itself when nothing is in progress.
let taskTickerId = null;

function ensureTaskTicker(anyInProgress) {
  if (anyInProgress && !taskTickerId) {
    taskTickerId = setInterval(() => {
      const liveEls = taskListEl.querySelectorAll(".t-time.live");
      if (liveEls.length === 0) {
        clearInterval(taskTickerId);
        taskTickerId = null;
        return;
      }
      for (const el of liveEls) el.textContent = formatElapsed(Date.now() - Number(el.dataset.start));
    }, 1000);
  } else if (!anyInProgress && taskTickerId) {
    clearInterval(taskTickerId);
    taskTickerId = null;
  }
}

function onTaskListUpdated(event) {
  const tasks = event.tasks || [];
  currentTasks = tasks; // per-tab (swapped) — lets a focus change re-render the rail

  // --- Per-tab state (ALWAYS, whichever tab owns this event) --------------
  // Observe status flips: they feed the now-line and the per-task stopwatch
  // (start on in_progress, freeze on completed).
  const now = Date.now();
  for (const task of tasks) {
    const prevStatus = taskStatusById.get(task.id);
    const times = taskTimes.get(task.id) || {};
    if (task.status === "in_progress" && !times.start) times.start = now;
    if (task.status === "completed" && times.start && !times.done) times.done = now;
    taskTimes.set(task.id, times);
    if (task.status === "in_progress" && prevStatus !== "in_progress" && nowVerb === "thinking") {
      setNowActivity("task", task.subject);
    }
  }
  taskStatusById = new Map(tasks.map((t) => [t.id, t.status]));
  if (tasks.length === 0) taskTimes = new Map();

  // --- Per-tab navbar bubbles (ALWAYS) — each pane header shows its own -----
  const ownerTab = typeof dispatchTabId !== "undefined" && dispatchTabId !== null ? dispatchTabId : focusedTabId;
  if (typeof setTabTaskBubbles === "function") setTabTaskBubbles(ownerTab, tasks);

  // --- Shared inspector rail (FOCUSED tab only) ----------------------------
  // A background tab's update must not overwrite the focused tab's rail (the bug
  // where the inspector was stuck on one tab). Focusing a tab re-renders it via
  // repaintChromeFromFocusedTab → renderTaskRail(currentTasks).
  if (typeof chromeIsFocused === "function" && !chromeIsFocused()) return;
  renderTaskRail(tasks);
}

/** Render the shared right-side task rail (progress, bar, list, dock badge) from
 * a task list. Only ever called for the focused tab's tasks. */
function renderTaskRail(tasks) {
  tasks = tasks || [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed").length;
  const progressText = total > 0 ? `${done}/${total}` : "";

  taskProgressEl.textContent = progressText;
  taskTabCountEl.textContent = total > 0 ? progressText : "—";
  taskBarFillEl.style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;
  if (taskRailBarEl) taskRailBarEl.classList.toggle("hidden", total === 0);
  if (taskEmptyEl) taskEmptyEl.classList.toggle("hidden", total > 0);

  const notCompleted = total - done;
  dockMissionCountEl.textContent = String(notCompleted);
  dockMissionCountEl.classList.toggle("hidden", notCompleted === 0);
  navMissionEl.classList.remove("hidden");

  // rebuild the list, preserving engine order
  taskListEl.textContent = "";
  let inProgressEl = null;
  let anyInProgress = false;
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

    // Duration chip: live stopwatch while in progress, frozen once completed,
    // absent when the flip was never observed (e.g. a restored session).
    const timeEl = document.createElement("span");
    timeEl.className = "t-time";
    const times = taskTimes.get(task.id) || {};
    if (task.status === "in_progress" && times.start) {
      timeEl.classList.add("live");
      timeEl.dataset.start = String(times.start);
      timeEl.textContent = formatElapsed(Date.now() - times.start);
      anyInProgress = true;
    } else if (task.status === "completed" && times.start && times.done) {
      timeEl.textContent = formatElapsed(times.done - times.start);
    }

    itemEl.appendChild(glyphEl);
    itemEl.appendChild(subjectEl);
    itemEl.appendChild(timeEl);
    taskListEl.appendChild(itemEl);

    if (task.status === "in_progress") inProgressEl = itemEl;
  }
  ensureTaskTicker(anyInProgress);
  if (inProgressEl) inProgressEl.scrollIntoView({ block: "nearest" });

  if (!railCollapsed && workspaceOpen) openInspector(activeInspectorTab);
}

navMissionEl.addEventListener("click", () => {
  openInspector("tasks");
});

// ---------------------------------------------------------------------------
// Skill chips: quick toggles for the hero skills plus a summary chip that
// opens the full Skills view (where every discipline lives).
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
  summaryEl.id = "skillsSummary";
  summaryEl.className = "mode-chip" + (activeCount > 0 ? " active" : "");
  summaryEl.textContent = `◈ ${activeCount} skill${activeCount === 1 ? "" : "s"}`;
  summaryEl.title = "Open the Skills view";
  summaryEl.addEventListener("click", () => showView("skills"));
  modeChipsEl.appendChild(summaryEl);
}

function toggleMode(id) {
  const mode = modes.find((m) => m.id === id);
  if (!mode) return;
  setSkillActive(id, !mode.active);
}

function onModesUpdated(event) {
  const isInitial = !modesReceived;
  modesReceived = true;
  modes = event.modes || [];
  renderSkillsSurfaces();
  if (pendingModesNote && !isInitial) {
    const activeIds = modes.filter((m) => m.active).map((m) => m.id);
    appendSysNote(`skills: ${activeIds.length ? activeIds.join(" + ") : "none active"}`);
  }
  pendingModesNote = false;
}
