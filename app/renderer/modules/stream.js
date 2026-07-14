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
  currentAssistantEl = null;
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
  if (!streamEl) return null;
  const el = document.createElement("div");
  el.className = "sys-error";
  el.textContent = text;
  withAutoScroll(() => streamEl.appendChild(el));
  return el;
}

function appendUserMessage(text) {
  finalizeAssistantEl();
  if (!streamEl) return;
  const el = document.createElement("div");
  el.className = "msg-user";
  el.textContent = text;
  withAutoScroll(() => streamEl.appendChild(el));
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

function appendTurnSeparator() {
  if (!streamEl) return;
  trimStream();
  const el = document.createElement("div");
  el.className = "turn-sep";
  el.textContent = timeString();
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

  rowEl.appendChild(glyphEl);
  rowEl.appendChild(nameEl);
  rowEl.appendChild(descEl);

  const detailEl = document.createElement("pre");
  detailEl.className = "tool-detail";

  if (!cinematic) {
    rowEl.addEventListener("click", () => rowEl.classList.toggle("open"));
  }

  return { rowEl, detailEl, glyphEl };
}

function finishToolRow(row, isError, resultPreview) {
  row.rowEl.classList.remove("running");
  row.rowEl.classList.add(isError ? "err" : "ok");
  row.glyphEl.textContent = isError ? "✗" : "✓"; // ✗ / ✓

  const cinematic = row.rowEl.classList.contains("op-cine");
  if (!cinematic) {
    row.detailEl.textContent = resultPreview;
  }

  if (isError) {
    if (cinematic) {
      const summaryEl = document.createElement("span");
      summaryEl.className = "tool-err-summary";
      summaryEl.textContent = "hit a snag — recovering";
      row.rowEl.insertAdjacentElement("afterend", summaryEl);
    } else {
      const summary = summarizeError(resultPreview);
      if (summary) {
        const summaryEl = document.createElement("span");
        summaryEl.className = "tool-err-summary";
        summaryEl.textContent = summary;
        row.rowEl.insertAdjacentElement("afterend", summaryEl);
      }
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

function finalizeAllAgentCards() {
  for (const card of agentCards.values()) finalizeCard(card);
  updateAgentMeter();
}
