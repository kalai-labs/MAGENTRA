import Anthropic from "@anthropic-ai/sdk";
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

  constructor(opts: AnthropicOptions = {}) {
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      maxRetries: opts.maxRetries ?? 4,
    });
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const stream = await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system || undefined,
        messages: req.messages.map(toAnthropicMessage),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
        })),
        stream: true,
      },
      { signal: req.signal },
    );

    // block index -> tool_use id, so stop events can be attributed
    const toolBlocks = new Map<number, string>();
    let stopReason: StopReason = "end_turn";
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          usage = {
            inputTokens: event.message.usage.input_tokens,
            outputTokens: event.message.usage.output_tokens,
            cacheReadTokens: event.message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: event.message.usage.cache_creation_input_tokens ?? 0,
          };
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
    case "model_context_window_exceeded":
      return "max_tokens";
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

function toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
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
                  : {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: (p.mediaType ?? "image/png") as
                          | "image/png"
                          | "image/jpeg"
                          | "image/gif"
                          | "image/webp",
                        data: p.data ?? "",
                      },
                    },
              ),
        ...(block.isError ? { is_error: true } : {}),
      };
  }
}
