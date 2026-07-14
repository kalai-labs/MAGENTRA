import type { Usage } from "@magentra/protocol";
import type { Provider, ProviderEvent, StreamRequest, StopReason } from "./types.js";

export interface FakeToolCall {
  id?: string;
  name: string;
  input: unknown;
}

/** One scripted assistant turn. */
export interface FakeTurn {
  text?: string;
  thinking?: string;
  toolCalls?: FakeToolCall[];
  stopReason?: StopReason;
  usage?: Partial<Usage>;
  /** Throw this error instead of streaming the turn. */
  error?: Error;
}

/**
 * Plays back scripted turns in order. Every test in the repo runs on this —
 * no test may call a real API. Records each StreamRequest it receives for
 * assertions.
 */
export class FakeProvider implements Provider {
  readonly requests: StreamRequest[] = [];
  private cursor = 0;
  private idCounter = 0;

  constructor(private readonly turns: FakeTurn[]) {}

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    const turn = this.turns[this.cursor++];
    if (!turn) {
      throw new Error(
        `FakeProvider script exhausted: request #${this.cursor} but only ${this.turns.length} turns scripted`,
      );
    }
    if (turn.error) throw turn.error;

    if (turn.thinking) {
      req.signal.throwIfAborted();
      yield { type: "thinking_delta", text: turn.thinking };
    }
    if (turn.text) {
      for (const chunk of splitChunks(turn.text)) {
        req.signal.throwIfAborted();
        yield { type: "text_delta", text: chunk };
      }
    }
    for (const call of turn.toolCalls ?? []) {
      req.signal.throwIfAborted();
      const id = call.id ?? `fake_tool_${++this.idCounter}`;
      yield { type: "tool_use_start", id, name: call.name };
      yield { type: "tool_use_delta", id, partialJson: JSON.stringify(call.input) };
      yield { type: "tool_use_end", id };
    }
    req.signal.throwIfAborted();
    yield {
      type: "message_end",
      stopReason: turn.stopReason ?? (turn.toolCalls?.length ? "tool_use" : "end_turn"),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...turn.usage,
      },
    };
  }
}

function splitChunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 16) out.push(text.slice(i, i + 16));
  return out;
}
