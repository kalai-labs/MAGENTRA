import type { ReasoningEffort } from "@magentra/protocol";

/**
 * The OpenAI-style `reasoning_effort` ladder, least to most. Our "off" is the
 * wire's "none"; every other level is spelled the same on both sides. This is
 * the vocabulary the most servers understand verbatim — Ollama's /v1 layer,
 * llama.cpp, vLLM, OpenAI, Nebius, Fireworks and OpenRouter all take it (some
 * without "minimal", some without "xhigh"/"max") — which is why it is the one
 * field sent, rather than a per-vendor table that would rot.
 */
export const WIRE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WireEffort = (typeof WIRE_EFFORTS)[number];

export function toWireEffort(level: ReasoningEffort): WireEffort {
  return level === "off" ? "none" : level;
}

/**
 * Remembers which effort levels an endpoint has refused and clamps every later
 * request to the nearest level it accepts — the user's rule made mechanical:
 * "if the value I set is over the maximum allowed for that model, the maximum
 * shall be taken."
 *
 * Learned from the endpoint's own 400s, like the negotiable fields in
 * OpenAICompatProvider, and remembered for the life of the provider instance,
 * so the cost of a model with a shorter ladder is one extra request, once.
 *
 *   - a rejected level ABOVE `high` lowers the ceiling to the level below it
 *     (max → xhigh → high)
 *   - a rejected level BELOW `high` raises the floor to the level above it
 *     (minimal → low → medium → high), because every reasoning endpoint has
 *     `high` if it has the field at all
 *   - a rejected `high`, or a body that says the FIELD itself is unknown,
 *     drops the field for good — nothing generic remains to try
 *   - a rejected `none` stops sending "none" (the caller may still switch
 *     thinking off another way, e.g. a chat-template flag)
 */
export class EffortClamp {
  /** Index into WIRE_EFFORTS of the highest level still believed accepted. */
  private ceiling = WIRE_EFFORTS.length - 1;
  /** Index of the lowest non-off level still believed accepted. */
  private floor = WIRE_EFFORTS.indexOf("minimal");
  private noneRejected = false;
  private fieldRejected = false;

  /** The wire value to send for `level`, or undefined when nothing should be sent. */
  resolve(level: ReasoningEffort): WireEffort | undefined {
    if (this.fieldRejected) return undefined;
    const wire = toWireEffort(level);
    if (wire === "none") return this.noneRejected ? undefined : "none";
    if (this.floor > this.ceiling) return undefined;
    const idx = Math.min(Math.max(WIRE_EFFORTS.indexOf(wire), this.floor), this.ceiling);
    return WIRE_EFFORTS[idx];
  }

  /**
   * Learn from a rejection of `sent`. `unknownField` says the body blamed the
   * field's existence, not its value. Returns true when the state changed —
   * i.e. a retry would send something different — and false when this
   * rejection teaches nothing new (the caller should give up and surface it).
   */
  reject(sent: WireEffort, unknownField: boolean): boolean {
    if (this.fieldRejected) return false;
    if (unknownField) {
      this.fieldRejected = true;
      return true;
    }
    if (sent === "none") {
      if (this.noneRejected) return false;
      this.noneRejected = true;
      return true;
    }
    const idx = WIRE_EFFORTS.indexOf(sent);
    const high = WIRE_EFFORTS.indexOf("high");
    if (idx > high) {
      if (this.ceiling < idx) return false;
      this.ceiling = idx - 1;
      return true;
    }
    if (idx < high) {
      if (this.floor > idx) return false;
      this.floor = idx + 1;
      return true;
    }
    // `high` itself refused: the endpoint has the field but not this ladder.
    this.fieldRejected = true;
    return true;
  }

  /**
   * One line for the user when what is sent differs from what they chose, or
   * undefined when it matches. Callers dedupe (a note per turn would be noise).
   */
  describe(level: ReasoningEffort, sent: WireEffort | undefined): string | undefined {
    const wanted = toWireEffort(level);
    if (sent === wanted) return undefined;
    if (sent === undefined) {
      return `reasoning effort "${level}" — this endpoint does not accept a reasoning-effort setting; the model runs at its default`;
    }
    return `reasoning effort "${level}" is not available on this model — using "${sent === "none" ? "off" : sent}", the nearest level it accepts`;
  }
}

/**
 * Does a 400/422 body blame the reasoning-effort setting at all? Providers
 * word it differently — OpenAI `"param": "reasoning_effort"`, Ollama
 * `invalid reasoning value`, Groq `reasoning_effort must be one of` — so the
 * field name (or "reasoning value") appearing in the rejection is the signal.
 */
export function mentionsReasoningEffort(errorText: string): boolean {
  return /reasoning[_ .-]?effort|reasoning value|"reasoning"/i.test(errorText);
}

/**
 * Does the body say the FIELD is unknown (as opposed to this VALUE being out of
 * range)? OpenAI: "Unrecognized request argument supplied"; pydantic servers:
 * "extra fields not permitted"/"Extra inputs are not permitted"; gateways:
 * "unknown parameter". A value complaint names the value or lists the allowed
 * ones and is handled by the ladder instead.
 */
export function looksLikeUnknownField(errorText: string): boolean {
  return /unrecognized|unknown (field|param|argument|key)|unsupported param|extra (fields?|inputs?)|not permitted|additional propert|is not allowed/i.test(
    errorText,
  );
}
