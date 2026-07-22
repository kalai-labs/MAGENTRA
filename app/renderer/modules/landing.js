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
  recentWorkspaces = Array.isArray(list) ? list : [];
  renderSidebarWorkspaces();
  if (!recentListEl) return;
  const recents = recentWorkspaces;
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

// Saved sessions reuse the engine's existing list/resume protocol. The row's
// main button resumes; destructive removal is a separate confirmed action.
function requestSessionList() {
  if (!workspaceOpen) return;
  window.magentra.send({ type: "list_sessions" });
}

function formatSessionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function sessionDisplayName(session) {
  return session.label || session.firstUserMessage || "Untitled session";
}

function renderSessions() {
  if (!sessionsListEl) return;
  sessionsListEl.textContent = "";
  const filter = (sessionsSearchEl && sessionsSearchEl.value.trim().toLowerCase()) || "";
  const shown = sessionSummaries.filter(
    (s) => !filter || sessionDisplayName(s).toLowerCase().includes(filter) || s.id.includes(filter),
  );
  sessionsEmptyEl.classList.toggle("hidden", sessionSummaries.length > 0);
  sessionsSubEl.textContent = filter
    ? `${shown.length} of ${sessionSummaries.length} saved conversations`
    : `${sessionSummaries.length} saved conversation${sessionSummaries.length === 1 ? "" : "s"}`;

  for (const session of shown) {
    const active = session.id === currentSessionId;
    const row = document.createElement("div");
    row.className = "session-row" + (active ? " active" : "");

    const resumeBtn = document.createElement("button");
    resumeBtn.className = "session-resume";
    resumeBtn.disabled = active || busy;

    const label = document.createElement("span");
    label.className = "session-label";
    label.textContent = sessionDisplayName(session);

    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = [formatSessionDate(session.updatedAt), session.model || "model not recorded"]
      .filter(Boolean)
      .join(" · ");

    const id = document.createElement("span");
    id.className = "session-id";
    id.textContent = active ? `${session.id} · ACTIVE` : session.id;

    resumeBtn.append(label, meta, id);
    resumeBtn.addEventListener("click", () => {
      window.magentra.send({ type: "resume_session", id: session.id });
    });

    const actions = document.createElement("div");
    actions.className = "session-actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "session-delete session-rename";
    renameBtn.title = "Rename session";
    renameBtn.textContent = "RENAME";
    renameBtn.addEventListener("click", async () => {
      const next = await showPromptModal({
        title: "RENAME SESSION",
        hint: `A name for ${session.id} — shown in this list instead of the first message.`,
        value: sessionDisplayName(session),
      });
      if (next === null || !next.trim()) return;
      window.magentra.send({ type: "rename_session", id: session.id, label: next.trim() });
    });

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "session-delete session-rename";
    archiveBtn.title = active
      ? "The active session cannot be archived"
      : "Move out of this list into .magentra/sessions/archive/";
    archiveBtn.textContent = "ARCHIVE";
    archiveBtn.disabled = active;
    archiveBtn.addEventListener("click", () => {
      window.magentra.send({ type: "archive_session", id: session.id });
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "session-delete";
    deleteBtn.title = active ? "The active session cannot be deleted" : "Delete session";
    deleteBtn.textContent = "DELETE";
    deleteBtn.disabled = active;
    deleteBtn.addEventListener("click", () => {
      const name = sessionDisplayName(session);
      if (!window.confirm(`Delete saved session “${name}”? This cannot be undone.`)) return;
      window.magentra.send({ type: "delete_session", id: session.id });
    });

    actions.append(renameBtn, archiveBtn, deleteBtn);
    row.append(resumeBtn, actions);
    sessionsListEl.appendChild(row);
  }
  renderSidebarSessions();
  syncWorkbenchContext();
}

function onSessionList(event) {
  sessionSummaries = Array.isArray(event.sessions) ? event.sessions : [];
  renderSessions();
}

navSessionsEl.addEventListener("click", () => {
  showView("sessions");
  requestSessionList();
});
sessionsRefreshBtnEl.addEventListener("click", requestSessionList);
sessionsCloseBtnEl.addEventListener("click", () => showView("console"));
if (sessionsSearchEl) sessionsSearchEl.addEventListener("input", renderSessions);

// Repaint a resumed conversation from the engine's render-ready snapshot. The
// engine already paired tool calls with results and stripped scaffolding, so
// this just replays it through the same DOM builders a live turn uses.
function onSessionRestored(event) {
  if (!streamEl) return;
  // session_started already repainted the resumed task list; clear only the
  // conversation-local DOM/maps here so that restored tasks stay visible.
  resetLocalViewForClear(true);
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
      const message = createMessageEl("assistant");
      message.body.appendChild(renderMarkdown(m.text));
      streamEl.appendChild(message.el);
    }
    for (const tc of m.toolCalls || []) {
      const row = createToolRow(tc.tool, "", tc.input);
      streamEl.appendChild(row.rowEl);
      streamEl.appendChild(row.detailEl);
      finishToolRow(row, tc.isError, tc.result);
      // Restored rows carry no timing — a fake "0s" would be a lie.
      row.timeEl.textContent = "";
    }
  }
  appendSysNote(`resumed — ${(event.messages || []).length} messages restored`);
  showView("console");
}

function onSessionStarted(event) {
  currentSessionId = event.sessionId;
  syncWorkbenchContext();
  // Adopt the engine's slash-command registry and rate card so the palette
  // and the model hints can never drift from what the engine actually does.
  if (Array.isArray(event.commands) && event.commands.length > 0) SLASH_COMMANDS = event.commands;
  if (event.rateCard && typeof event.rateCard === "object") modelRateCard = event.rateCard;
  // The rate card arrives with this event — repaint the footer hint so the
  // running model shows its prices/window from the very first session.
  if (hintModelEl && event.model) hintModelEl.textContent = modelHintText(event.model);
  // Settings → Context size: show the window the engine will actually use
  // when the field is left on auto.
  if (setContextEl && event.model && modelRateCard[event.model]) {
    setContextEl.placeholder = `auto (${Math.round(modelRateCard[event.model].contextWindow / 1000)}K for this model)`;
  }
  appendSysNote(`session ${event.sessionId} · model ${event.model}`);
  // Keep the composer's model picker aligned with the engine's actual model —
  // after a wizard IGNITE, a /clear, or a resume, the user must never have to
  // re-select what they already configured.
  if (event.model) applyModel(event.model);
  // The on-demand action skills discovered in this workspace ride along here.
  if (Array.isArray(event.skills)) {
    actionSkills = event.skills;
    renderSkillsSurfaces();
  }
  // A fresh session (boot, or /clear) is a fresh bill and an empty window.
  sessionModel = event.model;
  resetSessionMeter();
  // A fresh session boots with the guard on and OVERDRIVE off; re-assert the
  // user's saved safety choices.
  applySafetySettings(true);
  resetChanges();
  engineErrorBannerShown = false;
  // A running session is the proof the credentials work — unlock the composer.
  engineLinked = true;
  syncActivityUi();
  requestSessionList();
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
  // A model change restarts the engine; block it mid-turn at the source rather
  // than racing a confirm dialog against a running turn.
  if (modelSelectEl) modelSelectEl.disabled = busy;
  if (customModelEl) customModelEl.disabled = busy;
  renderSessions();
  renderMissions();

  if (!workspaceOpen) return; // landing page: composer stays disabled regardless
  // Clearing mid-turn would swap the engine's session out from under it.
  clearBtnEl.disabled = busy;
  // The composer stays usable during a turn — a message typed now steers the
  // running turn (commands still queue for turn end). It locks only when there
  // are no credentials (a prompt would go into a dead engine).
  promptInputEl.disabled = !engineLinked;
  promptInputEl.placeholder = !engineLinked
    ? "Engine not linked — open Settings → Connection or the setup wizard"
    : busy
      ? "Message joins the running turn to steer it…"
      : "Ask Magentra anything…";
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
const backgroundJobMeta = new Map(); // taskId -> description

function onBackgroundNotification(event) {
  if (!event || typeof event.taskId !== "string") return;
  if (event.kind === "start") {
    backgroundJobs.add(event.taskId);
    const desc = event.payload && event.payload.description;
    backgroundJobMeta.set(event.taskId, typeof desc === "string" ? desc : event.taskId);
  } else {
    backgroundJobs.delete(event.taskId); // "exit" and anything else terminal
    backgroundJobMeta.delete(event.taskId);
  }
  renderBackgroundJobs();
  syncActivityUi();
}

/** Running background jobs, each with its own stop — under the composer so
 * detached work is always visible and individually killable. */
function renderBackgroundJobs() {
  if (!jobsChipEl) return;
  jobsChipEl.textContent = "";
  jobsChipEl.classList.toggle("hidden", backgroundJobMeta.size === 0);
  for (const [taskId, description] of backgroundJobMeta) {
    const row = document.createElement("span");
    row.className = "job-row";
    const label = document.createElement("span");
    label.textContent = `⏳ ${description}`;
    label.title = taskId;
    const stopBtn = document.createElement("button");
    stopBtn.className = "job-stop";
    stopBtn.textContent = "STOP";
    stopBtn.title = `Stop background task ${taskId}`;
    stopBtn.addEventListener("click", () => {
      window.magentra.send({ type: "stop_background", taskId });
    });
    row.append(label, stopBtn);
    jobsChipEl.appendChild(row);
  }
}

function onTurnFinished(event) {
  busy = false;
  syncActivityUi();
  promptInputEl.focus();
  announce("The agent finished its turn.");

  if (event) {
    // contextTokens = how full the window is NOW (engine-computed, cache-aware).
    // contextWarn = the engine flags when it has grown past the /compact nudge
    // point; the counter tints on it. Cost is intentionally never shown.
    contextTokens = event.contextTokens ?? contextTokens;
    contextWarn = event.contextWarn === true;
    updateSessionMeter();
  }

  finalizeThinkingEl();
  finalizeAssistantEl();
  closeWorkGroup();

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
  // The model has moved from reasoning to answering — close the reasoning
  // block and stamp the finished "Agent working" group.
  finalizeThinkingEl();
  closeWorkGroup();
  if (!currentAssistantEl) {
    const message = createMessageEl("assistant");
    currentAssistantEl = message.el;
    // Raw source accumulates here; it streams as plain text for liveness and is
    // re-rendered as Markdown once the message finalizes (finalizeAssistantEl).
    currentAssistantEl._raw = "";
    const live = document.createElement("span");
    live.className = "md-live";
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▌"; // ▌
    message.body.appendChild(live);
    message.body.appendChild(caret);
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
  const target = workStream();
  withAutoScroll(() => {
    target.appendChild(row.rowEl);
    target.appendChild(row.detailEl);
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

// The /session report opens in its own modal (Esc-closable) rather than as a
// one-line console note — the report is multi-line and reads far better laid out
// row by row. The engine sends the whole formatted text; we render each source
// line as a row, preserving its indent and splitting "label:  value" pairs so
// headers, fields, and sub-fields are visually distinct.
function renderSessionReport(text) {
  sessionModalBodyEl.textContent = "";
  const lines = text.replace(/\s+$/, "").split("\n");
  for (const raw of lines) {
    if (raw.trim() === "") {
      const gap = document.createElement("div");
      gap.className = "sr-gap";
      sessionModalBodyEl.appendChild(gap);
      continue;
    }
    const indent = raw.length - raw.replace(/^ +/, "").length;
    const content = raw.trim();
    const row = document.createElement("div");
    row.className = indent === 0 ? "sr-line sr-head" : indent >= 6 ? "sr-line sr-sub" : "sr-line";
    if (indent > 0) row.style.paddingLeft = `${Math.min(indent, 8) * 0.7}em`;
    // "label:  value" (two+ spaces before the value) splits into key/value;
    // a trailing-colon line is a section header for the rows beneath it.
    const m = content.match(/^(.*?:)\s{2,}(.+)$/);
    if (m) {
      const key = document.createElement("span");
      key.className = "sr-key";
      key.textContent = m[1];
      const val = document.createElement("span");
      val.className = "sr-val";
      val.textContent = m[2];
      row.append(key, val);
    } else {
      if (content.endsWith(":")) row.classList.add("sr-section");
      row.textContent = content;
    }
    sessionModalBodyEl.appendChild(row);
  }
}

function openSessionModal(text) {
  renderSessionReport(text);
  sessionModalEl.classList.remove("hidden");
  openModalA11y(sessionModalEl, sessionModalDoneEl);
}

function closeSessionModal() {
  if (sessionModalEl.classList.contains("hidden")) return;
  sessionModalEl.classList.add("hidden");
  closeModalA11y();
}

if (sessionModalCloseEl) sessionModalCloseEl.addEventListener("click", closeSessionModal);
if (sessionModalDoneEl) sessionModalDoneEl.addEventListener("click", closeSessionModal);
if (sessionModalEl) {
  // Click on the backdrop (outside the box) closes, like the other overlays.
  sessionModalEl.addEventListener("click", (e) => {
    if (e.target === sessionModalEl) closeSessionModal();
  });
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
  // "Always allow" is offered only when the engine sent a subject to scope the
  // grant to. Without one there is nothing durable to remember, and the button
  // would silently behave like ALLOW ONCE.
  const grantable = typeof activePermission.subject === "string" && activePermission.subject !== "";
  if (allowAlwaysBtnEl) allowAlwaysBtnEl.classList.toggle("hidden", !grantable);
  if (allowAlwaysHintEl) {
    allowAlwaysHintEl.classList.toggle("hidden", !grantable);
    // The engine says what "always allow" would remember: a command shape
    // ("mkdir", "git push") when it can derive one, else this exact command.
    allowAlwaysHintEl.textContent =
      typeof activePermission.grant === "string" && activePermission.grant !== ""
        ? `“Always allow” covers every “${activePermission.grant} …” command in this workspace — other commands still ask.`
        : "“Always allow” remembers this exact command for this workspace — anything else still asks.";
  }
  // Each card starts with a blank note — never carry one card's note onto the next.
  if (permissionNoteEl) permissionNoteEl.value = "";
  deleteModalEl.classList.remove("hidden");
  // Initial focus goes to the default action, NOT the note textarea (the
  // first focusable in DOM order) — otherwise the single-key shortcuts
  // (Y/A/N) land in the note as typed text. The note is opt-in via Tab/click.
  openModalA11y(deleteModalEl, allowBtnEl);
  announce(`Approval required: ${subject}`);
}

function resolvePermission(decision) {
  if (!activePermission) return;
  // An optional note rides out with ANY decision — the engine folds it into the
  // refusal on deny, and delivers it as a system reminder on any allow.
  const note = permissionNoteEl ? permissionNoteEl.value.trim() : "";
  window.magentra.respondPermission(activePermission.id, decision, note);
  if (permissionNoteEl) permissionNoteEl.value = "";
  deleteModalEl.classList.add("hidden");
  closeModalA11y();
  activePermission = null;
  showNextPermission();
}

/** Drop pending permission requests wholesale — used when the engine process
 * goes away (crash or restart): a decision sent to the next engine would
 * answer a request that no longer exists. */
function clearPermissionState() {
  permissionQueue = [];
  activePermission = null;
  if (permissionNoteEl) permissionNoteEl.value = "";
  deleteModalEl.classList.add("hidden");
  closeModalA11y();
}

/** The engine process is gone: nothing it owed the UI (turn end, background
 * exits, permission decisions) will ever arrive — settle everything so a dead
 * process can never leave the composer locked. */
function onEngineGone() {
  backgroundJobs.clear();
  backgroundJobMeta.clear();
  renderBackgroundJobs();
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

  const questions = event.questions || [];
  // The engine holds the round open until every question is answered, so a
  // multi-question round needs to say so — otherwise answering the first card
  // and seeing nothing happen reads as a hang.
  const answered = new Set();
  let progressEl = null;
  if (questions.length > 1) {
    progressEl = document.createElement("div");
    progressEl.className = "question-progress";
    progressEl.textContent = `0 of ${questions.length} answered — answer all to continue`;
    // Appended after the cards, not before: the transcript sits at the live
    // edge, so a counter above three tall cards would be scrolled out of sight
    // exactly when it is telling the user there is more to answer.
  }
  function noteAnswered(qIdx) {
    answered.add(qIdx);
    if (!progressEl) return;
    const done = answered.size === questions.length;
    progressEl.textContent = done
      ? `${questions.length} of ${questions.length} answered`
      : `${answered.size} of ${questions.length} answered — answer all to continue`;
    progressEl.classList.toggle("complete", done);
  }

  questions.forEach((q, qIdx) => {
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
      if (answered.has(qIdx)) return; // a locked card must not re-answer
      window.magentra.send({
        type: "question_response",
        id: event.id,
        // Keyed by position, not question text — duplicate texts must not collide.
        answers: { [`q:${qIdx}`]: values },
      });
      cardEl.classList.add("answered");
      noteAnswered(qIdx);
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
      if (isRecommended) {
        const recEl = document.createElement("span");
        recEl.className = "q-rec";
        recEl.textContent = "★ recommended";
        btn.appendChild(recEl);
      }
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

  if (progressEl) withAutoScroll(() => streamEl.appendChild(progressEl));
}

function handleEngineEvent(event) {
  switch (event.type) {
    case "workspace_changed":
      enterActiveState(event.workspace);
      break;
    case "session_started":
      onSessionStarted(event);
      break;
    case "session_restored":
      onSessionRestored(event);
      break;
    case "session_list":
      onSessionList(event);
      break;
    case "turn_started":
      onTurnStarted();
      break;
    case "tool_output_delta":
      onToolOutputDelta(event);
      break;
    case "model_catalog":
      onModelCatalog(event);
      break;
    case "cwd_changed": {
      // Show when the session operates inside a worktree, and where.
      if (event.worktree) {
        const short = String(event.cwd || "").split(/[\\/]/).slice(-2).join("/");
        workspacePathEl.textContent = `${pathLeaf(activeWorkspace)} ⇒ ${short}`;
        workspaceWorktree = event.cwd;
        appendSysNote(`⌥ session cwd → ${event.cwd} (worktree)`);
      } else {
        workspacePathEl.textContent = pathLeaf(activeWorkspace || event.cwd);
        workspaceWorktree = null;
        appendSysNote("⌥ session cwd back at the workspace root");
      }
      renderSidebarWorkspaces();
      syncWorkbenchContext();
      break;
    }
    case "retry_status": {
      const secs = Math.max(1, Math.round((event.delayMs || 0) / 1000));
      showNowOverride(`${event.reason} — retrying in ${secs}s (attempt ${event.attempt})`);
      break;
    }
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
      announce("The agent is asking you a question.");
      break;
    case "command_output":
      onCommandOutput(event);
      break;
    case "session_report":
      openSessionModal(event.text || "");
      announce("Session report opened.");
      break;
    case "task_list_updated":
      onTaskListUpdated(event);
      break;
    case "overdrive_changed":
      onOverdriveChanged(event);
      break;
    case "modes_updated":
      onModesUpdated(event);
      break;
    case "team_updated":
      onTeamUpdated(event);
      break;
    case "skills_updated":
      actionSkills = Array.isArray(event.skills) ? event.skills : [];
      renderSkillsSurfaces();
      break;
    case "skill_draft":
      onSkillDraft(event);
      break;
    case "skill_export":
      onSkillExport(event);
      break;
    case "missions_updated":
      onMissionsUpdated(event);
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
      announce(`Error: ${event.message}`);
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
