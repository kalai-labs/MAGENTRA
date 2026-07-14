import type { Usage } from "@magentra/protocol";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string | ToolResultPart[];
      isError?: boolean;
    };

export interface ToolResultPart {
  type: "text" | "image";
  text?: string;
  /** base64 data for images */
  data?: string;
  mediaType?: string;
}

export interface Msg {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "aborted"
  | "error";

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialJson: string }
  | { type: "tool_use_end"; id: string }
  | { type: "message_end"; stopReason: StopReason; usage: Usage };

export interface StreamRequest {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolSchema[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface Provider {
  stream(req: StreamRequest): AsyncIterable<ProviderEvent>;
  countTokens?(req: Omit<StreamRequest, "signal" | "maxTokens">): Promise<number>;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
