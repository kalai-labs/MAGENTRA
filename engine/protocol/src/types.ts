export const PROTOCOL_VERSION = 1;

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Billed tokens of one model response. The four classes are DISJOINT and
 * additive: the whole prompt is `inputTokens + cacheReadTokens +
 * cacheWriteTokens`, and the whole request is that plus `outputTokens`. Each
 * class bills at its own rate (a cache read is ~10x cheaper than a fresh input
 * token; a cache write costs more), so they must never be collapsed or
 * double-counted.
 *
 * Providers must normalize to this contract. Anthropic already reports it this
 * way. OpenAI-compatible APIs do NOT: their `prompt_tokens` is the WHOLE prompt
 * and `cached_tokens` is a SUBSET of it — the adapter subtracts, so that
 * `inputTokens` here always means "fresh, uncached prompt tokens".
 */
export interface Usage {
  /** Fresh prompt tokens — NOT including anything served from cache. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from cache (billed at the cheap cache-read rate). */
  cacheReadTokens: number;
  /** Prompt tokens written into the cache (billed above the input rate). */
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
  /** Model used by the most recently completed turn, when recorded. */
  model?: string;
  /** User-assigned name (rename_session); shown instead of firstUserMessage. */
  label?: string;
}

/**
 * `allow_session` grants the whole tool until the process exits.
 * `allow_always` grants ONLY the exact subject (that literal command string),
 * persisted to the workspace's settings so it survives restarts — the narrow,
 * durable grant offered on destructive prompts.
 */
export type PermissionDecision = "allow_once" | "allow_session" | "allow_always" | "deny";

/** One slash command the engine understands — feeds the frontend palette. */
export interface SlashCommandInfo {
  cmd: string;
  args: string;
  desc: string;
}

/** Core -> frontend. */
export type CoreEvent =
  | {
      type: "session_started";
      v: number;
      sessionId: string;
      cwd: string;
      model: string;
      /** Whether OVERDRIVE (the fully-autonomous stance) is active for this session. */
      overdrive: boolean;
      /** The engine's slash-command registry, so the palette can never drift. */
      commands: SlashCommandInfo[];
      /**
       * The engine's rate card + context windows per known model ($/1M tokens),
       * user pricing overrides applied — the frontend's single source for
       * model hints; it must keep no pricing copy of its own.
       */
      rateCard: Record<
        string,
        { input: number; output: number; cacheRead?: number; cacheWrite?: number; contextWindow: number }
      >;
      /** Installed addons — built-ins plus anything under .magentra/addons/. Always invocable; there is no enabled state. */
      addons?: { name: string; description: string; builtin: boolean }[];
    }
  | { type: "turn_started"; turnId: string }
  | {
      /** Incremental output from a running tool call (throttled) — lets the UI tail e.g. a build log live. */
      type: "tool_output_delta";
      id: string;
      text: string;
    }
  | {
      /** A provider call hit a retryable failure and is backing off — the UI shows why the spinner is waiting. */
      type: "retry_status";
      attempt: number;
      delayMs: number;
      reason: string;
    }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "tool_call_started";
      id: string;
      tool: string;
      input: unknown;
      description?: string;
      /** True when this call belongs to a subagent's nested session, not the top-level turn. */
      subagent?: boolean;
      /** Stable id of the subagent this call belongs to (e.g. "ag_1"). Only set on subagent events. */
      agentId?: string;
      /** The spawning `description` for the subagent this call belongs to. Only set on subagent events. */
      agentDesc?: string;
    }
  | {
      type: "tool_call_finished";
      id: string;
      tool: string;
      resultPreview: string;
      isError: boolean;
      /** True when this call belongs to a subagent's nested session, not the top-level turn. */
      subagent?: boolean;
      /** Stable id of the subagent this call belongs to (e.g. "ag_1"). Only set on subagent events. */
      agentId?: string;
      /** The spawning `description` for the subagent this call belongs to. Only set on subagent events. */
      agentDesc?: string;
    }
  | {
      /** A subagent was just dispatched — emitted before its first model turn so
       *  the frontend can show the agent immediately instead of waiting for its
       *  first tool call. */
      type: "agent_spawned";
      agentId: string;
      agentDesc: string;
      /** True when the agent runs detached as a background task. */
      background?: boolean;
    }
  | { type: "agent_finished"; agentId: string; isError?: boolean }
  | {
      type: "permission_request";
      id: string;
      tool: string;
      input: unknown;
      description?: string;
      /**
       * The exact subject an `allow_always` decision would grant. Absent when
       * the tool defines no permission subject — offer only allow_once/deny
       * then, since there is nothing durable to scope a grant to.
       */
      subject?: string;
      /**
       * What `allow_always` would remember when broader than the exact
       * subject: the command's shape (e.g. "mkdir", "git push"). Frontends
       * surface it so the grant's scope is never a surprise.
       */
      grant?: string;
    }
  | { type: "question_request"; id: string; questions: Question[] }
  | { type: "task_list_updated"; tasks: TaskItem[] }
  | { type: "file_edited"; path: string; diff: string }
  | { type: "background_notification"; taskId: string; kind: string; payload: unknown }
  /** OVERDRIVE (fully-autonomous turn-loop policy) was toggled; frontends sync
   *  their indicator to this. */
  | { type: "overdrive_changed"; enabled: boolean }
  | { type: "command_output"; text: string }
  /**
   * The live token meters, pushed whenever either figure moves: mid-stream as
   * the agent deliberates, and outside a turn when a manual `/compact` shrinks
   * the window with no turn_finished to carry the new figure. Frontends update
   * their meters from this exactly as they do from turn_finished.
   */
  | {
      type: "context_update";
      /**
       * B(t) — tokens currently IN the window: the whole INPUT of the latest
       * request. Exact once a provider reports it, estimated before that.
       */
      contextTokens: number;
      /**
       * D(t) — output tokens generated so far by the CURRENT turn, summed over
       * every model call it has made (including subagents). Starts each turn at
       * 0 and only grows; the tail of the in-flight reply is estimated until the
       * call's usage lands. Absent means "unchanged", not zero.
       */
      outputTokens?: number;
      contextWarn?: boolean;
    }
  /** The /session report — the whole formatted summary, shown by frontends in a
   * dedicated modal (line-by-line) rather than a single inline console note. */
  | { type: "session_report"; text: string }
  | { type: "session_list"; sessions: SessionSummary[] }
  | {
      type: "turn_finished";
      turnId: string;
      stopReason: string;
      /**
       * T_turn — tokens BILLED for this turn: the sum over every model call it
       * made, including the auxiliary prompts (clarification, summarization)
       * and every subagent it spawned. A cumulative
       * cost figure — NOT the context size (a 10-round turn re-sends a similar
       * prompt 10 times; the window did not grow 10x).
       *
       * `usage.outputTokens` is also D_final: the authoritative deliberation
       * total that replaces the live estimates streamed via context_update.
       */
      usage: Usage;
      /**
       * B(t) — tokens currently IN the context window: the whole INPUT of the
       * last request (fresh + cacheWrite + cacheRead). Point-in-time, not
       * cumulative — this is the number a context meter must show. Reading
       * `usage.inputTokens` instead reports a near-empty context whenever prompt
       * caching is on, since most of the prompt then arrives as cacheRead; and
       * generated output is NOT part of it, because the next prompt is not
       * "this prompt plus this reply".
       */
      contextTokens: number;
      /**
       * OVERDRIVE only: the pre-turn `git stash create` ref capturing the
       * working tree before this uncapped turn ran — the recovery handle for
       * anything an in-workspace deletion removed. Absent when the tree was
       * clean, the workspace is not a repo, or OVERDRIVE is off.
       */
      overdriveSnapshot?: string;
      /**
       * True once the context has grown past the "run /compact" warn threshold
       * (~200k, capped under the model window). The frontend tints its context
       * counter on this; absent while the context is comfortably small.
       */
      contextWarn?: boolean;
    }
  | { type: "error"; message: string; fatal: boolean }
  /** The generate_addon result: a validated draft to preview/edit, or the failure after retries. */
  | { type: "addon_draft"; ok: boolean; text?: string; suggestedFilename?: string; error?: string }
  /** The export_addon result: the addon's .md text + suggested filename, for the app to save. */
  | { type: "addon_export"; ok: boolean; name: string; filename?: string; text?: string; error?: string }
  /** The installed-addon roster changed (e.g. after install_addon). */
  | { type: "addons_updated"; addons: { name: string; description: string; builtin: boolean }[] }
  /**
   * The full prior conversation, render-ready, sent once on /resume so the
   * frontend can repaint the chat. Flat by design: the frontend cannot read the
   * transcript file (sandboxed) and the wire has no user-message event, so the
   * engine reconstructs a paint list here (tool calls already paired with their
   * results, harness scaffolding stripped).
   */
  | { type: "session_restored"; sessionId: string; messages: RestoredMessage[] }
  | {
      /** The model ids the configured endpoint actually serves — the UI rebuilds its picker from this. */
      type: "model_catalog";
      models: string[];
    }
  | {
      /** The session's working directory moved (EnterWorktree/ExitWorktree). */
      type: "cwd_changed";
      cwd: string;
      /** True while operating somewhere other than the workspace root. */
      worktree: boolean;
    };
export interface RestoredToolCall {
  tool: string;
  input: unknown;
  result: string;
  isError: boolean;
}

export interface RestoredMessage {
  role: "user" | "assistant";
  /** Concatenated text blocks (Markdown for an assistant message). */
  text: string;
  /** Assistant reasoning, when the model emitted extended thinking. */
  thinking?: string;
  toolCalls?: RestoredToolCall[];
}

/**
 * One fully-resolved connection, as the frontend knows it: which API shape, at
 * which endpoint, with which key and model. The app resolves this from a saved
 * profile or the connection card (the renderer never holds a key — main does)
 * and hands it over whole, so the engine never has to guess a half-specified
 * endpoint.
 *
 * `provider` uses the app's vocabulary ("openai-compat"); the engine's settings
 * schema spells the same thing "openai-compatible". The mapping lives at the
 * boundary that consumes this, deliberately in one place.
 */
export interface ConnectionSpec {
  provider: "anthropic" | "openai-compat";
  /** Absent means the engine's default OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Empty string for a keyless local server (Ollama, LM Studio). */
  apiKey: string;
  model: string;
  /** Context window to run the model with; also `num_ctx` for a local server. */
  contextWindow?: number;
  /** Skip TLS verification for this endpoint (self-signed home-lab gateway). */
  insecureTls?: boolean;
  /**
   * The endpoint that looks at images, and whether it is switched on. The main
   * model is never sent a picture: a vision model describes it and the
   * DESCRIPTION enters the conversation.
   *
   * ABSENT MEANS CLEARED — the same rule `baseUrl` follows. A connection saved
   * with no vision model chosen must leave none behind, or the workspace keeps
   * describing images through an endpoint the user just removed.
   */
  vision?: VisionConnectionSpec;
}

/** The vision endpoint of a {@link ConnectionSpec}. `enabled` is the user-facing
 *  toggle; it cannot be true without the rest of this object existing. */
export interface VisionConnectionSpec {
  enabled: boolean;
  provider: "anthropic" | "openai-compat";
  baseUrl?: string;
  /** Empty string for a keyless local server. */
  apiKey: string;
  model: string;
  contextWindow?: number;
  insecureTls?: boolean;
}

/** An image attached to a user message. Base64, because it comes from the
 *  frontend over a line-delimited JSON protocol. */
export interface ImageAttachment {
  /** File name as the user knows it — used to label the description. */
  name: string;
  /** "image/png", "image/jpeg", "image/gif", "image/webp". */
  mediaType: string;
  data: string;
}

/** Frontend -> core. */
export type FrontendRequest =
  /**
   * A user turn. `images` are attachments the user added to it: each is sent to
   * the configured vision endpoint and enters the conversation as a
   * description, never as an image (see settings.visionConnection). Attaching
   * one while vision is off is refused with an error frame, and the text of the
   * message still runs.
   */
  | { type: "user_message"; text: string; images?: ImageAttachment[] }
  | {
      type: "permission_response";
      id: string;
      decision: PermissionDecision;
      message?: string;
    }
  | {
      type: "question_response";
      id: string;
      /** Keyed positionally ("q:<idx>"; question text accepted as a legacy fallback); values are the selected option labels (or free text). */
      answers: Record<string, string[]>;
    }
  | { type: "interrupt" }
  /** Toggles the always-ask deletion guard (true = guard active, the default). */
  | { type: "set_deletion_guard"; enabled: boolean }
  /** Toggles OVERDRIVE: the fully-autonomous turn-loop policy (caps lifted,
   *  self-verify end check). */
  | { type: "set_overdrive"; enabled: boolean }
  /** Auto-compact the conversation at this many context tokens (0 = off). The
   *  ONLY way to set it — no settings key or /settings path — so it stays
   *  consistent with the UI control that owns it. */
  | { type: "set_compact_limit"; limit: number }
  /**
   * Change the session's model live (takes effect on the next turn) WITHOUT
   * restarting the engine — so the conversation and session id are preserved.
   * The frontend sends this on a model-picker change instead of respawning.
   */
  | { type: "set_model"; model: string }
  /**
   * Change the session's whole CONNECTION live — provider, endpoint, key, model
   * — without restarting the engine, so the conversation and session id survive
   * a move from (say) a local Ollama to a hosted API mid-task. The frontend
   * sends this after it has persisted the connection; the engine rebuilds its
   * provider from the payload and applies it to the next provider call.
   *
   * The key travels in `connection` (not a top-level field) so the app's
   * stdin-log redaction covers this frame with no extra rule.
   */
  | { type: "set_connection"; connection: ConnectionSpec }
  /**
   * Switch image reading on or off, live, without touching the connection.
   *
   * Its own frame rather than a `set_connection` carrying a flag: that frame
   * rewrites the endpoint, the key and the environment and rebuilds the
   * provider, which is a great deal of machinery — and a credential rewrite —
   * to move one boolean. Refused when no vision endpoint is configured, since
   * the flag alone can look at nothing.
   */
  | { type: "set_vision"; enabled: boolean }
  /**
   * Mid-run steering: user text that joins the RUNNING turn at its next
   * message boundary instead of waiting for the turn to end. Sent by
   * frontends while a turn is busy; falls back to a normal user turn when
   * the session turns out to be idle (the busy check races the turn end).
   */
  | { type: "steer_message"; text: string; images?: ImageAttachment[] }
  | { type: "slash_command"; command: string; args?: string }
  | { type: "bang_command"; cmd: string }
  | { type: "resume_session"; id: string }
  | { type: "delete_session"; id: string }
  | { type: "stop_background"; taskId: string }
  | { type: "rename_session"; id: string; label: string }
  | { type: "archive_session"; id: string }
  | { type: "list_sessions" }
  /**
   * Ask the engine to author an addon .md from a plain-language description
   * (LLM-generated, parser-validated). `model` overrides which model authors it
   * (defaults to the session model); `context` is optional extra detail (when it
   * should apply, examples).
   */
  | {
      type: "generate_addon";
      description: string;
      model?: string;
      context?: string;
      /**
       * Author with a different provider entirely (a saved connection profile),
       * not just a different model on the current one. The app resolves the
       * profile and injects its connection here — the engine builds a one-off
       * provider for the authoring call. `model` is ignored when this is set.
       */
      connection?: ConnectionSpec;
    }
  /** Export an addon's .md text (built-in or workspace file) for the app to save. */
  | { type: "export_addon"; name: string }
  /** Write a (re-validated) addon file into .magentra/addons/ and reload the roster. */
  | { type: "install_addon"; filename: string; text: string };

export type Frame =
  | ({ kind: "event" } & CoreEvent)
  | ({ kind: "request" } & FrontendRequest);
