import Anthropic from "@anthropic-ai/sdk";
import { emptyUsage } from "@magentra/protocol";
import { withRetry } from "./retry.js";
import type {
  ContentBlock,
  Msg,
  Provider,
  ProviderEvent,
  StopReason,
  StreamRequest,
} from "./types.js";

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  maxRetries?: number;
}

export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;
  private readonly maxRetries: number;

  constructor(opts: AnthropicOptions = {}) {
    this.maxRetries = opts.maxRetries ?? 4;
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      // Retries run through our withRetry below so they are visible to the
      // UI (onRetry); the SDK's own invisible loop would hide them.
      maxRetries: 0,
    });
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    // Prompt caching: one breakpoint after the system prompt (covers tools +
    // system) and one on the last message, so the whole conversation prefix
    // is a cache read on the next request. Cache usage flows into the
    // existing 4-class accounting via cache_read/creation tokens below.
    const messages = req.messages.map(toAnthropicMessage);
    const lastMsg = messages[messages.length - 1];
    const lastBlock = Array.isArray(lastMsg?.content)
      ? lastMsg.content[lastMsg.content.length - 1]
      : undefined;
    if (lastBlock && typeof lastBlock === "object") {
      (lastBlock as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
    }
    const stream = await withRetry(
      () =>
        this.client.messages.create(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system
              ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
              : undefined,
            messages,
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
            })),
            stream: true,
          },
          { signal: req.signal },
        ),
      req.signal,
      { maxRetries: this.maxRetries, ...(req.onRetry ? { onRetry: req.onRetry } : {}) },
    );

    // block index -> tool_use id, so stop events can be attributed
    const toolBlocks = new Map<number, string>();
    let stopReason: StopReason = "end_turn";
    let usage = emptyUsage();

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          usage = {
            inputTokens: event.message.usage.input_tokens,
            outputTokens: event.message.usage.output_tokens,
            cacheReadTokens: event.message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: event.message.usage.cache_creation_input_tokens ?? 0,
          };
          // The whole input context is known here, before a single output token
          // exists — surface it so the caller's context meter is exact for the
          // entire call rather than only after it ends.
          yield { type: "message_start", usage };
          break;
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            toolBlocks.set(event.index, event.content_block.id);
            yield {
              type: "tool_use_start",
              id: event.content_block.id,
              name: event.content_block.name,
            };
          }
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "thinking_delta") {
            yield { type: "thinking_delta", text: event.delta.thinking };
          } else if (event.delta.type === "input_json_delta") {
            const id = toolBlocks.get(event.index);
            if (id) yield { type: "tool_use_delta", id, partialJson: event.delta.partial_json };
          }
          break;
        case "content_block_stop": {
          const id = toolBlocks.get(event.index);
          if (id) yield { type: "tool_use_end", id };
          break;
        }
        case "message_delta":
          stopReason = mapStop(event.delta.stop_reason);
          usage.outputTokens = event.usage.output_tokens;
          break;
        case "message_stop":
          break;
      }
    }
    yield { type: "message_end", stopReason, usage };
  }

  /** The Anthropic model catalog, for the UI's model picker. */
  async listModels(): Promise<string[]> {
    const page = await this.client.models.list();
    return page.data.map((m) => m.id);
  }

  async countTokens(req: Omit<StreamRequest, "signal" | "maxTokens">): Promise<number> {
    const res = await this.client.messages.countTokens({
      model: req.model,
      system: req.system || undefined,
      messages: req.messages.map(toAnthropicMessage),
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
            })),
          }
        : {}),
    });
    return res.input_tokens;
  }
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "model_context_window_exceeded":
      return "context_overflow";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

function toAnthropicMessage(msg: Msg): Anthropic.MessageParam {
  return {
    role: msg.role,
    content: msg.content.map(toAnthropicBlock),
  };
}

/** The base64 image block, in the one shape the SDK's types accept. Shared by a
 *  user-role image and an image returned inside a tool result. */
function toAnthropicImage(data: string | undefined, mediaType: string | undefined): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: (mediaType ?? "image/png") as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
      data: data ?? "",
    },
  };
}

function toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return toAnthropicImage(block.data, block.mediaType);
    case "thinking":
      return { type: "text", text: block.thinking };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content:
          typeof block.content === "string"
            ? block.content
            : block.content.map((p) =>
                p.type === "text"
                  ? { type: "text" as const, text: p.text ?? "" }
                  : toAnthropicImage(p.data, p.mediaType),
              ),
        ...(block.isError ? { is_error: true } : {}),
      };
  }
}
