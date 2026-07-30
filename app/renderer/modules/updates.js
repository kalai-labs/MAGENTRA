// The update affordance: a pinned footer in the inspector, plus a dot on the
// inspector toggle so a collapsed panel cannot swallow the notice.
//
// The main process owns the state machine (app/main/updates.js) and broadcasts
// every change. This module only renders what it is told and sends the clicks
// back. See docs/adr/0009-updates-have-two-tiers.md for why one click means
// "install it" on some formats and "download the right file" on others.

"use strict";

/* global window, document, updateFootEl, updateActionEl, updateLabelEl,
   updateBarEl, updateBarFillEl, updateNotesEl, inspectorToggleDotEl */

/** What the button says, and what a click will do, for each status. */
function renderUpdateState(state) {
  if (!updateFootEl || !state) return;

  const { status, tier, version, percent, notesUrl } = state;

  // A development run, or a user who turned the check off: no affordance at all.
  if (status === "disabled") {
    updateFootEl.classList.add("hidden");
    if (inspectorToggleDotEl) inspectorToggleDotEl.classList.add("hidden");
    return;
  }

  updateFootEl.classList.remove("hidden");

  const pending = status === "available" || status === "ready";
  updateFootEl.classList.toggle("pending", pending);
  // The dot exists for the collapsed inspector, so it tracks "needs attention"
  // and not "the footer is showing".
  if (inspectorToggleDotEl) inspectorToggleDotEl.classList.toggle("hidden", !pending);

  const downloading = status === "downloading";
  if (updateBarEl) updateBarEl.classList.toggle("hidden", !downloading);
  if (updateBarFillEl) updateBarFillEl.style.width = `${downloading ? percent || 0 : 0}%`;

  if (updateNotesEl) {
    updateNotesEl.classList.toggle("hidden", !pending);
    updateNotesEl.href = notesUrl || "#";
  }

  updateActionEl.disabled = downloading;

  switch (status) {
    case "available":
      // The assisted tier cannot install itself, so the word is honest about
      // what the click does: it fetches the file for this install's format.
      updateLabelEl.textContent =
        tier === "assisted" ? `↑ Download ${version}` : `↑ Update to ${version}`;
      updateActionEl.title =
        tier === "assisted"
          ? `Download MAGENTRA ${version} for this install`
          : `Download MAGENTRA ${version} and install it on quit`;
      break;
    case "downloading":
      updateLabelEl.textContent = `Downloading ${percent || 0}%`;
      updateActionEl.title = "Downloading the update";
      break;
    case "ready":
      updateLabelEl.textContent = "↑ Restart to finish";
      updateActionEl.title = `MAGENTRA ${version} installs when you quit — restart now to finish`;
      break;
    default:
      // Also the answer when the check failed or the machine is offline: we did
      // not see an update, and this is the only thing the user could act on.
      updateLabelEl.textContent = "Up to date";
      updateActionEl.title = "Check for updates";
      break;
  }
}

async function onUpdateActionClick() {
  const state = await window.magentra.updateState();
  if (!state) return;

  if (state.status === "ready") {
    await window.magentra.installUpdate();
    return;
  }
  if (state.status === "available") {
    await window.magentra.startUpdate();
    return;
  }
  // Resting: the click is a manual re-check, which is what the label promises.
  await window.magentra.checkUpdates();
}

function initUpdateFooter() {
  if (!updateActionEl || !window.magentra.updateState) return;

  updateActionEl.addEventListener("click", () => void onUpdateActionClick());

  if (updateNotesEl) {
    updateNotesEl.addEventListener("click", (event) => {
      event.preventDefault();
      const url = updateNotesEl.href;
      if (url && url !== "#") window.magentra.openExternal(url);
    });
  }

  window.magentra.onUpdateState(renderUpdateState);
  // The window may open after the first check already ran.
  window.magentra.updateState().then(renderUpdateState).catch(() => {});
}

initUpdateFooter();
