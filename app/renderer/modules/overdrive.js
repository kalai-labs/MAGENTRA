// OVERDRIVE mode: the composer toggle, the first-enable teaching dialog, the
// engage cinematic, and the shell-identity + engine sync it all drives.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Shell identity — button + document attribute reflect the live state.
// ---------------------------------------------------------------------------

/** Paint the toggle and the shell from uiSettings.overdrive. No engine traffic,
 * no animation — the pure "make the UI match the state" step, safe to call on
 * boot restore and on every engine-driven sync. */
function applyOverdriveShell() {
  const on = uiSettings.overdrive === true;
  document.documentElement.dataset.overdrive = on ? "on" : "off";
  if (overdriveBtnEl) {
    overdriveBtnEl.classList.toggle("on", on);
    overdriveBtnEl.setAttribute("aria-pressed", on ? "true" : "false");
    overdriveBtnEl.title = on
      ? "OVERDRIVE active — fully autonomous. Click to disengage."
      : "OVERDRIVE — fully autonomous stance (nothing asks)";
  }
  applyCarefulShell();
  // The footer safety hint reads OVERDRIVE state, so keep it in step on every
  // change — including engine-driven ones that skip applySafetySettings.
  renderSafetyHint();
}

/** Paint the CAREFUL pill. It only exists while OVERDRIVE is engaged — the mode
 * is a modifier of that stance, and a toggle that does nothing where it stands
 * is worse than no toggle at all. The setting itself survives being hidden. */
function applyCarefulShell() {
  const overdriveOn = uiSettings.overdrive === true;
  // Withdrawn beta: the pill stays hidden and the shell stays "off" whatever the
  // stored setting says. See CAREFUL_MODE_ENABLED in state.js.
  const on = CAREFUL_MODE_ENABLED && uiSettings.careful === true;
  document.documentElement.dataset.careful = overdriveOn && on ? "on" : "off";
  if (!carefulBtnEl) return;
  carefulBtnEl.classList.toggle("hidden", !overdriveOn || !CAREFUL_MODE_ENABLED);
  carefulBtnEl.classList.toggle("on", on);
  carefulBtnEl.setAttribute("aria-pressed", on ? "true" : "false");
  carefulBtnEl.title = on
    ? "CAREFUL active — substantial requests present a short proposal for your approval first. Click to turn off."
    : "CAREFUL — propose a direction and wait for approval before acting";
}

function onCarefulToggleClick() {
  uiSettings.careful = !uiSettings.careful;
  saveUiSettings();
  applySafetySettings(false); // rides the set_overdrive frame
  applyCarefulShell();
  announce(
    uiSettings.careful
      ? "CAREFUL mode on — Magentra will propose a direction for your approval before acting."
      : "CAREFUL mode off.",
  );
}

// ---------------------------------------------------------------------------
// Engage cinematic — pure CSS, driven by a class. The app's motion controls
// (data-motion="calm" and prefers-reduced-motion) collapse the sweep to an
// instant flash on their own; we only shorten the cleanup timer to match.
// ---------------------------------------------------------------------------

// One timer per cinematic element (the shared full-window one, and one per tiled
// pane) so a re-engage restarts only its own sweep. Keyed by the element itself:
// a pane's cinematic lives and dies with its pane.
const overdriveCinematicTimers = new WeakMap();

function overdriveMotionReduced() {
  if (uiSettings.motion === "calm") return true;
  return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** The cinematic layer inside a tiled pane, created on first use. Same markup
 * and same classes as the shared full-window one — only the host differs, so the
 * animation a single console plays is exactly the animation a pane plays,
 * bounded by that pane instead of the window. */
function paneCinematicEl(paneEl) {
  let el = paneEl.querySelector(":scope > .overdrive-cinematic");
  if (!el) {
    el = document.createElement("div");
    el.className = "overdrive-cinematic in-pane hidden";
    el.setAttribute("aria-hidden", "true");
    const veil = document.createElement("div");
    veil.className = "od-veil";
    const word = document.createElement("div");
    word.className = "od-word";
    word.textContent = "OVERDRIVE";
    el.append(veil, word);
    paneEl.appendChild(el);
  }
  return el;
}

/** Play the engage sweep. Without a pane it fills the window (single console);
 * with one it is bounded to that screen — the tiled equivalent. */
function playOverdriveCinematic(paneEl) {
  const el = paneEl ? paneCinematicEl(paneEl) : overdriveCinematicEl;
  if (!el) return;
  const reduced = overdriveMotionReduced();
  el.classList.remove("hidden");
  // Force a reflow so a rapid re-engage restarts the animation cleanly.
  void el.offsetWidth;
  el.classList.add("playing");
  clearTimeout(overdriveCinematicTimers.get(el));
  overdriveCinematicTimers.set(
    el,
    setTimeout(() => {
      el.classList.remove("playing");
      el.classList.add("hidden");
    }, reduced ? 320 : 1900),
  );
}

// ---------------------------------------------------------------------------
// Engage / disengage.
// ---------------------------------------------------------------------------

/** Turn the mode on. `fromUser` gates the cinematic — a boot restore or an
 * overdrive_changed sync must never fire it. */
function engageOverdrive(fromUser) {
  uiSettings.overdrive = true;
  saveUiSettings();
  applySafetySettings(false); // sends set_overdrive (the changed toggle)
  applyOverdriveShell();
  syncActivityUi(); // repaint composer/footer for the new safety stance
  if (fromUser) {
    playOverdriveCinematic();
    announce("OVERDRIVE engaged — fully autonomous mode.");
  }
}

function disengageOverdrive() {
  uiSettings.overdrive = false;
  saveUiSettings();
  applySafetySettings(false);
  applyOverdriveShell();
  syncActivityUi();
  announce("OVERDRIVE disengaged.");
}

// ---------------------------------------------------------------------------
// First-enable dialog.
// ---------------------------------------------------------------------------

function openOverdriveDialog() {
  if (!overdriveDialogEl) return;
  overdriveDialogEl.classList.remove("hidden");
  openModalA11y(overdriveDialogEl, overdriveEngageBtnEl);
}

function closeOverdriveDialog() {
  if (!overdriveDialogEl) return;
  overdriveDialogEl.classList.add("hidden");
  closeModalA11y();
}

/** ENGAGE from the dialog: remember the intro was seen, then engage. */
function confirmOverdriveDialog() {
  uiSettings.overdriveIntroSeen = true;
  saveUiSettings();
  closeOverdriveDialog();
  engageOverdrive(true);
}

// ---------------------------------------------------------------------------
// Toggle click + engine sync.
// ---------------------------------------------------------------------------

function onOverdriveToggleClick() {
  if (uiSettings.overdrive) {
    // ON → off immediately: no dialog, no cinematic.
    disengageOverdrive();
    return;
  }
  // OFF → on: the teaching dialog the very first time ever, direct after that.
  if (!uiSettings.overdriveIntroSeen) {
    openOverdriveDialog();
    return;
  }
  engageOverdrive(true);
}

/** The engine changed the mode on its own (the /overdrive slash command, or a
 * session resume). Adopt it without echoing back and without the cinematic. */
function onOverdriveChanged(event) {
  const enabled = Boolean(event && event.enabled);
  // CAREFUL rides this frame. Absent means "unchanged" (an engine that predates
  // the field), so only adopt it when the field is actually present — and never
  // while the mode is a withdrawn beta, so an older engine or a transcript that
  // still carries the flag cannot re-arm it behind the hidden pill.
  const carefulSent = CAREFUL_MODE_ENABLED && event && typeof event.careful === "boolean";
  // Reflect on the pane that owns this event — overdrive is per-engine, so each
  // tiled screen keeps its own state and glow.
  const tabId =
    (typeof dispatchTabId !== "undefined" && dispatchTabId) ||
    (typeof focusedTabId !== "undefined" ? focusedTabId : null);
  if (typeof setTabOverdrive === "function" && tabId) {
    setTabOverdrive(tabId, enabled, false, carefulSent ? event.careful : undefined);
  }
  // The shared button, document shell, and persisted default track the FOCUSED
  // tab only — a background tab flipping its own stance must not flip the app.
  if (typeof chromeIsFocused === "function" && !chromeIsFocused()) return;
  uiSettings.overdrive = enabled;
  lastSentSafety.overdrive = enabled; // engine is already there; don't re-send
  if (carefulSent) {
    uiSettings.careful = event.careful;
    lastSentSafety.careful = event.careful;
  }
  saveUiSettings();
  applyOverdriveShell();
  syncActivityUi();
}

if (overdriveBtnEl) overdriveBtnEl.addEventListener("click", onOverdriveToggleClick);
// No listener while CAREFUL is a withdrawn beta — the pill is hidden, and an
// unhidden one must still do nothing. See CAREFUL_MODE_ENABLED in state.js.
if (carefulBtnEl && CAREFUL_MODE_ENABLED) carefulBtnEl.addEventListener("click", onCarefulToggleClick);
if (overdriveEngageBtnEl) overdriveEngageBtnEl.addEventListener("click", confirmOverdriveDialog);
if (overdriveCancelBtnEl) overdriveCancelBtnEl.addEventListener("click", closeOverdriveDialog);

// Reflect the persisted state on first paint (attribute + button), before any
// engine event can arrive. The engine send itself rides applySafetySettings.
applyOverdriveShell();
