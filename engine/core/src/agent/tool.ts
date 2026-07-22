import type { z } from "zod";
import type { CoreEvent, TaskItem } from "@magentra/protocol";
import type { ToolResultPart } from "@magentra/providers";
import type { Settings } from "../config/settings.js";
import type { CrewAgent } from "../crew/team.js";

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
  /**
   * Override the child's per-turn iteration budget (maxIterationsPerTurn) for
   * this one spawn. Used to bound the blocking first-turn atlas build; omitted
   * spawns inherit the parent's settings unchanged.
   */
  maxIterations?: number;
  /**
   * Replace the agent type's role prompt for this one spawn (the toolset is
   * unchanged). Used when a task needs the type's tool restrictions but a
   * different persona — e.g. the atlas build runs on `explore` tools but must
   * author a full document, which the explore role explicitly discourages.
   */
  roleOverride?: string;
  /** CREW: run this child as a crew specialist (role prompt, model, tool subset, identity stamps). */
  crew?: {
    agent: CrewAgent;
    /** Phase B seam: a per-run backpack brief injected into the specialist's prompt. Always undefined in Phase A. */
    backpackBrief?: string;
    /** Experience: the member's learned-lessons prompt section for this run (assembled by CrewExperience.beginRun). */
    lessons?: string;
  };
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
  /** Phase 3b: skills loaded from .magentra/skills, consumed by the Skill tool. */
  skills?: { name: string; description: string; body: string }[];
  /** CREW Phase A: the loaded team roster (main session only), consumed by the CrewRun tool. */
  team?: CrewAgent[];
  /** CREW Phase B: this session's own crew agent id when it is a specialist; lets BackpackSearch default to self. */
  crewSelf?: string;
  /** Hirable crew: the per-workspace experience manager (main session only), consumed by CrewRun. */
  experience?: import("../crew/experience.js").CrewExperience;
}

export interface ToolContext {
  cwd: string;
  session: SessionServices;
  /** The tool_use id of this call — lets a tool stream tool_output_delta events to its own row. */
  callId?: string;
}

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
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
   * (Grep/Glob/GraphQuery/BackpackSearch) implement it; it never affects the
   * call's own execution.
   */
  searchTerms?: (input: I) => string[];
  /** Phase 3 (MCP): raw JSON Schema advertised to the provider instead of zodToJsonSchema(inputSchema). */
  rawInputSchema?: Record<string, unknown>;
  execute(input: I, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register(tool: AnyToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
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
  kind: "bash" | "monitor" | "agent" | "backpack";
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

