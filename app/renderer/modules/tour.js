// First-run teaching tour: a spotlight overlay that walks the real UI once
// after the first workspace opens. Skippable at any step, re-runnable from
// the application menu (HELP → Take the Tour).
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

const TOUR_DONE_KEY = "magentra-tour-done";
let tourStepIdx = 0;
let tourActive = false;

const TOUR_STEPS = [
  {
    target: ".sidebar-section-workspaces",
    title: "Workspaces",
    copy: "Your folders live here. Click one to switch; ＋ opens a new folder. Everything the agent does happens inside the active workspace.",
  },
  {
    target: "#composer .composer-inner",
    title: "Ask Magentra anything",
    copy: "Type what you want done — plans, edits, questions. / opens the command palette, Esc stops a running turn, and anything you type mid-turn queues as a follow-up.",
  },
  {
    target: "#permissionMenuBtn",
    title: "You control the permissions",
    copy: "Ask before changes reviews consequential commands first. Autonomous applies edits automatically. Deletions always ask.",
  },
  {
    target: "#overdriveBtn",
    title: "OVERDRIVE",
    copy: "Flip this for a fully autonomous run — no caps, self-verifying, deletes inside the workspace without asking. Keep typing to steer it mid-run; Esc stops it.",
  },
  {
    target: "#modelSelect",
    title: "Pick the model",
    copy: "Each entry shows its price per million tokens (in / out). Switching models restarts the session on the new one.",
  },
  {
    target: "#navSkills",
    title: "Skills",
    copy: "Skills shape how the agent works — all off by default, nothing locked. Enable the ★ Recommended set with one click, read each skill's ? to see why it helps, or create your own from a plain-language description.",
  },
  {
    target: "#taskRail",
    title: "Tasks, changes, crew",
    copy: "The inspector shows the agent's live task list, every file edit as a reviewable diff (undo included), and your crew of specialists.",
  },
  {
    target: "#sidebarSessionsList",
    title: "Sessions & missions",
    copy: "Every conversation is saved — resume any of them from here. Missions are standing directives the lab runs on demand or on a schedule.",
  },
  {
    target: null, // centered wrap-up card
    title: "That's the workbench",
    copy: "Press ? any time for keyboard shortcuts. You can replay this tour from the application menu (⋯ → Take the Tour). Now open a task and put the agent to work.",
  },
];

function tourDone() {
  try {
    return Boolean(localStorage.getItem(TOUR_DONE_KEY));
  } catch {
    return true; // no storage — never nag every launch
  }
}

function markTourDone() {
  try {
    localStorage.setItem(TOUR_DONE_KEY, "1");
  } catch {
    // storage unavailable — it may show again next launch, harmless
  }
}

function positionTourStep() {
  const step = TOUR_STEPS[tourStepIdx];
  if (!step) return;
  const target = step.target ? document.querySelector(step.target) : null;
  const rect = target ? target.getBoundingClientRect() : null;
  const visible = rect && rect.width > 0 && rect.height > 0;

  if (visible) {
    const pad = 6;
    tourSpotEl.style.display = "block";
    tourSpotEl.style.left = `${rect.left - pad}px`;
    tourSpotEl.style.top = `${rect.top - pad}px`;
    tourSpotEl.style.width = `${rect.width + pad * 2}px`;
    tourSpotEl.style.height = `${rect.height + pad * 2}px`;
  } else {
    tourSpotEl.style.display = "none";
  }
  tourOverlayEl.classList.toggle("no-spot", !visible);

  // Card placement: beside the spotlight where there is room, else centered.
  const cardW = Math.min(400, window.innerWidth - 32);
  tourCardEl.style.width = `${cardW}px`;
  if (visible) {
    const margin = 14;
    const below = rect.bottom + margin;
    const cardH = tourCardEl.offsetHeight || 180;
    let top = below + cardH < window.innerHeight ? below : Math.max(16, rect.top - cardH - margin);
    let left = Math.min(Math.max(16, rect.left), window.innerWidth - cardW - 16);
    // A target hugging the right edge (inspector) reads better with the card to its left.
    if (rect.left > window.innerWidth - rect.right + 200 && rect.width > window.innerWidth / 3) {
      left = Math.min(Math.max(16, rect.left + 20), window.innerWidth - cardW - 16);
    }
    tourCardEl.style.left = `${left}px`;
    tourCardEl.style.top = `${Math.max(16, Math.min(top, window.innerHeight - cardH - 16))}px`;
    tourCardEl.style.transform = "none";
  } else {
    tourCardEl.style.left = "50%";
    tourCardEl.style.top = "50%";
    tourCardEl.style.transform = "translate(-50%, -50%)";
  }
}

function renderTourStep() {
  const step = TOUR_STEPS[tourStepIdx];
  tourStepLabelEl.textContent = `${tourStepIdx + 1} / ${TOUR_STEPS.length}`;
  tourTitleEl.textContent = step.title;
  tourCopyEl.textContent = step.copy;
  tourBackEl.disabled = tourStepIdx === 0;
  tourNextEl.textContent = tourStepIdx === TOUR_STEPS.length - 1 ? "FINISH ▸" : "NEXT ▸";
  positionTourStep();
}

/** Starts the tour. `force` replays it even when already completed (Help menu). */
function startTour(force = false) {
  if (tourActive) return;
  if (!force && tourDone()) return;
  if (!workspaceOpen) return;
  if (setupWizardEl && !setupWizardEl.classList.contains("hidden")) return; // wait for setup first
  tourActive = true;
  tourStepIdx = 0;
  tourOverlayEl.classList.remove("hidden");
  tourOverlayEl.setAttribute("aria-hidden", "false");
  renderTourStep();
  tourNextEl.focus();
  announce("Welcome tour started. Use Next and Back to move through it, or Skip to leave.");
}

/** Auto-start hook: fires on workspace open and once setup completes. */
function maybeStartTour() {
  startTour(false);
}

function endTour() {
  if (!tourActive) return;
  tourActive = false;
  markTourDone();
  tourOverlayEl.classList.add("hidden");
  tourOverlayEl.setAttribute("aria-hidden", "true");
  if (promptInputEl && !promptInputEl.disabled) promptInputEl.focus();
}

tourNextEl.addEventListener("click", () => {
  if (tourStepIdx >= TOUR_STEPS.length - 1) {
    endTour();
    return;
  }
  tourStepIdx++;
  renderTourStep();
});
tourBackEl.addEventListener("click", () => {
  if (tourStepIdx === 0) return;
  tourStepIdx--;
  renderTourStep();
});
tourSkipEl.addEventListener("click", endTour);
window.addEventListener("resize", () => {
  if (tourActive) positionTourStep();
});
