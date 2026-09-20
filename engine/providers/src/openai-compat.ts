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
import { ProviderHttpError, looksLikeContextOverflow, parseRetryAfter, withRetry } from "./retry.js";
import { EffortClamp, looksLikeUnknownField, mentionsReasoningEffort, type WireEffort } from "./effort.js";
import { OllamaProvider } from "./ollama.js";
import { ThinkTagSplitter } from "./think.js";

export interface OpenAICompatOptions {
  /** Bearer token. Empty string for keyless local servers (e.g. Ollama). */
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
  /**
   * The context window a local server should load the model with. Sent as
   * `num_ctx` on the /v1 body for servers that might read it there — and,
   * because Ollama's /v1 layer provably does NOT (its request struct has no
   * options field), an endpoint that turns out to be Ollama is driven through
   * its native API instead, where `options.num_ctx` is honoured. See
   * {@link OpenAICompatProvider.ollamaNative}.
   */
  numCtx?: number;
}

/** How long the one-time "is this Ollama?" probe may take before we assume not. */
const OLLAMA_PROBE_TIMEOUT_MS = 1500;

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
 *   chat_template_kwargs — the local-server (vLLM, llama.cpp, SGLang) switch that
 *                     turns a hybrid model's thinking off; hosted APIs reject it.
 *
 * `reasoning_effort` is negotiated too, but by VALUE as well as by presence —
 * see {@link EffortClamp}: a level the model lacks is clamped, not dropped.
 *
 * Nothing that changes what the model can DO is negotiable this way — `tools` is
 * never dropped, because a silently tool-less agent looks like a broken model
 * rather than an unsupported endpoint.
 */
type NegotiableField = "stream_options" | "max_tokens" | "num_ctx" | "chat_template_kwargs";

/**
 * How many undecodable `data:` lines a stream may contain before we stop
 * treating it as a working stream (see parseSse). Low enough that a genuinely
 * broken endpoint still fails fast, high enough to absorb the stray keep-alive
 * or truncated fragment that a healthy gateway occasionally emits.
 */
const MAX_BAD_SSE_LINES = 5;

/**
 * Does this 400/422 body blame one of the negotiable fields? Providers word
 * these differently ("Unsupported parameter", "unknown field", "extra fields not
 * permitted"), so the field NAME appearing in a rejection is the signal — a
 * server that accepted a field does not name it in an error.
 */
function rejectedField(errorText: string): NegotiableField | undefined {
  // "max_tokens + prompt exceed the context length" names max_tokens without
  // rejecting the field. Treating it as a rejection would silently rename the
  // field and re-send the same oversized request.
  if (looksLikeContextOverflow(errorText)) return undefined;
  const text = errorText.toLowerCase();
  if (text.includes("stream_options")) return "stream_options";
  if (text.includes("max_completion_tokens")) return "max_tokens";
  if (text.includes("num_ctx")) return "num_ctx";
  if (text.includes("chat_template_kwargs")) return "chat_template_kwargs";
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
  /** Which reasoning levels this endpoint accepts, learned the same way. */
  private readonly effort = new EffortClamp();
  /**
   * Resolved once per instance: the native Ollama transport when the endpoint
   * is Ollama AND a context window was asked for, else null. See ollamaNative.
   */
  private ollama: Promise<OllamaProvider | null> | undefined;

  constructor(private readonly opts: OpenAICompatOptions) {}

  private buildBody(req: StreamRequest): Record<string, unknown> {
    const maxTokensKey = this.rejected.has("max_tokens") ? "max_completion_tokens" : "max_tokens";
    const wireEffort = req.reasoningEffort !== undefined ? this.effort.resolve(req.reasoningEffort) : undefined;
    return {
      model: req.model,
      [maxTokensKey]: req.maxTokens,
      stream: true,
      ...(this.rejected.has("stream_options") ? {} : { stream_options: { include_usage: true } }),
      messages: toWireMessages(req.system, req.messages),
      ...(this.opts.numCtx && !this.rejected.has("num_ctx") ? { num_ctx: this.opts.numCtx } : {}),
      // The one field most servers read for reasoning depth (our "off" is its
      // "none"); a rejected level is clamped by EffortClamp on the next pass.
      ...(wireEffort !== undefined ? { reasoning_effort: wireEffort } : {}),
      // "off" also flips the chat-template switch that hybrid models (Qwen3,
      // DeepSeek) actually read on vLLM/llama.cpp/SGLang — servers where
      // `reasoning_effort: "none"` alone may leave thinking on. Hosted APIs
      // that reject the unknown field teach us to drop it, once.
      ...(req.reasoningEffort === "off" && !this.rejected.has("chat_template_kwargs")
        ? { chat_template_kwargs: { enable_thinking: false } }
        : {}),
      ...(req.tools.length > 0 ? { tools: req.tools.map(toWireTool) } : {}),
    };
  }

  /**
   * Is this endpoint Ollama? Probed once (`GET <origin>/api/version`, which only
   * Ollama answers with a `version`), and only when a context window was asked
   * for — the sole thing the /v1 layer cannot carry. A `/v1` base URL is the
   * only shape probed: Ollama serves its compat layer there, and anything else
   * is not Ollama's own address. Any failure means "not Ollama": the /v1 path
   * keeps working exactly as before, just without the window.
   */
  private ollamaNative(): Promise<OllamaProvider | null> {
    if (this.ollama) return this.ollama;
    this.ollama = (async () => {
      if (this.opts.numCtx === undefined) return null;
      const m = /^(.*?)\/v1\/?$/.exec(this.opts.baseUrl);
      if (!m) return null;
      const origin = m[1]!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${origin}/api/version`, {
          signal: controller.signal,
          headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { version?: unknown };
        if (typeof body.version !== "string") return null;
        return new OllamaProvider({
          baseUrl: origin,
          numCtx: this.opts.numCtx,
          ...(this.opts.apiKey ? { apiKey: this.opts.apiKey } : {}),
          ...(this.opts.maxRetries !== undefined ? { maxRetries: this.opts.maxRetries } : {}),
        });
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.ollama;
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const native = await this.ollamaNative();
    if (native) {
      yield* native.stream(req);
      return;
    }
    const response = await withRetry(
      async () => {
        // Loops only to re-send after learning that a field is unsupported (or a
        // reasoning level is out of range). Each field is learned at most once,
        // the effort ladder is finite and only ever narrows, so this terminates
        // — an unrecognized 400 throws on the first pass.
        for (;;) {
          const body = this.buildBody(req);
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
          if (res.ok) {
            // Told on the request that was ACCEPTED, not on each attempt: the
            // user should read "max became high", never "max became xhigh"
            // followed by a correction.
            if (req.reasoningEffort !== undefined) {
              const note = this.effort.describe(req.reasoningEffort, body.reasoning_effort as WireEffort | undefined);
              if (note) req.onNegotiated?.(note);
            }
            return res;
          }
          const text = await res.text().catch(() => "");
          if (res.status === 400 || res.status === 422) {
            const field = rejectedField(text);
            if (field !== undefined && !this.rejected.has(field)) {
              this.rejected.add(field);
              continue;
            }
            // The effort ladder: a value complaint clamps toward `high`; a
            // "no such field" drops it. Either way the next pass sends
            // something different, or reject() says nothing is left to try.
            const sentEffort = body.reasoning_effort as WireEffort | undefined;
            if (sentEffort !== undefined && mentionsReasoningEffort(text)) {
              if (this.effort.reject(sentEffort, looksLikeUnknownField(text))) continue;
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
        error?: { message?: string; code?: unknown; status?: unknown; type?: string } | string;
      };
      // Many gateways answer 200, open the stream, and then deliver the failure
      // — a context overflow, an upstream 5xx — as an `{"error":…}` chunk with
      // no `choices`. Ignoring it ended the stream as a clean, empty turn with
      // stopReason end_turn and zero usage: the silent death. Surface it as
      // the HTTP error it stands for so the caller's classification runs.
      if (chunk.error !== undefined) {
        const e = typeof chunk.error === "string" ? { message: chunk.error } : chunk.error;
        const status =
          typeof e.status === "number" ? e.status : typeof e.code === "number" && e.code >= 400 ? e.code : 400;
        throw new ProviderHttpError(status, `provider returned ${status}: ${JSON.stringify(chunk.error).slice(0, 500)}`);
      }
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

    // One bad line must not cost the whole turn. `JSON.parse` in handleChunk
    // used to throw straight out of parseSse — past withRetry, which only ever
    // wrapped the fetch, never the stream — and end the turn with
    // stopReason "error". That also LOST the assistant message: blocks are
    // local to the caller's stream loop and are not pushed to history until the
    // stream completes, so text already on the user's screen vanished from the
    // conversation. Gateways really do emit empty keep-alive `data:` lines and
    // the occasional non-JSON fragment; skip those and keep the stream alive.
    //
    // Not silently, though: a stream that is mostly garbage is a real failure
    // and must still surface, so a flood of undecodable lines throws.
    let skipped = 0;
    const feed = (data: string): void => {
      try {
        handleChunk(data);
      } catch (err) {
        // A decoded in-band error is the stream's real verdict, not a bad line.
        if (err instanceof ProviderHttpError) throw err;
        skipped++;
        if (skipped >= MAX_BAD_SSE_LINES) {
          throw new Error(`provider stream is not valid SSE JSON (${skipped} undecodable data: lines)`);
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
        if (data === "" || data === "[DONE]") continue; // keep-alive / terminator
        feed(data);
        yield* drain(events);
      }
    }

    // A server that closes without a trailing newline leaves its last line in
    // the buffer, and the decoder can still hold a partial multi-byte
    // character. Both were dropped — and on this wire format the final chunk is
    // the one carrying `usage`, so the cost was silently wrong token accounting.
    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing.startsWith("data:")) {
      const data = trailing.slice(5).trim();
      if (data !== "" && data !== "[DONE]") {
        feed(data);
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

function* drain(events: ProviderEvent[]): Iterable<ProviderEvent> {
  while (events.length > 0) yield events.shift()!;
}

/**
 * Truncation reasons that are not the spec's `length`. "OpenAI-compatible"
 * endpoints invent their own name for the output cap, and each one that lands in
 * the `default` branch below reads as a deliberate, complete answer: the turn
 * ends on a half-written response and Session's continuation layer never runs.
 */
const TRUNCATION_REASONS = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "output_limit",
  "truncated",
  "content_length",
]);

/**
 * The INPUT outgrew the window (as opposed to the output cap above). Session
 * compacts and retries on this rather than asking the model to "continue" —
 * a continuation only adds to a history that is already too large.
 */
const CONTEXT_OVERFLOW_REASONS = new Set([
  "model_context_window_exceeded",
  "context_window_exceeded",
  "context_length_exceeded",
]);

/** Reasons already known to mean a clean, deliberate stop. */
const CLEAN_REASONS = new Set(["stop", "end_turn", "eos", "complete", "completed"]);

const warnedFinishReasons = new Set<string>();

function mapFinish(reason: string | undefined): StopReason {
  if (reason === undefined) return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "content_filter") return "refusal";
  if (TRUNCATION_REASONS.has(reason)) return "max_tokens";
  if (CONTEXT_OVERFLOW_REASONS.has(reason)) return "context_overflow";
  if (CLEAN_REASONS.has(reason)) return "end_turn";

  // An unrecognised reason still maps to end_turn, deliberately: every rung of
  // Session's finishing ladder (Stop hook, error recovery, incomplete tasks,
  // runtime evidence, self-verify, wrap-up) is gated on end_turn, so
  // reinterpreting an unknown would silently disable all six. But guessing
  // silently is how the truncation cases above went unnoticed — say it once, so
  // the next unknown name shows up in a log instead of as a mystery short answer.
  if (!warnedFinishReasons.has(reason)) {
    warnedFinishReasons.add(reason);
    process.stderr.write(
      `warning provider reported unrecognized finish_reason "${reason}" — treated as end_turn\n`,
    );
  }
  return "end_turn";
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
