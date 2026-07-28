// READABILITY: the optional finishing pass — after a turn that changed code,
// Magentra spends one last round reading its own diff for cleanliness and for
// anything the user still has to be told.
//
// It sits in the composer slot CAREFUL vacated, but it is not CAREFUL's
// replacement in behaviour: CAREFUL was a modifier of OVERDRIVE and only existed
// while that stance was engaged, so its pill hid itself. This modifies no
// stance. It applies in either one, it is always visible, and it rides its own
// set_readability frame instead of hitching to set_overdrive.
//
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

/** Paint the pill and the shell from uiSettings.readability. No engine traffic —
 * the pure "make the UI match the state" step, safe on boot restore and on every
 * engine-driven sync. */
function applyReadabilityShell() {
  const on = uiSettings.readability === true;
  document.documentElement.dataset.readability = on ? "on" : "off";
  if (!readabilityBtnEl) return;
  readabilityBtnEl.classList.toggle("on", on);
  readabilityBtnEl.setAttribute("aria-pressed", on ? "true" : "false");
  readabilityBtnEl.title = on
    ? "READABILITY on — after a code change, Magentra takes one last pass to clean it up and tell you what's left. Click to turn off."
    : "READABILITY — after a code change, one last pass to clean it up and tell you what's left";
}

function onReadabilityToggleClick() {
  uiSettings.readability = !uiSettings.readability;
  saveUiSettings();
  applySafetySettings(false); // sends set_readability
  applyReadabilityShell();
  announce(
    uiSettings.readability
      ? "Readability pass on — Magentra will tidy its own change and report what is left before ending a turn."
      : "Readability pass off.",
  );
}

/** The engine changed the setting on its own (the /readability slash command, or
 * a session resume). Adopt it without echoing back. */
function onReadabilityChanged(event) {
  const enabled = Boolean(event && event.enabled);
  // Reflect on the pane that owns this event — the setting is per-engine, so
  // each tiled screen keeps its own.
  const tabId =
    (typeof dispatchTabId !== "undefined" && dispatchTabId) ||
    (typeof focusedTabId !== "undefined" ? focusedTabId : null);
  if (typeof setTabReadability === "function" && tabId) {
    setTabReadability(tabId, enabled, false);
  }
  // The shared pill and the persisted default track the FOCUSED tab only — a
  // background tab changing its own setting must not change the app's.
  if (typeof chromeIsFocused === "function" && !chromeIsFocused()) return;
  uiSettings.readability = enabled;
  lastSentSafety.readability = enabled; // engine is already there; don't re-send
  saveUiSettings();
  applyReadabilityShell();
}

if (readabilityBtnEl) readabilityBtnEl.addEventListener("click", onReadabilityToggleClick);

// Reflect the persisted state on first paint, before any engine event can
// arrive. The engine send itself rides applySafetySettings.
applyReadabilityShell();
