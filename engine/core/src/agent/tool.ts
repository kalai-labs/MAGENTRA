import type { z } from "zod";
import {
  definePrompt,
  isPromptDisabled,
  promptText,
  renderPrompt,
  type CoreEvent,
  type TaskItem,
} from "@magentra/protocol";
import type { ToolResultPart } from "@magentra/providers";
import type { Settings } from "../config/settings.js";

export type PermissionClass = "read" | "mutate" | "execute" | "network" | "interact";

export interface ToolResult {
  content: string | ToolResultPart[];
  isError?: boolean;
}

export interface SpawnAgentOptions {
  agentType: string;
  prompt: string;
  description: string;
  runInBackground?: boolean;
}

/** Services a tool can reach through its context. */
export interface SessionServices {
  emit(event: CoreEvent): void;
  fileState: FileStateStore;
  tasks: TaskStoreApi;
  background: BackgroundApi;
  /** Queue a <system-reminder> for injection into the next model message. */
  remind(text: string): void;
  /** Ask the frontend the AskUserQuestion payload; resolves with answers. */
  askUser(questions: unknown): Promise<Record<string, string[]>>;
  /** Spawn a subagent; resolves with its final text (foreground) or task id (background). */
  spawnAgent(opts: SpawnAgentOptions): Promise<string>;
  /** One-shot model call (small model) used by WebFetch to digest a page. */
  runInference(opts: { system: string; user: string; maxTokens: number }): Promise<string>;
  /** Add or (with undefined text) remove a keyed dynamic system-prompt section. */
  setPromptSection(key: string, text: string | undefined): void;
  /** Add a session-scoped allow rule (subject "*" or undefined allows any subject). */
  addSessionAllow(tool: string, subject?: string): void;
  settings: Settings;
  /** Output tokens billed to the whole session tree so far — lets a workflow enforce its token budget. */
  usedOutputTokens(): number;
  stateDir: string;
  /** Phase 3: cron/wakeup scheduler, attached by the engine. */
  cron?: import("../scheduling/cron.js").CronScheduler;
  /** Phase 3: switch the session working directory (used by the worktree tools). */
  setCwd?(dir: string): void;
  /** Phase 3: settings.worktree.baseRef, consumed by EnterWorktree. */
  worktreeBaseRef?: "fresh" | "head";
  /** Addons loaded from .magentra/addons (plus built-ins), consumed by the Addon tool. */
  addons?: { name: string; description: string; body: string; resources: string[] }[];
}

export interface ToolContext {
  cwd: string;
  session: SessionServices;
  /** The tool_use id of this call — lets a tool stream tool_output_delta events to its own row. */
  callId?: string;
}

/** Values filling a description's `{{slots}}`. See {@link ToolDefinition.descriptionVars}. */
export type ToolDescriptionVars = Record<string, string | number>;

export interface ToolDefinition<I = unknown> {
  name: string;
  /**
   * Sent to the model with every request. Write runtime values as `{{slots}}`
   * and supply them via {@link descriptionVars} rather than interpolating them
   * into the literal: an interpolated description never appears verbatim in the
   * source, so the prompt editor cannot locate it to write an edit back.
   */
  description: string;
  /** Fills the `{{slots}}` in {@link description}. */
  descriptionVars?: ToolDescriptionVars;
  inputSchema: z.ZodType<I>;
  permissionClass: PermissionClass;
  /**
   * The argument string permission rules match against (e.g. the Bash
   * command, or a file path). Undefined means rules match on tool name only.
   */
  permissionSubject?: (input: I) => string | undefined;
  /** Human-readable one-liner shown in the permission UI / tool_call_started. */
  describeInput?: (input: I) => string | undefined;
  /**
   * Returns a human-readable description of what would be DELETED (a file,
   * folder, or worktree) when the input is destructive, undefined otherwise.
   * Deletion calls always require interactive user approval, in every
   * permission stance (OVERDRIVE included) and regardless of allow/deny rules or
   * session allows — see PermissionEngine.check.
   */
  deletionSubject?: (input: I) => string | undefined;
  /**
   * Scope classifier for a call already flagged by deletionSubject:
   * "workspace" when every deletion target provably resolves inside the
   * session workspace — such calls skip the deletion guard while OVERDRIVE is
   * active. "protected" when a target is a `.magentra` state directory —
   * such calls ALWAYS ask, in every mode, beating the "allow deletions"
   * setting, explicit allow rules, and OVERDRIVE. Anything unprovable is
   * "unknown" and keeps the ordinary guard. Receives the tool context because
   * only the tool knows its own effective cwd (Bash tracks `cd` across
   * calls). Absent = always "unknown".
   */
  deletionScope?: (input: I, ctx: ToolContext) => "workspace" | "unknown" | "protected";
  /** Max bytes of result kept in history before truncation. Default 40_000. */
  outputByteLimit?: number;
  /** File-editing tools are auto-approved in both permission stances. */
  isFileEdit?: boolean;
  /** Read-only tools run concurrently within one assistant turn. */
  parallelSafe?: boolean;
  /**
   * Search/lookup terms this call is evidence of — the reuse gate records them
   * so that a later Write of a new file whose name overlaps a searched term is
   * allowed through (the agent already looked). Only search-shaped tools
   * (Grep/Glob/GraphQuery) implement it; it never affects the
   * call's own execution.
   */
  searchTerms?: (input: I) => string[];
  /** Phase 3 (MCP): raw JSON Schema advertised to the provider instead of zodToJsonSchema(inputSchema). */
  rawInputSchema?: Record<string, unknown>;
  execute(input: I, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;

/**
 * Publishes a tool's description to the prompt registry so it can be tuned like
 * any other prompt. Descriptions are sent with every request and are what the
 * model reads to decide WHICH tool to reach for and how many calls to batch, so
 * they belong in the same editor as the system prompt.
 *
 * Tolerant by design: a registry is built per session, and re-registering the
 * same tool must never be able to break one.
 */
export function registerToolPrompt(name: string, description: string, vars?: ToolDescriptionVars): string {
  const id = `tool.${name}`;
  try {
    return definePrompt({
      id,
      group: "7 · Tool descriptions",
      label: name,
      channel: "tool",
      where: `What the model reads to decide when to reach for ${name} and how to call it. The \`description\` field of the ${name} tool definition, sent on every request in which ${name} is available.`,
      ...(vars ? { placeholders: Object.keys(vars) } : {}),
      text: description,
    });
  } catch {
    return id;
  }
}

/** The description in force for a registered tool, with its `{{slots}}` filled. */
export function toolDescriptionText(name: string, fallback: string, vars?: ToolDescriptionVars): string {
  try {
    return vars ? renderPrompt(`tool.${name}`, vars) : promptText(`tool.${name}`);
  } catch {
    return fallback;
  }
}

/**
 * Whether a tool has been switched off by emptying its description prompt.
 *
 * Every other channel drops a disabled prompt before it reaches the model. A
 * tool description cannot work that way: blanking it would still offer the tool,
 * with nothing left to say when it applies — strictly worse than either keeping
 * the description or removing the tool. So an empty description withholds the
 * tool entirely, which is what "disabled" means everywhere else.
 *
 * A name with no registered prompt is not disabled; the caller falls back to the
 * literal description on the tool definition.
 */
export function isToolDisabled(name: string): boolean {
  try {
    return isPromptDisabled(`tool.${name}`);
  } catch {
    return false;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register(tool: AnyToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    registerToolPrompt(tool.name, tool.description, tool.descriptionVars);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  /** The tools actually offered to the model — {@link isToolDisabled} excluded. */
  enabled(): AnyToolDefinition[] {
    return this.list().filter((t) => !isToolDisabled(t.name));
  }

  /** A registry containing only the named subset (for subagents). */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) sub.register(tool);
    }
    return sub;
  }
}

export interface FileStateStore {
  recordRead(path: string): void;
  /** Error text if the file must be re-read first, undefined when fresh. */
  checkFresh(path: string): string | undefined;
  wasRead(path: string): boolean;
}

export interface TaskPatch {
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  status?: TaskItem["status"] | "deleted";
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
}

export interface TaskStoreApi {
  create(fields: {
    subject: string;
    description: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  }): TaskItem;
  update(id: string, patch: TaskPatch): TaskItem;
  get(id: string): TaskItem | undefined;
  list(): TaskItem[];
}

export interface BackgroundTaskInfo {
  id: string;
  kind: "bash" | "monitor" | "agent";
  description: string;
  outputFile: string;
  status: "running" | "completed" | "failed" | "stopped";
  exitCode?: number;
}

export interface BackgroundApi {
  launch(opts: {
    kind: BackgroundTaskInfo["kind"];
    description: string;
    start: (outputFile: string, onExit: (code: number | null) => void) => { stop(): void };
  }): BackgroundTaskInfo;
  get(id: string): BackgroundTaskInfo | undefined;
  stop(id: string): boolean;
  list(): BackgroundTaskInfo[];
}

