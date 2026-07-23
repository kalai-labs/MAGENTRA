// Engine event handlers, the changes panel, and the failure banner.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Engine event handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Changes review panel — accumulates file_edited diffs for the session
// ---------------------------------------------------------------------------

// relPath -> { diffs: string[], adds, dels, count } — every edit this session,
// accumulated: a file edited five times shows all five, never just the latest.
const sessionChanges = new Map();
const sessionChangeOrder = [];

/** Pull the workspace-relative path and +/- counts out of a unified diff. */
function parseDiff(diff, fallbackPath) {
  const lines = diff.split("\n");
  let relPath = fallbackPath;
  let adds = 0;
  let dels = 0;
  for (const line of lines) {
    if (line.startsWith("+++ b/")) relPath = line.slice(6);
    else if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    else if (line.startsWith("+")) adds++;
    else if (line.startsWith("-")) dels++;
  }
  return { relPath, adds, dels };
}

function onFileEdited(event) {
  const { relPath, adds, dels } = parseDiff(event.diff || "", event.path || "file");
  sessionChangeOrder.push({ relPath, diff: event.diff || "" });
  const prev = sessionChanges.get(relPath) || { diffs: [], adds: 0, dels: 0, count: 0 };
  sessionChanges.set(relPath, {
    diffs: [...prev.diffs, event.diff || ""],
    adds: prev.adds + adds,
    dels: prev.dels + dels,
    count: prev.count + 1,
  });
  if (navChangesEl) navChangesEl.classList.remove("hidden");
  renderChanges();
}

function resetChanges() {
  sessionChanges.clear();
  sessionChangeOrder.length = 0;
  if (navChangesEl) navChangesEl.classList.add("hidden");
  renderChanges();
}

function rebuildSessionChanges() {
  sessionChanges.clear();
  for (const edit of sessionChangeOrder) {
    const { relPath, adds, dels } = parseDiff(edit.diff, edit.relPath);
    const prev = sessionChanges.get(relPath) || { diffs: [], adds: 0, dels: 0, count: 0 };
    sessionChanges.set(relPath, {
      diffs: [...prev.diffs, edit.diff],
      adds: prev.adds + adds,
      dels: prev.dels + dels,
      count: prev.count + 1,
    });
  }
}

function discardSessionFileChanges(relPath) {
  for (let index = sessionChangeOrder.length - 1; index >= 0; index--) {
    if (sessionChangeOrder[index].relPath === relPath) sessionChangeOrder.splice(index, 1);
  }
  rebuildSessionChanges();
  renderChanges();
}

function renderChanges() {
  const files = [...sessionChanges.entries()];
  if (dockChangesCountEl) {
    dockChangesCountEl.textContent = String(files.length);
    dockChangesCountEl.classList.toggle("hidden", files.length === 0);
  }
  let totalAdds = 0;
  let totalDels = 0;
  for (const [, c] of files) {
    totalAdds += c.adds;
    totalDels += c.dels;
  }
  if (changesSubEl) {
    changesSubEl.textContent = files.length
      ? `${files.length} file${files.length === 1 ? "" : "s"} · +${totalAdds} −${totalDels}`
      : "no edits yet";
  }
  if (changesEmptyEl) changesEmptyEl.classList.toggle("hidden", files.length > 0);
  if (!changesListEl) return;

  changesListEl.textContent = "";
  for (const [relPath, c] of files) {
    const row = document.createElement("div");
    row.className = "change-file tool-row";

    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = "±";
    row.appendChild(glyph);

    const name = document.createElement("span");
    name.className = "tool-name change-name";
    name.textContent = relPath;
    row.appendChild(name);

    const counts = document.createElement("span");
    counts.className = "change-counts";
    if (c.count > 1) {
      const times = document.createElement("span");
      times.className = "change-times";
      times.textContent = `${c.count} edits `;
      counts.appendChild(times);
    }
    const add = document.createElement("span");
    add.className = "add";
    add.textContent = `+${c.adds}`;
    const del = document.createElement("span");
    del.className = "del";
    del.textContent = `−${c.dels}`;
    counts.append(add, document.createTextNode(" "), del);
    row.appendChild(counts);

    makeRowExpandable(row);
    changesListEl.appendChild(row);

    const detail = document.createElement("div");
    detail.className = "change-diff tool-detail";
    c.diffs.forEach((diff, idx) => {
      if (c.diffs.length > 1) {
        const header = document.createElement("div");
        header.className = "diff-line hunk";
        header.textContent = `── edit ${idx + 1} of ${c.diffs.length} ──`;
        detail.appendChild(header);
      }
      for (const line of diff.split("\n")) {
        if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
        const el = document.createElement("div");
        el.className = "diff-line";
        if (line.startsWith("@@")) el.classList.add("hunk");
        else if (line.startsWith("+")) el.classList.add("add");
        else if (line.startsWith("-")) el.classList.add("del");
        else el.classList.add("ctx");
        el.textContent = line || " ";
        detail.appendChild(el);
      }
    });
    changesListEl.appendChild(detail);
  }
  renderInspectorChanges();
}

if (navChangesEl) navChangesEl.addEventListener("click", () => openInspector("changes"));
if (changesCloseBtnEl) changesCloseBtnEl.addEventListener("click", () => showView("console"));

// ---------------------------------------------------------------------------
// Engine-failure banner — a stranded user always gets an actionable path back
// ---------------------------------------------------------------------------

let engineErrorBannerShown = false;
let engineBannerEl = null;
// True once a fatal error frame has been reported for the current engine start.
// The engine exits (code 1) right after such an error; that exit is a
// consequence, not a second, separate failure — this flag suppresses the
// redundant "engine stopped unexpectedly" message. Reset when a session starts.
let fatalErrorReported = false;

/** Does a failure message point at credentials rather than a crash? Steers
 * which banner action leads — both are always offered, so a wrong guess costs
 * one extra click, never a dead end. */
function looksCredentialError(message) {
  return /api.?key|credential|unauthorized|\b401\b|\b403\b/i.test(message || "");
}

/** Remove the failure banner and re-arm it — a working session (session_started)
 * means the way-back-in is no longer needed. */
function hideEngineErrorBanner() {
  engineErrorBannerShown = false;
  if (engineBannerEl) {
    engineBannerEl.remove();
    engineBannerEl = null;
  }
}

function showEngineErrorBanner(message, kind) {
  if (engineErrorBannerShown || !streamEl) return;
  engineErrorBannerShown = true;
  finalizeAssistantEl();
  const el = document.createElement("div");
  el.className = "engine-banner";
  engineBannerEl = el;
  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);

  const restartBtn = document.createElement("button");
  restartBtn.className = "engine-banner-btn";
  restartBtn.textContent = "RESTART ENGINE ▸";
  restartBtn.addEventListener("click", () => {
    // Let a repeat failure raise a fresh banner instead of dying silently.
    hideEngineErrorBanner();
    window.magentra.restartEngine();
  });

  const setupBtn = document.createElement("button");
  setupBtn.className = "engine-banner-btn";
  setupBtn.textContent = "SET UP CONNECTIONS ▸";
  setupBtn.addEventListener("click", openSetupWizard);

  if (kind === "credential") el.append(setupBtn, restartBtn);
  else el.append(restartBtn, setupBtn);
  withAutoScroll(() => streamEl.appendChild(el));
}

/**
 * A credential/connection failure at engine boot — the friendly path in place of
 * a wall of red. Shows one soft banner, and if the user already has saved
 * connection profiles, opens the wizard straight onto the profile chooser so
 * they just pick one instead of reading an error. No profiles → the banner's
 * "SET UP CONNECTIONS" is the single clear next step.
 */
async function handleCredentialFailure() {
  setStatusLed("error");
  showEngineErrorBanner(
    "This workspace isn't connected yet — pick a saved connection profile, or set one up.",
    "credential",
  );
  if (!window.magentra.listProfiles) return;
  let profiles = [];
  try {
    profiles = (await window.magentra.listProfiles()) || [];
  } catch {
    profiles = [];
  }
  // Only auto-open while nothing is linked (i.e. at open/boot, not mid-session),
  // and only when there's actually a profile to choose.
  if (profiles.length > 0 && !engineLinked) openSetupWizard();
}
