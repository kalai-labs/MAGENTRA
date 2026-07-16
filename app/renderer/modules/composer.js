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

function resetLocalViewForClear() {
  if (streamEl) streamEl.textContent = "";
  for (const card of agentCards.values()) {
    if (card.intervalId) clearInterval(card.intervalId);
  }
  agentCards.clear();
  toolRows.clear();
  toolCountThisTurn = 0;
  currentAgentsRow = null;
  currentAssistantEl = null;
  updateAgentMeter();
  onTaskListUpdated({ tasks: [] });
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

function sendMessage() {
  const text = promptInputEl.value;
  if (!text.trim() || busy || !engineLinked) return;
  dismissFirstUseHint();

  const trimmed = text.trim();
  if (trimmed.startsWith("/") && !text.includes("\n")) {
    sendSlashCommand(trimmed);
    return;
  }

  appendUserMessage(text);
  window.magentra.send({ type: "user_message", text });
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
// (palette → styles panel → wizard → permission modal), and only interrupt
// the turn when nothing was open. Two competing listeners here once made a
// modal deny ALSO hard-kill the running turn.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (slashVisible) {
    // Normally consumed by the composer's own keydown (which stops
    // propagation); this is a safety net if focus wandered.
    hideSlashPop();
    return;
  }
  if (stylesPanelOpen) {
    closeStylesPanel();
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
// Ctrl+L: the terminal-classic clear shortcut (same key on Linux and Windows).
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "l") {
    e.preventDefault();
    requestClear();
  }
});

allowBtnEl.addEventListener("click", () => resolvePermission("allow_once"));
denyBtnEl.addEventListener("click", () => resolvePermission("deny"));

document.addEventListener("click", (e) => {
  if (stylesPanelOpen && !modeChipsEl.contains(e.target)) closeStylesPanel();
});

function dismissSetupWizard() {
  setupWizardEl.classList.add("hidden");
  if (!engineLinked) {
    // The composer is locked (syncActivityUi) — give the stranded user the
    // way back on a banner instead of only a note that scrolls away.
    showEngineErrorBanner("Engine not linked — this workspace has no credentials yet.", "credential");
  }
  appendSysNote("engine not linked — add credentials any time in SETTINGS → CONNECTION");
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
