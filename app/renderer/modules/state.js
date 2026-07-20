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
let activeWorkspace = null;
// Recent workspace folders (main process pushes updates); shown in the sidebar.
let recentWorkspaces = [];
// The session's worktree cwd when it diverges from the workspace root.
let workspaceWorktree = null;
// The open "Agent working" group collecting this turn's tool rows.
let currentWorkGroup = null;
let currentSessionId = null;
let sessionSummaries = [];
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
// id -> { start, done } wall-clock ms, observed from status flips — feeds the
// per-task duration chips (the workbench's flight-recorder instrumentation).
let taskTimes = new Map();

// ---------------------------------------------------------------------------
// UI settings (persisted appearance / activity-detail preferences)
// ---------------------------------------------------------------------------

const UI_SETTINGS_KEY = "magentra-ui";
// The themes that have a token block in styles.css. Kept in step with the
// `:root`/`html[data-theme=…]` blocks there and with THEME_TITLEBAR below.
const THEMES = ["workbench", "light"];
const DEFAULT_UI_SETTINGS = {
  // JetBrains Mono ships with the app (renderer/fonts), so the default always
  // resolves to the same face on every OS instead of a per-distro fallback.
  font: '"JetBrains Mono", "Cascadia Mono", "DejaVu Sans Mono", monospace',
  size: "14",
  theme: "workbench",
  motion: "full",
  // Default to the transparent view: a coding agent's trust rests on the user
  // being able to see what each tool actually did. "cinematic" is opt-in.
  detail: "engineer",
  deletions: "ask", // "ask" (guard always prompts) | "allow" (deletions run freely)
  // Autonomous out of the box: the agent acts without asking, and the deletion
  // guard above stays the gate — it fires even in bypass mode, so destructive
  // calls (rm, force-push, drop table, terraform destroy, …) still prompt.
  // Turning `deletions` to "allow" as well is what removes every prompt.
  commands: "auto", // "auto" (autonomous) | "ask" (approval before consequential tools)
};

function loadUiSettings() {
  let saved = {};
  try {
    const raw = localStorage.getItem(UI_SETTINGS_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    saved = {};
  }
  const settings = { ...DEFAULT_UI_SETTINGS, ...saved };
  // Concept A was a deliberate reset, so the pre-reset atmosphere names are no
  // longer themes. Anything not in THEMES — a legacy atmosphere, a hand-edited
  // localStorage value — collapses to the dark default rather than leaving the
  // shell on a data-theme with no token block behind it.
  if (!THEMES.includes(settings.theme)) settings.theme = DEFAULT_UI_SETTINGS.theme;
  if (settings.detail === "technical") settings.detail = "engineer";
  // One-time migration off the old Cascadia default: it fell back to a
  // per-distro face on machines without it, while the bundled JetBrains Mono
  // always renders. The flag keeps a later deliberate Cascadia choice intact.
  if (!settings.fontMigrated) {
    if (settings.font === '"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace') {
      settings.font = DEFAULT_UI_SETTINGS.font;
    }
    settings.fontMigrated = true;
  }
  if (!["12", "13", "14", "15"].includes(settings.size)) settings.size = "14";
  return settings;
}

let uiSettings = loadUiSettings();

function saveUiSettings() {
  try {
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(uiSettings));
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

// Window-controls overlay tint per theme (panel background + primary ink),
// kept in step with the theme blocks in styles.css.
const THEME_TITLEBAR = {
  workbench: { color: "#0e1114", symbolColor: "#ced6dd" },
  light: { color: "#e7ebf0", symbolColor: "#36424f" },
};

function applyUiSettings() {
  document.documentElement.dataset.theme = uiSettings.theme;
  document.documentElement.dataset.motion = uiSettings.motion;
  document.documentElement.dataset.detail = uiSettings.detail;
  document.documentElement.style.setProperty("--font-user", uiSettings.font);
  document.documentElement.style.setProperty("--fs-base", uiSettings.size + "px");
  // Keep the native min/max/close overlay in the theme's colors.
  const titleBar = THEME_TITLEBAR[uiSettings.theme];
  if (titleBar && window.magentra && window.magentra.setTitleBarTheme) {
    // The name rides along so main can persist it and paint the next launch's
    // window in the right shade before the renderer exists.
    window.magentra.setTitleBarTheme({ name: uiSettings.theme, ...titleBar });
  }
}

// Applied immediately at load, before any engine events can render UI, so the
// very first paint already reflects the user's saved preferences.
applyUiSettings();
// macOS reserves the dock's top corner for the inset traffic lights.
if (/mac/i.test(navigator.platform || "")) document.body.classList.add("platform-mac");

function syncSegGroup(containerEl, settingKey) {
  if (!containerEl) return;
  containerEl.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset[settingKey] === uiSettings[settingKey]);
  });
}

function syncUiControlsFromSettings() {
  if (setFontEl) setFontEl.value = uiSettings.font;
  syncSegGroup(setThemeEl, "theme");
  syncSegGroup(setSizeEl, "size");
  syncSegGroup(setMotionEl, "motion");
  syncSegGroup(setDetailEl, "detail");
  syncSegGroup(setDeletionsEl, "deletions");
  syncSegGroup(setCommandsEl, "commands");
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
  const acting = MODE_HINT[mode] || MODE_HINT.default;
  const deleting = uiSettings.deletions === "allow" ? "deletions allowed" : "deletions always ask";
  if (hintAutoEl) hintAutoEl.textContent = `${acting} · ${deleting}`;
  if (typeof syncPermissionMenu === "function") syncPermissionMenu(mode);
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
  if (typeof syncPermissionMenu === "function") syncPermissionMenu(mode);
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

if (setFontEl) {
  setFontEl.addEventListener("change", () => {
    uiSettings.font = setFontEl.value;
    saveUiSettings();
    applyUiSettings();
  });
}
wireSegGroup(setThemeEl, "theme");
wireSegGroup(setSizeEl, "size");
wireSegGroup(setMotionEl, "motion");
wireSegGroup(setDetailEl, "detail");
wireSegGroup(setDeletionsEl, "deletions");
wireSegGroup(setCommandsEl, "commands");

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

// skill chips / Skills view state
let modes = []; // discipline skills, from modes_updated
let modesReceived = false; // has the first modes_updated arrived (vs. still session-start)
let pendingModesNote = false; // set on a set_modes click; consumed by the next modes_updated

const HERO_MODE_IDS = ["grill", "reshape"];
const HERO_MODE_LABELS = { grill: "⚡ grill", reshape: "⟲ reshape" };

// slash-command palette state. The engine ships its real command registry in
// session_started (onSessionStarted adopts it), so the palette can never
// drift; this minimal set only covers the moments before the first session.
let SLASH_COMMANDS = [
  { cmd: "/help", args: "", desc: "all commands" },
  { cmd: "/settings", args: "[<key> <value>]", desc: "show settings, or set one (persisted)" },
  { cmd: "/sessions", args: "", desc: "list saved sessions" },
];
let slashMatches = []; // currently filtered registry rows shown in the palette
let slashSelIdx = 0; // index into slashMatches of the "sel" row
let slashVisible = false;
