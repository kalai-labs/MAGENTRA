// Startup landing page — recent folders under the logo.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Startup landing page — recent folders under the logo
// ---------------------------------------------------------------------------

async function openWorkspaceByPath(workspace) {
  const cfg = await window.magentra.openWorkspace(workspace);
  if (cfg && cfg.workspace === workspace) {
    enterActiveState(cfg.workspace);
    applyModel(cfg.model);
  }
}

function renderRecentList(list) {
  if (!recentListEl) return;
  const recents = Array.isArray(list) ? list : [];
  recentListEl.textContent = "";
  if (recents.length === 0) {
    recentListEl.classList.add("hidden");
    return;
  }
  recentListEl.classList.remove("hidden");
  const heading = document.createElement("div");
  heading.className = "recent-heading";
  heading.textContent = "RECENT";
  recentListEl.appendChild(heading);
  for (const workspace of recents) {
    const row = document.createElement("button");
    row.className = "recent-row";
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = workspace.split(/[\\/]/).filter(Boolean).pop() || workspace;
    const path = document.createElement("span");
    path.className = "recent-path";
    path.textContent = workspace;
    row.append(name, path);
    row.addEventListener("click", () => openWorkspaceByPath(workspace));
    recentListEl.appendChild(row);
  }
}

if (window.magentra.onRecentWorkspaces) {
  window.magentra.onRecentWorkspaces(renderRecentList);
}

function onSessionStarted(event) {
  appendSysNote(`session ${event.sessionId} · model ${event.model}`);
  // A fresh session (boot, or /clear) is a fresh bill and an empty window.
  sessionModel = event.model;
  resetSessionMeter();
  // A fresh session boots with guard on + bypass; re-assert the user's safety choices.
  applySafetySettings(true);
  resetChanges();
  engineErrorBannerShown = false;
}

/**
 * The one place that decides what the composer looks like, from what is actually
 * running. Two kinds of work, and they are NOT the same:
 *
 *   - a TURN owns the conversation, so the composer is locked while it runs;
 *   - BACKGROUND work (an atlas build) owns nothing — you can keep typing while
 *     it maps, so only the stop button appears.
 *
 * The stop button is shown for either. It is a hard stop: it kills whatever is
 * in flight, turn or not.
 */
function syncActivityUi() {
  const working = busy || backgroundJobs.size > 0;

  stopBtnEl.classList.toggle("hidden", !working);
  // SEND hides only during a turn — background work leaves the composer usable.
  sendBtnEl.classList.toggle("hidden", busy);
  setStatusLed(working ? "busy" : "idle");
  document.body.classList.toggle("busy", busy);

  if (!workspaceOpen) return; // landing page: composer stays disabled regardless
  // Clearing mid-turn would swap the engine's session out from under it.
  clearBtnEl.disabled = busy;
  promptInputEl.disabled = busy;
}

function onTurnStarted() {
  toolCountThisTurn = 0;
  currentAgentsRow = null;
  agentCards.clear();
  toolRows.clear();
  currentAssistantEl = null;
  updateAgentMeter();

  busy = true;
  syncActivityUi();
  startNowLine();
}

/**
 * Work that is not a turn, starting or ending (currently the atlas build). It is
 * the only way the UI learns the engine is busy without a turn — turn_started
 * never fires for it.
 */
function onBackgroundNotification(event) {
  if (!event || typeof event.taskId !== "string") return;
  if (event.kind === "start") backgroundJobs.add(event.taskId);
  else backgroundJobs.delete(event.taskId); // "exit" and anything else terminal
  syncActivityUi();
}

function onTurnFinished(event) {
  busy = false;
  syncActivityUi();
  promptInputEl.focus();

  if (event) {
    // contextTokens = how full the window is NOW (engine-computed, cache-aware).
    // usage = what this turn BILLED (cumulative) — two different quantities.
    contextTokens = event.contextTokens ?? contextTokens;
    if (event.usage) recordTurnUsage(sessionModel || "unknown", event.usage);
    updateSessionMeter();
  }

  finalizeAssistantEl();

  finalizeAllAgentCards();
  agentMeterEl.classList.add("hidden");

  stopNowLine();

  appendTurnSeparator();
}

function onTextDelta(text) {
  if (busy) setNowActivity("responding", "");
  if (!streamEl) return;
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "msg-assistant";
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▌"; // ▌
    currentAssistantEl.appendChild(caret);
    withAutoScroll(() => streamEl.appendChild(currentAssistantEl));
  }
  const caret = currentAssistantEl.querySelector(".caret");
  withAutoScroll(() => {
    const textNode = document.createTextNode(text);
    if (caret) currentAssistantEl.insertBefore(textNode, caret);
    else currentAssistantEl.appendChild(textNode);
  });
}

function onToolCallStarted(event) {
  toolCountThisTurn++;

  if (event.subagent) {
    const card = getOrCreateAgentCard(event);
    if (event.agentColor) {
      card.cardEl.classList.add("crewed");
      card.cardEl.style.borderTopColor = event.agentColor;
    }
    const row = createToolRow(event.tool, event.description, event.input);
    withAutoScroll(() => {
      card.bodyEl.appendChild(row.rowEl);
      card.bodyEl.appendChild(row.detailEl);
    });
    card.toolRows.set(event.id, row);
    updateAgentMeter();

    if (event.agentDesc) card.agentDesc = event.agentDesc;
    const runningCount = Array.from(agentCards.values()).filter((c) => c.running).length;
    setNowActivity(`${runningCount} agents working`, card.agentDesc || "");
    return;
  }

  if (!streamEl) return;
  finalizeAssistantEl();
  const row = createToolRow(event.tool, event.description, event.input);
  withAutoScroll(() => {
    streamEl.appendChild(row.rowEl);
    streamEl.appendChild(row.detailEl);
  });
  toolRows.set(event.id, row);
  updateAgentMeter();

  setNowActivity(event.tool, event.description || compactInput(event.input));
}

function onToolCallFinished(event) {
  if (event.subagent) {
    const key = event.agentId || "agent-solo";
    const card = agentCards.get(key);
    if (card) {
      const row = card.toolRows.get(event.id);
      if (row) {
        finishToolRow(row, event.isError, event.resultPreview);
        card.lastRowErr = !!event.isError;
      }
    }
    return;
  }

  const row = toolRows.get(event.id);
  if (row) finishToolRow(row, event.isError, event.resultPreview);

  if (event.tool === "Agent" || event.tool === "Workflow") {
    finalizeAllAgentCards();
  }
}

function onAgentSpawned(event) {
  getOrCreateAgentCard(event);
  updateAgentMeter();

  const runningCount = Array.from(agentCards.values()).filter((c) => c.running).length;
  setNowActivity(`${runningCount} agents working`, `dispatched ${event.agentDesc}`);
}

function onAgentFinished(event) {
  const card = agentCards.get(event.agentId);
  if (card && card.running) {
    if (event.isError) card.lastRowErr = true;
    finalizeCard(card);
  }
  updateAgentMeter();
}

function onCommandOutput(event) {
  const text = event.text || "";
  if (text.startsWith("▶ ")) {
    appendPhaseBanner(text.slice(2));
  } else {
    appendSysNote(text);
    if (busy && text.startsWith("↻")) {
      showNowOverride(text);
    }
  }
}

function onPermissionRequest(event) {
  permissionQueue.push(event);
  if (!activePermission) showNextPermission();
}

function showNextPermission() {
  if (permissionQueue.length === 0) {
    activePermission = null;
    return;
  }
  activePermission = permissionQueue.shift();
  const input = activePermission.input;
  const subject =
    (input && typeof input === "object" && input.command) ||
    activePermission.description ||
    safeStringify(input);
  deleteSubjectEl.textContent = subject;
  deleteModalEl.classList.remove("hidden");
}

function resolvePermission(decision) {
  if (!activePermission) return;
  window.magentra.respondPermission(activePermission.id, decision);
  deleteModalEl.classList.add("hidden");
  activePermission = null;
  showNextPermission();
}

const RECOMMENDED_SUFFIX = "(Recommended)";

function onQuestionRequest(event) {
  if (!streamEl) return;

  (event.questions || []).forEach((q) => {
    const cardEl = document.createElement("div");
    cardEl.className = "question-card";

    const headEl = document.createElement("div");
    headEl.className = "question-head";
    headEl.textContent = "QUESTION";
    cardEl.appendChild(headEl);

    const textEl = document.createElement("div");
    textEl.className = "question-text";
    textEl.textContent = q.question;
    cardEl.appendChild(textEl);

    const optionsEl = document.createElement("div");
    optionsEl.className = "question-options";
    cardEl.appendChild(optionsEl);

    function answerWith(rawValue, chosenBtnEl) {
      window.magentra.send({
        type: "question_response",
        id: event.id,
        answers: { [q.question]: [rawValue] },
      });
      cardEl.classList.add("answered");
      if (chosenBtnEl) chosenBtnEl.classList.add("chosen");
    }

    (q.options || []).forEach((opt) => {
      const isRecommended = opt.label.includes(RECOMMENDED_SUFFIX);
      const shownLabel = isRecommended
        ? opt.label.replace(RECOMMENDED_SUFFIX, "").trim()
        : opt.label;

      const btn = document.createElement("button");
      btn.className = "q-opt" + (isRecommended ? " recommended" : "");
      btn.textContent = shownLabel;
      if (opt.description) {
        const descEl = document.createElement("span");
        descEl.className = "q-opt-desc";
        descEl.textContent = opt.description;
        btn.appendChild(descEl);
      }
      btn.addEventListener("click", () => answerWith(opt.label, btn));
      optionsEl.appendChild(btn);
    });

    const otherRowEl = document.createElement("div");
    otherRowEl.className = "q-other-row";

    const otherInputEl = document.createElement("input");
    otherInputEl.className = "q-other-input";
    otherInputEl.placeholder = "Other…";

    const otherSendEl = document.createElement("button");
    otherSendEl.className = "q-other-send";
    otherSendEl.textContent = "SEND";

    function sendOther() {
      const val = otherInputEl.value.trim();
      if (!val) return;
      const chosenBtn = document.createElement("button");
      chosenBtn.className = "q-opt chosen";
      chosenBtn.textContent = val;
      optionsEl.appendChild(chosenBtn);
      answerWith(val, chosenBtn);
    }

    otherSendEl.addEventListener("click", sendOther);
    otherInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendOther();
      }
    });

    otherRowEl.appendChild(otherInputEl);
    otherRowEl.appendChild(otherSendEl);
    cardEl.appendChild(otherRowEl);

    withAutoScroll(() => streamEl.appendChild(cardEl));
  });
}

function onPlanReady(event) {
  if (!streamEl) return;

  const cardEl = document.createElement("div");
  cardEl.className = "question-card plan-card";

  const headEl = document.createElement("div");
  headEl.className = "question-head";
  headEl.textContent = "PLAN — REVIEW REQUIRED";
  cardEl.appendChild(headEl);

  const planEl = document.createElement("textarea");
  planEl.className = "plan-text";
  planEl.value = event.plan;
  cardEl.appendChild(planEl);

  if (event.allowedPrompts && event.allowedPrompts.length > 0) {
    const preauthEl = document.createElement("div");
    preauthEl.className = "plan-preauth";
    preauthEl.textContent =
      "Will pre-authorize on approval: " +
      event.allowedPrompts.map((ap) => `${ap.tool} — ${ap.prompt}`).join("; ");
    cardEl.appendChild(preauthEl);
  }

  const actionsEl = document.createElement("div");
  actionsEl.className = "q-other-row plan-actions";

  const feedbackEl = document.createElement("input");
  feedbackEl.className = "q-other-input";
  feedbackEl.placeholder = "Feedback for revision (optional)…";

  const approveBtn = document.createElement("button");
  approveBtn.className = "q-opt recommended plan-approve";
  approveBtn.textContent = "Approve";

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "q-other-send plan-reject";
  rejectBtn.textContent = "Reject";

  function decide(approve) {
    const edited = planEl.value !== event.plan ? planEl.value : undefined;
    const message = feedbackEl.value.trim();
    window.magentra.send({
      type: "plan_decision",
      approve,
      ...(edited !== undefined ? { editedPlan: edited } : {}),
      ...(message ? { message } : {}),
    });
    planEl.disabled = true;
    feedbackEl.disabled = true;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    cardEl.classList.add("answered");
  }

  approveBtn.addEventListener("click", () => decide(true));
  rejectBtn.addEventListener("click", () => decide(false));

  actionsEl.appendChild(feedbackEl);
  actionsEl.appendChild(rejectBtn);
  actionsEl.appendChild(approveBtn);
  cardEl.appendChild(actionsEl);

  withAutoScroll(() => streamEl.appendChild(cardEl));
}

function handleEngineEvent(event) {
  switch (event.type) {
    case "session_started":
      onSessionStarted(event);
      break;
    case "turn_started":
      onTurnStarted();
      break;
    case "background_notification":
      onBackgroundNotification(event);
      break;
    case "text_delta":
      onTextDelta(event.text);
      break;
    case "tool_call_started":
      onToolCallStarted(event);
      break;
    case "tool_call_finished":
      onToolCallFinished(event);
      break;
    case "agent_spawned":
      onAgentSpawned(event);
      break;
    case "agent_finished":
      onAgentFinished(event);
      break;
    case "permission_request":
      onPermissionRequest(event);
      break;
    case "question_request":
      onQuestionRequest(event);
      break;
    case "plan_ready":
      onPlanReady(event);
      break;
    case "command_output":
      onCommandOutput(event);
      break;
    case "task_list_updated":
      onTaskListUpdated(event);
      break;
    case "modes_updated":
      onModesUpdated(event);
      break;
    case "team_updated":
      onTeamUpdated(event);
      break;
    case "backpack_progress":
      onBackpackProgress(event);
      break;
    case "file_edited":
      onFileEdited(event);
      break;
    case "turn_finished":
      onTurnFinished(event);
      break;
    case "error":
      appendSysError(event.message);
      if (event.fatal) {
        setStatusLed("error");
        showEngineErrorBanner(event.message);
      }
      break;
    case "engine_stderr":
      appendSysError(event.text);
      break;
    case "engine_exit":
      if (event.code) {
        appendSysError(`engine exited with code ${event.code}`);
        showEngineErrorBanner("The engine stopped. Check your connection settings, then set up again.");
      }
      break;
    default:
      break;
  }
}
