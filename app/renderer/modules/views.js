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
}

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

function openModalA11y(modalEl, initialFocusEl) {
  modalRestoreFocus = document.activeElement;
  modalTrapEl = modalEl;
  document.addEventListener("keydown", onModalTrapKeydown, true);
  const target = initialFocusEl || modalFocusables(modalEl)[0];
  if (target) target.focus();
}

function closeModalA11y() {
  if (!modalTrapEl) return;
  modalTrapEl = null;
  document.removeEventListener("keydown", onModalTrapKeydown, true);
  if (modalRestoreFocus && typeof modalRestoreFocus.focus === "function") modalRestoreFocus.focus();
  modalRestoreFocus = null;
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
