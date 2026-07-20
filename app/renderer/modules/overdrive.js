// OVERDRIVE mode: the composer toggle, the first-enable teaching dialog, the
// engage cinematic, and the shell-identity + engine sync it all drives.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// The two disciplines the dialog recommends for unattended runs. Kept here so
// the checkbox markup and the engage handler agree on one source of truth.
const OVERDRIVE_SKILL_IDS = ["prover", "sentinel"];

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
      : "OVERDRIVE — fully autonomous mode (self-verifying, no caps)";
  }
}

// ---------------------------------------------------------------------------
// Engage cinematic — pure CSS, driven by a class. The app's motion controls
// (data-motion="calm" and prefers-reduced-motion) collapse the sweep to an
// instant flash on their own; we only shorten the cleanup timer to match.
// ---------------------------------------------------------------------------

let overdriveCinematicTimer = null;

function overdriveMotionReduced() {
  if (uiSettings.motion === "calm") return true;
  return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function playOverdriveCinematic() {
  if (!overdriveCinematicEl) return;
  const reduced = overdriveMotionReduced();
  overdriveCinematicEl.classList.remove("hidden");
  // Force a reflow so a rapid re-engage restarts the animation cleanly.
  void overdriveCinematicEl.offsetWidth;
  overdriveCinematicEl.classList.add("playing");
  clearTimeout(overdriveCinematicTimer);
  overdriveCinematicTimer = setTimeout(() => {
    overdriveCinematicEl.classList.remove("playing");
    overdriveCinematicEl.classList.add("hidden");
  }, reduced ? 320 : 1900);
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
  syncActivityUi(); // busy placeholder flips to the steering hint
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

/** ENGAGE from the dialog: activate whichever recommended skills are still
 * checked (same set_modes frame the Skills panel uses), remember the intro was
 * seen, then engage. */
function confirmOverdriveDialog() {
  const checkedIds = OVERDRIVE_SKILL_IDS.filter((id) => {
    const box = overdriveDialogEl.querySelector(`input[data-skill="${id}"]`);
    return box && box.checked;
  });
  if (checkedIds.length > 0) {
    pendingModesNote = true;
    window.magentra.setModes([...new Set([...activeSkillIds(), ...checkedIds])]);
    for (const m of modes) if (checkedIds.includes(m.id)) m.active = true;
    renderSkillsSurfaces();
  }
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
  uiSettings.overdrive = enabled;
  lastSentSafety.overdrive = enabled; // engine is already there; don't re-send
  saveUiSettings();
  applyOverdriveShell();
  syncActivityUi();
}

if (overdriveBtnEl) overdriveBtnEl.addEventListener("click", onOverdriveToggleClick);
if (overdriveEngageBtnEl) overdriveEngageBtnEl.addEventListener("click", confirmOverdriveDialog);
if (overdriveCancelBtnEl) overdriveCancelBtnEl.addEventListener("click", closeOverdriveDialog);

// Reflect the persisted state on first paint (attribute + button), before any
// engine event can arrive. The engine send itself rides applySafetySettings.
applyOverdriveShell();
