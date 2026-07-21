// Composer: listeners, slash palette, and submit.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

workspaceBtnEl.addEventListener("click", handleChooseWorkspace);
pickFolderBtnEl.addEventListener("click", handleChooseWorkspace);

modelSelectEl.addEventListener("change", () => {
  const val = modelSelectEl.value;
  if (val === "__custom__") {
    customModelEl.classList.remove("hidden");
    customModelEl.focus();
    return;
  }
  customModelEl.classList.add("hidden");
  applyModelChange(val);
});

customModelEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitCustomModel();
  }
});
customModelEl.addEventListener("blur", commitCustomModel);

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

// ---------------------------------------------------------------------------
// Slash-command palette
// ---------------------------------------------------------------------------

function hideSlashPop() {
  slashVisible = false;
  slashMatches = [];
  slashSelIdx = 0;
  slashPopEl.classList.add("hidden");
  slashPopEl.textContent = "";
}

function renderSlashPop() {
  slashPopEl.textContent = "";
  slashMatches.forEach((entry, idx) => {
    const rowEl = document.createElement("button");
    rowEl.type = "button";
    rowEl.className = "slash-item" + (idx === slashSelIdx ? " sel" : "");

    const cmdEl = document.createElement("span");
    cmdEl.className = "slash-cmd";
    cmdEl.textContent = entry.cmd;
    rowEl.appendChild(cmdEl);

    if (entry.args) {
      const argsEl = document.createElement("span");
      argsEl.className = "slash-args";
      argsEl.textContent = entry.args;
      rowEl.appendChild(argsEl);
    }

    const descEl = document.createElement("span");
    descEl.className = "slash-desc";
    descEl.textContent = entry.desc;
    rowEl.appendChild(descEl);

    rowEl.addEventListener("click", () => {
      completeSlashCommand(entry.cmd);
      promptInputEl.focus();
    });

    slashPopEl.appendChild(rowEl);
  });
}

function updateSlashPop() {
  const value = promptInputEl.value;
  if (!value.startsWith("/") || value.includes("\n")) {
    hideSlashPop();
    return;
  }
  const firstToken = value.split(/\s+/)[0].toLowerCase();
  slashMatches = SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(firstToken));
  if (slashMatches.length === 0) {
    hideSlashPop();
    return;
  }
  slashVisible = true;
  slashSelIdx = 0;
  slashPopEl.classList.remove("hidden");
  renderSlashPop();
}

function completeSlashCommand(cmd) {
  promptInputEl.value = cmd + " ";
  autoGrow(promptInputEl);
  updateSlashPop();
}

// ---------------------------------------------------------------------------
// Composer submit (normal prompt + slash-command interception)
// ---------------------------------------------------------------------------

function resetLocalViewForClear(preserveTasks = false) {
  if (streamEl) streamEl.textContent = "";
  for (const card of agentCards.values()) {
    if (card.intervalId) clearInterval(card.intervalId);
  }
  agentCards.clear();
  toolRows.clear();
  toolCountThisTurn = 0;
  currentAgentsRow = null;
  currentAssistantEl = null;
  currentThinkingEl = null;
  currentWorkGroup = null;
  clearMessageQueue();
  updateAgentMeter();
  if (!preserveTasks) onTaskListUpdated({ tasks: [] });
}

function sendSlashCommand(trimmed) {
  const spaceIdx = trimmed.indexOf(" ");
  const rawCmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const command = rawCmd.slice(1); // strip the leading "/"

  window.magentra.send({
    type: "slash_command",
    command,
    ...(args ? { args } : {}),
  });

  if (command.toLowerCase() === "clear") {
    resetLocalViewForClear();
  }

  appendSysNote(trimmed);
  promptInputEl.value = "";
  autoGrow(promptInputEl);
  hideSlashPop();
}

// Slash/bang commands typed while a turn is running wait here and flush one per
// turn end (each starts its own turn). Plain messages no longer queue — they
// steer the running turn immediately (see sendMessage) — but commands can't
// steer, so they still queue.
const messageQueue = [];

function renderQueueChip() {
  if (!queueChipEl) return;
  if (messageQueue.length === 0) {
    queueChipEl.classList.add("hidden");
    queueChipEl.textContent = "";
    return;
  }
  queueChipEl.classList.remove("hidden");
  queueChipEl.textContent = "";
  const label = document.createElement("span");
  label.className = "queue-label";
  label.textContent = `${messageQueue.length} queued`;
  queueChipEl.appendChild(label);
  messageQueue.forEach((text, idx) => {
    const item = document.createElement("button");
    item.className = "queue-item";
    item.title = "Remove from queue";
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 48);
    item.textContent = `${preview}${preview.length < text.trim().length ? "…" : ""} ✕`;
    item.addEventListener("click", () => {
      messageQueue.splice(idx, 1);
      renderQueueChip();
    });
    queueChipEl.appendChild(item);
  });
}

/** Actually send one message: a slash command or a user turn. Shared by the
 * immediate path and the queue flush. */
// Prompt history: ArrowUp in an empty composer recalls what was sent.
const promptHistory = [];
let promptHistIdx = -1; // -1 = not browsing

function dispatch(text) {
  if (text.trim()) {
    promptHistory.push(text);
    if (promptHistory.length > 100) promptHistory.shift();
  }
  promptHistIdx = -1;
  const trimmed = text.trim();
  if (trimmed.startsWith("/") && !text.includes("\n")) {
    sendSlashCommand(trimmed);
    return;
  }
  // "! <command>" runs a shell command directly; its output lands in the
  // conversation as context (the engine defers it while a turn is running).
  if (trimmed.startsWith("!") && !text.includes("\n")) {
    const cmd = trimmed.slice(1).trim();
    if (cmd) {
      appendSysNote(`! ${cmd}`);
      window.magentra.send({ type: "bang_command", cmd });
    }
    return;
  }
  appendUserMessage(text);
  window.magentra.send({ type: "user_message", text });
}

/** Flush the next queued message when the engine goes idle. One per turn end:
 * the message starts a new turn, whose finish flushes the next. */
function flushMessageQueue() {
  if (busy || messageQueue.length === 0) return;
  const text = messageQueue.shift();
  renderQueueChip();
  dispatch(text);
}

/** Drop every queued message — the engine went away or the chat was cleared,
 * so flushing them would send into a dead or wrong session. */
function clearMessageQueue() {
  messageQueue.length = 0;
  renderQueueChip();
}

function sendMessage() {
  const text = promptInputEl.value;
  if (!text.trim() || !engineLinked) return;

  if (busy) {
    const trimmed = text.trim();
    const isCommand = (trimmed.startsWith("/") || trimmed.startsWith("!")) && !text.includes("\n");
    // Commands can't steer a running turn — steer_message carries plain text to
    // the model, not a slash/bang command — so they still queue for turn end.
    if (isCommand) {
      messageQueue.push(text);
      renderQueueChip();
      promptInputEl.value = "";
      autoGrow(promptInputEl);
      return;
    }
    // Mid-turn plain text steers the running turn: it joins the turn at its next
    // boundary rather than starting a new one. Available in every stance now,
    // not only OVERDRIVE.
    window.magentra.send({ type: "steer_message", text });
    appendSysNote(`↳ steering — "${text.replace(/\s+/g, " ").trim().slice(0, 80)}"`);
    promptInputEl.value = "";
    autoGrow(promptInputEl);
    return;
  }

  dispatch(text);
  promptInputEl.value = "";
  autoGrow(promptInputEl);
}

promptInputEl.addEventListener("input", () => {
  autoGrow(promptInputEl);
  updateSlashPop();
});
promptInputEl.addEventListener("keydown", (e) => {
  if (slashVisible) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashSelIdx = (slashSelIdx + 1) % slashMatches.length;
      renderSlashPop();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashSelIdx = (slashSelIdx - 1 + slashMatches.length) % slashMatches.length;
      renderSlashPop();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      completeSlashCommand(slashMatches[slashSelIdx].cmd);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideSlashPop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const firstToken = promptInputEl.value.trim().split(/\s+/)[0].toLowerCase();
      const exact = SLASH_COMMANDS.some((c) => c.cmd.toLowerCase() === firstToken);
      if (!exact) {
        e.preventDefault();
        completeSlashCommand(slashMatches[slashSelIdx].cmd);
        return;
      }
      hideSlashPop();
      // exact match: fall through to the normal Enter handling below, which submits
    }
  }
  // Prompt history: only from an empty composer (or while already browsing),
  // so arrows inside a multi-line draft keep moving the caret.
  if (!slashVisible && e.key === "ArrowUp" && promptHistory.length > 0 &&
      (promptHistIdx !== -1 || promptInputEl.value === "")) {
    e.preventDefault();
    promptHistIdx = promptHistIdx === -1 ? promptHistory.length - 1 : Math.max(0, promptHistIdx - 1);
    promptInputEl.value = promptHistory[promptHistIdx];
    autoGrow(promptInputEl);
    return;
  }
  if (!slashVisible && e.key === "ArrowDown" && promptHistIdx !== -1) {
    e.preventDefault();
    promptHistIdx++;
    if (promptHistIdx >= promptHistory.length) {
      promptHistIdx = -1;
      promptInputEl.value = "";
    } else {
      promptInputEl.value = promptHistory[promptHistIdx];
    }
    autoGrow(promptInputEl);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
sendBtnEl.addEventListener("click", sendMessage);

/**
 * HARD STOP — kills everything the engine has in flight: the running turn, every
 * subagent under it, a background atlas build, and any background job. Safe to
 * press when nothing is running (the engine just says so).
 *
 * The UI does not clear `busy` / `backgroundJobs` itself: the engine answers with
 * turn_finished and background_notification(exit), and those are what settle the
 * composer. Guessing here would leave the two out of sync when a stop races a
 * turn that was finishing anyway.
 */
function hardStop() {
  window.magentra.interrupt();
}

stopBtnEl.addEventListener("click", hardStop);

// Escape, one handler, strict priority: dismiss the topmost surface first
// (palette → skill wizard → tour → setup wizard → permission modal), and only
// interrupt the turn when nothing was open. Two competing listeners here once
// made a modal deny ALSO hard-kill the running turn.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (closeOpenMenu()) return; // an open menu is the topmost surface
  if (!reviewDrawerEl.classList.contains("hidden")) {
    closeReviewDrawer();
    return;
  }
  if (shortcutSheetEl && !shortcutSheetEl.classList.contains("hidden")) {
    toggleShortcutSheet();
    return;
  }
  if (slashVisible) {
    // Normally consumed by the composer's own keydown (which stops
    // propagation); this is a safety net if focus wandered.
    hideSlashPop();
    return;
  }
  if (overdriveDialogEl && !overdriveDialogEl.classList.contains("hidden")) {
    closeOverdriveDialog();
    return;
  }
  if (skillWizardEl && !skillWizardEl.classList.contains("hidden")) {
    closeSkillWizard();
    return;
  }
  if (tourActive) {
    endTour();
    return;
  }
  if (!setupWizardEl.classList.contains("hidden")) {
    dismissSetupWizard();
    return;
  }
  if (!deleteModalEl.classList.contains("hidden")) {
    resolvePermission("deny");
    return;
  }
  // A non-console stage view (Settings, Skills, Changes, Crew, Sessions,
  // Missions) is a full-surface "popup tab" — Esc returns to the console, the
  // same as its ✕. Sits below the modals above and above the stop-work
  // fallback, so Esc closes an open view before it interrupts a running turn.
  if (document.body.dataset.view && document.body.dataset.view !== "console") {
    showView("console");
    return;
  }
  if (busy || backgroundJobs.size > 0) {
    e.preventDefault();
    hardStop();
  }
});

// Clear chat + context: one codepath with the typed "/clear" — the engine
// starts a fresh session and resetLocalViewForClear() wipes the local view.
// A half-typed draft survives the clear: the user likely wants to ask it in
// the fresh session (sendSlashCommand blanks the composer as a side effect).
function requestClear() {
  if (busy || clearBtnEl.disabled) return;
  const draft = promptInputEl.value;
  sendSlashCommand("/clear");
  if (draft.trim() && !draft.trim().startsWith("/")) {
    promptInputEl.value = draft;
    autoGrow(promptInputEl);
  }
}
clearBtnEl.addEventListener("click", requestClear);
navConsoleEl.addEventListener("click", () => {
  if (workspaceOpen) requestClear();
});

// ---------------------------------------------------------------------------
// Keyboard power layer. "mod" is Ctrl on Linux/Windows, Cmd on macOS — every
// shortcut works on all three platforms. `?` shows the cheat sheet.
// ---------------------------------------------------------------------------

const IS_MAC = /mac/i.test(navigator.platform || "");
// The cheat sheet spells the real modifier for this platform.
if (IS_MAC) document.querySelectorAll(".mod-key").forEach((el) => (el.textContent = "Cmd"));
const isMod = (e) => (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
const isTypingTarget = (t) =>
  t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT");

const VIEW_KEYS = { 1: "console", 2: "sessions", 3: "team", 4: "lab", 5: "changes", 6: "settings", 7: "skills" };

function toggleShortcutSheet() {
  if (!shortcutSheetEl) return;
  const opening = shortcutSheetEl.classList.contains("hidden");
  shortcutSheetEl.classList.toggle("hidden", !opening);
  if (opening) openModalA11y(shortcutSheetEl);
  else closeModalA11y();
}

window.addEventListener("keydown", (e) => {
  // Approval modal focused: single-key answer (buttons also spell these out).
  if (!deleteModalEl.classList.contains("hidden") && !isMod(e)) {
    // Typing in the note must not fire the single-key answers. Enter there
    // triggers the card's default (allow once); Shift+Enter adds a newline.
    if (e.target === permissionNoteEl) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        resolvePermission("allow_once");
      }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "y") {
      e.preventDefault();
      resolvePermission("allow_once");
      return;
    }
    // "A" is the durable grant, and only when the modal actually offers it —
    // it must never fall through to a plain allow, which is what it used to do.
    if (k === "a") {
      e.preventDefault();
      if (allowAlwaysBtnEl && !allowAlwaysBtnEl.classList.contains("hidden")) {
        resolvePermission("allow_always");
      }
      return;
    }
    if (k === "n" || k === "d") {
      e.preventDefault();
      resolvePermission("deny");
      return;
    }
    return;
  }
  if (isMod(e) && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "l") {
      e.preventDefault();
      requestClear();
      return;
    }
    if (k === "k") {
      e.preventDefault();
      promptInputEl.focus();
      return;
    }
    if (VIEW_KEYS[e.key] && workspaceOpen) {
      e.preventDefault();
      if (e.key === "5") openInspector("changes");
      else showView(VIEW_KEYS[e.key]);
      return;
    }
  }
  if (e.key === "?" && !isTypingTarget(e.target)) {
    e.preventDefault();
    toggleShortcutSheet();
  }
});
if (shortcutCloseBtnEl) shortcutCloseBtnEl.addEventListener("click", toggleShortcutSheet);

allowBtnEl.addEventListener("click", () => resolvePermission("allow_once"));
if (allowAlwaysBtnEl) allowAlwaysBtnEl.addEventListener("click", () => resolvePermission("allow_always"));
denyBtnEl.addEventListener("click", () => resolvePermission("deny"));

function dismissSetupWizard() {
  setupWizardEl.classList.add("hidden");
  closeModalA11y();
  maybeStartTour();
  // Opened to manage profiles over a working (or no) workspace: closing is
  // silent. The stranded-engine guidance only applies when there is genuinely
  // no linked engine behind the wizard.
  if (!engineLinked) {
    // The composer is locked (syncActivityUi) — give the stranded user the
    // way back on a banner instead of only a note that scrolls away.
    showEngineErrorBanner("Engine not linked — this workspace has no credentials yet.", "credential");
    appendSysNote("engine not linked — add credentials any time in SETTINGS → CONNECTION, or ⇆ Connect");
  }
}
if (wizCloseBtnEl) wizCloseBtnEl.addEventListener("click", dismissSetupWizard);

window.magentra.onEvent(handleEngineEvent);
window.magentra.onRestarted(() => {
  // A running turn (if any) and any queued permission requests are no longer
  // valid once the engine process restarts.
  clearPermissionState();
  if (busy) {
    onTurnFinished();
  }
});

boot();
