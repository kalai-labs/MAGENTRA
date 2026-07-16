// Renderer state: live session state plus persisted UI preferences.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// cinematic-mode verb glossary: tool name -> present-participle activity
const OP_VERBS = {
  Read: "scanning",
  Grep: "scanning",
  Glob: "scanning",
  Write: "forging",
  Edit: "refining",
  NotebookEdit: "refining",
  Bash: "executing",
  PowerShell: "executing",
  Agent: "delegating",
  Workflow: "delegating",
  CrewRun: "delegating",
  TaskCreate: "charting",
  TaskUpdate: "charting",
  TaskGet: "charting",
  TaskList: "charting",
  GraphQuery: "mapping",
  BackpackSearch: "consulting",
  WebSearch: "reaching out",
  WebFetch: "reaching out",
  AskUserQuestion: "asking",
};

let streamEl = null;
let currentAssistantEl = null;
let currentThinkingEl = null; // live reasoning block for the current turn segment
let currentAgentsRow = null;
let agentCards = new Map(); // key -> card record
let toolRows = new Map(); // id -> { rowEl, detailEl, glyphEl }
let toolCountThisTurn = 0;
// A turn is running (the model is thinking / calling tools).
let busy = false;
// Work that is NOT a turn: a background atlas build, a background job. Tracked
// by taskId, because the engine can be busy with no turn in flight at all — and
// the stop button has to know about that, or it would look like nothing to stop.
const backgroundJobs = new Set();
// False until a workspace is chosen; before that the composer stays disabled
// regardless of what else is going on.
let workspaceOpen = false;
// False while the workspace has no working credentials (setup:required fired
// and no session_started since): prompts would go into a dead engine, so the
// composer locks and points at setup instead. An engine CRASH does not clear
// this — a configured engine can be restarted from the banner.
let engineLinked = true;

let permissionQueue = [];
let activePermission = null;

// now-line (liveness strip) state
const NOW_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let nowSpinnerIdx = 0;
let nowSpinnerIntervalId = null;
let nowTickIntervalId = null;
let nowTurnStart = null;
let nowActivityStart = null;
let nowVerb = "thinking";
let nowDetail = "";
let nowOverrideText = null;
let nowOverrideTimeoutId = null;

// mission rail (live task list) state
let railCollapsed = false; // user preference for the rest of the session
let taskStatusById = new Map(); // id -> last known status, to detect flips to in_progress

// ---------------------------------------------------------------------------
// UI settings (persisted appearance / activity-detail preferences)
// ---------------------------------------------------------------------------

const UI_SETTINGS_KEY = "magentra-ui";
const DEFAULT_UI_SETTINGS = {
  font: '"Cascadia Mono", Consolas, monospace',
  size: "17",
  theme: "phosphor", // phosphor (matrix) | glacier (winter) | dusk (night) | paper (print)
  rain: "faint",
  motion: "full",
  // Default to the transparent view: a coding agent's trust rests on the user
  // being able to see what each tool actually did. "cinematic" is opt-in.
  detail: "technical",
  deletions: "ask", // "ask" (guard always prompts) | "allow" (deletions run freely)
  commands: "auto", // "auto" (autonomous) | "ask" (approval before consequential tools)
};

function loadUiSettings() {
  try {
    const raw = localStorage.getItem(UI_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_UI_SETTINGS };
    return { ...DEFAULT_UI_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_UI_SETTINGS };
  }
}

let uiSettings = loadUiSettings();

function saveUiSettings() {
  try {
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(uiSettings));
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

function applyUiSettings() {
  document.documentElement.dataset.theme = uiSettings.theme;
  document.documentElement.dataset.rain = uiSettings.rain;
  document.documentElement.dataset.motion = uiSettings.motion;
  document.documentElement.dataset.detail = uiSettings.detail;
  document.documentElement.style.setProperty("--font-user", uiSettings.font);
  document.documentElement.style.setProperty("--fs-base", uiSettings.size + "px");
}

// Applied immediately at load, before any engine events can render UI, so the
// very first paint already reflects the user's saved preferences.
applyUiSettings();

function syncSegGroup(containerEl, settingKey) {
  if (!containerEl) return;
  containerEl.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset[settingKey] === uiSettings[settingKey]);
  });
}

function syncSwatchGroup(containerEl, settingKey) {
  if (!containerEl) return;
  containerEl.querySelectorAll(".swatch").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset[settingKey] === uiSettings[settingKey]);
  });
}

function syncUiControlsFromSettings() {
  if (setFontEl) setFontEl.value = uiSettings.font;
  syncSegGroup(setSizeEl, "size");
  syncSegGroup(setRainEl, "rain");
  syncSegGroup(setMotionEl, "motion");
  syncSegGroup(setDetailEl, "detail");
  syncSegGroup(setDeletionsEl, "deletions");
  syncSegGroup(setCommandsEl, "commands");
  syncSwatchGroup(setThemeEl, "theme");
}

// Safety toggles reach the engine as frames; only send what actually changed
// (a fresh session gets a forced full send since it boots with defaults).
const lastSentSafety = { deletions: null, commands: null };
function applySafetySettings(force) {
  if (window.magentra && window.magentra.send) {
    if (force || uiSettings.deletions !== lastSentSafety.deletions) {
      window.magentra.send({ type: "set_deletion_guard", enabled: uiSettings.deletions !== "allow" });
      lastSentSafety.deletions = uiSettings.deletions;
    }
    if (force || uiSettings.commands !== lastSentSafety.commands) {
      window.magentra.send({ type: "set_mode", mode: uiSettings.commands === "ask" ? "default" : "bypass" });
      lastSentSafety.commands = uiSettings.commands;
    }
  }
  renderSafetyHint(uiSettings.commands === "ask" ? "default" : "bypass");
}

// The engine's four permission modes, worded for the footer hint. The UI's
// two-way "commands" toggle only produces default/bypass, but /mode and plan
// flows can put the engine in acceptEdits/plan — mode_changed drives this so
// the hint never lies about what the agent will do.
const MODE_HINT = {
  default: "asks before acting",
  acceptEdits: "auto-accepts edits, asks for commands",
  plan: "plan mode — read-only",
  bypass: "autonomous",
};

function renderSafetyHint(mode) {
  if (!hintAutoEl) return;
  const acting = MODE_HINT[mode] || MODE_HINT.default;
  const deleting = uiSettings.deletions === "allow" ? "deletions allowed" : "deletions always ask";
  hintAutoEl.textContent = `${acting} · ${deleting}`;
}

/** The engine changed permission mode on its own (/mode, plan approve/exit).
 * Update the hint to match, and keep the commands segment in sync where the
 * mode maps onto its two options. */
function onModeChanged(event) {
  const mode = event && event.mode;
  if (!mode) return;
  renderSafetyHint(mode);
  if (mode === "default" || mode === "bypass") {
    uiSettings.commands = mode === "default" ? "ask" : "auto";
    lastSentSafety.commands = uiSettings.commands; // engine already there; don't echo back
    saveUiSettings();
    syncSegGroup(setCommandsEl, "commands");
  }
}

function wireSegGroup(containerEl, settingKey) {
  if (!containerEl) return;
  containerEl.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      containerEl.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      uiSettings[settingKey] = btn.dataset[settingKey];
      saveUiSettings();
      applyUiSettings();
      applySafetySettings(false);
    });
  });
}

function wireSwatchGroup(containerEl, settingKey) {
  if (!containerEl) return;
  containerEl.querySelectorAll(".swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      containerEl.querySelectorAll(".swatch").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      uiSettings[settingKey] = btn.dataset[settingKey];
      saveUiSettings();
      applyUiSettings();
    });
  });
}

if (setFontEl) {
  setFontEl.addEventListener("change", () => {
    uiSettings.font = setFontEl.value;
    saveUiSettings();
    applyUiSettings();
  });
}
wireSegGroup(setSizeEl, "size");
wireSegGroup(setRainEl, "rain");
wireSegGroup(setMotionEl, "motion");
wireSegGroup(setDetailEl, "detail");
wireSegGroup(setDeletionsEl, "deletions");
wireSegGroup(setCommandsEl, "commands");
wireSwatchGroup(setThemeEl, "theme");

syncUiControlsFromSettings();
applySafetySettings(false);

// Web search toggle: persisted in the workspace engine settings file (not
// localStorage) via IPC, so it deliberately bypasses wireSegGroup. Flipping it
// rewrites .magentra/settings.json and restarts the engine.
function syncWebSearchSeg(enabled) {
  if (!setWebSearchEl) return;
  setWebSearchEl.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.classList.toggle("on", (btn.dataset.websearch === "on") === enabled);
  });
}

if (setWebSearchEl && window.magentra && window.magentra.getWebSearch) {
  window.magentra
    .getWebSearch()
    .then((enabled) => syncWebSearchSeg(enabled !== false))
    .catch(() => {});
  setWebSearchEl.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const enabled = btn.dataset.websearch === "on";
      const prevBtn = setWebSearchEl.querySelector(".seg-btn.on");
      const prevEnabled = prevBtn ? prevBtn.dataset.websearch === "on" : true;
      if (enabled === prevEnabled) return;
      syncWebSearchSeg(enabled);
      let res = null;
      try {
        res = await window.magentra.setWebSearch(enabled);
      } catch {
        res = null;
      }
      if (!res || res.ok !== true) syncWebSearchSeg(prevEnabled);
    });
  });
}

// .ma style chips state
let modes = [];
let modesReceived = false; // has the first modes_updated arrived (vs. still session-start)
let pendingModesNote = false; // set on a set_modes click; consumed by the next modes_updated
let stylesPanelOpen = false; // is the #stylesPanel popover currently open

const HERO_MODE_IDS = ["grill", "reshape"];
const HERO_MODE_LABELS = { grill: "⚡ grill", reshape: "⟲ reshape" };

// slash-command palette state
const SLASH_COMMANDS = [
  { cmd: "/clear", args: "", desc: "fresh session — history cleared" },
  { cmd: "/compact", args: "", desc: "compact the conversation now" },
  { cmd: "/session", args: "", desc: "this session's bill: cost per model, time, code churn, context" },
  { cmd: "/mode", args: "<default|acceptEdits|plan|bypass>", desc: "set permission mode" },
  { cmd: "/styles", args: "[on|off <id>]", desc: "list optional .ma styles, or toggle one" },
  { cmd: "/settings", args: "[<key> <value>]", desc: "show settings, or set one (persisted)" },
  { cmd: "/tasks", args: "", desc: "show the task list" },
  { cmd: "/build-crew", args: "", desc: "design a crew of specialist agents (if none exists)" },
  { cmd: "/resume", args: "<session-id>", desc: "resume a previous session" },
  { cmd: "/sessions", args: "", desc: "list saved sessions" },
  { cmd: "/help", args: "", desc: "all commands" },
];
let slashMatches = []; // currently filtered registry rows shown in the palette
let slashSelIdx = 0; // index into slashMatches of the "sel" row
let slashVisible = false;
