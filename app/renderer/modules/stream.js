// The transcript stream: append helpers, tool rows, agent fleet cards.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Stream append helpers
// ---------------------------------------------------------------------------

/**
 * The longest prefix of `raw` that is safe to render as Markdown right now.
 *
 * Live text streams in as plain characters and only became Markdown when the
 * message finished, which meant a long answer sat on screen as raw source —
 * and, when a question card followed it, until the user had answered. So we
 * render progressively instead: everything up to the last blank line is
 * COMPLETE Markdown and can be committed, while the tail after it is still
 * being typed and stays plain.
 *
 * The blank line alone is not enough. A blank line inside an unterminated code
 * fence or display-math block would commit half a construct, which then
 * re-renders differently a moment later — the flicker the original all-at-once
 * approach was written to avoid. So a candidate cut point is only accepted
 * when the fences and `$$` delimiters before it are balanced.
 */
function markdownCommitPoint(raw) {
  const scan = newCommitScan();
  feedCommitScan(scan, raw);
  return scan.cut > 0 ? raw.slice(0, scan.cut + 1) : "";
}

/*
 * The scan behind markdownCommitPoint, kept on the streaming message and fed
 * each delta as it arrives, so a delta costs what it adds rather than what came
 * before it. Asked afresh on every delta, a long code block re-counted its
 * fences from the top once for every blank line inside it, and the answer got
 * slower to stream the longer it ran.
 *
 * A cut is the first newline of a "\n\n" (never at 0), and it is safe when the
 * text up to and including it holds an even number of fence lines and of `$$`.
 * Neither can span a newline, so both counts are sums over complete lines, and
 * a cut's verdict never changes once its line is complete — which is what lets
 * the scan only move forward. `cut` is the last safe cut, or -1; `line` is the
 * incomplete last line, which starts at index `at`.
 */
function newCommitScan() {
  return { line: "", at: 0, fences: 0, display: 0, cut: -1 };
}

/** Read `text`, the next piece of the message, into `scan`. */
function feedCommitScan(scan, text) {
  if (text.indexOf("\n") === -1) {
    // No line was completed, so no cut can have become safe.
    scan.line += text;
    return;
  }
  const buf = scan.line + text;
  let start = 0;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(start, nl);
    const end = scan.at + nl; // this newline's index in the whole message
    if (line === "") {
      // An empty line: the newline before it is a candidate cut, and an empty
      // line adds nothing to either count.
      if (end - 1 > 0 && scan.fences % 2 === 0 && scan.display % 2 === 0) scan.cut = end - 1;
    } else {
      // The same patterns the whole-text count used, applied per line — so a
      // `^` after a lone \r inside a line still counts exactly as it did.
      scan.fences += (line.match(/^[ \t]*(?:```|~~~)/gm) || []).length;
      scan.display += (line.match(/\$\$/g) || []).length;
    }
    start = nl + 1;
    nl = buf.indexOf("\n", start);
  }
  scan.line = buf.slice(start);
  scan.at += start;
}

/**
 * Renders whatever has become complete since the last call, and leaves the rest
 * as live plain text. Only the NEW segment is parsed each time, so a long
 * message costs linear work overall rather than re-rendering itself on every
 * delta. finalizeAssistantEl re-renders the whole message at the end, which
 * corrects anything the segment-by-segment view split awkwardly.
 *
 * `text` is the delta just added to `el._raw`. When it completes nothing, the
 * live tail only grows by it, so it is appended rather than rewritten.
 */
function commitStreamedMarkdown(el, text) {
  const done = el._mdDone || el.querySelector(".md-done");
  const live = el._mdLive || el.querySelector(".md-live");
  if (!done || !live) return;
  const scan = el._commitScan || (el._commitScan = newCommitScan());
  feedCommitScan(scan, text);
  const committed = el._committedLen || 0;
  const cutLen = scan.cut > 0 ? scan.cut + 1 : 0;
  if (cutLen > committed) {
    const raw = el._raw || "";
    try {
      done.appendChild(renderMarkdown(raw.slice(committed, cutLen)));
      el._committedLen = cutLen;
    } catch {
      /* keep the plain live text; the final render will fix it */
    }
    live.textContent = raw.slice(el._committedLen || 0);
    return;
  }
  if (live.firstChild) live.firstChild.appendData(text);
  else if (text) live.appendChild(document.createTextNode(text));
}

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
 * one. Leaves it in the transcript, collapsed, now holding all of its text —
 * written before whatever ended it is appended below it. */
function finalizeThinkingEl() {
  if (!currentThinkingEl) return;
  const el = currentThinkingEl;
  followLiveEdge(() => finishReasoning(el), scrollerOf(el.closest(".stream")));
  el.classList.add("done");
  currentThinkingEl = null;
}

// ---------------------------------------------------------------------------
// Streaming, once per frame
//
// A reasoning model sends its thoughts as tens of thousands of deltas of a few
// characters each (127,802 in the 2026-09-23 field run). Writing each one into
// the page and then reading scrollHeight made the renderer lay the transcript
// out once per token; with the reasoning block open that cost grew with the
// block, and the window fell 25 minutes behind the engine (FIX-PLAN T01). So:
//   - the live edge is measured once per frame, before that frame's first
//     write, and followed once, just before the frame is drawn;
//   - reasoning text waits on its own block and is written once per frame;
//   - a live reasoning block shows only the end of its text.
// Everything pending lives on the element it belongs to, never in the
// per-tab globals, so it lands in its own tab's transcript whichever tab is
// focused when the frame runs.
// ---------------------------------------------------------------------------

const pendingReasoningEls = new Set(); // reasoning blocks holding text not yet on the page
const pendingFollows = new Map(); // scroller -> whether it was at the live edge before this frame's first write
let streamFrameId = null;
let streamFrameTimer = null;

// A hidden or covered window draws no frames, so a timer stands behind the
// frame request: text still lands, just less often.
const STREAM_FRAME_FALLBACK_MS = 250;

function requestStreamFrame() {
  if (streamFrameId !== null) return;
  streamFrameId = requestAnimationFrame(runStreamFrame);
  streamFrameTimer = setTimeout(runStreamFrame, STREAM_FRAME_FALLBACK_MS);
}

function runStreamFrame() {
  cancelAnimationFrame(streamFrameId);
  clearTimeout(streamFrameTimer);
  streamFrameId = null;
  streamFrameTimer = null;
  // Measure every live edge first, then write, then scroll: reads between
  // writes would each force a layout.
  const els = [...pendingReasoningEls];
  pendingReasoningEls.clear();
  for (const el of els) {
    const c = scrollerOf(el.closest(".stream"));
    if (c && !pendingFollows.has(c)) pendingFollows.set(c, isNearBottom(c));
  }
  for (const el of els) writeReasoning(el);
  for (const [c, wasNear] of pendingFollows) {
    if (wasNear && c.isConnected) c.scrollTop = c.scrollHeight;
  }
  pendingFollows.clear();
  syncScrollPill();
}

/** withAutoScroll for a stream's per-delta writes: the same "stay at the live
 * edge if the user was there" rule, asked once per frame instead of once per
 * delta. `scroller` defaults to the stream of the tab being handled. */
function followLiveEdge(mutate, scroller = scrollContainer()) {
  if (scroller && !pendingFollows.has(scroller)) pendingFollows.set(scroller, isNearBottom(scroller));
  mutate();
  if (scroller) requestStreamFrame();
}

// While a block streams it shows the last REASONING_TAIL_KEEP characters, cut
// back once they pass REASONING_TAIL_MAX, after one line saying how much is
// held back. The whole text stays on the element and is written into the
// block when it ends, so a finished block — and a restored one — holds all of it.
const REASONING_TAIL_KEEP = 8000;
const REASONING_TAIL_MAX = 10000;

/** A reasoning block: a dim, collapsed <details> whose body is the reasoning. */
function createReasoningEl(done) {
  const el = document.createElement("details");
  el.className = done ? "msg-thinking done" : "msg-thinking";
  const summary = document.createElement("summary");
  summary.textContent = "reasoning";
  const body = document.createElement("div");
  body.className = "thinking-body";
  el.appendChild(summary);
  el.appendChild(body);
  if (!done) {
    const held = document.createElement("div");
    held.className = "thinking-held hidden";
    const tail = document.createTextNode("");
    body.appendChild(held);
    body.appendChild(tail);
    el._reasoning = { full: "", pending: "", tail: "", heldEl: held, tailNode: tail, summaryEl: summary, started: Date.now() };
  }
  return el;
}

/** A reasoning block's summary: "reasoning · 8m12s · ~12k tokens". The size is
 * estimated from characters like every live token figure; the time is shown
 * only for a block watched live — a restored one has none to show. A collapsed
 * block that says only "reasoning" for minutes reads as a frozen window. */
function reasoningLabel(chars, ms) {
  let label = "reasoning";
  if (ms !== undefined) label += ` · ${formatElapsed(ms)}`;
  if (chars > 0) label += ` · ~${formatTokens(estimateTokens(chars))} tokens`;
  return label;
}

/** Queue a reasoning delta on its block; the page gets it on the next frame. */
function appendReasoning(el, text) {
  const r = el._reasoning;
  if (!r || !text) return;
  r.full += text;
  r.pending += text;
  pendingReasoningEls.add(el);
  requestStreamFrame();
}

/** Put a live block's queued text on the page, keeping only its tail there. */
function writeReasoning(el) {
  const r = el._reasoning;
  if (!r || !r.pending) return;
  let tail = r.tail + r.pending;
  r.pending = "";
  if (tail.length > REASONING_TAIL_MAX) {
    let cut = tail.length - REASONING_TAIL_KEEP;
    // Start the visible part at a line when one is near, not mid-word.
    const nl = tail.indexOf("\n", cut);
    if (nl !== -1 && nl - cut < 400) cut = nl + 1;
    tail = tail.slice(cut);
  }
  r.tail = tail;
  r.tailNode.data = tail;
  r.summaryEl.textContent = reasoningLabel(r.full.length, Date.now() - r.started);
  const held = r.full.length - tail.length;
  if (held > 0) {
    r.heldEl.classList.remove("hidden");
    r.heldEl.textContent = `… ${held.toLocaleString()} earlier characters are held back while the reasoning streams — all of it appears here when it ends`;
  }
}

/** A block has ended: write all of its text, in order. What was held back goes
 * where the "held back" line was, above the tail, so a reader of an open block
 * keeps their place. */
function finishReasoning(el) {
  const r = el._reasoning;
  if (!r) return;
  el._reasoning = null;
  pendingReasoningEls.delete(el);
  r.summaryEl.textContent = reasoningLabel(r.full.length, Date.now() - r.started);
  if (r.pending) r.tailNode.appendData(r.pending);
  const before = r.full.slice(0, r.full.length - r.tail.length - r.pending.length);
  if (before) r.heldEl.replaceWith(document.createTextNode(before));
  else r.heldEl.remove();
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

/* Compaction concerns the conversation itself, so its progress belongs in the
 * transcript rather than the detached-jobs chip under the composer. A calm,
 * emoji-free indicator (label + indeterminate sweep) sits in the chat while the
 * engine summarizes; removeCompactingCard() clears it when the engine reports
 * the compact job exited, and the context counter refreshes on the
 * context_update that accompanies it. */
function showCompactingCard() {
  if (!streamEl || compactingCardEl) return;
  finalizeAssistantEl();
  const el = document.createElement("div");
  el.className = "compacting";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "compacting-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "compacting-label";
  label.textContent = "Compacting conversation";
  const track = document.createElement("span");
  track.className = "compacting-track";
  track.setAttribute("aria-hidden", "true");
  el.append(spinner, label, track);
  compactingCardEl = el;
  withAutoScroll(() => streamEl.appendChild(el));
}

function removeCompactingCard() {
  if (!compactingCardEl) return;
  compactingCardEl.remove();
  compactingCardEl = null;
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

/** A soft, non-alarming heads-up (amber, not red) — engine warnings a user may
 * want to know but need not act on, e.g. "TLS verification is disabled". Deduped
 * by text so a warning that repeats across restarts shows only once. */
function appendSysNotice(text) {
  const target = streamEl || transcriptEl;
  if (!target) return null;
  // One is enough: skip an identical notice already on screen.
  for (const existing of target.querySelectorAll(".sys-notice")) {
    if (existing.textContent === text) return existing;
  }
  finalizeAssistantEl();
  const el = document.createElement("div");
  el.className = "sys-notice";
  el.textContent = text;
  withAutoScroll(() => target.appendChild(el));
  return el;
}

/** Clear the transient connection notices (soft warnings + red errors) — called
 * when a fresh working session proves the connection is good, so stale "no API
 * key" / TLS lines from a failed attempt don't linger after it's fixed. */
function clearTransientNotices() {
  for (const target of [streamEl, transcriptEl]) {
    if (!target) continue;
    for (const el of target.querySelectorAll(".sys-notice, .sys-error")) el.remove();
  }
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
// the turn's tool rows so the transcript reads log-style instead of
// loose rows. Closes when the model starts answering.
// ---------------------------------------------------------------------------

// The Magentra brand mark, drawn as a stroke SVG so it inherits the glyph color
// (accent while working, green when done) and scales crisply: a rounded square
// enclosing an angular "M". Kept in step with the .logo-mark elsewhere.
const WORK_GLYPH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5.5" stroke-width="1.6"/>' +
  '<path d="M6.6 16.6 L6.6 7.8 L12 12.9 L17.4 7.8 L17.4 16.6" stroke-width="2"/>' +
  "</svg>";

/** The open work group's body, opened if needed. `at` is the engine's time of
 * the call that opens it (the group is timed on the engine clock when it can be). */
function workStream(at) {
  if (!streamEl) return streamEl;
  if (!currentWorkGroup || !currentWorkGroup.el.isConnected) {
    const el = document.createElement("details");
    el.className = "work-group";
    el.open = true;
    const summary = document.createElement("summary");
    summary.className = "work-group-head";
    const glyph = document.createElement("span");
    glyph.className = "work-group-glyph";
    // Magentra's own mark — a rounded-square "M" monogram — instead of a generic
    // four-point sparkle. currentColor lets it inherit the accent while working
    // and the green "done" tint afterward; CSS gives it a gentle pulse.
    glyph.innerHTML = WORK_GLYPH_SVG;
    const label = document.createElement("span");
    label.className = "work-group-label";
    label.textContent = "Agent working";
    summary.append(glyph, label);
    const body = document.createElement("div");
    body.className = "work-group-body";
    el.append(summary, body);
    withAutoScroll(() => streamEl.appendChild(el));
    currentWorkGroup = { el, body, labelEl: label, start: typeof at === "number" ? at : Date.now(), lastAt: undefined };
  }
  return currentWorkGroup.body;
}

/** The model moved on (answering, or the turn ended): stamp the group with
 * its op count and elapsed time so the finished block reads as evidence. The
 * end is the engine's: `endAt` (the turn's end), else the last call's own
 * finish; the page's clock only when the engine sent neither. A group handled
 * late after a backlog still says how long the work took. */
function closeWorkGroup(endAt) {
  if (!currentWorkGroup) return;
  const { el, body, labelEl, start, lastAt } = currentWorkGroup;
  el.classList.add("done");
  const ops = body.querySelectorAll(".tool-row").length;
  const end = typeof endAt === "number" ? endAt : typeof lastAt === "number" ? lastAt : Date.now();
  labelEl.textContent = `Agent worked · ${ops} op${ops === 1 ? "" : "s"} · ${formatElapsed(end - start)}`;
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
  context_overflow: "the model's context window overflowed",
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
let runningToolRows = new Set(); // let: reassigned by the per-tab state swap (tabs.js)
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

/**
 * Find the row a tool event belongs to, wherever it lives.
 *
 * A SUBAGENT's tool rows are stored on its agent card (`card.toolRows`), not in
 * the flat map — onToolCallStarted/Finished both branch on `event.subagent` to
 * pick the right one. But `tool_output_delta` carries no subagent tag at all
 * (engine/protocol only stamps that onto tool_call_started/finished), so a flat
 * lookup silently dropped every delta from a subagent's shell command: the live
 * tail simply never appeared inside an agent card. Resolving by id across both
 * places fixes it without touching the wire.
 */
function findToolRow(id) {
  const own = toolRows.get(id);
  if (own) return own;
  for (const card of agentCards.values()) {
    const row = card.toolRows && card.toolRows.get(id);
    if (row) return row;
  }
  return null;
}

/** Live tail: incremental tool output renders under its row while it runs. */
function onToolOutputDelta(event) {
  const row = findToolRow(event.id);
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
  // The live edge is measured once per frame, not per delta: a noisy command
  // (a Workflow log, which is not throttled) forced a layout on every line.
  followLiveEdge(() => {
    row.tailEl.textContent = lines.slice(-3).join("\n");
  }, scrollerOf(row.rowEl.closest(".stream")));
}

/** `finishedAt` is the engine's tool_call_finished.at, when it sent one. */
function finishToolRow(row, isError, resultPreview, finishedAt) {
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
  if (row.timeEl) row.timeEl.textContent = formatElapsed((typeof finishedAt === "number" ? finishedAt : Date.now()) - row.startMs);

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
  if (typeof chromeIsFocused === "function" && !chromeIsFocused()) return; // background tab: the shared topbar meter reflects the focused tab only
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
