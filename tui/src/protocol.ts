/**
 * The slice of the MAGENTRA wire protocol (v1) this TUI speaks.
 *
 * Source of truth: MAGENTRA/engine/protocol/src/types.ts. These are local
 * declarations of the frames we consume and send — a wire contract, typed at
 * the consumer, exactly as the desktop app's renderer does on its side of the
 * stdio pipe. Fields we never read are omitted; unknown event types must be
 * tolerated, never crashed on.
 */

export const PROTOCOL_VERSION = 1;

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  /** Present-tense label ("wiring the resolver cache") — preferred for display while running. */
  activeForm?: string;
  status: TaskStatus;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  firstUserMessage?: string;
  model?: string;
  /** User-assigned name (rename_session); preferred over firstUserMessage. */
  label?: string;
}

export interface SlashCommandInfo {
  cmd: string;
  args: string;
  desc: string;
  addon?: boolean;
}

export type PermissionDecision = "allow_once" | "allow_session" | "allow_always" | "deny";

export interface RestoredToolCall {
  tool: string;
  input: unknown;
  result: string;
  isError: boolean;
}

export interface RestoredMessage {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  toolCalls?: RestoredToolCall[];
}

/** Core -> frontend. Only the fields this TUI reads. */
export type CoreEvent =
  | {
      type: "session_started";
      v: number;
      sessionId: string;
      cwd: string;
      model: string;
      overdrive: boolean;
      commands: SlashCommandInfo[];
    }
  | { type: "turn_started"; turnId: string }
  | { type: "tool_output_delta"; id: string; text: string }
  | { type: "retry_status"; attempt: number; delayMs: number; reason: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "tool_call_started";
      id: string;
      tool: string;
      input: unknown;
      description?: string;
      subagent?: boolean;
      agentId?: string;
      agentDesc?: string;
    }
  | {
      type: "tool_call_finished";
      id: string;
      tool: string;
      resultPreview: string;
      isError: boolean;
      subagent?: boolean;
      agentId?: string;
      agentDesc?: string;
    }
  | { type: "agent_spawned"; agentId: string; agentDesc: string; background?: boolean }
  | { type: "agent_finished"; agentId: string; isError?: boolean }
  | {
      type: "permission_request";
      id: string;
      tool: string;
      input: unknown;
      description?: string;
      subject?: string;
      grant?: string;
    }
  | { type: "question_request"; id: string; questions: Question[] }
  | { type: "task_list_updated"; tasks: TaskItem[] }
  | {
      /** Addon roster changed (install). `commands` is the refreshed registry —
       *  adopt it, or the palette misses every addon installed this session. */
      type: "addons_updated";
      addons: { name: string; description: string; builtin: boolean }[];
      commands?: SlashCommandInfo[];
    }
  | { type: "overdrive_changed"; enabled: boolean }
  | { type: "command_output"; text: string }
  | { type: "context_update"; contextTokens: number; outputTokens?: number; contextWarn?: boolean }
  | { type: "session_report"; text: string }
  | { type: "session_list"; sessions: SessionSummary[] }
  | {
      type: "turn_finished";
      turnId: string;
      stopReason: string;
      usage: Usage;
      contextTokens: number;
      contextWarn?: boolean;
    }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "session_restored"; sessionId: string; messages: RestoredMessage[] }
  | { type: "model_catalog"; models: string[] }
  | { type: "cwd_changed"; cwd: string; worktree: boolean }
  /**
   * Work that runs OUTSIDE a turn: a manual /compact, a backgrounded Bash job,
   * addon generation. turn_started never fires for these, so a frontend that
   * ignores them shows nothing at all while they run — /compact looked frozen.
   * `kind` is "start" | "exit"; the payload carries a description and, on exit,
   * an exit code / output file.
   */
  | {
      type: "background_notification";
      taskId: string;
      kind: string;
      payload?: {
        description?: string;
        code?: number | null;
        outputFile?: string;
        stopped?: boolean;
      };
    }
  /**
   * Event types this TUI does not consume. They parse fine and fall through
   * handleEvent's default arm — listed loosely here so the wire can grow
   * without breaking the compile.
   */
  | {
      type: "file_edited" | "addon_draft" | "addon_export";
    };

/** Frontend -> core. Only the frames this TUI sends. */
export type FrontendRequest =
  | { type: "user_message"; text: string }
  | { type: "steer_message"; text: string }
  | { type: "permission_response"; id: string; decision: PermissionDecision; message?: string }
  | { type: "question_response"; id: string; answers: Record<string, string[]> }
  | { type: "interrupt" }
  | { type: "set_overdrive"; enabled: boolean }
  | { type: "set_model"; model: string }
  | { type: "slash_command"; command: string; args?: string }
  | { type: "bang_command"; cmd: string }
  | { type: "list_sessions" }
  | { type: "resume_session"; id: string };
