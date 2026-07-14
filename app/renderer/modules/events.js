// Engine event handlers, the changes panel, and the failure banner.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Engine event handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Changes review panel — accumulates file_edited diffs for the session
// ---------------------------------------------------------------------------

// relPath -> { diff, adds, dels, count }
const sessionChanges = new Map();

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
  const prev = sessionChanges.get(relPath);
  sessionChanges.set(relPath, {
    diff: event.diff || "",
    adds,
    dels,
    count: (prev ? prev.count : 0) + 1,
  });
  if (navChangesEl) navChangesEl.classList.remove("hidden");
  renderChanges();
}

function resetChanges() {
  sessionChanges.clear();
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
    const add = document.createElement("span");
    add.className = "add";
    add.textContent = `+${c.adds}`;
    const del = document.createElement("span");
    del.className = "del";
    del.textContent = `−${c.dels}`;
    counts.append(add, document.createTextNode(" "), del);
    row.appendChild(counts);

    row.addEventListener("click", () => row.classList.toggle("open"));
    changesListEl.appendChild(row);

    const detail = document.createElement("div");
    detail.className = "change-diff tool-detail";
    for (const line of c.diff.split("\n")) {
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
    changesListEl.appendChild(detail);
  }
}

if (navChangesEl) navChangesEl.addEventListener("click", () => showView("changes"));
if (changesCloseBtnEl) changesCloseBtnEl.addEventListener("click", () => showView("console"));

// ---------------------------------------------------------------------------
// Engine-failure banner — a stranded user always gets an actionable path back
// ---------------------------------------------------------------------------

let engineErrorBannerShown = false;

function showEngineErrorBanner(message) {
  if (engineErrorBannerShown || !streamEl) return;
  engineErrorBannerShown = true;
  finalizeAssistantEl();
  const el = document.createElement("div");
  el.className = "engine-banner";
  const text = document.createElement("span");
  text.textContent = message;
  const btn = document.createElement("button");
  btn.className = "engine-banner-btn";
  btn.textContent = "SET UP ENGINE ▸";
  btn.addEventListener("click", openSetupWizard);
  el.append(text, btn);
  withAutoScroll(() => streamEl.appendChild(el));
}
