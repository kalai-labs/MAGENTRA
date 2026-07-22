// Small pure helpers shared across the renderer.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function isNearBottom() {
  return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
}

function scrollToBottom() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function withAutoScroll(mutate) {
  const wasNear = isNearBottom();
  mutate();
  if (wasNear) scrollToBottom();
  syncScrollPill();
}

// "↓ latest" escape pill: content is streaming below the fold whenever the
// user has scrolled up — one click returns to the live edge.
function syncScrollPill() {
  if (!scrollPillEl) return;
  scrollPillEl.classList.toggle("hidden", isNearBottom());
}

if (typeof scrollPillEl !== "undefined" && scrollPillEl) {
  scrollPillEl.addEventListener("click", () => {
    scrollToBottom();
    syncScrollPill();
  });
  transcriptEl.addEventListener("scroll", syncScrollPill);
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
