import { emptyUsage } from "@magentra/protocol";
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

/** Multimodal user content: the array form of `content`, sent only when a
 *  message actually carries an image (a plain string is what every server
 *  accepts, including the ones that never learned the array form). */
type WireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | WireContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}

/**
 * Request-body fields that "OpenAI-compatible" does not actually guarantee.
 * Each one is optional to us and load-bearing to somebody: dropping or renaming
 * a rejected field costs a detail, keeping it costs the whole turn.
 *
 *   stream_options  — token usage in the stream. Older vLLM/llama.cpp builds and
 *                     some gateways 400 on the unknown field; without it usage is
 *                     estimated instead of measured (see Session's fallback).
 *   max_tokens      — renamed to `max_completion_tokens` by OpenAI's reasoning
 *                     models, which reject the old name outright.
 *   num_ctx         — Ollama's context-window hint; not a standard field.
 *
 * Nothing that changes what the model can DO is negotiable this way — `tools` is
 * never dropped, because a silently tool-less agent looks like a broken model
 * rather than an unsupported endpoint.
 */
type NegotiableField = "stream_options" | "max_tokens" | "num_ctx";

/**
 * Does this 400/422 body blame one of the negotiable fields? Providers word
 * these differently ("Unsupported parameter", "unknown field", "extra fields not
 * permitted"), so the field NAME appearing in a rejection is the signal — a
 * server that accepted a field does not name it in an error.
 */
function rejectedField(errorText: string): NegotiableField | undefined {
  const text = errorText.toLowerCase();
  if (text.includes("stream_options")) return "stream_options";
  if (text.includes("max_completion_tokens")) return "max_tokens";
  if (text.includes("num_ctx")) return "num_ctx";
  if (text.includes("max_tokens") && /unsupported|not supported|unknown|unrecognized|not permitted|invalid/.test(text)) {
    return "max_tokens";
  }
  return undefined;
}

/**
 * Provider for any OpenAI-compatible chat completions endpoint — a hosted API,
 * a gateway, or a local server. Hand-rolled fetch + SSE — no SDK.
 *
 * "OpenAI-compatible" is a family resemblance, not a specification: servers
 * differ over which optional body fields they tolerate. Rather than shipping a
 * per-vendor table that would rot, this provider learns from the endpoint's own
 * rejections — see {@link NegotiableField} — and remembers for the rest of its
 * life, so the cost of an unfamiliar API is one extra request, once.
 */
export class OpenAICompatProvider implements Provider {
  /** Fields this endpoint has rejected, learned from its own 400s. */
  private readonly rejected = new Set<NegotiableField>();

  constructor(private readonly opts: OpenAICompatOptions) {}

  private buildBody(req: StreamRequest): Record<string, unknown> {
    const maxTokensKey = this.rejected.has("max_tokens") ? "max_completion_tokens" : "max_tokens";
    return {
      model: req.model,
      [maxTokensKey]: req.maxTokens,
      stream: true,
      ...(this.rejected.has("stream_options") ? {} : { stream_options: { include_usage: true } }),
      messages: toWireMessages(req.system, req.messages),
      ...(this.opts.numCtx && !this.rejected.has("num_ctx") ? { num_ctx: this.opts.numCtx } : {}),
      ...(req.tools.length > 0 ? { tools: req.tools.map(toWireTool) } : {}),
    };
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const response = await withRetry(
      async () => {
        // Loops only to re-send after learning that a field is unsupported. Each
        // field is learned at most once and the set is finite, so this
        // terminates — an unrecognized 400 throws on the first pass.
        for (;;) {
          const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // Keyless local servers (Ollama) reject an empty Bearer; omit it.
              ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
            },
            body: JSON.stringify(this.buildBody(req)),
            signal: req.signal,
          });
          if (res.ok) return res;
          const text = await res.text().catch(() => "");
          if (res.status === 400 || res.status === 422) {
            const field = rejectedField(text);
            if (field !== undefined && !this.rejected.has(field)) {
              this.rejected.add(field);
              continue;
            }
          }
          throw new ProviderHttpError(
            res.status,
            `provider returned ${res.status}: ${text.slice(0, 500)}`,
            parseRetryAfter(res.headers.get("retry-after")),
          );
        }
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
    // No message_start counterpart here: OpenAI-compatible endpoints report
    // usage only in the final chunk, so the caller keeps its own estimate of the
    // input context until `message_end` lands.
    let usage = emptyUsage();
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
      // Images ride in the same user message as the text that introduces them —
      // a separate message would let a server interleave them wrongly, and some
      // reject an image-only user turn outright.
      const images = msg.content.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image");
      if (images.length > 0) {
        wire.push({
          role: "user",
          content: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...images.map((b) => ({
              type: "image_url" as const,
              image_url: { url: `data:${b.mediaType};base64,${b.data}` },
            })),
          ],
        });
      } else if (text) {
        wire.push({ role: "user", content: text });
      }
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
