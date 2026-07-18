// The transcript stream: append helpers, tool rows, agent fleet cards.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Stream append helpers
// ---------------------------------------------------------------------------

/* Close the streaming assistant paragraph so the NEXT text delta starts a
 * fresh one below whatever is appended after this call. Keeps the transcript
 * strictly chronological instead of splicing later text into an old bubble. */
function finalizeAssistantEl() {
  if (!currentAssistantEl) return;
  const caret = currentAssistantEl.querySelector(".caret");
  if (caret) caret.remove();
  // Swap the plain live text for its Markdown rendering. On the off chance the
  // renderer throws on some pathological input, the raw text already on screen
  // stays — a message must never vanish over formatting.
  const raw = currentAssistantEl._raw;
  const body = currentAssistantEl.querySelector(".msg-body") || currentAssistantEl;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const rendered = renderMarkdown(raw);
      body.textContent = "";
      body.appendChild(rendered);
    } catch {
      /* keep the plain live text already rendered */
    }
  }
  currentAssistantEl = null;
}

/* Close the live reasoning block so the next segment's thinking starts a fresh
 * one. Leaves it in the transcript, collapsed. */
function finalizeThinkingEl() {
  if (!currentThinkingEl) return;
  currentThinkingEl.classList.add("done");
  currentThinkingEl = null;
}

function appendSysNote(text) {
  finalizeAssistantEl();
  if (!streamEl) return null;
  const el = document.createElement("div");
  el.className = "sys-note";
  el.textContent = text;
  withAutoScroll(() => streamEl.appendChild(el));
  return el;
}

function appendSysError(text) {
  finalizeAssistantEl();
  // Before a workspace opens there is no stream yet, but a boot/IPC error must
  // still be visible — fall back to the transcript container so it lands on the
  // landing page instead of vanishing (the status LED was the only prior clue).
  const target = streamEl || transcriptEl;
  if (!target) return null;
  const el = document.createElement("div");
  el.className = "sys-error";
  el.textContent = text;
  withAutoScroll(() => target.appendChild(el));
  return el;
}

/** Short clock time for message headers ("9:41 AM" style, locale-aware). */
function messageClock() {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date());
}

/** One message card: avatar chip + role + time header, body below. Shared by
 * user messages, streamed assistant messages, and session restore. */
function createMessageEl(role) {
  const el = document.createElement("div");
  el.className = role === "user" ? "msg-user" : "msg-assistant";
  const head = document.createElement("div");
  head.className = "msg-head";
  const avatar = document.createElement("span");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "◇" : "M";
  const name = document.createElement("span");
  name.className = "msg-role";
  name.textContent = role === "user" ? "You" : "Magentra";
  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = messageClock();
  head.append(avatar, name, time);
  const body = document.createElement("div");
  body.className = "msg-body";
  el.append(head, body);
  return { el, body };
}

function appendUserMessage(text) {
  finalizeAssistantEl();
  if (!streamEl) return;
  const { el, body } = createMessageEl("user");
  body.textContent = text;
  withAutoScroll(() => streamEl.appendChild(el));
}

// ---------------------------------------------------------------------------
// "Agent working" group: one collapsible block per work stretch, collecting
// the turn's tool rows so the transcript reads mission-log style instead of
// loose rows. Closes when the model starts answering.
// ---------------------------------------------------------------------------

function workStream() {
  if (!streamEl) return streamEl;
  if (!currentWorkGroup || !currentWorkGroup.el.isConnected) {
    const el = document.createElement("details");
    el.className = "work-group";
    el.open = true;
    const summary = document.createElement("summary");
    summary.className = "work-group-head";
    const glyph = document.createElement("span");
    glyph.className = "work-group-glyph";
    glyph.textContent = "✦";
    const label = document.createElement("span");
    label.className = "work-group-label";
    label.textContent = "Agent working";
    summary.append(glyph, label);
    const body = document.createElement("div");
    body.className = "work-group-body";
    el.append(summary, body);
    withAutoScroll(() => streamEl.appendChild(el));
    currentWorkGroup = { el, body, labelEl: label, start: Date.now() };
  }
  return currentWorkGroup.body;
}

/** The model moved on (answering, or the turn ended): stamp the group with
 * its op count and elapsed time so the finished block reads as evidence. */
function closeWorkGroup() {
  if (!currentWorkGroup) return;
  const { el, body, labelEl, start } = currentWorkGroup;
  el.classList.add("done");
  const ops = body.querySelectorAll(".tool-row").length;
  labelEl.textContent = `Agent worked · ${ops} op${ops === 1 ? "" : "s"} · ${formatElapsed(Date.now() - start)}`;
  currentWorkGroup = null;
}

function appendPhaseBanner(text) {
  finalizeAssistantEl();
  if (!streamEl) return;
  const el = document.createElement("div");
  el.className = "phase-banner";
  el.textContent = text;
  withAutoScroll(() => streamEl.appendChild(el));
}

// Long sessions grow the transcript without bound; trim the oldest rows at
// turn boundaries and drop map entries whose DOM nodes went with them.
const STREAM_MAX_NODES = 2400;
function trimStream() {
  if (!streamEl || streamEl.children.length <= STREAM_MAX_NODES) return;
  while (streamEl.children.length > STREAM_MAX_NODES - 400) {
    streamEl.removeChild(streamEl.firstChild);
  }
  const notice = document.createElement("div");
  notice.className = "sys-note trim-notice";
  notice.textContent = currentSessionId
    ? `older messages trimmed — full log in \`.magentra/sessions/${currentSessionId}.jsonl\``
    : "older messages trimmed — full log remains in `.magentra/sessions/`";
  streamEl.insertBefore(notice, streamEl.firstChild);
  for (const [id, row] of toolRows) {
    if (!row.rowEl.isConnected) toolRows.delete(id);
  }
  for (const [key, card] of agentCards) {
    if (!card.cardEl.isConnected) {
      if (card.intervalId) clearInterval(card.intervalId);
      agentCards.delete(key);
    }
  }
}

// How a turn ended, for the separator. A clean completion says nothing extra;
// anything else is worth surfacing so the user can tell "done" from "stopped"
// or "failed" at a glance.
const STOP_REASON_LABELS = {
  aborted: "stopped by you",
  error: "ended with an error",
  max_tokens: "hit the response length limit",
  max_iterations: "hit the tool-round limit",
  refusal: "the model declined",
};

function appendTurnSeparator(stopReason) {
  if (!streamEl) return;
  trimStream();
  const el = document.createElement("div");
  el.className = "turn-sep";
  const label = STOP_REASON_LABELS[stopReason];
  if (label) {
    el.classList.add("flagged");
    el.textContent = `${timeString()} · ${label}`;
  } else {
    el.textContent = timeString();
  }
  withAutoScroll(() => streamEl.appendChild(el));
}

// ---------------------------------------------------------------------------
// Tool row lifecycle (shared between main stream and agent cards)
// ---------------------------------------------------------------------------

/* Cinematic mode never shows descriptions, commands, patterns, prompts, or
 * JSON — only a file basename when the input plausibly names one. */
function cinematicHint(input) {
  if (!input || typeof input !== "object") return "";
  let raw = null;
  if (typeof input.file_path === "string") raw = input.file_path;
  else if (typeof input.path === "string") raw = input.path;
  if (!raw) return "";
  const idx = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  return idx === -1 ? raw : raw.slice(idx + 1);
}

function createToolRow(tool, description, input) {
  const rowEl = document.createElement("div");
  rowEl.className = "tool-row running";

  const glyphEl = document.createElement("span");
  glyphEl.className = "glyph";

  const nameEl = document.createElement("span");
  nameEl.className = "tool-name";

  const descEl = document.createElement("span");
  descEl.className = "tool-desc";

  // Detail mode is read live at row creation: flipping the setting only
  // affects new rows, existing rows keep whatever mode they were born in.
  const cinematic = uiSettings.detail === "cinematic";

  if (cinematic) {
    rowEl.classList.add("op-cine");
    glyphEl.textContent = "◆";
    nameEl.textContent = OP_VERBS[tool] || "processing";
    descEl.textContent = cinematicHint(input);
  } else {
    glyphEl.textContent = "▸"; // ▸
    nameEl.textContent = tool;
    descEl.textContent = " " + (description || compactInput(input));
  }

  // Right-aligned duration chip: ticks while the op runs, freezes on finish —
  // the transcript doubles as a flight recorder.
  const timeEl = document.createElement("span");
  timeEl.className = "tool-time";
  timeEl.textContent = "0s";

  rowEl.appendChild(glyphEl);
  rowEl.appendChild(nameEl);
  rowEl.appendChild(descEl);
  rowEl.appendChild(timeEl);

  const detailEl = document.createElement("pre");
  detailEl.className = "tool-detail";

  // Every row is click-to-expand, cinematic included: the choreography is the
  // default look, but a user must always be able to open a row and see the
  // exact command and result — that is the whole basis of trusting the agent.
  makeRowExpandable(rowEl);

  const row = { rowEl, detailEl, glyphEl, timeEl, startMs: Date.now() };
  runningToolRows.add(row);
  ensureToolTicker();
  return row;
}

// One shared 1s ticker updates every running row's duration chip; it stops
// itself when nothing is running so an idle app burns no timers.
const runningToolRows = new Set();
let toolTickerId = null;

function ensureToolTicker() {
  if (toolTickerId) return;
  toolTickerId = setInterval(() => {
    for (const row of runningToolRows) {
      if (!row.rowEl.isConnected) {
        runningToolRows.delete(row);
        continue;
      }
      row.timeEl.textContent = formatElapsed(Date.now() - row.startMs);
    }
    if (runningToolRows.size === 0) {
      clearInterval(toolTickerId);
      toolTickerId = null;
    }
  }, 1000);
}

/** Click-or-keyboard expandable row: focusable, Enter/Space toggles. */
function makeRowExpandable(rowEl) {
  rowEl.classList.add("expandable");
  rowEl.tabIndex = 0;
  rowEl.setAttribute("role", "button");
  rowEl.setAttribute("aria-expanded", "false");
  const toggle = () => {
    rowEl.classList.toggle("open");
    rowEl.setAttribute("aria-expanded", rowEl.classList.contains("open") ? "true" : "false");
  };
  rowEl.addEventListener("click", toggle);
  rowEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
}

/** Live tail: incremental tool output renders under its row while it runs. */
function onToolOutputDelta(event) {
  const row = toolRows.get(event.id);
  if (!row || !row.rowEl.isConnected) return;
  if (!row.tailEl) {
    row.tailEl = document.createElement("pre");
    row.tailEl.className = "tool-tail";
    row.rowEl.insertAdjacentElement("afterend", row.tailEl);
  }
  // Keep only the last few lines — the full output lands in the detail on finish.
  const combined = (row.tailText || "") + event.text;
  row.tailText = combined.length > 4000 ? combined.slice(-4000) : combined;
  const lines = row.tailText.split("\n").filter((l) => l.trim() !== "");
  withAutoScroll(() => {
    row.tailEl.textContent = lines.slice(-3).join("\n");
  });
}

function finishToolRow(row, isError, resultPreview) {
  // The live tail's job is done — the detail now holds the full output.
  if (row.tailEl) {
    row.tailEl.remove();
    row.tailEl = null;
    row.tailText = "";
  }
  row.rowEl.classList.remove("running");
  row.rowEl.classList.add(isError ? "err" : "ok");
  row.glyphEl.textContent = isError ? "✗" : "✓"; // ✗ / ✓
  runningToolRows.delete(row);
  if (row.timeEl) row.timeEl.textContent = formatElapsed(Date.now() - row.startMs);

  // The result is always available on expand, in both detail modes — hiding it
  // in cinematic left the user unable to inspect what a tool returned.
  row.detailEl.textContent = resultPreview;

  // Show the real error, never a euphemism: "hit a snag — recovering" told the
  // user nothing and hid genuine failures. summarizeError picks the meaningful
  // line from the result.
  if (isError) {
    const summary = summarizeError(resultPreview);
    if (summary) {
      const summaryEl = document.createElement("span");
      summaryEl.className = "tool-err-summary";
      summaryEl.textContent = summary;
      row.rowEl.insertAdjacentElement("afterend", summaryEl);
    }
  }
}

// ---------------------------------------------------------------------------
// Agent fleet cards
// ---------------------------------------------------------------------------

function ensureAgentsRow() {
  finalizeAssistantEl();
  if (!currentAgentsRow) {
    currentAgentsRow = document.createElement("div");
    currentAgentsRow.className = "agents-row";
    streamEl.appendChild(currentAgentsRow);
  }
  return currentAgentsRow;
}

function updateAgentMeter() {
  const runningCount = Array.from(agentCards.values()).filter((c) => c.running).length;
  agentCountEl.textContent = String(runningCount);
  toolCountEl.textContent = String(toolCountThisTurn);
  if (runningCount >= 1) {
    agentMeterEl.classList.remove("hidden");
  } else {
    agentMeterEl.classList.add("hidden");
  }
}

function getOrCreateAgentCard(event) {
  const key = event.agentId || "agent-solo";
  let card = agentCards.get(key);
  if (card) return card;

  withAutoScroll(() => ensureAgentsRow());

  const cardEl = document.createElement("div");
  cardEl.className = "agent-card running";
  if (event.agentColor) {
    cardEl.classList.add("crewed");
    cardEl.style.borderTopColor = event.agentColor;
  }

  const head = document.createElement("div");
  head.className = "agent-head";

  const glyphEl = document.createElement("span");
  glyphEl.className = "agent-glyph";
  glyphEl.textContent = "◇"; // ◇

  const titleEl = document.createElement("span");
  titleEl.className = "agent-title";
  titleEl.textContent = event.agentDesc || "AGENT";

  const timerEl = document.createElement("span");
  timerEl.className = "agent-timer";
  timerEl.textContent = "0s";

  const ledEl = document.createElement("span");
  ledEl.className = "agent-led";

  head.appendChild(glyphEl);
  head.appendChild(titleEl);
  head.appendChild(timerEl);
  head.appendChild(ledEl);

  const bodyEl = document.createElement("div");
  bodyEl.className = "agent-body";

  cardEl.appendChild(head);
  cardEl.appendChild(bodyEl);
  currentAgentsRow.appendChild(cardEl);

  const startTime = Date.now();
  const intervalId = setInterval(() => {
    timerEl.textContent = formatElapsed(Date.now() - startTime);
  }, 1000);

  card = {
    key,
    cardEl,
    bodyEl,
    timerEl,
    ledEl,
    titleEl,
    agentDesc: event.agentDesc || "AGENT",
    background: Boolean(event.background),
    running: true,
    intervalId,
    lastRowErr: false,
    toolRows: new Map(),
  };
  agentCards.set(key, card);
  updateAgentMeter();
  return card;
}

function finalizeCard(card) {
  if (!card.running) return;
  card.running = false;
  clearInterval(card.intervalId);
  card.cardEl.classList.remove("running");
  card.cardEl.classList.add(card.lastRowErr ? "failed" : "done");
}

/** Turn-end sweep. Background agents detach from the turn — they stay live
 * until their own agent_finished/background exit arrives. */
function finalizeAllAgentCards() {
  for (const card of agentCards.values()) {
    if (!card.background) finalizeCard(card);
  }
  updateAgentMeter();
}
