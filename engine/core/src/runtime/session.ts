import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadBackpackIndex } from "../knowledge/backpack/index.js";
import {
  STATE_DIR_NAME,
  type CoreEvent,
  type PermissionDecision,
  type PermissionMode,
  type TaskItem,
  type Usage,
} from "@magentra/protocol";
import type { ContentBlock, Msg, Provider, StopReason, ToolSchema } from "@magentra/providers";
import { friendlyProviderError } from "@magentra/providers";
import { zodToJsonSchema } from "../util/zodToJsonSchema.js";
import { AGENT_TYPES, SUBAGENT_RESULT_SECTION, agentToolNames, resolveAgentType } from "../agent/agents.js";
import {
  ATLAS_AREA_MAX_ITERATIONS,
  ATLAS_AREA_ROLE,
  ATLAS_FANOUT_CONCURRENCY,
  ATLAS_OVERVIEW_SYSTEM,
  assembleAtlas,
  atlasAreaPrompt,
  atlasOverviewPrompt,
  normalizeAtlasSection,
  type AtlasArea,
  atlasIsStale,
  atlasWasHandEdited,
  gitCommitsSince,
  gitHead,
  loadAtlas,
  looksLikeAtlas,
  readAtlasRaw,
  workspaceLooksNonTrivial,
  writeAtlas,
} from "../knowledge/atlas.js";
import { areaFacts, graphSummary, planAtlasAreas, projectName } from "../knowledge/atlasPlan.js";
import { loadOrBuildGraph, type GraphData } from "../knowledge/graph.js";
import { loadStandards } from "../knowledge/standards.js";
import { contextWindowFor } from "../config/pricing.js";
import { BackgroundManager } from "../scheduling/background.js";
import { FileState } from "./fileState.js";
import type { HookRunner } from "../agent/hooks.js";
import type { ModeEngine } from "../ma/modes.js";
import { PermissionEngine, type PermissionRequestPayload } from "./permissions.js";
import { buildSystemPrompt } from "../agent/prompts.js";
import { DEBUG_DIR, commandRunsRepro, reproScriptRelPath } from "../ma/debug.js";
import { SearchLog, evaluateReuseGate, type ReuseGateResult } from "../knowledge/reuseGate.js";
import { buildSymbolIndex, loadOrBuildSymbolIndex, type SymbolIndexData } from "../knowledge/symbols.js";
import { SessionStats } from "./sessionStats.js";
import type { Settings } from "../config/settings.js";
import { type CrewAgent, CREW_ALWAYS_ALLOWED, crewSection } from "../crew/team.js";
import { CrewExperience } from "../crew/experience.js";
import { recordCrewRun } from "../crew/ledger.js";
import type { Skill } from "../agent/skills.js";
import { TaskStore } from "../state/taskStore.js";
import type {
  PlanDecisionResult,
  SessionServices,
  SpawnAgentOptions,
  ToolContext,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "../agent/tool.js";
import { Transcript, syntheticToolResults, unansweredToolUseIds } from "../state/transcript.js";

const DEFAULT_OUTPUT_LIMIT = 40_000;

/** Per-turn cap on auto-recovery / length-continuation nudges (see runTurn). */
const MAX_AUTO_NUDGES = 3;

const ERROR_BATCH_REMINDER =
  "One or more tool calls above failed. Diagnose the cause and continue working — fix and retry rather than ending the turn. Only stop if the task is complete or genuinely blocked, and if blocked, explain why.";

const RECOVERY_NUDGE_TEXT =
  "<system-reminder>The last tool call in this turn failed and the turn is ending. Either fix the failure and re-verify, or state explicitly why this failure does not block success. Do not end with a failing command unaccounted for.</system-reminder>";

const WRAPUP_NUDGE_TEXT =
  "<system-reminder>You finished working but did not summarize. Give the user a short wrap-up: what was built/changed, how to use it, what you verified and the outcome, and any open issues.</system-reminder>";

const LENGTH_CONTINUATION_TEXT =
  "<system-reminder>Your previous response was cut off by the output-token limit. Continue exactly where you left off.</system-reminder>";

const PLAN_FIRST_REMINDER =
  "The task list is empty. If this request needs more than a couple of steps, first create a plan with TaskCreate — one task per step, the last one a verification task stating the expected end state — before making any edits. Trivial requests can proceed directly.";

const NO_ATLAS_REMINDER =
  "No design atlas exists for this workspace. Suggest the user run /atlas to generate one — a mapped atlas speeds up every future session. For non-trivial multi-module work you may instead create .magentra/ATLAS.md yourself: each module, one-line purpose, public interface, key dependencies — modules and boundaries, not a file listing, compact (fits in 12KB).";

const ATLAS_SECTION_HEADER =
  "# Codebase atlas (.magentra/ATLAS.md)\nThe whole-design map of this workspace. Consult it before planning or editing; it is the big picture.\n\n";

const STANDARDS_SECTION_HEADER =
  "# Coding standards (user-provided — binding)\nThe user supplied these standards. They are RULES, not suggestions: where they conflict with any default guidance about code style, the standards win. A change that violates them is a failed change regardless of whether it works.\n\n";

export interface SessionOptions {
  cwd: string;
  settings: Settings;
  provider: Provider;
  registry: ToolRegistry;
  emit: (event: CoreEvent) => void;
  requestApproval: (
    req: PermissionRequestPayload & { id: string },
  ) => Promise<{ decision: PermissionDecision; message?: string }>;
  askUser: (id: string, questions: unknown) => Promise<Record<string, string[]>>;
  sessionId?: string;
  initialMessages?: Msg[];
  /** Overrides the assembled system prompt (used by subagents). */
  systemPromptOverride?: string;
  skills?: Skill[];
  /** Extra prompt sections appended (e.g. plan-mode instructions). */
  extraPromptSections?: string[];
  /** Blocks awaiting the frontend's plan_decision after a plan_ready event. */
  requestPlanDecision?: () => Promise<PlanDecisionResult>;
  /**
   * Share an existing PermissionEngine instead of building one (subagents get
   * their parent's): session-allows granted during one specialist run hold for
   * the next, and mode/deletion-guard changes reach the whole tree.
   */
  permissionEngine?: PermissionEngine;
  /**
   * Share the parent's SessionStats (subagents/crew children do): their token
   * spend, API time and code changes belong to the same /session report as the
   * orchestrator's. Also set on /resume with the ledger rebuilt from the
   * transcript's meta snapshot. Omitted for a fresh root session.
   */
  stats?: SessionStats;
  /**
   * Subagent/crew child session: its transcript lives in sessions/subagents/
   * (off the resumable listing) and stats snapshots are the root's job.
   */
  child?: boolean;
  /** Runs lifecycle hooks; omitted for subagent sessions. */
  hookRunner?: HookRunner;
  /** The .ma style engine; omitted for subagent sessions (children inherit no modes). */
  modeEngine?: ModeEngine;
  /** CREW Phase A: the loaded team roster (main session only; children never inherit it). */
  team?: CrewAgent[];
  /** CREW Phase B: this session's own crew agent id (set for specialist children so BackpackSearch self-scopes). */
  crewSelf?: string;
  /**
   * Resolves a dedicated Provider for a crew member whose team file declares an
   * endpoint (provider/baseurl/apikeyenv frontmatter). undefined → the member
   * shares the session provider. A warning → the endpoint could not be resolved
   * (e.g. missing env key): the spawn falls back to the session provider AND the
   * default model, and the warning is surfaced as a non-fatal error event.
   */
  crewProviderResolver?: (agent: CrewAgent) => { provider: Provider } | { warning: string } | undefined;
  /** A2: called at turn start when the .magentra/team/*.md files changed on disk since the last turn. */
  onTeamFilesChanged?: () => void;
}

interface PendingToolCall {
  id: string;
  name: string;
  json: string;
}

export class Session {
  readonly id: string;
  cwd: string;
  readonly stateDir: string;
  readonly settings: Settings;
  readonly permissions: PermissionEngine;
  readonly tasks: TaskStore;
  readonly fileState = new FileState();
  readonly background: BackgroundManager;
  readonly transcript: Transcript;
  readonly services: SessionServices;

  messages: Msg[];
  extraPromptSections: string[];
  private readonly provider: Provider;
  private readonly registry: ToolRegistry;
  private readonly emit: (event: CoreEvent) => void;
  private readonly reminders: string[] = [];
  private readonly dynamicSections = new Map<string, string>();
  private abortController: AbortController | undefined;
  private turnCounter = 0;
  /**
   * Whole-session accounting (cost, API time, code changes, and the CURRENT
   * context size). Shared by reference with every subagent/crew child, so one
   * /session report covers the whole tree. See SessionStats for why context and
   * usage must not be conflated.
   */
  readonly stats: SessionStats;
  private busy = false;
  /**
   * Unattended run (a scheduled/continuous mission fired with nobody at the
   * keyboard): permission asks auto-deny instead of blocking forever, and
   * AskUserQuestion fails with a teaching error. Set by the engine around the
   * run; propagated to every child this session spawns.
   */
  private unattended = false;
  /** Usage totals of the most recently completed turn (undefined before the first turn ends). */
  lastTurnUsage: Usage | undefined;
  /** User-assigned session name (rename_session); persisted in the meta snapshot. */
  label: string | undefined;
  /** True once the empty-task-list plan-first reminder has fired and the list has stayed empty since. */
  private planReminderFired = false;
  /** True once the missing-atlas reminder has fired for this session. */
  private atlasReminderFired = false;
  /** True once the first-turn `/atlas` hint has fired (once per session, never for subagents). */
  private atlasHintFired = false;
  private readonly hooks: HookRunner | undefined;
  private planFile: string | undefined;
  /** Reuse gate: tokenized record of related searches/queries made this session. */
  private readonly searchLog = new SearchLog();
  /** Reuse gate: target paths already refused once, so the confirm-retry passes. */
  private readonly reuseBlocked = new Set<string>();
  /** Reuse gate: the workspace symbol index, loaded once then refreshed incrementally. */
  private symbolIndexCache: SymbolIndexData | undefined;
  /** debug.ma repro oracle: the designated repro script has been observed exiting nonzero (bug reproduced) — unlocks the repro-failed gate. */
  private reproFailedObserved = false;
  /** debug.ma repro oracle: the repro script has been observed exiting zero AFTER a failure (fix verified). */
  private reproPassedObserved = false;
  /** debug.ma: true once this turn's "rerun the repro" verify nudge has fired (reset at each turn start, so one nudge per turn). */
  private debugVerifyNudgeFired = false;
  /** A2: mutable crew roster (hot-reloadable); consumed by buildSystemPrompt and services.team. */
  private teamAgents: CrewAgent[];
  /** Hirable crew: the experience manager (lessons + service record). Main session with a team only. */
  private experience: CrewExperience | undefined;
  /** A2: last observed team-directory signature, for hot-reload detection. */
  private lastTeamSig: string | undefined;
  /** Set by interrupt(); the background atlas loop checks it and stops taking work. */
  private atlasCancelled = false;
  private activeChildren = 0;
  /** Foreground child sessions currently running, so interrupt() can propagate.
   *  Background children are deliberately excluded — they detach from the turn
   *  and are stopped through the BackgroundManager instead. */
  private liveChildren = new Set<Session>();
  private static readonly MAX_CHILDREN = 8;
  private static agentCounter = 0;

  constructor(private readonly opts: SessionOptions) {
    this.id = opts.sessionId ?? `s_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    this.cwd = opts.cwd;
    this.stateDir = join(opts.cwd, STATE_DIR_NAME);
    this.settings = opts.settings;
    // Children share the parent's ledger; a root session opens a fresh one.
    this.stats = opts.stats ?? new SessionStats();
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.emit = opts.emit;
    this.messages = opts.initialMessages ?? [];
    this.teamAgents = opts.team ?? [];
    this.hooks = opts.hookRunner;
    this.extraPromptSections = [...(opts.extraPromptSections ?? [])];
    this.transcript = new Transcript(this.stateDir, this.id, { child: opts.child ?? false });
    this.tasks = new TaskStore(this.stateDir, this.id, this.emit);
    // Hirable crew: when a crew-owned task is verified completed, confirm the
    // lessons that rode on the run and capture new candidates from the report.
    if (this.teamAgents.length > 0) this.experience = new CrewExperience(this.cwd);
    this.tasks.onStatusChange = (task, prev) => {
      if (task.status !== "completed" || prev === "completed") return;
      const owner = task.owner;
      if (!owner || owner === "orchestrator" || !this.experience) return;
      if (!this.teamAgents.some((a) => a.id === owner)) return;
      void this.experience.onTaskCompleted(task, (o) => this.runInference(o));
    };
    this.background = new BackgroundManager(this.stateDir, this.emit, (t) => this.remind(t));
    this.permissions =
      opts.permissionEngine ??
      new PermissionEngine(
        opts.settings.permissionMode,
        opts.settings.permissions,
        async (req, approvalSource) => {
        // Unattended runs never block on a human: deny with a reason instead.
        // In the default bypass-mode unattended run, only the deletion guard
        // reaches here — so destructive calls are exactly what this refuses.
        if (this.unattended) {
          this.transcript.append({
            kind: "permission",
            tool: req.tool,
            ...(subjectOf(req) !== undefined ? { subject: subjectOf(req) } : {}),
            decision: "deny",
            source: approvalSource === "deletion-guard" ? "deletion-guard" : "user",
          });
          return {
            decision: "deny",
            message:
              "unattended mission run — nobody is available to approve this call. It was denied automatically; find a non-destructive way, or leave it for an attended session.",
          };
        }
        const id = `perm_${randomBytes(4).toString("hex")}`;
        const res = await opts.requestApproval({ ...req, id });
        this.transcript.append({
          kind: "permission",
          tool: req.tool,
          ...(subjectOf(req) !== undefined ? { subject: subjectOf(req) } : {}),
          decision: res.decision,
          source: approvalSource === "deletion-guard" ? "deletion-guard" : "user",
        });
        return res;
      },
    );
    this.services = {
      // The tools' emit seam — and the single place a file_edited diff is
      // counted. A child's Write/Edit calls ITS OWN services.emit (writing to
      // the shared stats object), so counting here tallies the whole tree
      // exactly once; hooking the internal emit instead would double-count,
      // because emitFromChild forwards a child's events back through it.
      emit: (event) => {
        if (event.type === "file_edited") this.stats.recordDiff(event.diff);
        this.emit(event);
      },
      fileState: this.fileState,
      tasks: this.tasks,
      background: this.background,
      remind: (t) => this.remind(t),
      askUser: (questions) => {
        if (this.unattended) {
          return Promise.reject(
            new Error("unattended mission run — the user cannot be asked. Decide autonomously and note the decision in your report."),
          );
        }
        return opts.askUser(`q_${randomBytes(4).toString("hex")}`, questions);
      },
      spawnAgent: (o) => this.spawnAgent(o),
      runInference: (o) => this.runInference(o),
      setMode: (m) => this.setMode(m),
      setPlanFile: (p) => this.setPlanFile(p),
      getPlanFile: () => this.planFile,
      setPromptSection: (k, t) => this.setPromptSection(k, t),
      addSessionAllow: (tool, subject) => this.permissions.addSessionAllow(tool, subject),
      requestPlanDecision: () => this.requestPlanDecision(),
      settings: this.settings,
      usedOutputTokens: () => this.stats.totalUsage().outputTokens,
      stateDir: this.stateDir,
      setCwd: (dir: string) => {
        this.cwd = dir;
        // The UI must show when the session operates inside a worktree —
        // edits landing in an unexpected tree read as data loss.
        this.emit({ type: "cwd_changed", cwd: dir, worktree: dir !== this.opts.cwd });
      },
      worktreeBaseRef: opts.settings.worktree.baseRef,
      ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
      ...(this.teamAgents.length > 0 ? { team: this.teamAgents } : {}),
      ...(opts.crewSelf !== undefined ? { crewSelf: opts.crewSelf } : {}),
      ...(this.experience !== undefined ? { experience: this.experience } : {}),
    };
  }

  /** Marks this session (and every child it spawns from now on) as unattended. */
  setUnattended(value: boolean): void {
    this.unattended = value;
  }

  /** A2: replace the crew roster live (used by the engine on team-file hot-reload). */
  setTeam(agents: CrewAgent[]): void {
    this.teamAgents = agents;
    this.services.team = agents.length > 0 ? agents : undefined;
    if (agents.length > 0 && !this.experience) {
      this.experience = new CrewExperience(this.cwd);
      this.services.experience = this.experience;
    }
  }

  remind(text: string): void {
    this.reminders.push(text);
  }

  /** Records out-of-band context (e.g. `!` command output) without a model turn. */
  addContextMessage(text: string): void {
    const msg: Msg = { role: "user", content: [{ type: "text", text }] };
    this.messages.push(msg);
    this.transcript.append({ kind: "message", message: msg });
  }

  setMode(mode: PermissionMode): void {
    this.permissions.setMode(mode);
    this.emit({ type: "mode_changed", mode });
  }

  /** Sets (or clears) the plan file the model may Write/Edit while in plan mode. */
  setPlanFile(path: string | undefined): void {
    if (this.planFile) {
      this.permissions.removeSessionAllow(`Write(${this.planFile})`);
      this.permissions.removeSessionAllow(`Edit(${this.planFile})`);
    }
    this.planFile = path;
    if (path) {
      this.permissions.addSessionAllow("Write", path);
      this.permissions.addSessionAllow("Edit", path);
    }
  }

  setPromptSection(key: string, text: string | undefined): void {
    if (text === undefined) this.dynamicSections.delete(key);
    else this.dynamicSections.set(key, text);
  }

  /** The app's "Allow deletions" safety toggle. Turning it on both disables the
   *  always-ask deletion guard and tells the model (via a prompt section) that
   *  destructive local operations carry a durable user authorization — the
   *  prompt otherwise instructs it to seek confirmation for them. */
  setDeletionPolicy(allowDeletions: boolean): void {
    this.permissions.setDeletionGuard(!allowDeletions);
    this.setPromptSection(
      "deletion-policy",
      allowDeletions
        ? `Deletion policy:
- The user has enabled "Allow deletions" in the app settings — a durable authorization for destructive local operations (deleting files or folders, forced git history rewrites, and similar). They run without an extra confirmation prompt.
- This is a license, not a directive: delete only what the task genuinely requires, keep the smallest possible blast radius, and still call out anything surprising you are about to remove.`
        : undefined,
    );
  }

  private requestPlanDecision(): Promise<PlanDecisionResult> {
    return this.opts.requestPlanDecision
      ? this.opts.requestPlanDecision()
      : Promise.reject(new Error("no plan-decision channel is wired for this session"));
  }

  /** One-shot completion on the small model, no tools; returns concatenated text. */
  async runInference(opts: { system: string; user: string; maxTokens: number }): Promise<string> {
    let text = "";
    const stream = this.provider.stream({
      model: this.settings.smallModel ?? this.settings.model,
      system: opts.system,
      messages: [{ role: "user", content: [{ type: "text", text: opts.user }] }],
      tools: [],
      maxTokens: opts.maxTokens,
      signal: new AbortController().signal,
    });
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.text;
    }
    return text;
  }

  /**
   * Filters events from a child (subagent) session before they reach this
   * session's own emit. Child turn/text events must not leak into the
   * top-level stream (a frontend waiting for the outer turn_finished would
   * otherwise stop on the child's t_1); tool call events pass through so
   * subagent activity is still visible, tagged so frontends can render them
   * distinctly. Everything else (permissions, questions, tasks, background
   * notifications) passes through unchanged.
   */
  private emitFromChild(
    event: CoreEvent,
    agentId: string,
    agentDesc: string,
    stamp?: { agentColor?: string; agentEmoji?: string },
  ): void {
    switch (event.type) {
      case "turn_started":
      case "turn_finished":
      case "text_delta":
      case "thinking_delta":
        return;
      case "tool_call_started":
      case "tool_call_finished":
        // A grandchild's own emitFromChild layer stamps its tags first, so an
        // outer layer must not overwrite an already-present agentId/agentDesc.
        this.emit({
          ...event,
          subagent: true,
          agentId: event.agentId ?? agentId,
          agentDesc: event.agentDesc ?? agentDesc,
          ...(stamp?.agentColor !== undefined && event.agentColor === undefined
            ? { agentColor: stamp.agentColor }
            : {}),
          ...(stamp?.agentEmoji !== undefined && event.agentEmoji === undefined
            ? { agentEmoji: stamp.agentEmoji }
            : {}),
        });
        return;
      default:
        this.emit(event);
    }
  }

  /**
   * Spawns a child Session with a restricted registry and an agent-type role.
   * The child shares this session's provider (so scripted/live turns are drawn
   * from the same stream, parent-then-child-then-parent), emit, and approval
   * channel — except a crew member with a resolvable dedicated endpoint, which
   * runs on its own Provider (see SessionOptions.crewProviderResolver). Foreground: resolves with the child's final assistant text.
   * Background: resolves with a task id; the final text lands in the task
   * output file when the child finishes.
   */
  async spawnAgent(opts: SpawnAgentOptions): Promise<string> {
    const def = resolveAgentType(opts.agentType);
    if (!def) {
      throw new Error(
        `Unknown subagent_type "${opts.agentType}". Available: ${Object.keys(AGENT_TYPES).join(", ")}.`,
      );
    }
    if (this.activeChildren >= Session.MAX_CHILDREN) {
      throw new Error(
        `Too many concurrent subagents (max ${Session.MAX_CHILDREN}). Wait for running subagents to finish before spawning more.`,
      );
    }

    const agentId = `ag_${++Session.agentCounter}`;
    const crew = opts.crew?.agent;
    const agentDesc = crew ? `${crew.emoji ?? ""} ${crew.name}`.trim() : opts.description;
    // A crew member with a dedicated endpoint runs on its own Provider; an
    // unresolvable endpoint falls back to the session provider AND default
    // model (its declared model most likely doesn't exist on the fallback host).
    let crewProvider: Provider | undefined;
    let crewModel = crew?.model;
    if (crew) {
      const resolved = this.opts.crewProviderResolver?.(crew);
      if (resolved !== undefined) {
        if ("provider" in resolved) {
          crewProvider = resolved.provider;
        } else {
          this.emit({ type: "error", message: resolved.warning, fatal: false });
          crewModel = undefined;
        }
      }
    }
    const baseSettings = crew ? { ...this.settings, model: crewModel ?? this.settings.model } : this.settings;
    const childSettings =
      opts.maxIterations !== undefined
        ? { ...baseSettings, maxIterationsPerTurn: opts.maxIterations }
        : baseSettings;
    const stamp = crew
      ? {
          ...(crew.color !== undefined ? { agentColor: crew.color } : {}),
          ...(crew.emoji !== undefined ? { agentEmoji: crew.emoji } : {}),
        }
      : undefined;

    const allNames = this.registry.list().map((t) => t.name);
    // A crew specialist never spawns further agents or workflows in Phase A.
    const childRegistry = crew
      ? this.registry.subset(
          (crew.tools && crew.tools.length > 0
            ? [...new Set([...crew.tools, ...CREW_ALWAYS_ALLOWED])]
            : allNames
          ).filter((n) => n !== "Agent" && n !== "Workflow"),
        )
      : this.registry.subset(agentToolNames(def, allNames));
    const backpackSection = crew ? this.backpackPromptSection(crew.id, opts.crew?.backpackBrief) : undefined;
    const system = buildSystemPrompt({
      env: {
        cwd: this.cwd,
        isGitRepo: existsSync(join(this.cwd, ".git")),
        platform: process.platform,
        model: childSettings.model,
        date: new Date().toISOString().slice(0, 10),
      },
      skills: [],
      extraSections: crew
        ? [
            `You are ${crew.name}, the crew's ${crew.role}.`,
            crew.rolePrompt,
            ...(backpackSection ? [backpackSection] : []),
            ...(opts.crew?.lessons ? [opts.crew.lessons] : []),
            SUBAGENT_RESULT_SECTION,
          ]
        : [opts.roleOverride ?? def.role, SUBAGENT_RESULT_SECTION],
    });
    const child = new Session({
      cwd: this.cwd,
      settings: childSettings,
      provider: crewProvider ?? this.provider,
      registry: childRegistry,
      emit: (event) => this.emitFromChild(event, agentId, agentDesc, stamp),
      requestApproval: this.opts.requestApproval,
      askUser: async () => {
        throw new Error("subagents cannot ask the user — decide or report back");
      },
      requestPlanDecision: async () => {
        throw new Error("subagents cannot use plan mode");
      },
      systemPromptOverride: system,
      // The child shares this session's PermissionEngine: an "always allow
      // this session" granted during one specialist's run holds for the next.
      permissionEngine: this.permissions,
      // ...and its stats ledger: a crew member's spend (possibly on its own
      // model) belongs in the same /session report as the orchestrator's.
      stats: this.stats,
      child: true,
      ...(crew ? { crewSelf: crew.id } : {}),
    });
    child.setUnattended(this.unattended);

    // Announce the dispatch before the child's first model turn: without this
    // the frontend hears nothing until the child's first tool call, so a
    // parallel fan-out looks stalled for a full LLM turn.
    const spawnedEvent = {
      type: "agent_spawned" as const,
      agentId,
      agentDesc,
      ...(stamp ?? {}),
    };

    if (opts.runInBackground) {
      const info = this.background.launch({
        kind: "agent",
        description: opts.description,
        start: (outputFile, onExit) => {
          this.activeChildren++;
          this.emit({ ...spawnedEvent, background: true });
          void (async () => {
            try {
              await child.runTurn(opts.prompt);
              writeFileSync(outputFile, finalAssistantText(child));
              this.emit({ type: "agent_finished", agentId });
              onExit(0);
            } catch (err) {
              writeFileSync(outputFile, `Subagent failed: ${(err as Error).message}`);
              this.emit({ type: "agent_finished", agentId, isError: true });
              onExit(1);
            } finally {
              this.activeChildren--;
              this.recordCrewUsage(crew?.id, child);
            }
          })();
          return { stop: () => child.interrupt() };
        },
      });
      return info.id;
    }

    this.activeChildren++;
    this.liveChildren.add(child);
    this.emit(spawnedEvent);
    let failed = false;
    try {
      await child.runTurn(opts.prompt);
      return finalAssistantText(child);
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      this.activeChildren--;
      this.liveChildren.delete(child);
      this.recordCrewUsage(crew?.id, child);
      this.emit({ type: "agent_finished", agentId, ...(failed ? { isError: true } : {}) });
    }
  }

  /** Cost ledger: bank a crew child's run usage against its member id (best-effort). */
  private recordCrewUsage(crewId: string | undefined, child: Session): void {
    if (!crewId || !child.lastTurnUsage) return;
    try {
      recordCrewRun(this.cwd, crewId, child.lastTurnUsage);
    } catch {
      // accounting must never fail a run
    }
  }

  /**
   * HARD STOP — everything this session started, stopped now.
   *
   * "Stop" only means something if it reaches all the way. Three kinds of work
   * outlive a naive abort, and each is cut here:
   *
   *   1. the current turn, and every subagent under it (they run their own
   *      controllers, so aborting only this session would leave them burning
   *      tokens while the parent waits on their results);
   *   2. a background atlas build, whose loop would otherwise catch the abort of
   *      one area agent, wait, and cheerfully spawn the next one;
   *   3. background jobs (bash, monitors) — detached from any turn, so nothing
   *      else would ever kill them.
   *
   * Idempotent and safe when idle.
   */
  interrupt(): void {
    this.atlasCancelled = true;
    this.abortController?.abort(new Error("interrupted by user"));
    for (const child of this.liveChildren) child.interrupt();
    this.stopBackgroundTasks();
  }

  /** Kills every still-running background job this session launched. Returns how many died. */
  private stopBackgroundTasks(): number {
    let stopped = 0;
    for (const task of this.background.list()) {
      if (task.status === "running" && this.background.stop(task.id)) stopped++;
    }
    return stopped;
  }

  isBusy(): boolean {
    return this.busy;
  }

  toolSchemas(): ToolSchema[] {
    return this.registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.rawInputSchema ?? zodToJsonSchema(t.inputSchema),
    }));
  }

  buildSystemPrompt(): string {
    if (this.opts.systemPromptOverride) return this.opts.systemPromptOverride;
    const atlas = loadAtlas(this.cwd);
    const standards = loadStandards(this.cwd);
    return buildSystemPrompt({
      env: {
        cwd: this.cwd,
        isGitRepo: existsSync(join(this.cwd, ".git")),
        platform: process.platform,
        model: this.settings.model,
        date: new Date().toISOString().slice(0, 10),
      },
      skills: this.opts.skills ?? [],
      extraSections: [
        ...this.extraPromptSections,
        ...this.dynamicSections.values(),
        ...(this.opts.modeEngine?.promptSections() ?? []),
        ...(this.teamAgents.length > 0 ? [crewSection(this.teamAgents)] : []),
        ...(atlas ? [ATLAS_SECTION_HEADER + atlas] : []),
        ...(standards ? [STANDARDS_SECTION_HEADER + standards] : []),
      ],
    });
  }

  /** CREW Phase B: the knowledge-brief prompt section for a specialist, or undefined. */
  private backpackPromptSection(agentId: string, briefOverride?: string): string | undefined {
    const index = loadBackpackIndex(this.cwd, agentId);
    const brief = briefOverride ?? index?.brief;
    if (brief) return `# Your knowledge brief\n${brief}\n(Use BackpackSearch for exact passages.)`;
    if (index && index.chunks.length > 0) {
      return "(backpack still indexing — BackpackSearch over raw text is available)";
    }
    return undefined;
  }

  /** A2: a cheap signature of the team dir (names + mtime + size) for hot-reload detection. */
  private teamDirSignature(): string {
    const dir = join(this.cwd, ".magentra", "team");
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      return "";
    }
    return names
      .map((n) => {
        try {
          const st = statSync(join(dir, n));
          return `${n}:${st.mtimeMs}:${st.size}`;
        } catch {
          return n;
        }
      })
      .join("|");
  }

  /**
   * The `/atlas` build, as an orchestrator over three stages: derive the facts
   * (no model), map every area in parallel (one agent each), then synthesize the
   * overview and assemble the document. See the ATLAS BUILD note in atlas.ts for
   * why it is shaped this way.
   *
   * Best-effort throughout: a failure emits a notice, leaves any existing atlas
   * alone, and the missing-atlas nudge still fires. A hand-edited atlas is never
   * clobbered without `force`. Subagents opt out entirely.
   */
  async buildAtlas(force = false): Promise<void> {
    // Subagents (which always run with an overridden system prompt) never
    // auto-explore: it would recurse via spawnAgent, and a child cannot own the
    // workspace atlas anyway.
    if (this.opts.systemPromptOverride !== undefined) return;

    // A stop from a previous build must not kill this one before it starts.
    this.atlasCancelled = false;

    // If a human edited the atlas since the engine wrote it (its body hash no
    // longer matches the stamp), never clobber that work unless forced.
    const raw = readAtlasRaw(this.cwd);
    if (raw !== undefined && atlasWasHandEdited(raw) && !force) {
      this.emit({
        type: "command_output",
        text: "🗺 atlas was hand-edited — keeping your version (run /atlas force to overwrite)",
      });
      return;
    }

    try {
      // ── 1. Facts. Costs nothing, and spares every agent the grepping. ──────
      const graph = loadOrBuildGraph(this.cwd);
      const symbols = loadOrBuildSymbolIndex(this.cwd);
      const areas = planAtlasAreas(graph, undefined, this.cwd);
      if (areas.length === 0) throw new Error("no source files to map");

      const project = projectName(this.cwd);
      this.emit({
        type: "command_output",
        text: `🗺 mapping ${project}: ${graphSummary(graph, areas)} — ${areas.length} agent${areas.length === 1 ? "" : "s"} in parallel…`,
      });

      // ── 2. Fan out. Each agent maps one area and returns one compact section. ─
      const sections = await this.mapAreasInParallel(areas, graph, symbols);
      // A stopped build writes nothing: half a map, silently saved, is worse
      // than no map — the next session would trust it.
      if (this.atlasCancelled) {
        this.emit({ type: "command_output", text: "🗺 atlas build stopped — nothing written." });
        return;
      }
      if (sections.length === 0) throw new Error("no area could be mapped");

      // ── 3. Synthesize. One cheap, tool-free call opens the document. ────────
      const overview = await this.runInference({
        system: ATLAS_OVERVIEW_SYSTEM,
        user: atlasOverviewPrompt(project, sections, graphSummary(graph, areas)),
        maxTokens: 400,
      });

      const atlas = assembleAtlas(project, overview, sections);
      if (!looksLikeAtlas(atlas)) throw new Error("assembled atlas failed its shape check");

      writeAtlas(this.cwd, atlas, gitHead(this.cwd));
      this.emit({
        type: "command_output",
        text: `🗺 design atlas ready — .magentra/ATLAS.md (${sections.length}/${areas.length} areas mapped)`,
      });
    } catch (err) {
      this.emit({
        type: "command_output",
        text: `🗺 atlas build failed (${(err as Error).message}) — continuing without it`,
      });
    }
  }

  /**
   * Runs one agent per area, ATLAS_FANOUT_CONCURRENCY at a time. A failed or
   * empty area is dropped rather than failing the build — a partial atlas beats
   * none. Sections come back in area order regardless of completion order, so
   * the document is stable across runs.
   */
  private async mapAreasInParallel(
    areas: AtlasArea[],
    graph: GraphData,
    symbols: SymbolIndexData,
  ): Promise<string[]> {
    const results: (string | undefined)[] = new Array(areas.length).fill(undefined);
    let next = 0;

    const mapOne = async (area: AtlasArea): Promise<string | undefined> => {
      const section = await this.spawnAgent({
        agentType: "explore",
        description: `map ${area.name}`,
        prompt: atlasAreaPrompt(area, areaFacts(area, areas, graph, symbols)),
        // The explore role ("return concise conclusions — file paths with line
        // numbers") is the wrong persona for authoring a section.
        roleOverride: ATLAS_AREA_ROLE,
        maxIterations: ATLAS_AREA_MAX_ITERATIONS,
      });
      const text = section.trim();
      if (!text || text === NO_SUBAGENT_TEXT) return undefined;
      return normalizeAtlasSection(text, area.name);
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        // A hard stop must actually stop: check before taking new work, and
        // again before retrying, or the loop would happily out-live the abort it
        // just caught.
        if (this.atlasCancelled) return;
        const index = next++;
        const area = areas[index];
        if (!area) return;
        try {
          results[index] = await mapOne(area);
        } catch {
          if (this.atlasCancelled) return;
          // The build runs in the background, so the user's own turn may be
          // spawning agents at the same time and briefly exhaust the subagent
          // slots. That is transient — back off once and retry, rather than
          // silently shipping an atlas with a hole in it.
          await new Promise((r) => setTimeout(r, 2_000));
          if (this.atlasCancelled) return;
          try {
            results[index] = await mapOne(area);
          } catch {
            // Genuinely failed. One missing area beats no atlas.
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(ATLAS_FANOUT_CONCURRENCY, areas.length) }, () => worker()),
    );
    return results.filter((s): s is string => s !== undefined);
  }

  /**
   * Zero-cost first-turn nudge toward `/atlas`. Fires at most once per session
   * and never for a subagent. Emits a hint when a non-trivial workspace has no
   * atlas, or when its machine-owned atlas has gone git-stale; a hand-edited
   * atlas is left alone. Cheap (one file read + at most one git call) and never
   * throws — atlas building is now an explicit command, so this is only a signpost.
   */
  private maybeHintAtlas(): void {
    if (this.atlasHintFired) return;
    if (this.opts.systemPromptOverride !== undefined) return;
    this.atlasHintFired = true;
    try {
      const raw = readAtlasRaw(this.cwd);
      if (raw === undefined) {
        if (workspaceLooksNonTrivial(this.cwd)) {
          this.emit({
            type: "command_output",
            text: "🗺 no design atlas — run /atlas to map this codebase (speeds up every future session)",
          });
        }
        return;
      }
      if (atlasIsStale(raw, (commit) => gitCommitsSince(this.cwd, commit)) && !atlasWasHandEdited(raw)) {
        this.emit({
          type: "command_output",
          text: "🗺 the design atlas looks stale — run /atlas to rebuild it",
        });
      }
    } catch {
      // A signpost must never break a turn.
    }
  }

  /** Runs one full user turn: model call -> tool calls -> ... -> final text. */
  async runTurn(userText: string): Promise<void> {
    if (this.busy) throw new Error("session is already processing a turn");
    this.busy = true;

    // A2: hot-reload the crew when its files changed since the last turn.
    if (this.opts.onTeamFilesChanged) {
      const sig = this.teamDirSignature();
      if (this.lastTeamSig !== undefined && sig !== this.lastTeamSig) this.opts.onTeamFilesChanged();
      this.lastTeamSig = sig;
    }

    if (this.hooks?.has("UserPromptSubmit")) {
      const summary = this.hooks.summarize(
        await this.hooks.run("UserPromptSubmit", {
          hook_event_name: "UserPromptSubmit",
          session_id: this.id,
          cwd: this.cwd,
          prompt: userText,
        }),
      );
      if (summary.blocked) {
        this.busy = false;
        this.emit({
          type: "error",
          message: `UserPromptSubmit hook blocked this prompt: ${summary.blockReason}`,
          fatal: false,
        });
        return;
      }
      if (summary.contextText) this.remind(summary.contextText);
    }

    if (this.tasks.list().length === 0) {
      if (!this.planReminderFired) {
        this.remind(PLAN_FIRST_REMINDER);
        this.planReminderFired = true;
      }
    } else {
      this.planReminderFired = false;
    }

    for (const text of this.opts.modeEngine?.turnStartInjections() ?? []) this.remind(text);

    // debug.ma: at most one "rerun the repro" verify nudge per turn.
    this.debugVerifyNudgeFired = false;

    const turnId = `t_${++this.turnCounter}`;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const turnUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    this.emit({ type: "turn_started", turnId });

    // Zero-cost first-turn hint: point the user at `/atlas` when this workspace
    // has no atlas (or a stale machine-owned one). Fires once per session, never
    // for subagents, and is cheap (one file read + at most one git call) — it
    // must not throw, so any failure is swallowed.
    this.maybeHintAtlas();

    // Fallback: no atlas on disk — nudge the model to suggest /atlas (or map the
    // design itself for non-trivial work), once per session.
    if (!this.atlasReminderFired && loadAtlas(this.cwd) === undefined && workspaceLooksNonTrivial(this.cwd)) {
      this.remind(NO_ATLAS_REMINDER);
      this.atlasReminderFired = true;
    }

    this.pushMessage({ role: "user", content: this.withReminders([{ type: "text", text: userText }]) });

    let stopReason: string = "end_turn";
    let stopHookFired = false;
    let lastBatchHadError = false;
    let nudgeCount = 0;
    let totalToolCallsThisTurn = 0;
    let wroteOrEditedThisTurn = false;
    try {
      for (let iteration = 0; ; iteration++) {
        if (iteration >= this.settings.maxIterationsPerTurn) {
          this.emit({
            type: "command_output",
            text: `⏸ Iteration cap reached (${iteration} tool rounds) — send any message to continue.`,
          });
          stopReason = "max_iterations";
          break;
        }
        if (turnUsage.outputTokens > this.settings.maxTokensPerTurn) {
          this.emit({
            type: "command_output",
            text: `⏸ Turn token budget reached (${turnUsage.outputTokens} output tokens) — send any message to continue.`,
          });
          break;
        }

        const { assistant, toolCalls, end } = await this.streamAssistantTurn(signal);
        // turnUsage ACCUMULATES (it is billed cost for this turn). The context
        // size does NOT — streamAssistantTurn already set stats.contextTokens
        // from this one response's whole prompt. Never sum the two concepts.
        turnUsage.inputTokens += end.usage.inputTokens;
        turnUsage.outputTokens += end.usage.outputTokens;
        turnUsage.cacheReadTokens += end.usage.cacheReadTokens;
        turnUsage.cacheWriteTokens += end.usage.cacheWriteTokens;

        if (assistant.content.length > 0) this.pushMessage(assistant);
        stopReason = end.stopReason;

        if (toolCalls.length === 0) {
          if (stopReason === "end_turn" && !stopHookFired && this.hooks?.has("Stop")) {
            stopHookFired = true;
            const summary = this.hooks.summarize(
              await this.hooks.run("Stop", {
                hook_event_name: "Stop",
                session_id: this.id,
                cwd: this.cwd,
              }),
            );
            if (summary.blocked) {
              this.pushMessage({
                role: "user",
                content: [
                  { type: "text", text: `<system-reminder>Stop hook: ${summary.blockReason}</system-reminder>` },
                ],
              });
              continue;
            }
          }

          // LAYER 3: the provider cut the response off at the output-token
          // limit with no tool calls pending — resume rather than ending the
          // turn on a truncated answer.
          if (stopReason === "max_tokens" && nudgeCount < MAX_AUTO_NUDGES) {
            nudgeCount++;
            this.emit({ type: "command_output", text: "↻ continuing after output-length cutoff" });
            this.pushMessage({ role: "user", content: [{ type: "text", text: LENGTH_CONTINUATION_TEXT }] });
            continue;
          }

          // DEBUG VERIFY: debug.ma's repro oracle saw the script fail but never
          // observed it pass again — the fix (if any) is unverified. Force one
          // more iteration demanding a rerun, guarded by its own once-per-turn
          // flag (not the nudge cap) so the oracle is always checked.
          if (
            this.opts.modeEngine?.requiresReproOracle() &&
            this.reproFailedObserved &&
            !this.reproPassedObserved &&
            !this.debugVerifyNudgeFired
          ) {
            this.debugVerifyNudgeFired = true;
            this.emit({ type: "command_output", text: "↻ debug: repro not yet observed passing — verify" });
            this.pushMessage({
              role: "user",
              content: [{ type: "text", text: debugVerifyNudgeText(reproScriptRelPath()) }],
            });
            continue;
          }

          // LAYER 2: the previous tool-result batch had a failure and the
          // turn is ending regardless of what the final text says — weak
          // models sometimes bury a failure under a long non-answer. Nudge
          // it to keep going, capped so a persistently failing model still
          // terminates.
          if (stopReason === "end_turn" && lastBatchHadError && nudgeCount < MAX_AUTO_NUDGES) {
            nudgeCount++;
            this.emit({
              type: "command_output",
              text: "↻ auto-recovery: nudging the agent to continue after a failed tool call",
            });
            this.pushMessage({ role: "user", content: [{ type: "text", text: RECOVERY_NUDGE_TEXT }] });
            continue;
          }

          // LAYER 1.5: the turn is ending cleanly but the task list still has
          // pending or in-progress work — nudge the model to finish or
          // explicitly justify leaving it open. Checked after error-recovery
          // (a failure takes priority) and before the wrap-up nudge.
          if (stopReason === "end_turn" && !lastBatchHadError && nudgeCount < MAX_AUTO_NUDGES) {
            const incomplete = this.tasks.list().filter((t) => t.status === "pending" || t.status === "in_progress");
            if (incomplete.length > 0) {
              nudgeCount++;
              this.emit({ type: "command_output", text: "↻ tasks incomplete — continuing" });
              this.pushMessage({ role: "user", content: [{ type: "text", text: incompleteTasksNudgeText(incomplete) }] });
              continue;
            }
          }

          // LAYER 1: the turn did substantial tool-driven work but ended on a
          // bare reply with no wrap-up for the user — nudge once for a summary
          // rather than letting the turn end in silence. Checked after LAYER 2
          // so error-recovery still takes priority over the wrap-up nudge.
          if (
            stopReason === "end_turn" &&
            !lastBatchHadError &&
            totalToolCallsThisTurn >= 5 &&
            assistantTextLength(assistant) < 150 &&
            nudgeCount < MAX_AUTO_NUDGES
          ) {
            nudgeCount++;
            this.emit({ type: "command_output", text: "↻ requesting a work summary" });
            const checklist = this.opts.modeEngine?.wrapupChecklist() ?? "";
            const mentionAtlas = wroteOrEditedThisTurn && loadAtlas(this.cwd) !== undefined;
            const mentionStandards = wroteOrEditedThisTurn && loadStandards(this.cwd) !== undefined;
            this.pushMessage({
              role: "user",
              content: [{ type: "text", text: wrapupNudgeText(checklist, mentionAtlas, mentionStandards) }],
            });
            continue;
          }

          break;
        }

        totalToolCallsThisTurn += toolCalls.length;
        if (toolCalls.some((c) => c.name === "Write" || c.name === "Edit")) wroteOrEditedThisTurn = true;
        const results = await this.executeToolCalls(toolCalls, signal);
        lastBatchHadError = results.some((r) => r.type === "tool_result" && r.isError === true);
        if (lastBatchHadError) {
          this.remind(ERROR_BATCH_REMINDER);
          for (const text of this.opts.modeEngine?.afterErrorInjections() ?? []) this.remind(text);
        }
        // These results are read in round iteration+1; the last round that
        // streams before the cap breaks the loop is cap-1. Warn the model ON
        // that final round (teaching, not enforcement): a weak model that
        // over-explores otherwise ends the turn cut off mid-exploration with
        // no final answer — the atlas build was the canonical casualty.
        if (iteration === this.settings.maxIterationsPerTurn - 2) {
          this.remind(
            "Final tool round: the per-turn iteration cap is reached after this response. Give your complete final answer now — further tool calls will be cut off.",
          );
        }
        this.pushMessage({ role: "user", content: this.withReminders(results) });
        // Mid-turn compaction: a long tool loop must squeeze the window when it
        // fills instead of dying on a provider context error at the next call.
        // (maybeCompact self-gates on the threshold, so this is cheap.)
        await this.maybeCompact();
      }
    } catch (err) {
      // If the turn died between an assistant tool_use and its results, the
      // history is malformed until each dangling call gets a tool_result —
      // providers reject the next request otherwise (and /resume replays the
      // same wound). Synthesize the missing results before recording anything.
      const repairs = syntheticToolResults(
        unansweredToolUseIds(this.messages[this.messages.length - 1]),
      );
      if (signal.aborted) {
        stopReason = "aborted";
        this.pushMessage({
          role: "user",
          content: [
            ...repairs,
            { type: "text", text: "<system-reminder>The user interrupted this turn before it finished.</system-reminder>" },
          ],
        });
      } else {
        stopReason = "error";
        // Provider failures reach the user here: a raw "provider returned 401:
        // {json}" means nothing, so classify to a plain-English cause. The
        // original text is preserved in the engine log by the desktop layer.
        const host = providerHost(this.settings);
        this.emit({ type: "error", message: friendlyProviderError(err, host), fatal: false });
        if (repairs.length > 0) {
          this.pushMessage({
            role: "user",
            content: [
              ...repairs,
              { type: "text", text: "<system-reminder>This turn ended with an error before its tool calls completed.</system-reminder>" },
            ],
          });
        }
      }
    } finally {
      this.busy = false;
      this.abortController = undefined;
      this.lastTurnUsage = turnUsage;
      const totalCostUsd = this.stats.totalCost(this.settings);
      this.emit({
        type: "turn_finished",
        turnId,
        stopReason,
        usage: turnUsage,
        contextTokens: this.stats.contextTokens,
        ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      });
      // Snapshot the tree-wide ledger + mode so /resume restores real
      // accounting instead of a $0.00 session. Children share the root's
      // ledger, so only the root writes it.
      if (!this.opts.child) {
        this.transcript.append({
          kind: "meta",
          data: {
            stats: this.stats.snapshot(),
            mode: this.permissions.getMode(),
            model: this.settings.model,
            ...(this.label !== undefined ? { label: this.label } : {}),
          },
        });
      }
    }

    await this.maybeCompact();
  }

  private async streamAssistantTurn(signal: AbortSignal): Promise<{
    assistant: Msg;
    toolCalls: PendingToolCall[];
    end: { stopReason: StopReason; usage: Usage };
  }> {
    const blocks: ContentBlock[] = [];
    const toolCalls: PendingToolCall[] = [];
    let text = "";
    let thinking = "";
    let end: { stopReason: StopReason; usage: Usage } = {
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };

    const model = this.settings.model;
    const apiStartedAt = Date.now();

    const stream = this.provider.stream({
      model,
      system: this.buildSystemPrompt(),
      messages: this.messages,
      tools: this.toolSchemas(),
      maxTokens: this.settings.maxTokensPerResponse,
      signal,
      // A silent backoff looks like a frozen spinner — narrate every retry.
      onRetry: (info) =>
        this.emit({ type: "retry_status", attempt: info.attempt, delayMs: info.delayMs, reason: info.reason }),
    });

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          this.emit({ type: "text_delta", text: event.text });
          break;
        case "thinking_delta":
          thinking += event.text;
          this.emit({ type: "thinking_delta", text: event.text });
          break;
        case "tool_use_start":
          toolCalls.push({ id: event.id, name: event.name, json: "" });
          break;
        case "tool_use_delta": {
          const call = toolCalls.find((c) => c.id === event.id);
          if (call) call.json += event.partialJson;
          break;
        }
        case "tool_use_end":
          break;
        case "message_end":
          end = { stopReason: event.stopReason, usage: event.usage };
          break;
      }
    }

    // Bank this response against the whole-session ledger: its billed tokens
    // (per model — a crew child may run on a different one), the API time it
    // took, and the context size it reveals. Shared with the parent session, so
    // a crew/subagent's spend lands in the same /session report.
    this.stats.recordResponse(model, end.usage, Date.now() - apiStartedAt);

    if (thinking) blocks.push({ type: "thinking", thinking });
    if (text) blocks.push({ type: "text", text });
    for (const call of toolCalls) {
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: safeParse(call.json) });
    }
    return { assistant: { role: "assistant", content: blocks }, toolCalls, end };
  }

  private async executeToolCalls(calls: PendingToolCall[], signal: AbortSignal): Promise<ContentBlock[]> {
    interface Planned {
      call: PendingToolCall;
      run: () => Promise<ToolResult>;
      parallel: boolean;
    }

    const planned: Planned[] = [];
    for (const call of calls) {
      const tool = this.registry.get(call.name);
      if (!tool) {
        planned.push({
          call,
          parallel: true,
          run: async () => ({
            content: `Unknown tool "${call.name}". Available tools: ${this.registry.list().map((t) => t.name).join(", ")}`,
            isError: true,
          }),
        });
        continue;
      }

      const rawInput = safeParse(call.json);
      const parsed = tool.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        planned.push({
          call,
          parallel: true,
          run: async () => ({ content: `Invalid input for ${call.name}: ${issues}`, isError: true }),
        });
        continue;
      }

      const input = parsed.data as never;
      const subject = tool.permissionSubject?.(input);
      const description = tool.describeInput?.(input);
      planned.push({
        call,
        parallel: tool.permissionClass === "read" || tool.parallelSafe === true,
        run: async () => {
          // Reuse gate: record any search/query evidence this call carries, then
          // (for a Write) decide whether a new-file creation should be refused.
          if (tool.searchTerms) {
            try {
              this.searchLog.record(tool.searchTerms(input));
            } catch {
              // evidence logging must never break the call it observes
            }
          }
          const gateHit = this.opts.modeEngine?.gateFor(tool.name);
          if (gateHit) {
            if (gateHit.gate.require === "never") {
              return { content: gateHit.gate.message, isError: true };
            }
            if (gateHit.gate.require === "tasks-exist" && this.tasks.list().length === 0) {
              return { content: gateHit.gate.message, isError: true };
            }
            // debug.ma repro oracle: edits stay locked until the repro script has
            // been observed failing — except a Write/Edit into the debug dir
            // itself, so the model can create and refine that very script.
            if (
              gateHit.gate.require === "repro-failed" &&
              !this.reproFailedObserved &&
              !this.isDebugScriptWrite(tool.name, input)
            ) {
              return { content: gateHit.gate.message, isError: true };
            }
          }
          if (tool.name === "Write") {
            const gate = this.evaluateWriteReuseGate(input);
            if (gate.kind === "block") return { content: gate.text, isError: true };
            if (gate.kind === "remind") this.remind(gate.text);
          }
          if (this.hooks?.has("PreToolUse")) {
            const summary = this.hooks.summarize(
              await this.hooks.run("PreToolUse", {
                hook_event_name: "PreToolUse",
                session_id: this.id,
                cwd: this.cwd,
                tool_name: tool.name,
                tool_input: input,
              }),
            );
            if (summary.blocked) {
              return { content: "PreToolUse hook blocked this call: " + summary.blockReason, isError: true };
            }
          }
          const outcome = await this.permissions.check(tool, input, subject, description);
          if (outcome.source !== "user") {
            this.transcript.append({
              kind: "permission",
              tool: tool.name,
              ...(subject !== undefined ? { subject } : {}),
              decision: outcome.allowed ? "allow" : "deny",
              source: outcome.source,
            });
          }
          if (!outcome.allowed) {
            return { content: outcome.message ?? "Permission denied.", isError: true };
          }
          this.emit({
            type: "tool_call_started",
            id: call.id,
            tool: tool.name,
            input,
            ...(description !== undefined ? { description } : {}),
          });
          try {
            const result = await tool.execute(input, { ...this.toolContext(), callId: call.id }, signal);
            this.observeReproRun(tool.name, input, result.isError === true);
            const truncated = truncateResult(result, tool.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT);
            if (this.hooks?.has("PostToolUse")) {
              const summary = this.hooks.summarize(
                await this.hooks.run("PostToolUse", {
                  hook_event_name: "PostToolUse",
                  session_id: this.id,
                  cwd: this.cwd,
                  tool_name: tool.name,
                  tool_input: input,
                  tool_response: preview(truncated),
                }),
              );
              if (summary.blocked && typeof truncated.content === "string") {
                return {
                  ...truncated,
                  content: `${truncated.content}\n<system-reminder>PostToolUse hook: ${summary.blockReason}</system-reminder>`,
                };
              }
            }
            return truncated;
          } catch (err) {
            if (signal.aborted) throw err;
            return { content: `Tool failed: ${(err as Error).message}`, isError: true };
          }
        },
      });
    }

    const results = new Map<string, ToolResult>();
    const parallelBatch = planned.filter((p) => p.parallel);
    const sequential = planned.filter((p) => !p.parallel);

    // Permission prompts must not race; sequential (mutating) calls run first-to-last
    // while read-only calls execute concurrently.
    const parallelPromise = Promise.all(
      parallelBatch.map(async (p) => results.set(p.call.id, await p.run())),
    );
    for (const p of sequential) {
      signal.throwIfAborted();
      results.set(p.call.id, await p.run());
    }
    await parallelPromise;

    return calls.map((call) => {
      const result = results.get(call.id) ?? { content: "Tool did not run.", isError: true };
      this.emit({
        type: "tool_call_finished",
        id: call.id,
        tool: call.name,
        resultPreview: preview(result),
        isError: result.isError ?? false,
      });
      return {
        type: "tool_result",
        toolUseId: call.id,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      };
    });
  }

  private toolContext(): ToolContext {
    return { cwd: this.cwd, session: this.services };
  }

  /**
   * debug.ma repro oracle. Watches Bash calls that run the designated repro
   * script (matched structurally on the command string): a nonzero exit marks
   * the bug reproduced — unlocking edits via the repro-failed gate — while a
   * zero exit AFTER a prior failure marks the fix verified. A pass is credited
   * only once a failure has been seen: the fail→pass sequence is what validates
   * the oracle, so a green run before any red is not a proof.
   */
  private observeReproRun(toolName: string, input: unknown, isError: boolean): void {
    if (toolName !== "Bash") return;
    if (typeof input !== "object" || input === null) return;
    const command = (input as Record<string, unknown>).command;
    if (typeof command !== "string" || !commandRunsRepro(command)) return;
    if (isError) this.reproFailedObserved = true;
    else if (this.reproFailedObserved) this.reproPassedObserved = true;
  }

  /**
   * True when a Write/Edit targets the debug workspace (<cwd>/.magentra/debug/).
   * The repro-failed gate lets these through before any failing run so the model
   * can create and refine the oracle script itself. Reads `file_path`
   * structurally (this module must not depend on @magentra/tools).
   */
  private isDebugScriptWrite(toolName: string, input: unknown): boolean {
    if (toolName !== "Write" && toolName !== "Edit") return false;
    if (typeof input !== "object" || input === null) return false;
    const filePath = (input as Record<string, unknown>).file_path;
    if (typeof filePath !== "string") return false;
    const debugRoot = resolve(this.cwd, DEBUG_DIR);
    const target = resolve(this.cwd, filePath);
    return target === debugRoot || target.startsWith(debugRoot + sep);
  }

  /**
   * Reuse gate for a Write call. Reads `file_path`/`content` structurally (this
   * module must not depend on @magentra/tools) and delegates to the pure
   * evaluator. Fails open on any throw — the gate must never break a Write.
   */
  private evaluateWriteReuseGate(input: unknown): ReuseGateResult {
    if (typeof input !== "object" || input === null) return { kind: "pass" };
    const rec = input as Record<string, unknown>;
    const filePath = rec.file_path;
    const content = rec.content;
    if (typeof filePath !== "string" || typeof content !== "string") return { kind: "pass" };
    try {
      return evaluateReuseGate(
        this.cwd,
        filePath,
        content,
        this.settings.reuseCheck,
        this.searchLog,
        (p) => this.fileState.wasRead(p),
        this.reuseBlocked,
        () => this.loadSymbolIndex(),
        this.planFile,
      );
    } catch {
      return { kind: "pass" };
    }
  }

  /** The workspace symbol index: built (and persisted) once, then refreshed incrementally per gate check. */
  private loadSymbolIndex(): SymbolIndexData {
    this.symbolIndexCache = this.symbolIndexCache
      ? buildSymbolIndex(this.cwd, this.symbolIndexCache)
      : loadOrBuildSymbolIndex(this.cwd);
    return this.symbolIndexCache;
  }

  private withReminders(blocks: ContentBlock[]): ContentBlock[] {
    if (this.reminders.length === 0) return blocks;
    const text = this.reminders.splice(0).map(wrapReminder).join("\n");
    return [...blocks, { type: "text", text }];
  }

  private pushMessage(msg: Msg): void {
    this.messages.push(msg);
    this.transcript.append({ kind: "message", message: msg });
  }

  /** Summarize the oldest span when the context estimate crosses the threshold. */
  async maybeCompact(force = false): Promise<boolean> {
    const window = contextWindowFor(this.settings.model, this.settings);
    const threshold = window * this.settings.compactionThreshold;
    if (!force && this.stats.contextTokens < threshold) return false;

    // Keep the most recent messages (a shorter tail under /compact force, so a
    // small history can still be squeezed), but never split a tool_use from
    // its tool_result: a tail that opens with tool_results whose tool_use was
    // summarized away is a history every provider rejects, bricking the
    // session. Tool pairs are adjacent, so walking the boundary back to a
    // message with no tool_result blocks guarantees each pair lands whole.
    let splitIdx = this.messages.length - (force ? 2 : 6);
    while (splitIdx > 0 && this.messages[splitIdx]!.content.some((b) => b.type === "tool_result")) {
      splitIdx--;
    }
    if (splitIdx <= 0) return false;
    const head = this.messages.slice(0, splitIdx);
    const tail = this.messages.slice(splitIdx);

    const before = this.stats.contextTokens;
    const summaryText = await this.summarizeForCompaction(head);

    const summaryMessage =
      `<system-reminder>Earlier conversation was compacted. Summary of the compacted span:\n\n${summaryText}\n\nContinue the work; do not wrap up early on account of the compaction.</system-reminder>`;
    this.messages = [{ role: "user", content: [{ type: "text", text: summaryMessage }] }, ...tail];
    this.transcript.append({ kind: "compaction", replacedCount: head.length, summary: summaryMessage });
    // The window was just emptied; the next response reports its true new size.
    // (Cost/usage totals stay — compaction does not un-bill what was spent.)
    this.stats.contextTokens = 0;
    // An automatic (threshold) compaction must not be silent — mid-turn it
    // would otherwise look like the agent quietly forgot the conversation.
    if (!force) {
      this.emit({
        type: "command_output",
        text: `🗜 context compacted automatically (${before} tokens — over ${Math.round(this.settings.compactionThreshold * 100)}% of the ${window}-token window)`,
      });
    }
    return true;
  }

  /**
   * Summarizes the compacted head, chunking the input so the summary call can
   * never itself overflow the summarizer's window: each chunk is folded into a
   * rolling summary that carries forward what earlier chunks established.
   */
  private async summarizeForCompaction(head: Msg[]): Promise<string> {
    // ~4 chars/token: keep each summarizer prompt well inside even a small
    // (128k-token) window, leaving room for the rolling summary + reply.
    const MAX_CHUNK_CHARS = 200_000;
    const serialized = head.map((m) => serializeForSummary([m]));
    const chunks: string[] = [];
    let current = "";
    for (const piece of serialized) {
      // A single oversized message still becomes its own (hard-sliced) chunk.
      if (current && current.length + piece.length > MAX_CHUNK_CHARS) {
        chunks.push(current);
        current = "";
      }
      current += (current ? "\n" : "") + piece;
      while (current.length > MAX_CHUNK_CHARS) {
        chunks.push(current.slice(0, MAX_CHUNK_CHARS));
        current = current.slice(MAX_CHUNK_CHARS);
      }
    }
    if (current) chunks.push(current);

    let summary = "";
    for (const chunk of chunks) {
      const input = summary
        ? `Summary of the conversation so far:\n${summary}\n\nNext span of the conversation:\n${chunk}`
        : chunk;
      summary = await this.runSummarizer(input);
    }
    return summary;
  }

  private async runSummarizer(text: string): Promise<string> {
    const summarySignal = new AbortController().signal;
    let summaryText = "";
    const stream = this.provider.stream({
      model: this.settings.smallModel ?? this.settings.model,
      system:
        "Summarize this coding-agent conversation so work can continue seamlessly in a fresh context. Structure the summary as: 1) task state and goal, 2) decisions made and why, 3) files read or modified (with paths), 4) open items and next steps. Be specific; keep every detail a continuation would need.",
      messages: [{ role: "user", content: [{ type: "text", text }] }],
      tools: [],
      maxTokens: 2000,
      signal: summarySignal,
    });
    for await (const event of stream) {
      if (event.type === "text_delta") summaryText += event.text;
    }
    return summaryText;
  }
}

/** Sentinel returned when a subagent finished without any assistant text (e.g. it errored out). */
const NO_SUBAGENT_TEXT = "(the subagent produced no text output)";

/** Concatenated text blocks of the session's last assistant message with text. */
function finalAssistantText(session: Session): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]!;
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.trim()) return text;
  }
  return NO_SUBAGENT_TEXT;
}

/** Total length of the text blocks in an assistant message (used to detect a bare give-up). */
function assistantTextLength(msg: Msg): number {
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .reduce((sum, b) => sum + b.text.length, 0);
}

/** Builds the incomplete-task nudge text listing each pending/in-progress task. */
function incompleteTasksNudgeText(tasks: TaskItem[]): string {
  const lines = tasks.map((t) => `- #${t.id} ${t.subject} (${t.status})`).join("\n");
  return `<system-reminder>The turn is ending but these tasks are not completed:\n${lines}\nFinish them (marking each completed via TaskUpdate only when actually done), or explicitly state why they cannot be completed.</system-reminder>`;
}

/** debug.ma: the verify nudge fired when the repro failed but was never seen passing again this turn. */
function debugVerifyNudgeText(reproPath: string): string {
  return `<system-reminder>The repro script has not been observed passing since it failed. Rerun ${reproPath} now and report the result — or state plainly that the fix is UNVERIFIED.</system-reminder>`;
}

/** Folds an active mode's wrap-up checklist and the atlas/standards nudges into the wrap-up nudge. */
function wrapupNudgeText(checklist: string, mentionAtlas = false, mentionStandards = false): string {
  let text = WRAPUP_NUDGE_TEXT;
  if (checklist) {
    text = text.replace("</system-reminder>", `\nAlso check:\n${checklist}</system-reminder>`);
  }
  if (mentionAtlas) {
    text = text.replace(
      "</system-reminder>",
      `\nIf any module or public interface changed, update .magentra/ATLAS.md to match.</system-reminder>`,
    );
  }
  if (mentionStandards) {
    text = text.replace(
      "</system-reminder>",
      `\nConfirm the diff complies with STANDARDS.md — name any deviation and why.</system-reminder>`,
    );
  }
  return text;
}

function wrapReminder(text: string): string {
  return text.trimStart().startsWith("<system-reminder>")
    ? text
    : `<system-reminder>${text}</system-reminder>`;
}

/** A short host label for provider-error messages: the endpoint's hostname,
 * or "anthropic" for the Anthropic provider. Best-effort — never throws. */
function providerHost(settings: Settings): string | undefined {
  if (settings.provider === "anthropic") return "anthropic";
  if (!settings.baseUrl) return undefined;
  try {
    return new URL(settings.baseUrl).host;
  } catch {
    return undefined;
  }
}

function safeParse(json: string): unknown {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return { __unparseable_input: json };
  }
}

function truncateResult(result: ToolResult, limit: number): ToolResult {
  if (typeof result.content !== "string") return result;
  const bytes = Buffer.byteLength(result.content, "utf8");
  if (bytes <= limit) return result;
  const buf = Buffer.from(result.content, "utf8");
  const half = Math.floor(limit / 2);
  const contentStr =
    buf.subarray(0, half).toString("utf8") +
    `\n\n[truncated: output was ${bytes} bytes, showing first and last ${half}]\n\n` +
    buf.subarray(bytes - half).toString("utf8");
  return { content: contentStr, ...(result.isError !== undefined ? { isError: result.isError } : {}) };
}

function preview(result: ToolResult): string {
  const text =
    typeof result.content === "string"
      ? result.content
      : result.content.map((p) => (p.type === "text" ? (p.text ?? "") : "[image]")).join(" ");
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}

function serializeForSummary(messages: Msg[]): string {
  return messages
    .map((m) => {
      const parts = m.content.map((b) => {
        switch (b.type) {
          case "text":
            return b.text;
          case "thinking":
            return "";
          case "tool_use":
            return `[tool call ${b.name}: ${JSON.stringify(b.input).slice(0, 300)}]`;
          case "tool_result": {
            const c = typeof b.content === "string" ? b.content : "[non-text result]";
            return `[tool result: ${c.slice(0, 500)}]`;
          }
        }
      });
      return `${m.role.toUpperCase()}: ${parts.filter(Boolean).join("\n")}`;
    })
    .join("\n\n");
}

function subjectOf(req: PermissionRequestPayload): string | undefined {
  return typeof req.input === "object" && req.input !== null && "command" in req.input
    ? String((req.input as { command: unknown }).command)
    : undefined;
}
