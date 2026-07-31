import type { Usage } from "@magentra/protocol";

export type ContentBlock =
  | { type: "text"; text: string }
  /**
   * An image in a user message — base64 payload plus its media type.
   *
   * Distinct from the image a {@link ToolResultPart} carries: a tool result is
   * addressed to a tool_call_id, which the OpenAI wire format serializes as a
   * `role: "tool"` message that cannot hold anything but text. A user-role image
   * is the shape every multimodal API does accept, and it is how the vision
   * side-call hands its picture to the model that can see one.
   */
  | { type: "image"; data: string; mediaType: string }
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
  /**
   * The invocation's input context, reported before any output arrives. Only the
   * three INPUT classes are authoritative here (`outputTokens` is a partial the
   * caller must ignore) — it exists so the context meter shows the ACTIVE call's
   * exact B(t) instead of an estimate for the whole time it runs. Optional:
   * endpoints that only report usage at the end simply never emit it, and the
   * caller falls back to its estimate until `message_end`.
   */
  | { type: "message_start"; usage: Usage }
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
  /** Observes connection retries (rate limit / server error / network) so the UI can say why it's waiting. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

export interface Provider {
  stream(req: StreamRequest): AsyncIterable<ProviderEvent>;
  countTokens?(req: Omit<StreamRequest, "signal" | "maxTokens">): Promise<number>;
  /** Model ids the endpoint actually serves (GET /models); feeds the UI's model picker. */
  listModels?(): Promise<string[]>;
}
