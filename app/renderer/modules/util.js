// Small pure helpers shared across the renderer.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

// The element that actually scrolls for the tab whose stream is currently live
// (streamEl): in the tiled multi-pane layout each pane's own .stream scrolls
// itself, so THAT is the scroller; in the single console view the shared
// #transcript scrolls its child stream. A detached stream (a background tab in
// single view) has no visible scroller — return null so we never scroll the
// focused tab's view on another tab's event.
function scrollContainer() {
  if (!streamEl) return null;
  const parent = streamEl.parentNode;
  if (parent && parent.classList && parent.classList.contains("console-pane")) return streamEl;
  if (parent === transcriptEl) return transcriptEl;
  return null;
}

function isNearBottom(el) {
  const c = el || scrollContainer();
  if (!c) return true; // detached: treat as pinned so it stays at the live edge once mounted
  return c.scrollHeight - c.scrollTop - c.clientHeight < 40;
}

function scrollToBottom(el) {
  const c = el || scrollContainer();
  if (!c) return;
  c.scrollTop = c.scrollHeight;
}

// Auto-follow the live edge, but only when the user was already there — scrolling
// up mid-answer to read back is preserved (we don't yank them down).
function withAutoScroll(mutate) {
  const c = scrollContainer();
  const wasNear = isNearBottom(c);
  mutate();
  if (wasNear) scrollToBottom(c);
  syncScrollPill();
}

// "↓ latest" escape pill: content is streaming below the fold whenever the
// user has scrolled up — one click returns to the live edge. It belongs to the
// single console view; the tiled layout gives each pane its own scroller, so the
// one shared pill is hidden there.
function syncScrollPill() {
  if (!scrollPillEl) return;
  if (document.body.classList.contains("tiled")) {
    scrollPillEl.classList.add("hidden");
    return;
  }
  scrollPillEl.classList.toggle("hidden", isNearBottom(transcriptEl));
}

if (typeof scrollPillEl !== "undefined" && scrollPillEl) {
  scrollPillEl.addEventListener("click", () => {
    scrollToBottom();
    syncScrollPill();
  });
  transcriptEl.addEventListener("scroll", syncScrollPill);
}

// A brief notice dropped from the top navbar — for soft, transient warnings
// (e.g. the workspace cap) that should NOT land in a conversation as a system
// note. Re-showing restarts the timer; it fades itself after `ms`.
let topToastTimer = null;
function showTopToast(message, ms = 3200) {
  if (!topToastEl) return;
  topToastEl.textContent = message;
  topToastEl.classList.remove("hidden");
  if (topToastTimer) clearTimeout(topToastTimer);
  topToastTimer = setTimeout(() => {
    topToastEl.classList.add("hidden");
    topToastTimer = null;
  }, ms);
}

function timeString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactInput(input) {
  let s = safeStringify(input) || "";
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 90) s = s.slice(0, 87) + "...";
  return s;
}

function setStatusLed(state) {
  if (typeof chromeIsFocused === "function" && !chromeIsFocused()) return; // background tab: LED reflects the focused tab only
  statusLedEl.className = state;
  statusLedEl.title = state;
  if (sidebarStatusTextEl) {
    sidebarStatusTextEl.textContent = state === "busy" ? "Working" : state === "error" ? "Needs attention" : "Ready";
  }
}

function looksLikeErrorLine(line) {
  return (
    line.includes("Error") ||
    line.includes("error:") ||
    line.includes("Traceback") ||
    line.includes("failed") ||
    line.includes("exit code")
  );
}

function summarizeError(resultPreview) {
  const lines = String(resultPreview || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  const last = lines[lines.length - 1];
  let chosen = looksLikeErrorLine(last) ? last : lines[0];
  if (chosen.length > 160) chosen = chosen.slice(0, 157) + "...";
  return chosen;
}
