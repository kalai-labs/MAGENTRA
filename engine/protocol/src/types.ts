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
      /** On-demand action skills discovered in .magentra/skills/ (disciplines arrive via modes_updated). */
      skills?: { name: string; description: string }[];
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
      /** Crew agent's color, stamped when the subagent is a crew specialist. */
      agentColor?: string;
      /** Crew agent's emoji, stamped when the subagent is a crew specialist. */
      agentEmoji?: string;
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
      /** Crew agent's color, stamped when the subagent is a crew specialist. */
      agentColor?: string;
      /** Crew agent's emoji, stamped when the subagent is a crew specialist. */
      agentEmoji?: string;
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
      /** Crew agent's color, stamped when the subagent is a crew specialist. */
      agentColor?: string;
      /** Crew agent's emoji, stamped when the subagent is a crew specialist. */
      agentEmoji?: string;
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
  /** OVERDRIVE (fully-autonomous turn-loop policy) was toggled; frontends sync their indicator to this. */
  | { type: "overdrive_changed"; enabled: boolean }
  | { type: "command_output"; text: string }
  | { type: "session_list"; sessions: SessionSummary[] }
  | {
      type: "turn_finished";
      turnId: string;
      stopReason: string;
      /**
       * Tokens BILLED for this turn: the sum over every model call it made.
       * A cumulative cost figure — NOT the context size (a 10-round turn
       * re-sends a similar prompt 10 times; the window did not grow 10x).
       */
      usage: Usage;
      /**
       * Tokens currently IN the context window: the whole prompt of the last
       * request (input + cacheRead + cacheWrite) plus the reply appended to the
       * history. Point-in-time, not cumulative — this is the number a context
       * meter must show. Reading `usage.inputTokens` instead reports a near-empty
       * context whenever prompt caching is on, since most of the prompt then
       * arrives as cacheRead.
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
  /** The generate_skill result: a validated draft to preview/edit, or the failure after retries. */
  | { type: "skill_draft"; ok: boolean; text?: string; suggestedFilename?: string; error?: string }
  /** The export_skill result: the skill's .md text + suggested filename, for the app to save. */
  | { type: "skill_export"; ok: boolean; id: string; filename?: string; text?: string; error?: string }
  /** On-demand action skills changed (e.g. after install_skill); disciplines re-arrive via modes_updated. */
  | { type: "skills_updated"; skills: { name: string; description: string }[] }
  | {
      type: "modes_updated";
      modes: {
        id: string;
        name: string;
        description: string;
        /** Why a user would enable this skill — powers the "?" explainers. */
        why?: string;
        active: boolean;
        builtin: boolean;
        /** Badged "Recommended" in frontends; advisory only, never forced on. */
        recommended?: boolean;
        conflicts?: string[];
      }[];
    }
  | {
      type: "team_updated";
      agents: {
        id: string;
        name: string;
        role: string;
        model?: string;
        /** Dedicated-endpoint members: the API kind ("anthropic" | "openai-compatible") and base URL they run on. */
        provider?: string;
        baseUrl?: string;
        emoji?: string;
        color?: string;
        docCount: number;
        /** Workspace-relative paths of the member's backpack documents. */
        docs: string[];
        /** Backpack readiness: a distilled brief exists, or every doc reached at least the "noted" phase. */
        ready: boolean;
        /** Ledger spend summary ("12.3k in / 4.1k out over 7 runs"); absent when the member has never run. */
        spend?: string;
        /** Durable lessons earned through verified work. */
        lessonsPromoted: number;
        /** Lessons still on probation. */
        lessonsCandidate: number;
        /** Verified completed tasks from the hash-chained service record. */
        tasksCompleted: number;
      }[];
    }
  | {
      type: "backpack_progress";
      agentId: string;
      /** One of "raw" | "noted" | "embedded" | "brief". */
      phase: string;
      done: number;
      total: number;
    }
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
    }
  | {
      type: "missions_updated";
      missions: {
        id: string;
        name: string;
        description?: string;
        keywords: string[];
        /** 5-field cron expression from the mission file, when present. */
        schedule?: string;
        /** A durable cron job is currently armed for this mission. */
        scheduled: boolean;
        /** The mission is marked continuous-capable in its file. */
        continuous: boolean;
        /** The continuous loop is currently active. */
        running: boolean;
        /** Workspace-relative report path (explicit deliverable or the default). */
        deliverable: string;
        /** Last time the deliverable was written, when it exists. */
        lastRunAt?: string;
      }[];
      warnings: string[];
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

/** Frontend -> core. */
export type FrontendRequest =
  | { type: "user_message"; text: string }
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
  /** Toggles OVERDRIVE: the fully-autonomous turn-loop policy (caps lifted, self-verify end check). */
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
   * Mid-run steering: user text that joins the RUNNING turn at its next
   * message boundary instead of waiting for the turn to end. Sent by
   * frontends while a turn is busy; falls back to a normal user turn when
   * the session turns out to be idle (the busy check races the turn end).
   */
  | { type: "steer_message"; text: string }
  | { type: "slash_command"; command: string; args?: string }
  | { type: "bang_command"; cmd: string }
  | { type: "resume_session"; id: string }
  | { type: "delete_session"; id: string }
  | { type: "stop_background"; taskId: string }
  | { type: "rename_session"; id: string; label: string }
  | { type: "archive_session"; id: string }
  | { type: "list_sessions" }
  | { type: "set_modes"; active: string[] }
  | { type: "reload_team" }
  /**
   * Ask the engine to author a skill .md from a plain-language description
   * (LLM-generated, parser-validated). `model` overrides which model authors it
   * (defaults to the session model); `context` is optional extra detail (when it
   * should apply, examples); `enforce` asks a discipline to hard-gate edits
   * ("block") rather than only remind ("remind", the default).
   */
  | {
      type: "generate_skill";
      description: string;
      kind: "discipline" | "action";
      model?: string;
      context?: string;
      enforce?: "remind" | "block";
      /**
       * Author with a different provider entirely (a saved connection profile),
       * not just a different model on the current one. The app resolves the
       * profile and injects its connection here — the engine builds a one-off
       * provider for the authoring call. `model` is ignored when this is set.
       */
      connection?: { provider: "anthropic" | "openai-compat"; baseUrl?: string; apiKey: string; model: string };
    }
  /** Export a skill's .md text (built-in or workspace file) for the app to save. */
  | { type: "export_skill"; id: string }
  /** Write a (re-validated) skill file into .magentra/skills/ and reload both skill kinds. */
  | { type: "install_skill"; filename: string; text: string };

export type Frame =
  | ({ kind: "event" } & CoreEvent)
  | ({ kind: "request" } & FrontendRequest);
