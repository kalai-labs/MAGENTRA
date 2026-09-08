const THINK_TAGS: { text: string; kind: "open" | "close" }[] = [
  { text: "<think>", kind: "open" },
  { text: "</think>", kind: "close" },
  { text: "<thinking>", kind: "open" },
  { text: "</thinking>", kind: "close" },
];

function matchThinkTag(s: string, i: number): { length: number; kind: "open" | "close" } | null {
  for (const tag of THINK_TAGS) {
    if (s.startsWith(tag.text, i)) return { length: tag.text.length, kind: tag.kind };
  }
  return null;
}

/** True when `sub` is a non-empty, still-incomplete prefix of some think tag —
 *  i.e. it could still grow into one once the next chunk arrives. */
function isThinkTagPrefix(sub: string): boolean {
  return THINK_TAGS.some((tag) => tag.text.length > sub.length && tag.text.startsWith(sub));
}

/**
 * Separates inline <think>…</think> reasoning from the answer in a streamed
 * content channel. Some reasoning models served over an OpenAI-compatible
 * endpoint do not populate the `reasoning_content` field:
 * they inline their chain of thought straight into `content`, wrapped in
 * <think>…</think> — and some emit only a stray closing </think> when the chat
 * template opened the block implicitly. Left untouched those tags and the
 * reasoning prose leak into the visible answer (and get replayed as assistant
 * text next turn). This splitter reroutes inline reasoning through the same
 * thinking channel as a native reasoning field.
 *
 * Stream-safe: a tag can straddle two SSE chunks, so a trailing partial that
 * could still become a tag is held back until the next chunk (or `flush`)
 * resolves it. A stray </think> with no matching open is simply dropped, and a
 * literal `<` that is not a tag is passed through untouched.
 *
 * (Cost: the astronomically rare answer that legitimately contains a literal
 * <think>/<thinking> tag would have it stripped — the accepted trade every such
 * client makes to keep reasoning models' scratchpads out of the transcript.)
 *
 * Its own module because two transports share it — the OpenAI-compatible SSE
 * stream and Ollama's native NDJSON stream — and the second imports the first.
 */
export class ThinkTagSplitter {
  private inThink = false;
  private held = "";

  /** Route one content chunk into answer text and/or reasoning text. */
  push(chunk: string): { text: string; thinking: string } {
    const s = this.held + chunk;
    this.held = "";
    let text = "";
    let thinking = "";
    let segStart = 0;
    const emit = (end: number) => {
      const piece = s.slice(segStart, end);
      if (!piece) return;
      if (this.inThink) thinking += piece;
      else text += piece;
    };
    let i = 0;
    while (i < s.length) {
      if (s[i] === "<") {
        const tag = matchThinkTag(s, i);
        if (tag) {
          emit(i);
          this.inThink = tag.kind === "open";
          i += tag.length;
          segStart = i;
          continue;
        }
        // A tag fragment at the very tail: keep it for the next chunk.
        if (isThinkTagPrefix(s.slice(i))) {
          emit(i);
          this.held = s.slice(i);
          return { text, thinking };
        }
      }
      i++;
    }
    emit(s.length);
    return { text, thinking };
  }

  /** Stream ended: release any held fragment as ordinary text/reasoning. */
  flush(): { text: string; thinking: string } {
    const piece = this.held;
    this.held = "";
    if (!piece) return { text: "", thinking: "" };
    return this.inThink ? { text: "", thinking: piece } : { text: piece, thinking: "" };
  }
}
