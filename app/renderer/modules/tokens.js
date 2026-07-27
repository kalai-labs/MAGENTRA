// The renderer's token vocabulary — the ONE place this side of the IPC boundary
// that turns token counts into text or estimates them from characters. Loaded as
// a classic script in index.html, first, so every later module can use it.
//
// It is the mirror of engine/protocol/src/tokens.ts and must stay identical to
// it: the renderer is a separate bundle and cannot import the engine's module,
// so the only thing keeping the two honest is that neither side has a second
// copy to drift into. Change one, change the other.
//
// Three quantities travel over the IPC boundary and must never be confused:
//
//   B(t)  CURRENT CONTEXT — how full the window is right now: the whole INPUT
//         (fresh + cache-write + cache-read) of the latest request. Point in
//         time; it does not accumulate, and generated output is not part of it.
//         Arrives as `contextTokens`.
//
//   D(t)  DELIBERATION OUTPUT — everything the CURRENT turn has generated, over
//         every model call it made including subagents'. Starts each turn at 0
//         and only climbs. Arrives as `outputTokens`.
//
//   T_turn CUMULATIVE TURN USAGE — every token the turn billed, all four
//         classes. The cost figure, and not a context size.
//
// The engine computes all three; the renderer only displays them. It never adds
// output to context, and never sums contexts over turns.

// κ — characters per token. Deliberately below real-world English (~4) so an
// estimate over-counts rather than under-counts.
const CHARS_PER_TOKEN = 3.5;

/** T̂ ≈ N_characters / κ — the estimate used where no exact count exists. Takes
 *  a string or a character count. */
function estimateTokens(input) {
  const chars = typeof input === "number" ? input : String(input || "").length;
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/** Display rounding: "12.3k", "210k", "1.5M". The step coarsens as the number
 *  grows — precision we do not have would be a lie. Each threshold is where the
 *  NEXT band's rounding takes over, so the text never reads backwards across one
 *  token: 9,949 → "9.9k", 9,950 → "10k", with no "10.0k" in between. */
function formatTokens(n) {
  const abs = Math.max(0, n || 0);
  if (abs >= 999_500) return `${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 9_950) return `${Math.round(abs / 1_000)}k`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
  return String(Math.round(abs));
}
