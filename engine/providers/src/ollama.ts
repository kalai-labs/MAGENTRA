import { emptyUsage, type ReasoningEffort, type Usage } from "@magentra/protocol";
import type { ContentBlock, Msg, Provider, ProviderEvent, StopReason, StreamRequest, ToolSchema } from "./types.js";
import { ProviderHttpError, parseRetryAfter, withRetry } from "./retry.js";
import { ThinkTagSplitter } from "./think.js";

export interface OllamaOptions {
  /** The server ORIGIN (e.g. http://localhost:11434) — no `/v1`. */
  baseUrl: string;
  /** Sent as `options.num_ctx`: the context window to load the model with. */
  numCtx?: number;
  /** Bearer token for a proxied Ollama; empty/absent for a plain local one. */
  apiKey?: string;
  maxRetries?: number;
}

/**
 * Ollama's NATIVE chat API (`POST /api/chat`, NDJSON stream).
 *
 * Exists for one reason: Ollama's OpenAI-compatible `/v1` layer has no
 * `options` field, so a `num_ctx` sent there is silently dropped and the model
 * loads with the server's default window (4k on a small GPU) — exactly the
 * mismatch that lets a session die at the model's wall while auto-compaction
 * plans around the window the user typed. The native API honours
 * `options.num_ctx` (and clamps it to the model's own maximum, so "over the
 * limit takes the limit" needs no table here) and takes reasoning depth as
 * `think`.
 *
 * Selected by OpenAICompatProvider, lazily, once it has proved the endpoint is
 * Ollama (see its `ollamaNative`) — nothing in the settings names Ollama, and
 * nothing should have to: the user typed a base URL, and the engine learns the
 * rest from the server.
 */
export class OllamaProvider implements Provider {
  /**
   * What this server has refused about `think`, learned from its 400s:
   *   "levels" — a level string ("low") was refused; only booleans work for
   *              this model (levels are a gpt-oss feature in Ollama)
   *   "all"    — the model cannot think at all; the field is dropped
   */
  private thinkRejected: "levels" | "all" | undefined;

  constructor(private readonly opts: OllamaOptions) {}

  private thinkFor(level: ReasoningEffort): boolean | string | undefined {
    if (this.thinkRejected === "all") return undefined;
    if (level === "off") return false;
    if (this.thinkRejected === "levels") return true;
    // Ollama's own /v1 mapping, mirrored: minimal → low, xhigh → max.
    if (level === "minimal") return "low";
    if (level === "xhigh") return "max";
    return level;
  }

  /** The one-line note when what is sent differs from what the user chose. */
  private describeThink(level: ReasoningEffort): string | undefined {
    if (this.thinkRejected === "all") {
      return `reasoning effort "${level}" — this model cannot switch thinking on or off in Ollama; it runs at its default`;
    }
    if (this.thinkRejected === "levels" && level !== "off") {
      return `reasoning effort "${level}" — this model has no thinking levels in Ollama; thinking is switched on without a level`;
    }
    return undefined;
  }

  private buildBody(req: StreamRequest): Record<string, unknown> {
    const think = req.reasoningEffort !== undefined ? this.thinkFor(req.reasoningEffort) : undefined;
    return {
      model: req.model,
      messages: toOllamaMessages(req.system, req.messages),
      stream: true,
      options: {
        ...(this.opts.numCtx !== undefined ? { num_ctx: this.opts.numCtx } : {}),
        num_predict: req.maxTokens,
      },
      ...(req.tools.length > 0 ? { tools: req.tools.map(toOllamaTool) } : {}),
      ...(think !== undefined ? { think } : {}),
    };
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const response = await withRetry(
      async () => {
        for (;;) {
          const body = this.buildBody(req);
          const res = await fetch(`${this.opts.baseUrl}/api/chat`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: req.signal,
          });
          if (res.ok) {
            // Say what was actually sent, once the server accepted it — a
            // silently ignored choice is the failure this setting exists to avoid.
            if (req.reasoningEffort !== undefined) {
              const note = this.describeThink(req.reasoningEffort);
              if (note) req.onNegotiated?.(note);
            }
            return res;
          }
          const text = await res.text().catch(() => "");
          // `"<model>" does not support thinking` — or a level this model has
          // no notion of. Step down: level → boolean → nothing, each learned once.
          if (res.status === 400 && body.think !== undefined && /think/i.test(text)) {
            if (typeof body.think === "string" && this.thinkRejected === undefined) {
              this.thinkRejected = "levels";
              continue;
            }
            if (this.thinkRejected !== "all") {
              this.thinkRejected = "all";
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
    yield* this.parseNdjson(response, req.signal);
  }

  private async *parseNdjson(response: Response, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    if (!response.body) throw new Error("provider response had no body");
    const think = new ThinkTagSplitter();
    let usage: Usage = emptyUsage();
    let doneReason: string | undefined;
    let sawToolCall = false;
    let toolSeq = 0;
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (raw: string): ProviderEvent[] => {
      const chunk = JSON.parse(raw) as {
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
        };
        done?: boolean;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
        error?: string | { message?: string };
      };
      // Ollama delivers a mid-stream failure as an `{"error": …}` line with a
      // 200 already sent; surface it as the HTTP error it stands for.
      if (chunk.error !== undefined) {
        const message = typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? JSON.stringify(chunk.error));
        throw new ProviderHttpError(400, `provider returned 400: ${message.slice(0, 500)}`);
      }
      const events: ProviderEvent[] = [];
      const msg = chunk.message;
      if (msg?.thinking) events.push({ type: "thinking_delta", text: msg.thinking });
      if (msg?.content) {
        // A model whose template inlines <think>…</think> (thinking off, or an
        // older template) still gets its scratchpad routed to the thinking channel.
        const split = think.push(msg.content);
        if (split.thinking) events.push({ type: "thinking_delta", text: split.thinking });
        if (split.text) events.push({ type: "text_delta", text: split.text });
      }
      // Ollama emits each tool call WHOLE (arguments already an object), so the
      // three-event shape collapses into one line.
      for (const call of msg?.tool_calls ?? []) {
        const name = call.function?.name;
        if (!name) continue;
        sawToolCall = true;
        const id = call.id ?? `call_${toolSeq++}_${Date.now()}`;
        events.push({ type: "tool_use_start", id, name });
        events.push({ type: "tool_use_delta", id, partialJson: JSON.stringify(call.function?.arguments ?? {}) });
        events.push({ type: "tool_use_end", id });
      }
      if (chunk.done) {
        doneReason = chunk.done_reason;
        usage = {
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      }
      return events;
    };

    for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      buffer += decoder.decode(raw, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield* handleLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield* handleLine(buffer.trim());

    const tail = think.flush();
    if (tail.thinking) yield { type: "thinking_delta", text: tail.thinking };
    if (tail.text) yield { type: "text_delta", text: tail.text };

    yield { type: "message_end", stopReason: mapDone(doneReason, sawToolCall), usage };
  }
}

function mapDone(reason: string | undefined, sawToolCall: boolean): StopReason {
  if (sawToolCall) return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function toOllamaTool(tool: ToolSchema) {
  return {
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: { id: string; function: { name: string; arguments: unknown } }[];
  tool_name?: string;
  tool_call_id?: string;
}

/**
 * Same message shape as the OpenAI-compatible transport, in Ollama's spelling:
 * images are bare base64 strings on the user message, tool arguments are an
 * OBJECT rather than a JSON string, and a tool result names the tool it answers
 * (`tool_name`, looked up from the assistant call it follows) as well as the id.
 * Assistant thinking is NOT replayed, matching the other transport — the
 * templates re-derive it, and a fixed history keeps the prompt cache warm.
 */
function toOllamaMessages(system: string, messages: Msg[]): OllamaMessage[] {
  const wire: OllamaMessage[] = [];
  if (system) wire.push({ role: "system", content: system });
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const toolCalls = msg.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => {
          toolNames.set(b.id, b.name);
          return { id: b.id, function: { name: b.name, arguments: b.input ?? {} } };
        });
      wire.push({
        role: "assistant",
        content: joinText(msg.content),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      const name = toolNames.get(block.toolUseId);
      wire.push({
        role: "tool",
        content: flattenToolResult(block),
        tool_call_id: block.toolUseId,
        ...(name ? { tool_name: name } : {}),
      });
    }
    const text = joinText(msg.content);
    const images = msg.content
      .filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image")
      .map((b) => b.data);
    if (text || images.length > 0) {
      wire.push({ role: "user", content: text, ...(images.length > 0 ? { images } : {}) });
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
  return block.content.map((p) => (p.type === "text" ? (p.text ?? "") : "[image omitted]")).join("\n");
}
