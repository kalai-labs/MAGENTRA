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
  if (total === 0) taskTimes = new Map();

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
    } else if (m.running) {
      // A one-off run in progress: hard-stop it (the global stop, surfaced here).
      const stop = document.createElement("button");
      stop.className = "lab-btn danger";
      stop.textContent = "STOP";
      stop.title = "Stop the running mission";
      stop.addEventListener("click", () => window.magentra.interrupt());
      actions.appendChild(stop);
    }
    if (m.schedule) {
      actions.appendChild(
        m.scheduled
          ? missionActionButton("UNSCHEDULE", "Remove the cron schedule", `unschedule ${m.id}`)
          : missionActionButton("SCHEDULE", `Arm the cron schedule (${m.schedule})`, `schedule ${m.id}`),
      );
    }
    actions.appendChild(missionDeleteButton(m));

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
labNewBtnEl.addEventListener("click", openMissionBuilder);

/** DELETE with a two-click arm — window.confirm is unreliable in this renderer,
 *  so the first click arms ("CONFIRM?"), a second within 3s removes the mission
 *  (the engine stops/unschedules it first; past reports are kept). */
function missionDeleteButton(m) {
  const btn = document.createElement("button");
  btn.className = "lab-btn danger";
  btn.textContent = "DELETE";
  btn.title = `Remove the mission "${m.id}" (its past reports are kept)`;
  let armed = false;
  let timer = null;
  btn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      btn.textContent = "CONFIRM?";
      btn.classList.add("armed");
      timer = setTimeout(() => {
        armed = false;
        btn.textContent = "DELETE";
        btn.classList.remove("armed");
      }, 3000);
      return;
    }
    if (timer) clearTimeout(timer);
    sendMissionCommand(`delete ${m.id}`);
  });
  return btn;
}

// ── Mission builder modal ──────────────────────────────────────────────────
// Collects the mission in plain language, then sends a create_mission frame; the
// engine assembles .magentra/missions/<id>.md (see buildMissionFile) and reloads.
const mf = (id) => document.getElementById(id);
let missionIdEdited = false;

function slugifyMissionId(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function setMissionStatus(text, isError) {
  const el = mf("missionModalStatus");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("err", Boolean(isError));
}

function syncMissionAutomation() {
  const mode = mf("mfAutomation").value;
  mf("mfCooldownField").classList.toggle("hidden", mode !== "continuous");
  mf("mfScheduleField").classList.toggle("hidden", mode !== "schedule");
}

function openMissionBuilder() {
  if (!missionModalEl) return;
  for (const id of ["mfName", "mfId", "mfDescription", "mfInvestigate", "mfDone", "mfKeywords", "mfDeliverable", "mfCooldown", "mfSchedule", "mfBudget"]) {
    const el = mf(id);
    if (el) el.value = "";
  }
  mf("mfAutomation").value = "manual";
  syncMissionAutomation();
  missionIdEdited = false;
  setMissionStatus("");
  missionModalEl.classList.remove("hidden");
  openModalA11y(missionModalEl, mf("mfName"));
}

function closeMissionBuilder() {
  if (!missionModalEl || missionModalEl.classList.contains("hidden")) return;
  missionModalEl.classList.add("hidden");
  closeModalA11y();
}

function submitMissionBuilder() {
  const name = mf("mfName").value.trim();
  const investigate = mf("mfInvestigate").value.trim();
  const id = mf("mfId").value.trim() || slugifyMissionId(name);
  if (!name) return setMissionStatus("A name is required.", true), mf("mfName").focus();
  if (!investigate) return setMissionStatus("Describe what the mission should investigate.", true), mf("mfInvestigate").focus();
  if (!/^[a-z0-9_-]+$/.test(id)) return setMissionStatus("Invalid file id — lowercase letters, digits, - or _.", true), mf("mfId").focus();

  const mode = mf("mfAutomation").value;
  const budget = parseInt(mf("mfBudget").value, 10);
  const draft = {
    id,
    name,
    description: mf("mfDescription").value.trim() || undefined,
    investigate,
    done: mf("mfDone").value.trim() || undefined,
    keywords: mf("mfKeywords").value.trim() || undefined,
    deliverable: mf("mfDeliverable").value.trim() || undefined,
    continuous: mode === "continuous" || undefined,
    cooldown: mode === "continuous" ? mf("mfCooldown").value.trim() || undefined : undefined,
    schedule: mode === "schedule" ? mf("mfSchedule").value.trim() || undefined : undefined,
    budget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
  };
  window.magentra.send({ type: "create_mission", draft });
  closeMissionBuilder();
  showView("lab");
}

async function browseMissionDeliverable() {
  if (!window.magentra.pickMissionDeliverable) return;
  const id = mf("mfId").value.trim() || slugifyMissionId(mf("mfName").value) || "mission";
  const res = await window.magentra.pickMissionDeliverable(`report-${id}.md`);
  if (res && res.ok && res.path) mf("mfDeliverable").value = res.path;
  else if (res && res.error) setMissionStatus(res.error, true);
}

if (missionModalEl) {
  mf("mfName").addEventListener("input", () => {
    if (!missionIdEdited) mf("mfId").value = slugifyMissionId(mf("mfName").value);
  });
  mf("mfId").addEventListener("input", () => {
    missionIdEdited = true;
  });
  mf("mfAutomation").addEventListener("change", syncMissionAutomation);
  mf("mfBrowse").addEventListener("click", () => void browseMissionDeliverable());
  missionModalEl.querySelectorAll(".mf-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      mf("mfSchedule").value = chip.dataset.cron || "";
    });
  });
  mf("missionModalCreate").addEventListener("click", submitMissionBuilder);
  mf("missionModalCancel").addEventListener("click", closeMissionBuilder);
}
