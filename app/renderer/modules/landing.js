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

// Repaint a resumed conversation from the engine's render-ready snapshot. The
// engine already paired tool calls with results and stripped scaffolding, so
// this just replays it through the same DOM builders a live turn uses.
function onSessionRestored(event) {
  if (!streamEl) return;
  resetLocalViewForClear(); // clear the current view + tool/agent maps
  for (const m of event.messages || []) {
    if (m.role === "user") {
      appendUserMessage(m.text);
      continue;
    }
    if (m.thinking) {
      const details = document.createElement("details");
      details.className = "msg-thinking done";
      const summary = document.createElement("summary");
      summary.textContent = "reasoning";
      const body = document.createElement("div");
      body.className = "thinking-body";
      body.textContent = m.thinking;
      details.appendChild(summary);
      details.appendChild(body);
      streamEl.appendChild(details);
    }
    if (m.text) {
      const el = document.createElement("div");
      el.className = "msg-assistant";
      el.appendChild(renderMarkdown(m.text));
      streamEl.appendChild(el);
    }
    for (const tc of m.toolCalls || []) {
      const row = createToolRow(tc.tool, "", tc.input);
      streamEl.appendChild(row.rowEl);
      streamEl.appendChild(row.detailEl);
      finishToolRow(row, tc.isError, tc.result);
    }
  }
  appendSysNote(`resumed — ${(event.messages || []).length} messages restored`);
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
  // A running session is the proof the credentials work — unlock the composer.
  engineLinked = true;
  syncActivityUi();
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
  // A model change restarts the engine; block it mid-turn at the source rather
  // than racing a confirm dialog against a running turn.
  if (modelSelectEl) modelSelectEl.disabled = busy;
  if (customModelEl) customModelEl.disabled = busy;

  if (!workspaceOpen) return; // landing page: composer stays disabled regardless
  // Clearing mid-turn would swap the engine's session out from under it.
  clearBtnEl.disabled = busy;
  // The composer stays usable during a turn — a message typed now queues and
  // sends on turn end. It locks only when there are no credentials (a prompt
  // would go into a dead engine).
  promptInputEl.disabled = !engineLinked;
  promptInputEl.placeholder = !engineLinked
    ? "engine not linked — open SETTINGS → CONNECTION or the setup wizard"
    : busy
      ? "queue a follow-up… (sends when the turn ends)"
      : "Enter directive…";
}

function onTurnStarted() {
  toolCountThisTurn = 0;
  currentAgentsRow = null;
  agentCards.clear();
  toolRows.clear();
  currentAssistantEl = null;
  currentThinkingEl = null;
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

  finalizeThinkingEl();
  finalizeAssistantEl();

  finalizeAllAgentCards();
  agentMeterEl.classList.add("hidden");

  stopNowLine();

  appendTurnSeparator(event && event.stopReason);

  // A follow-up typed during the turn now goes out (starting its own turn).
  flushMessageQueue();
}

function onTextDelta(text) {
  if (busy) setNowActivity("responding", "");
  if (!streamEl) return;
  // The model has moved from reasoning to answering — close the reasoning block.
  finalizeThinkingEl();
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "msg-assistant";
    // Raw source accumulates here; it streams as plain text for liveness and is
    // re-rendered as Markdown once the message finalizes (finalizeAssistantEl).
    currentAssistantEl._raw = "";
    const live = document.createElement("span");
    live.className = "md-live";
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▌"; // ▌
    currentAssistantEl.appendChild(live);
    currentAssistantEl.appendChild(caret);
    withAutoScroll(() => streamEl.appendChild(currentAssistantEl));
  }
  currentAssistantEl._raw += text;
  const live = currentAssistantEl.querySelector(".md-live");
  withAutoScroll(() => {
    // Append to the live text span; full Markdown layout waits for finalize so
    // half-streamed fences/lists don't flicker through partial parses.
    if (live) live.appendChild(document.createTextNode(text));
  });
}

// Extended-thinking tokens (reasoning models). Rendered as a dim, collapsed
// "reasoning" block so it's available without dominating the transcript, and
// the last line feeds the now-line so "thinking · 45s" shows real movement.
function onThinkingDelta(text) {
  if (busy) {
    const lastLine = text.split("\n").filter(Boolean).pop();
    setNowActivity("thinking", lastLine ? lastLine.slice(0, 80) : "");
  }
  if (!streamEl) return;
  if (!currentThinkingEl) {
    finalizeAssistantEl();
    currentThinkingEl = document.createElement("details");
    currentThinkingEl.className = "msg-thinking";
    const summary = document.createElement("summary");
    summary.textContent = "reasoning";
    const body = document.createElement("div");
    body.className = "thinking-body";
    currentThinkingEl.appendChild(summary);
    currentThinkingEl.appendChild(body);
    withAutoScroll(() => streamEl.appendChild(currentThinkingEl));
  }
  const body = currentThinkingEl.querySelector(".thinking-body");
  withAutoScroll(() => body.appendChild(document.createTextNode(text)));
}

function onToolCallStarted(event) {
  toolCountThisTurn++;
  // Reasoning for this segment is done once the model acts or speaks.
  finalizeThinkingEl();

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

/** Drop pending permission requests wholesale — used when the engine process
 * goes away (crash or restart): a decision sent to the next engine would
 * answer a request that no longer exists. */
function clearPermissionState() {
  permissionQueue = [];
  activePermission = null;
  deleteModalEl.classList.add("hidden");
}

/** The engine process is gone: nothing it owed the UI (turn end, background
 * exits, permission decisions) will ever arrive — settle everything so a dead
 * process can never leave the composer locked. */
function onEngineGone() {
  backgroundJobs.clear();
  clearPermissionState();
  // Drop queued follow-ups first: onTurnFinished would otherwise flush one into
  // the dead engine.
  clearMessageQueue();
  if (busy) onTurnFinished();
  else syncActivityUi();
}

const RECOMMENDED_SUFFIX = "(Recommended)";

function onQuestionRequest(event) {
  if (!streamEl) return;

  (event.questions || []).forEach((q) => {
    const multi = q.multiSelect === true;
    const cardEl = document.createElement("div");
    cardEl.className = "question-card";

    const headEl = document.createElement("div");
    headEl.className = "question-head";
    // Use the question's own header when it provides one, so a series of
    // questions is distinguishable instead of a wall of "QUESTION".
    headEl.textContent = (q.header && q.header.trim()) || "QUESTION";
    cardEl.appendChild(headEl);

    const textEl = document.createElement("div");
    textEl.className = "question-text";
    textEl.textContent = q.question;
    cardEl.appendChild(textEl);

    if (multi) {
      const hintEl = document.createElement("div");
      hintEl.className = "question-multi-hint";
      hintEl.textContent = "select all that apply";
      cardEl.appendChild(hintEl);
    }

    const optionsEl = document.createElement("div");
    optionsEl.className = "question-options";
    cardEl.appendChild(optionsEl);

    // Sends the final answer array and locks the card. One element for single
    // select; every chosen label for multi-select.
    function submitAnswers(values) {
      window.magentra.send({
        type: "question_response",
        id: event.id,
        answers: { [q.question]: values },
      });
      cardEl.classList.add("answered");
    }

    const selected = new Set(); // multi-select accumulator

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
      if (multi) {
        // Toggle membership; the SUBMIT button below sends the whole set.
        btn.addEventListener("click", () => {
          if (selected.has(opt.label)) {
            selected.delete(opt.label);
            btn.classList.remove("chosen");
          } else {
            selected.add(opt.label);
            btn.classList.add("chosen");
          }
        });
      } else {
        // Single-select answers immediately on click.
        btn.addEventListener("click", () => {
          btn.classList.add("chosen");
          submitAnswers([opt.label]);
        });
      }
      optionsEl.appendChild(btn);
    });

    const otherRowEl = document.createElement("div");
    otherRowEl.className = "q-other-row";

    const otherInputEl = document.createElement("input");
    otherInputEl.className = "q-other-input";
    otherInputEl.placeholder = multi ? "Add another…" : "Other…";

    const otherSendEl = document.createElement("button");
    otherSendEl.className = "q-other-send";
    otherSendEl.textContent = multi ? "ADD" : "SEND";

    function addOther() {
      const val = otherInputEl.value.trim();
      if (!val) return;
      if (multi) {
        // Add as a chosen chip and clear the field; SUBMIT sends it with the rest.
        selected.add(val);
        const chip = document.createElement("button");
        chip.className = "q-opt chosen";
        chip.textContent = val;
        chip.addEventListener("click", () => {
          selected.delete(val);
          chip.remove();
        });
        optionsEl.appendChild(chip);
        otherInputEl.value = "";
      } else {
        const chosenBtn = document.createElement("button");
        chosenBtn.className = "q-opt chosen";
        chosenBtn.textContent = val;
        optionsEl.appendChild(chosenBtn);
        submitAnswers([val]);
      }
    }

    otherSendEl.addEventListener("click", addOther);
    otherInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addOther();
      }
    });

    otherRowEl.appendChild(otherInputEl);
    otherRowEl.appendChild(otherSendEl);
    cardEl.appendChild(otherRowEl);

    if (multi) {
      const submitEl = document.createElement("button");
      submitEl.className = "q-opt q-submit recommended";
      submitEl.textContent = "SUBMIT SELECTION";
      submitEl.addEventListener("click", () => {
        if (selected.size === 0) return;
        submitAnswers([...selected]);
      });
      cardEl.appendChild(submitEl);
    }

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
    case "session_restored":
      onSessionRestored(event);
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
    case "thinking_delta":
      onThinkingDelta(event.text);
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
    case "mode_changed":
      onModeChanged(event);
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
        showEngineErrorBanner(event.message, looksCredentialError(event.message) ? "credential" : "crash");
      }
      break;
    case "engine_stderr":
      appendSysError(event.text);
      break;
    case "engine_exit": {
      // Deliberate stops (restart, model change, quit) are flagged expected by
      // the main process; everything else — including signal deaths, where
      // code is null — is a crash and must both say so and unlock the UI.
      if (event.expected) break;
      const cause = event.signal ? `signal ${event.signal}` : `code ${event.code}`;
      appendSysError(`engine stopped unexpectedly (${cause})`);
      setStatusLed("error");
      showEngineErrorBanner("The engine stopped unexpectedly. Restart it, or review your connection settings.");
      onEngineGone();
      break;
    }
    default:
      break;
  }
}
