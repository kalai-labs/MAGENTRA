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
// Addon chip: one summary chip that opens the Addons view. Addons are always
// available, so there is nothing to toggle here — the chip is a signpost.
// ---------------------------------------------------------------------------

function renderAddonChip() {
  modeChipsEl.textContent = "";
  if (addons.length === 0) return;
  const summaryEl = document.createElement("button");
  summaryEl.id = "addonsSummary";
  summaryEl.className = "mode-chip active";
  summaryEl.textContent = `◈ ${addons.length} addon${addons.length === 1 ? "" : "s"}`;
  summaryEl.title = "Open the Addons view";
  summaryEl.addEventListener("click", () => showView("addons"));
  modeChipsEl.appendChild(summaryEl);
}
