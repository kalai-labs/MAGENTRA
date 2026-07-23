import type {
  ContentBlock,
  Msg,
  Provider,
  ProviderEvent,
  StopReason,
  StreamRequest,
  ToolSchema,
} from "./types.js";
import { ProviderHttpError, parseRetryAfter, withRetry } from "./retry.js";

export interface OpenAICompatOptions {
  /** Bearer token. Empty string for keyless local servers (e.g. Ollama). */
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
  /** When set, sent as `num_ctx` so a local server loads the model with this
   *  context window. Ignored by hosted providers that don't recognize it. */
  numCtx?: number;
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}

/**
 * Provider for any OpenAI-compatible chat completions endpoint
 * (DeepInfra, OpenRouter, vLLM, ...). Hand-rolled fetch + SSE — no SDK.
 */
export class OpenAICompatProvider implements Provider {
  constructor(private readonly opts: OpenAICompatOptions) {}

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const body = {
      model: req.model,
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: toWireMessages(req.system, req.messages),
      ...(this.opts.numCtx ? { num_ctx: this.opts.numCtx } : {}),
      ...(req.tools.length > 0 ? { tools: req.tools.map(toWireTool) } : {}),
    };

    const response = await withRetry(
      async () => {
        const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Keyless local servers (Ollama) reject an empty Bearer; omit it.
            ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new ProviderHttpError(
            res.status,
            `provider returned ${res.status}: ${text.slice(0, 500)}`,
            parseRetryAfter(res.headers.get("retry-after")),
          );
        }
        return res;
      },
      req.signal,
      { maxRetries: this.opts.maxRetries, ...(req.onRetry ? { onRetry: req.onRetry } : {}) },
    );

    yield* this.parseSse(response, req.signal);
  }

  /** GET /models — the endpoint's real catalog for the UI's model picker. */
  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.opts.baseUrl}/models`, {
      headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
    });
    if (!res.ok) throw new ProviderHttpError(res.status, `GET /models returned ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  }

  private async *parseSse(
    response: Response,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    if (!response.body) throw new Error("provider response had no body");

    // tool calls are keyed by index in the OpenAI wire format
    const open = new Map<number, { id: string; started: boolean }>();
    // Pulls inline <think> reasoning out of the content stream (see class doc).
    const think = new ThinkTagSplitter();
    let finishReason: string | undefined;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let buffer = "";
    const decoder = new TextDecoder();

    const events: ProviderEvent[] = [];
    const handleChunk = (raw: string) => {
      const chunk = JSON.parse(raw) as {
        choices?: {
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: {
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      if (chunk.usage) {
        // Normalize to Usage's disjoint-classes contract (see @magentra/protocol):
        // inputTokens must be the FRESH prompt tokens only, with cache reads
        // counted separately, so the four fields sum to the whole prompt+reply.
        //
        // OpenAI-compatible APIs report it the other way round: `prompt_tokens`
        // is the WHOLE prompt and `cached_tokens` is a SUBSET of it. Passing
        // prompt_tokens straight through would count every cached token twice —
        // inflating the context reading and billing cached tokens at the full
        // input rate on top of the cache rate. Subtract to get the fresh part.
        const promptTokens = chunk.usage.prompt_tokens ?? 0;
        const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage = {
          inputTokens: Math.max(0, promptTokens - cachedTokens),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: cachedTokens,
          cacheWriteTokens: 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) return;
      if (delta.reasoning_content) {
        events.push({ type: "thinking_delta", text: delta.reasoning_content });
      }
      if (delta.content) {
        // Reasoning models that don't use `reasoning_content` inline their chain
        // of thought here wrapped in <think>…</think>; route that to the thinking
        // channel instead of letting the tags and prose leak into the answer.
        const { text, thinking } = think.push(delta.content);
        if (thinking) events.push({ type: "thinking_delta", text: thinking });
        if (text) events.push({ type: "text_delta", text });
      }
      for (const call of delta.tool_calls ?? []) {
        let entry = open.get(call.index);
        if (!entry) {
          entry = { id: call.id ?? `call_${call.index}_${Date.now()}`, started: false };
          open.set(call.index, entry);
        }
        if (!entry.started && call.function?.name) {
          entry.started = true;
          events.push({ type: "tool_use_start", id: entry.id, name: call.function.name });
        }
        if (call.function?.arguments) {
          events.push({
            type: "tool_use_delta",
            id: entry.id,
            partialJson: call.function.arguments,
          });
        }
      }
    };

    for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      buffer += decoder.decode(raw, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        handleChunk(data);
        yield* drain(events);
      }
    }

    // A partial tag held back for the next chunk that never came was never a
    // real tag — release it now, before the turn is sealed.
    const tail = think.flush();
    if (tail.thinking) yield { type: "thinking_delta", text: tail.thinking };
    if (tail.text) yield { type: "text_delta", text: tail.text };

    for (const entry of open.values()) {
      if (entry.started) yield { type: "tool_use_end", id: entry.id };
    }
    yield { type: "message_end", stopReason: mapFinish(finishReason), usage };
  }
}

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
 * endpoint (DeepSeek-R1, QwQ, …) do not populate the `reasoning_content` field:
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

function* drain(events: ProviderEvent[]): Iterable<ProviderEvent> {
  while (events.length > 0) yield events.shift()!;
}

function mapFinish(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "stop":
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

function toWireTool(tool: ToolSchema) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toWireMessages(system: string, messages: Msg[]): WireMessage[] {
  const wire: WireMessage[] = [];
  if (system) wire.push({ role: "system", content: system });

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const text = joinText(msg.content);
      const toolCalls = msg.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      wire.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // tool results must directly follow the assistant tool_calls message
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          wire.push({
            role: "tool",
            tool_call_id: block.toolUseId,
            content: flattenToolResult(block),
          });
        }
      }
      const text = joinText(msg.content);
      if (text) wire.push({ role: "user", content: text });
    }
  }
  return wire;
}

function joinText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function flattenToolResult(block: Extract<ContentBlock, { type: "tool_result" }>): string {
  if (typeof block.content === "string") return block.content;
  return block.content
    .map((p) => (p.type === "text" ? (p.text ?? "") : "[image omitted]"))
    .join("\n");
}
