// View switching (dock nav / stage) and the liveness strip.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// View switching (dock nav / stage)
// ---------------------------------------------------------------------------

const STAGE_VIEWS = {
  console: consoleViewEl,
  sessions: sessionsViewEl,
  team: teamViewEl,
  lab: labViewEl,
  changes: changesViewEl,
  settings: settingsViewEl,
  skills: skillsViewEl,
};

function showView(name) {
  for (const [key, el] of Object.entries(STAGE_VIEWS)) {
    if (!el) continue;
    el.classList.toggle("hidden", key !== name);
  }
  document.body.dataset.view = name;
  navConsoleEl.classList.toggle("active", name === "console");
  navSessionsEl.classList.toggle("active", name === "sessions");
  teamBtnEl.classList.toggle("active", name === "team");
  navLabEl.classList.toggle("active", name === "lab");
  navChangesEl.classList.toggle("active", name === "changes");
  navSettingsEl.classList.toggle("active", name === "settings");
  if (navSkillsEl) navSkillsEl.classList.toggle("active", name === "skills");
}

// ---------------------------------------------------------------------------
// In-app menu bar. The OS title bar (and its native menu) is gone — the top
// strip carries the app's own FILE / SESSION / VIEW / HELP menus, themed like
// everything else. Actions reference functions from later-loaded modules;
// that is safe because they only run on click.
// ---------------------------------------------------------------------------

const MENU_BAR = [
  {
    label: "FILE",
    items: [
      { label: "Open Workspace…", action: () => handleChooseWorkspace() },
      { label: "Open Logs Folder", action: () => window.magentra.openLogs() },
      { sep: true },
      { label: "Quit", action: () => window.close() },
    ],
  },
  {
    label: "SESSION",
    items: [
      { label: "New Session", hint: "Ctrl+L", needsWorkspace: true, action: () => requestClear() },
      { label: "Saved Sessions…", hint: "Ctrl+2", needsWorkspace: true, action: () => { showView("sessions"); requestSessionList(); } },
      { sep: true },
      { label: "Compact Context", needsWorkspace: true, action: () => sendSlashCommand("/compact") },
      { label: "Session Bill", needsWorkspace: true, action: () => { showView("console"); sendSlashCommand("/session"); } },
      { label: "Interrupt Turn", hint: "Esc", needsWorkspace: true, action: () => hardStop() },
    ],
  },
  {
    label: "VIEW",
    items: [
      { label: "Console", hint: "Ctrl+1", action: () => showView("console") },
      { label: "Sessions", hint: "Ctrl+2", needsWorkspace: true, action: () => { showView("sessions"); requestSessionList(); } },
      { label: "Crew", hint: "Ctrl+3", needsWorkspace: true, action: () => showView("team") },
      { label: "Missions", hint: "Ctrl+4", needsWorkspace: true, action: () => showView("lab") },
      { label: "Changes", hint: "Ctrl+5", needsWorkspace: true, action: () => showView("changes") },
      { label: "Settings", hint: "Ctrl+6", action: () => { showView("settings"); void loadConnectionCard(); } },
      { label: "Skills", hint: "Ctrl+7", needsWorkspace: true, action: () => showView("skills") },
    ],
  },
  {
    label: "HELP",
    items: [
      { label: "Keyboard Shortcuts", hint: "?", action: () => toggleShortcutSheet() },
      { label: "Take the Tour", needsWorkspace: true, action: () => startTour(true) },
      { label: "All Commands (/help)", needsWorkspace: true, action: () => { showView("console"); sendSlashCommand("/help"); } },
      { label: "Glossary", action: () => showView("settings") },
    ],
  },
];

let openMenuEl = null; // the open dropdown panel, if any

function closeOpenMenu() {
  if (!openMenuEl) return false;
  openMenuEl.remove();
  openMenuEl = null;
  for (const btn of menuBarEl.querySelectorAll(".menu-root")) btn.classList.remove("open");
  return true;
}

function openMenu(btn) {
  closeOpenMenu();
  const panel = document.createElement("div");
  panel.className = "menu-panel";
  panel.setAttribute("role", "menu");
  const rect = btn.getBoundingClientRect();
  panel.style.left = `${Math.max(8, rect.right - 228)}px`;
  panel.style.top = `${rect.bottom + 5}px`;
  for (const menu of MENU_BAR) {
    const group = document.createElement("div");
    group.className = "menu-group-label";
    group.textContent = menu.label;
    panel.appendChild(group);
    for (const item of menu.items) {
      if (item.sep) {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        panel.appendChild(sep);
        continue;
      }
      const row = document.createElement("button");
      row.className = "menu-item";
      row.setAttribute("role", "menuitem");
      row.disabled = Boolean(item.needsWorkspace) && !workspaceOpen;
      const labelEl = document.createElement("span");
      labelEl.textContent = item.label;
      row.appendChild(labelEl);
      if (item.hint) {
        const hintEl = document.createElement("span");
        hintEl.className = "menu-hint";
        hintEl.textContent = item.hint;
        row.appendChild(hintEl);
      }
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        closeOpenMenu();
        item.action();
      });
      panel.appendChild(row);
    }
  }
  btn.classList.add("open");
  document.body.appendChild(panel);
  openMenuEl = panel;
}

const menuRootBtn = document.createElement("button");
menuRootBtn.className = "menu-root";
menuRootBtn.textContent = "•••";
menuRootBtn.title = "Application menu";
menuRootBtn.setAttribute("aria-label", "Application menu");
menuRootBtn.setAttribute("aria-haspopup", "menu");
menuRootBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  if (menuRootBtn.classList.contains("open")) closeOpenMenu();
  else openMenu(menuRootBtn);
});
menuBarEl.appendChild(menuRootBtn);
document.addEventListener("click", () => closeOpenMenu());

// ---------------------------------------------------------------------------
// Modal accessibility: focus the first control on open, trap Tab inside the
// dialog (nothing behind the scrim is reachable), restore focus on close.
// ---------------------------------------------------------------------------

let modalRestoreFocus = null;
let modalTrapEl = null;

function modalFocusables(modalEl) {
  return [...modalEl.querySelectorAll("button, input, select, textarea, [tabindex]")].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );
}

function onModalTrapKeydown(e) {
  if (e.key !== "Tab" || !modalTrapEl) return;
  const items = modalFocusables(modalTrapEl);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// Both focus moves pass preventScroll. Focusing an element normally scrolls it
// into view, and the element focus returns to on close is often a .tool-row far
// up the scrollback — restoring it yanked the transcript away from the live
// edge every time an approval modal closed. The user's scroll position is not
// the modal's to move; it was already correct when the modal opened.
function openModalA11y(modalEl, initialFocusEl) {
  modalRestoreFocus = document.activeElement;
  modalTrapEl = modalEl;
  document.addEventListener("keydown", onModalTrapKeydown, true);
  const target = initialFocusEl || modalFocusables(modalEl)[0];
  if (target) target.focus({ preventScroll: true });
}

function closeModalA11y() {
  if (!modalTrapEl) return;
  modalTrapEl = null;
  document.removeEventListener("keydown", onModalTrapKeydown, true);
  if (modalRestoreFocus && typeof modalRestoreFocus.focus === "function") {
    modalRestoreFocus.focus({ preventScroll: true });
  }
  modalRestoreFocus = null;
}

// ---------------------------------------------------------------------------
// Text prompt modal. Electron does not implement window.prompt (it throws),
// so every "ask the user for one string" flow goes through this instead.
// Resolves with the entered string, or null on cancel/Escape.
// ---------------------------------------------------------------------------

let promptModalResolve = null;

function settlePromptModal(value) {
  if (!promptModalResolve) return;
  const resolve = promptModalResolve;
  promptModalResolve = null;
  promptModalEl.classList.add("hidden");
  closeModalA11y();
  resolve(value);
}

function showPromptModal({ title, hint = "", value = "", placeholder = "" }) {
  // A second prompt while one is open cancels the first — never two resolvers.
  settlePromptModal(null);
  promptModalTitleEl.textContent = title;
  promptModalHintEl.textContent = hint;
  promptModalHintEl.classList.toggle("hidden", hint === "");
  promptModalInputEl.value = value;
  promptModalInputEl.placeholder = placeholder;
  promptModalEl.classList.remove("hidden");
  openModalA11y(promptModalEl, promptModalInputEl);
  promptModalInputEl.select();
  return new Promise((resolve) => {
    promptModalResolve = resolve;
  });
}

if (promptModalOkEl) {
  promptModalOkEl.addEventListener("click", () => settlePromptModal(promptModalInputEl.value));
  promptModalCancelEl.addEventListener("click", () => settlePromptModal(null));
  promptModalInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      settlePromptModal(promptModalInputEl.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // the global Escape chain must not also fire
      settlePromptModal(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Screen-reader live announcements: batched, meaningful moments only —
// streaming every text delta would make NVDA/Orca unusable.
// ---------------------------------------------------------------------------

function announce(text) {
  if (!srAnnounceEl) return;
  srAnnounceEl.textContent = text;
}

// ---------------------------------------------------------------------------
// Now-line: liveness strip
// ---------------------------------------------------------------------------

function formatTurnElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderNowText() {
  if (nowOverrideText !== null) {
    nowTextEl.textContent = nowOverrideText;
    return;
  }
  const elapsedSec = nowActivityStart ? Math.floor((Date.now() - nowActivityStart) / 1000) : 0;
  nowTextEl.textContent = "";
  const verbEl = document.createElement("span");
  verbEl.className = "now-verb";
  verbEl.textContent = nowVerb;
  nowTextEl.appendChild(verbEl);
  const tail = nowDetail ? ` · ${nowDetail} · ${elapsedSec}s` : ` · ${elapsedSec}s`;
  nowTextEl.appendChild(document.createTextNode(tail));
}

function setNowActivity(verb, detail) {
  nowVerb = verb;
  nowDetail = detail || "";
  nowActivityStart = Date.now();
  renderNowText();
}

function showNowOverride(text) {
  nowOverrideText = text;
  renderNowText();
  if (nowOverrideTimeoutId) clearTimeout(nowOverrideTimeoutId);
  nowOverrideTimeoutId = setTimeout(() => {
    nowOverrideText = null;
    nowOverrideTimeoutId = null;
    renderNowText();
  }, 4000);
}

function tickNowLine() {
  if (nowTurnStart) {
    nowTimerEl.textContent = formatTurnElapsed(Date.now() - nowTurnStart);
  }
  renderNowText();
}

function startNowLine() {
  nowLineEl.classList.remove("hidden");
  nowTurnStart = Date.now();
  nowOverrideText = null;
  if (nowOverrideTimeoutId) {
    clearTimeout(nowOverrideTimeoutId);
    nowOverrideTimeoutId = null;
  }
  setNowActivity("thinking", "");
  nowTimerEl.textContent = "0:00";

  nowSpinnerIdx = 0;
  if (nowSpinnerIntervalId) clearInterval(nowSpinnerIntervalId);
  nowSpinnerIntervalId = setInterval(() => {
    nowSpinnerIdx = (nowSpinnerIdx + 1) % NOW_SPINNER_FRAMES.length;
    nowSpinnerEl.textContent = NOW_SPINNER_FRAMES[nowSpinnerIdx];
  }, 90);

  if (nowTickIntervalId) clearInterval(nowTickIntervalId);
  nowTickIntervalId = setInterval(tickNowLine, 1000);
}

function stopNowLine() {
  nowLineEl.classList.add("hidden");
  if (nowSpinnerIntervalId) {
    clearInterval(nowSpinnerIntervalId);
    nowSpinnerIntervalId = null;
  }
  if (nowTickIntervalId) {
    clearInterval(nowTickIntervalId);
    nowTickIntervalId = null;
  }
  if (nowOverrideTimeoutId) {
    clearTimeout(nowOverrideTimeoutId);
    nowOverrideTimeoutId = null;
  }
  nowOverrideText = null;
  nowTurnStart = null;
  nowActivityStart = null;
}
