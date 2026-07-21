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
// Order matches the settings segmented control: light is the default, dark the
// second choice, matrix the third.
const THEMES = ["light", "workbench", "matrix"];
const DEFAULT_UI_SETTINGS = {
  // JetBrains Mono ships with the app (renderer/fonts), so the default always
  // resolves to the same face on every OS instead of a per-distro fallback.
  font: '"JetBrains Mono", "Cascadia Mono", "DejaVu Sans Mono", monospace',
  size: "14",
  // Whole-interface scale (page zoom), independent of `size` above: `size`
  // sets the type ramp, `zoom` scales everything including the layout tokens.
  zoom: 1.2,
  theme: "light",
  // Matrix-rain strength, 0..1. Ships faint so the rain reads as atmosphere
  // behind the transcript rather than competing with it; the user can raise it
  // toward 1 or drop it to 0. Only has any effect under the matrix theme.
  rainOpacity: 0.35,
  motion: "full",
  // Default to the transparent view: a coding agent's trust rests on the user
  // being able to see what each tool actually did. "cinematic" is opt-in.
  detail: "engineer",
  // The deletion guard is the gate that survives everything — it fires even in
  // OVERDRIVE, so destructive calls (rm, force-push, drop table, terraform
  // destroy, …) still prompt. Setting `deletions` to "allow" is what removes
  // that last prompt.
  deletions: "ask", // "ask" (guard always prompts) | "allow" (deletions run freely)
  // OVERDRIVE: fully autonomous stance (nothing asks — commands run without
  // approval prompts). Persisted so it survives a reload and re-asserts itself
  // on the next engine link, exactly like the safety toggles above.
  overdrive: false,
  // First-enable teaching dialog is shown once, ever; after that, flipping the
  // composer toggle on engages the mode directly.
  overdriveIntroSeen: false,
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
  // First launch on a dark-mode OS opens dark: the theme default follows the
  // OS until the user picks a theme explicitly (which persists and wins).
  // Matrix is never auto-selected — it is a deliberate choice, not a shade.
  if (!("theme" in saved) && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    settings.theme = "workbench";
  }
  // Concept A was a deliberate reset, so the pre-reset atmosphere names are no
  // longer themes. Anything not in THEMES — a legacy atmosphere, a hand-edited
  // localStorage value — collapses to the default rather than leaving the
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
  settings.zoom = clampZoom(settings.zoom);
  settings.rainOpacity = clampUnit(settings.rainOpacity, DEFAULT_UI_SETTINGS.rainOpacity);
  return settings;
}

/** Coerce anything into a 0..1 fraction, falling back to `fallback` for blank
 * or unparseable input (an empty number field hands back "", and Number("") is
 * 0, which would silently read as fully transparent). */
function clampUnit(value, fallback) {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || raw === null || raw === undefined) return fallback;
  const factor = Number(raw);
  if (!Number.isFinite(factor)) return fallback;
  return Math.min(1, Math.max(0, Math.round(factor * 100) / 100));
}

/** Coerce anything — a hand-edited localStorage string, a half-typed field,
 * NaN — into the supported scale range. Out-of-range values clamp rather than
 * reset, so typing "5" lands on the maximum instead of snapping back to 1.0. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
function clampZoom(value) {
  // A number input hands back "" for anything it could not parse, and
  // Number("") is 0 — which would clamp a cleared or mistyped field down to
  // the 0.5 minimum instead of leaving the interface alone. Blank means
  // "no usable value", so it lands on the documented normal.
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || raw === null || raw === undefined) return 1;
  const factor = Number(raw);
  if (!Number.isFinite(factor)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(factor * 100) / 100));
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
  light: { color: "#e7ebf0", symbolColor: "#36424f" },
  workbench: { color: "#0e1114", symbolColor: "#ced6dd" },
  // Matrix's --sidebar carries alpha; the native overlay cannot, so this is
  // that color already composited over --bg.
  matrix: { color: "#040a06", symbolColor: "#b9f5cd" },
};

function applyUiSettings() {
  document.documentElement.dataset.theme = uiSettings.theme;
  document.documentElement.dataset.motion = uiSettings.motion;
  document.documentElement.dataset.detail = uiSettings.detail;
  document.documentElement.style.setProperty("--font-user", uiSettings.font);
  document.documentElement.style.setProperty("--fs-base", uiSettings.size + "px");
  // Whole-interface scale. Page zoom changes the layout viewport, so the
  // stylesheet's responsive breakpoints re-evaluate against the scaled size —
  // zooming in collapses the workbench exactly as narrowing the window does.
  if (window.magentra && window.magentra.setZoom) window.magentra.setZoom(uiSettings.zoom);
  // The rain dial only means anything under the matrix theme, so its row is
  // hidden everywhere else rather than sitting inert in the other two themes.
  const matrix = uiSettings.theme === "matrix";
  if (setRainRowEl) setRainRowEl.classList.toggle("hidden", !matrix);
  if (setRainNoteEl) setRainNoteEl.classList.toggle("hidden", !matrix);
  // Mount / tear down the matrix rain to match the theme and motion setting.
  // Guarded because the first call happens at load, before rain.js (which
  // loads after this module, and takes its own first sync) has defined it.
  if (typeof syncMatrixRain === "function") syncMatrixRain();
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
  if (setZoomEl) setZoomEl.value = String(uiSettings.zoom);
  if (setRainOpacityEl) setRainOpacityEl.value = String(uiSettings.rainOpacity);
  syncSegGroup(setThemeEl, "theme");
  syncSegGroup(setSizeEl, "size");
  syncSegGroup(setMotionEl, "motion");
  syncSegGroup(setDetailEl, "detail");
  syncSegGroup(setDeletionsEl, "deletions");
}

// Safety toggles reach the engine as frames; only send what actually changed
// (a fresh session gets a forced full send since it boots with defaults).
const lastSentSafety = { deletions: null, overdrive: null };
function applySafetySettings(force) {
  if (window.magentra && window.magentra.send) {
    if (force || uiSettings.deletions !== lastSentSafety.deletions) {
      window.magentra.send({ type: "set_deletion_guard", enabled: uiSettings.deletions !== "allow" });
      lastSentSafety.deletions = uiSettings.deletions;
    }
    // OVERDRIVE rides the same re-send-on-link pattern: a fresh session boots
    // with the mode off, so a forced send re-asserts the user's saved choice.
    if (force || uiSettings.overdrive !== lastSentSafety.overdrive) {
      window.magentra.send({ type: "set_overdrive", enabled: uiSettings.overdrive === true });
      lastSentSafety.overdrive = uiSettings.overdrive;
    }
  }
  renderSafetyHint();
}

// Footer hint for the two-state safety model: commands prompt for approval on
// every consequential tool unless OVERDRIVE is engaged, and the deletion guard
// prompts on destructive calls unless Deletions is set to allow.
function renderSafetyHint() {
  const acting = uiSettings.overdrive ? "autonomous" : "asks before commands";
  const deleting = uiSettings.deletions === "allow" ? "deletions allowed" : "deletions always ask";
  if (hintAutoEl) hintAutoEl.textContent = `${acting} · ${deleting}`;
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
/** Commit a typed or reset scale. The field is rewritten from the clamped
 * value so an out-of-range entry visibly corrects itself instead of leaving
 * the box disagreeing with the interface it just scaled. */
function commitZoom(value) {
  uiSettings.zoom = clampZoom(value);
  if (setZoomEl) setZoomEl.value = String(uiSettings.zoom);
  saveUiSettings();
  applyUiSettings();
}

/** Electron's native View▸Zoom accelerators (Ctrl/Cmd +, −, 0) stay live
 * wherever the app menu is not nulled — dev runs and macOS — and move the frame
 * zoom without going through this setting. Re-reading the real factor whenever
 * the settings view opens keeps the field honest instead of showing a stale
 * 1.0 over a zoomed interface. A factor outside the supported range snaps back
 * into it, which is also what makes the reading safe to persist. */
function adoptExternalZoom() {
  if (!window.magentra || !window.magentra.getZoom) return;
  const actual = clampZoom(window.magentra.getZoom());
  if (actual === uiSettings.zoom) return;
  commitZoom(actual);
}

if (setZoomEl) {
  // `change` (blur / Enter / stepper) rather than `input`: re-zooming on every
  // keystroke would rescale the page mid-word, moving the field under the cursor.
  setZoomEl.addEventListener("change", () => commitZoom(setZoomEl.value));
}
if (setZoomResetBtnEl) setZoomResetBtnEl.addEventListener("click", () => commitZoom(1));

if (setRainOpacityEl) {
  // `change`, not `input`: applyUiSettings re-syncs the rain, and rescaling it
  // on every keystroke would flicker the canvas mid-entry. The field is
  // rewritten from the clamped value so an out-of-range entry visibly corrects.
  setRainOpacityEl.addEventListener("change", () => {
    uiSettings.rainOpacity = clampUnit(setRainOpacityEl.value, DEFAULT_UI_SETTINGS.rainOpacity);
    setRainOpacityEl.value = String(uiSettings.rainOpacity);
    saveUiSettings();
    applyUiSettings();
  });
}

wireSegGroup(setThemeEl, "theme");
wireSegGroup(setSizeEl, "size");
wireSegGroup(setMotionEl, "motion");
wireSegGroup(setDetailEl, "detail");
wireSegGroup(setDeletionsEl, "deletions");

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
