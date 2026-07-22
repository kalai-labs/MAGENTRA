import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  PROTOCOL_VERSION,
  STATE_DIR_NAME,
  type CoreEvent,
  type FrontendRequest,
  type PermissionDecision,
  type RestoredMessage,
  type SessionSummary,
  type SlashCommandInfo,
} from "@magentra/protocol";
import type { ContentBlock, Msg, Provider } from "@magentra/providers";
import { AsyncQueue } from "../util/asyncQueue.js";
import { CronScheduler } from "../scheduling/cron.js";
import { HookRunner } from "../agent/hooks.js";
import { BUILTIN_SKILL_FILES, loadModes, ModeEngine, parseSkillMd } from "../ma/modes.js";
import { parseFrontmatter } from "../config/frontmatter.js";
import { loadSkills } from "../agent/skills.js";
import { loadAtlas } from "../knowledge/atlas.js";
import { buildDebugHeader } from "../ma/debug.js";
import { buildCrewPrompt, loadTeam, type CrewAgent } from "../crew/team.js";
import { LAB_FILE_NAME, compileLab, findLabFile, parseLabFile, snapshotLab } from "../lab.js";
import {
  MISSION_FILE_FORMAT,
  buildMissionPrompt,
  loadContinuousState,
  loadMissions,
  missionDeliverablePath,
  missionTemplate,
  saveContinuousState,
  type Mission,
} from "../scheduling/missions.js";
import { buildBackpack } from "../knowledge/backpack/build.js";
import { createEmbedder, type Embedder } from "../knowledge/backpack/embed.js";
import { docKey, loadBackpackIndex, sha256 } from "../knowledge/backpack/index.js";
import { loadExperience } from "../crew/experience.js";
import { exportCrewPack, hireCrewPack } from "../crew/pack.js";
import { formatLedgerEntry, loadLedger } from "../crew/ledger.js";
import { exportTeamPack, hireTeamPack } from "../crew/teamPack.js";
import {
  createProviderForEndpoint,
  endpointKey,
  resolveCrewEndpoint,
  type EndpointSpec,
} from "../crew/providerFactory.js";
import { readRecord, summarizeRecord, verifyRecordChain } from "../crew/serviceRecord.js";
import { Session } from "./session.js";
import { SessionStats } from "./sessionStats.js";
import {
  DEFAULT_OPENAI_BASE_URL,
  describeSettings,
  resolveApiKey,
  setSetting,
  setSettingPath,
  settingsSchema,
  type Settings,
} from "../config/settings.js";
import { MODEL_PRICING, contextWindowFor, pricingFor } from "../config/pricing.js";
import type { Skill } from "../agent/skills.js";
import type { ToolRegistry } from "../agent/tool.js";
import { Transcript } from "../state/transcript.js";

/** When a just-persisted setting takes effect, relative to the running session. */
type SettingTiming = "session" | "nextTurn" | "backpackRebuild" | "restart" | "clear";

/** The human-readable note reported for each timing after `/settings <key> <value>`. */
const SETTING_TIMING_NOTE: Record<SettingTiming, string> = {
  session: "Applied to the current session.",
  nextTurn: "Takes effect on the next turn.",
  backpackRebuild: "Takes effect on the next backpack rebuild.",
  restart: "Takes effect after restarting magentra.",
  clear: "Takes effect after /clear (new session).",
};

/**
 * When each top-level setting takes effect. Keyed by `keyof settingsSchema.shape`
 * so tsc forces this map to stay exhaustive: add a schema key without a timing
 * entry and this file fails to typecheck (see the exhaustiveness test too). This
 * is the single source of truth — the old divorced live/restart Sets rotted
 * silently when a new key fell through to the wrong default.
 *   session         — pushed into the live session immediately (see applySettingLive)
 *   nextTurn        — the running session re-reads it at the start of the next turn
 *   backpackRebuild — picked up on the next backpack (re)build
 *   restart         — wired outside the Engine (provider, hooks, MCP); only a restart reads it
 *   clear           — a fresh session via /clear picks it up
 */
export const SETTING_TIMING: Record<keyof typeof settingsSchema.shape, SettingTiming> = {
  provider: "restart",
  model: "nextTurn",
  smallModel: "nextTurn",
  baseUrl: "restart",
  apiKeyEnv: "restart",
  apiKey: "restart",
  maxTokensPerResponse: "nextTurn",
  maxTokensPerTurn: "nextTurn",
  maxIterationsPerTurn: "nextTurn",
  contextWindow: "nextTurn",
  retention: "session",
  // Rates are read at report time (/session, status bar), so a new price applies
  // to the whole session's accumulated usage the moment it is set.
  pricing: "session",
  clarify: "nextTurn",
  permissions: "clear",
  hooks: "restart",
  mcpServers: "restart",
  worktree: "clear",
  search: "nextTurn",
  embeddings: "backpackRebuild",
  modes: "clear",
  allowInsecureTls: "restart",
  reuseCheck: "clear",
};

export interface EngineOptions {
  cwd: string;
  settings: Settings;
  provider: Provider;
  registry: ToolRegistry;
  skills?: Skill[];
  /**
   * Constructs the Provider for a crew member's dedicated endpoint (team-file
   * provider/baseurl/apikeyenv). Defaults to the real factory; injectable so
   * tests hand out FakeProviders without touching the network.
   */
  providerFactory?: (spec: EndpointSpec) => Provider;
}

/**
 * The in-process protocol endpoint. Frontends (terminal REPL, stdio server,
 * future IDE) consume `events` and call `send()` — nothing else. If the CLI
 * can do it, it goes through here.
 */
export class Engine {
  /**
   * The outbound event stream — SINGLE-CONSUMER by design. Exactly one
   * `for await` loop may drain it for the Engine's lifetime: AsyncQueue hands
   * each event to whichever waiter asked first, so a second concurrent
   * consumer (or a reconnect that leaves the old loop alive) silently steals
   * events from the first. An embedder that must fan out to several sinks
   * should read the queue once and re-broadcast itself.
   */
  readonly events = new AsyncQueue<CoreEvent>();
  private session: Session;
  private readonly pendingPermissions = new Map<
    string,
    (res: { decision: PermissionDecision; message?: string }) => void
  >();
  /**
   * In-flight AskUserQuestion rounds. A frontend may answer a multi-question
   * round one card at a time, so answers accumulate here and the tool's promise
   * only resolves once every question has one — otherwise the first card
   * answered would settle the round and the rest would report "(no answer)".
   */
  private readonly pendingQuestions = new Map<
    string,
    { resolve: (answers: Record<string, string[]>) => void; expected: number; answers: Record<string, string[]> }
  >();
  /** Chain of ALL outstanding exclusive work (turns, /compact, /build-crew); idle() awaits it. */
  private turnPromise: Promise<void> = Promise.resolve();
  /** True while exclusive session work is in flight — set synchronously so a same-tick send is refused. */
  private busy = false;
  /** True while a background atlas build is in flight; a second /atlas is refused, not queued. */
  private atlasBuilding = false;
  private readonly scheduler: CronScheduler;
  private readonly hookRunner: HookRunner;
  private modeEngine!: ModeEngine;
  private modeWarnings: string[] = [];
  /**
   * Engine-level memory of the OVERDRIVE toggle so a /clear-created fresh
   * session inherits it — the UI persists the state and re-sends it on link,
   * but the engine must not lose it between those two moments.
   */
  private overdriveEnabled = false;
  private team: CrewAgent[];
  private teamWarnings: string[];
  /** Agent ids with a backpack build currently in flight (dedupes launches). */
  private readonly backpackBuilding = new Set<string>();
  /** The anthropic-without-embeddings-endpoint warning fired (once per engine). */
  private embedderWarned = false;
  /** `!` commands received mid-turn, run in order once the engine goes idle. */
  private readonly pendingBangs: string[] = [];
  /** One Provider per distinct crew endpoint, shared across spawns and sessions. */
  private readonly crewProviders = new Map<string, Provider>();

  constructor(private readonly opts: EngineOptions) {
    this.scheduler = new CronScheduler({
      stateDir: join(this.opts.cwd, STATE_DIR_NAME),
      isIdle: () => !this.session.isBusy(),
      // A scheduled prompt that reads as a slash command routes as one (this is
      // how a scheduled mission re-reads its file at fire time); anything else
      // starts a plain user turn. Scheduler-fired work is UNATTENDED: nobody is
      // at the keyboard, so mission runs must never block on approval prompts.
      enqueue: (prompt) => {
        const slash = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
        if (slash) this.handleSlash(slash[1]!, slash[2], { unattended: true });
        else this.send({ type: "user_message", text: prompt });
      },
    });
    this.hookRunner = new HookRunner({ cwd: this.opts.cwd, hooks: this.opts.settings.hooks });
    const team = loadTeam(this.opts.cwd);
    this.team = team.agents;
    this.teamWarnings = team.warnings;
    this.session = this.createSession();
  }

  private emit = (event: CoreEvent): void => {
    this.events.push(event);
  };

  private createSession(
    sessionId?: string,
    initialMessages?: Session["messages"],
    stats?: SessionStats,
  ): Session {
    // SETTING_TIMING.modes says "clear": rebuild the ModeEngine per session so
    // a modes.active change (or an edited .ma file) actually lands on the next
    // /clear instead of silently requiring a restart.
    const { modes, warnings } = loadModes(this.opts.cwd);
    this.modeWarnings = warnings;
    this.modeEngine = new ModeEngine(modes, this.opts.settings.modes.active);
    const session = new Session({
      cwd: this.opts.cwd,
      settings: this.opts.settings,
      provider: this.opts.provider,
      registry: this.opts.registry,
      emit: this.emit,
      requestApproval: (req) =>
        new Promise((resolve) => {
          this.pendingPermissions.set(req.id, resolve);
          this.emit({
            type: "permission_request",
            id: req.id,
            tool: req.tool,
            input: req.input,
            ...(req.description !== undefined ? { description: req.description } : {}),
            ...(req.subject !== undefined ? { subject: req.subject } : {}),
            ...(req.grant !== undefined ? { grant: req.grant } : {}),
          });
        }),
      askUser: (id, questions) =>
        new Promise((resolve) => {
          const expected = Array.isArray(questions) ? questions.length : 1;
          this.pendingQuestions.set(id, { resolve, expected, answers: {} });
          this.emit({ type: "question_request", id, questions: questions as never });
        }),
      hookRunner: this.hookRunner,
      modeEngine: this.modeEngine,
      onTeamFilesChanged: () => this.reloadTeam(),
      crewProviderResolver: (agent) => this.resolveCrewProvider(agent),
      ...(this.team.length > 0 ? { team: this.team } : {}),
      ...(this.opts.skills ? { skills: this.opts.skills } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(initialMessages ? { initialMessages } : {}),
      ...(stats ? { stats } : {}),
    });
    session.services.cron = this.scheduler;
    if (this.overdriveEnabled) session.setOverdrive(true);
    return session;
  }

  /**
   * The crew-endpoint seam handed to every Session: resolves a member's
   * declared endpoint against the environment and caches one Provider per
   * distinct endpoint, so repeated CrewRun spawns reuse the same instance.
   */
  private resolveCrewProvider(agent: CrewAgent): { provider: Provider } | { warning: string } | undefined {
    const resolution = resolveCrewEndpoint(agent, this.opts.settings);
    if (resolution === undefined || "warning" in resolution) return resolution;
    const key = endpointKey(resolution.spec);
    let provider = this.crewProviders.get(key);
    if (!provider) {
      provider = (this.opts.providerFactory ?? createProviderForEndpoint)(resolution.spec);
      this.crewProviders.set(key, provider);
    }
    return { provider };
  }

  start(): void {
    this.announceSession();
    // Boot-only work below: /clear and /resume swap sessions via
    // announceSession() alone, so they never re-launch builds, re-arm
    // mission loops, or repeat the lab hint.
    this.publishModelCatalog();
    this.launchBackpackBuilds();
    this.rearmContinuousMissions();
    // A blueprint with no live crew is almost certainly waiting to be applied.
    if (this.team.length === 0 && findLabFile(this.opts.cwd)) {
      this.emit({ type: "command_output", text: `🧪 ${LAB_FILE_NAME} found — /lab load builds the whole lab from it.` });
    }
  }

  /**
   * Fetches the endpoint's real model catalog in the background and validates
   * the configured model against it: a typo'd model warns at startup, not on
   * the first turn. Best-effort — a catalog-less endpoint changes nothing.
   */
  private publishModelCatalog(): void {
    const provider = this.opts.provider;
    if (!provider.listModels) return;
    void provider
      .listModels()
      .then((models) => {
        if (models.length === 0) return;
        this.emit({ type: "model_catalog", models });
        if (!models.includes(this.opts.settings.model)) {
          this.emit({
            type: "error",
            message: `Model "${this.opts.settings.model}" is not in the endpoint's catalog (${models.length} models listed). Check the model id — the first turn will likely fail with a 404.`,
            fatal: false,
          });
        }
      })
      .catch(() => {
        // No catalog endpoint (or auth scope) — the picker keeps its defaults.
      });
  }

  /**
   * Everything a NEW current session must tell the frontend (and its
   * SessionStart hook). Shared by boot, /clear, and /resume.
   */
  private announceSession(): void {
    this.gcStateFiles();
    this.emit({
      type: "session_started",
      v: PROTOCOL_VERSION,
      commands: SLASH_COMMANDS.map(({ cmd, args, desc }) => ({ cmd, args, desc })),
      rateCard: buildRateCard(this.opts.settings),
      sessionId: this.session.id,
      cwd: this.opts.cwd,
      model: this.opts.settings.model,
      overdrive: this.session.isOverdrive(),
      skills: (this.opts.skills ?? []).map((s) => ({ name: s.name, description: s.description })),
    });
    this.emit({ type: "task_list_updated", tasks: this.session.tasks.list() });
    this.emitMissionsUpdated();
    // A tiny explicit contextWindow shadowing a model's real one causes
    // constant compaction (the 4096-on-a-160k-model trap). One storage, one
    // resolver — and a loud warning when the override looks like a leftover.
    const override = this.opts.settings.contextWindow;
    if (override !== undefined) {
      const modelWindow = contextWindowFor(this.opts.settings.model);
      if (override < modelWindow / 2) {
        this.emit({
          type: "error",
          message: `contextWindow is overridden to ${override} tokens, but ${this.opts.settings.model} supports ~${Math.round(modelWindow / 1000)}K — expect constant compaction. Clear it with /settings contextWindow auto (the override exists for local servers only).`,
          fatal: false,
        });
      }
    }
    for (const warning of this.modeWarnings) {
      this.emit({ type: "error", message: warning, fatal: false });
    }
    for (const warning of this.teamWarnings) {
      this.emit({ type: "error", message: warning, fatal: false });
    }
    this.emitModesUpdated();
    this.emitTeamUpdated();
    if (this.hookRunner.has("SessionStart")) {
      const session = this.session;
      void this.hookRunner
        .run("SessionStart", {
          hook_event_name: "SessionStart",
          session_id: session.id,
          cwd: this.opts.cwd,
        })
        .then((outcomes) => {
          const { contextText } = this.hookRunner.summarize(outcomes);
          if (contextText) session.addContextMessage(`<system-reminder>${contextText}</system-reminder>`);
        })
        .catch(() => {});
    }
  }

  /** Resolves when ALL outstanding exclusive work (turn, /compact, /build-crew) completes. */
  idle(): Promise<void> {
    return this.turnPromise;
  }

  /**
   * `/atlas` runs in the BACKGROUND, deliberately unlike /compact or /build-crew.
   * Mapping a codebase is a long fan-out of read-only agents, and it touches
   * nothing the session owns — it never appends to the conversation, it only
   * reads files and writes ATLAS.md at the end. So there is no reason to hold
   * the session hostage while it runs, and every reason not to: the whole point
   * of an atlas is to have one, and a user who must sit and wait will just stop
   * asking for it.
   *
   * Not chained onto {@link turnPromise}: idle() must not wait for it either, or
   * a frontend that disconnects would hang until the map finished. A second
   * /atlas while one is in flight is refused rather than queued — two builds
   * would race for the same file.
   */
  private startAtlasBuild(force: boolean): void {
    if (this.atlasBuilding) {
      this.emit({ type: "command_output", text: "🗺 an atlas build is already running." });
      return;
    }
    this.atlasBuilding = true;
    // Tell the frontend work has begun that is NOT tied to a turn, so it can
    // offer a stop for it. Without this the UI has no way to know the engine is
    // busy at all — turn_started never fires for a background build.
    this.emit({
      type: "background_notification",
      taskId: "atlas",
      kind: "start",
      payload: { description: "atlas build" },
    });
    const session = this.session;
    void session
      .buildAtlas(force)
      .catch((err: Error) => this.emit({ type: "error", message: `atlas build: ${err.message}`, fatal: false }))
      .finally(() => {
        this.atlasBuilding = false;
        // The build outlives the turn that started it, so the frontend needs a
        // signal that is not tied to a turn ending.
        this.emit({
          type: "background_notification",
          taskId: "atlas",
          kind: "exit",
          payload: { description: "atlas build" },
        });
      });
  }

  // ── Create-skill wizard ────────────────────────────────────────────────────

  /**
   * generate_skill: author a skill .md from the user's plain-language
   * description with a one-shot subagent, validate it with the real parser,
   * and retry with the error appended (up to 3 attempts) before giving up.
   * Emits skill_draft either way — the frontend previews the text or shows
   * the failure. Runs like the atlas build: backgrounded, stoppable, never
   * tied to a turn.
   */
  private skillGenBusy = false;

  private startSkillGeneration(description: string, kind: "discipline" | "action", opts: SkillGenOptions = {}): void {
    if (this.skillGenBusy) {
      this.emit({ type: "command_output", text: "🧩 a skill generation is already running." });
      return;
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      this.emit({ type: "skill_draft", ok: false, error: "Describe the skill first — the description was empty." });
      return;
    }
    this.skillGenBusy = true;
    this.emit({
      type: "background_notification",
      taskId: "skill-gen",
      kind: "start",
      payload: { description: "generating skill" },
    });
    void this.generateSkill(description.trim(), kind, opts)
      .then((draft) => this.emit({ type: "skill_draft", ...draft }))
      .catch((err: Error) => this.emit({ type: "skill_draft", ok: false, error: err.message }))
      .finally(() => {
        this.skillGenBusy = false;
        this.emit({
          type: "background_notification",
          taskId: "skill-gen",
          kind: "exit",
          payload: { description: "generating skill" },
        });
      });
  }

  private async generateSkill(
    description: string,
    kind: "discipline" | "action",
    opts: SkillGenOptions = {},
  ): Promise<{ ok: boolean; text?: string; suggestedFilename?: string; error?: string }> {
    const takenIds = this.modeEngine.list().map((m) => m.id);
    // Author with a different provider entirely when a profile connection was
    // passed (the app resolved it); otherwise use the session's own provider and
    // the chosen/default model.
    let authorProvider: Provider | undefined;
    let authorModel = opts.model ?? this.opts.settings.model;
    if (opts.connection) {
      authorProvider = createProviderForEndpoint({
        provider: opts.connection.provider === "anthropic" ? "anthropic" : "openai-compatible",
        apiKey: opts.connection.apiKey,
        ...(opts.connection.baseUrl ? { baseUrl: opts.connection.baseUrl } : {}),
      });
      authorModel = opts.connection.model || authorModel;
    }
    let feedback = "";
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      // A single completion — NOT an agentic explore loop. Authoring one small
      // file needs no tools; the old explore agent could spend minutes reading
      // workspace files and still return prose instead of a file. runInference
      // is one focused call, on the chosen model (defaulting to the session's
      // main model — skill authoring wants the capable model, not smallModel).
      const raw = await this.session.runInference({
        system: SKILL_AUTHOR_ROLE,
        user: buildSkillPrompt(description, kind, takenIds, opts) + feedback,
        maxTokens: 4096,
        model: authorModel,
        ...(authorProvider ? { provider: authorProvider } : {}),
      });
      const text = repairSkillText(raw);
      const check = this.validateSkillText(text, kind);
      if (check.ok) return { ok: true, text, suggestedFilename: check.filename };
      lastError = check.error;
      feedback = `\n\nYour previous attempt was rejected by the validator:\n${check.error}\nReturn ONLY the corrected file, starting with the "---" line — no sentence before it.`;
    }
    return { ok: false, error: `Generation failed validation after 3 attempts: ${lastError}` };
  }

  /** Validates a candidate skill text for its kind; returns the suggested filename on success. */
  private validateSkillText(
    text: string,
    kind: "discipline" | "action",
  ): { ok: true; filename: string } | { ok: false; error: string } {
    const fm = parseFrontmatter(text);
    if (!fm.present) return { ok: false, error: "the file must open with --- frontmatter" };
    const declaredKind = (fm.map.kind ?? "action").trim();
    if (kind === "discipline" && declaredKind !== "discipline") {
      return { ok: false, error: 'a discipline skill must declare "kind: discipline" in the frontmatter' };
    }
    if (kind === "action" && declaredKind === "discipline") {
      return { ok: false, error: 'an action skill must not declare "kind: discipline"' };
    }
    const slugSource = fm.map.id ?? fm.map.name ?? "";
    const slug = slugSource
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug || !/^[a-z]/.test(slug)) {
      return { ok: false, error: "frontmatter needs a name: (or id:) that yields a [a-z][a-z0-9_-]* slug" };
    }
    if (kind === "discipline") {
      try {
        parseSkillMd(text, "workspace", slug);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    } else {
      if (!fm.map.name || !fm.map.description) {
        return { ok: false, error: "an action skill needs name: and description: frontmatter keys" };
      }
      if (fm.body.trim().length === 0) return { ok: false, error: "the Markdown body (the procedure) is empty" };
    }
    return { ok: true, filename: `${slug}.md` };
  }

  /**
   * install_skill: re-validate (never trust a stale draft), write into
   * .magentra/skills/, reload both skill kinds in place so the live session
   * sees them, auto-enable a discipline, and re-emit the updated lists.
   */
  private installSkill(filename: string, text: string): void {
    if (!/^[a-z][a-z0-9_-]*\.md$/.test(filename)) {
      this.emit({ type: "error", message: `install_skill: filename "${filename}" must match <slug>.md`, fatal: false });
      return;
    }
    const kind = (parseFrontmatter(text).map.kind ?? "action").trim() === "discipline" ? "discipline" : "action";
    const check = this.validateSkillText(text, kind);
    if (!check.ok) {
      this.emit({ type: "error", message: `install_skill: ${check.error}`, fatal: false });
      return;
    }
    const dir = join(this.opts.cwd, ".magentra", "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), text.endsWith("\n") ? text : text + "\n");

    // Reload both kinds. The action-skill array mutates in place so the live
    // session's captured reference picks the new skill up on its next request.
    const reloaded = loadModes(this.opts.cwd);
    for (const warning of reloaded.warnings) {
      this.emit({ type: "command_output", text: `⚠ ${warning}` });
    }
    this.modeEngine.replaceModes(reloaded.modes);
    const actions = loadSkills(this.opts.cwd);
    if (this.opts.skills) {
      this.opts.skills.length = 0;
      this.opts.skills.push(...actions);
    } else {
      this.opts.skills = actions;
    }
    this.emit({ type: "skills_updated", skills: actions.map((s) => ({ name: s.name, description: s.description })) });

    const id = filename.slice(0, -3);
    if (kind === "discipline") {
      const active = this.modeEngine.list().filter((m) => m.active).map((m) => m.id);
      this.applyModes([...new Set([...active, id])]);
      this.emit({ type: "command_output", text: `🧩 installed and enabled the ${id} skill (.magentra/skills/${filename})` });
    } else {
      this.emitModesUpdated();
      this.emit({ type: "command_output", text: `🧩 installed the ${id} skill (.magentra/skills/${filename}) — the agent can now invoke it on demand` });
    }
  }

  /**
   * export_skill: hand the app a skill's .md text so it can save it anywhere.
   * A workspace file wins (it may be a customized override); otherwise the
   * built-in's shipped text — so every skill in the list can be exported, not
   * just user-authored ones.
   */
  private exportSkill(id: string): void {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      this.emit({ type: "skill_export", ok: false, id: String(id), error: "invalid skill id" });
      return;
    }
    const dir = join(this.opts.cwd, ".magentra", "skills");
    for (const rel of [`${id}.md`, join(id, "SKILL.md")]) {
      const p = join(dir, rel);
      try {
        if (statSync(p).isFile()) {
          this.emit({ type: "skill_export", ok: true, id, filename: `${id}.md`, text: readFileSync(p, "utf8") });
          return;
        }
      } catch {
        // not this candidate — try the next / fall through to built-ins
      }
    }
    const builtin = BUILTIN_SKILL_FILES.find((b) => b.id === id);
    if (builtin) {
      this.emit({ type: "skill_export", ok: true, id, filename: `${id}.md`, text: builtin.text });
      return;
    }
    this.emit({ type: "skill_export", ok: false, id, error: `no source found for skill "${id}"` });
  }

  /**
   * The single seam for starting exclusive session work — a user turn, /compact,
   * or /build-crew. Two invariants it exists to hold:
   *   1. Exclusive work never overlaps a running turn: if the session is mid-turn
   *      (or another exclusive job is in flight) it refuses with a command_output
   *      and returns false, so callers do nothing further.
   *   2. idle() never forgets in-flight work: the new job is chained onto
   *      {@link turnPromise} (never overwrites it), so a shutdown/test awaiting
   *      idle() waits for this job too. `busy` flips synchronously so a second
   *      send in the same tick sees it and is refused.
   */
  private startExclusive(label: string, work: () => Promise<void>): boolean {
    if (this.busy || this.session.isBusy()) {
      this.emit({
        type: "command_output",
        text: `⏳ busy — wait for the current turn to finish before ${label}.`,
      });
      return false;
    }
    this.busy = true;
    this.turnPromise = this.turnPromise
      .then(() => work())
      .catch((err: Error) => this.emit({ type: "error", message: err.message, fatal: false }))
      .finally(() => {
        this.busy = false;
        this.gcStateFiles();
        this.flushPendingBangs();
        void this.maybeAutoNameSession();
      });
    return true;
  }

  /**
   * After a turn settles, give a still-unnamed but now-substantial session an
   * auto-generated title (see {@link Session.maybeAutoName}). Persisted to the
   * transcript meta and broadcast via `session_list`, exactly like a manual
   * rename, so the sidebar updates. Best-effort and fire-and-forget: any failure
   * is swallowed and a manual name always wins (the session's own guard skips
   * naming once a label exists).
   */
  private async maybeAutoNameSession(): Promise<void> {
    try {
      const label = await this.session.maybeAutoName();
      if (!label) return;
      this.session.transcript.append({
        kind: "meta",
        data: { ...(Transcript.latestMeta(this.session.transcript.file) ?? {}), label },
      });
      this.emit({ type: "session_list", sessions: this.listSessions() });
      this.emit({
        type: "command_output",
        text: `✎ Named this chat “${label}”. Rename it anytime by clicking its name in the sidebar.`,
      });
    } catch {
      // Naming is a nicety — never let it disrupt the session.
    }
  }

  currentSession(): Session {
    return this.session;
  }

  send(request: FrontendRequest): void {
    switch (request.type) {
      case "user_message":
        this.startExclusive("sending another message", () => this.session.runTurn(request.text));
        break;
      case "steer_message":
        // The frontend saw a busy turn; if it ended in the meantime, the
        // steering text is just the next user message.
        if (this.session.isBusy()) this.session.steer(request.text);
        else this.startExclusive("sending another message", () => this.session.runTurn(request.text));
        break;
      case "permission_response": {
        const resolve = this.pendingPermissions.get(request.id);
        if (resolve) {
          this.pendingPermissions.delete(request.id);
          resolve({ decision: request.decision, ...(request.message !== undefined ? { message: request.message } : {}) });
        }
        break;
      }
      case "question_response": {
        const pending = this.pendingQuestions.get(request.id);
        if (pending) {
          Object.assign(pending.answers, request.answers);
          // Positional keys ("q:<idx>") are the contract; a frontend that
          // answers the whole round in one frame (including older ones keyed
          // by question text) satisfies the count check instead.
          const positional = Array.from({ length: pending.expected }, (_, i) => `q:${i}`);
          const complete =
            positional.every((key) => key in pending.answers) ||
            Object.keys(pending.answers).length >= pending.expected;
          if (complete) {
            this.pendingQuestions.delete(request.id);
            pending.resolve(pending.answers);
          }
        }
        break;
      }
      case "interrupt": {
        // HARD STOP. Everything in flight, not just the turn: the session cuts
        // the turn, every subagent, any background atlas build, and every
        // background job.
        const wasBusy = this.busy || this.session.isBusy();
        const wasMapping = this.atlasBuilding;
        this.session.interrupt();
        // A half-answered question round would otherwise wait forever for the
        // cards the user is no longer going to fill in. Settle it with whatever
        // was collected; the tool reports "(no answer)" for the rest.
        for (const [id, pending] of this.pendingQuestions) {
          this.pendingQuestions.delete(id);
          pending.resolve(pending.answers);
        }
        // Say what was actually stopped — a stop button that reports nothing
        // leaves the user unsure whether it worked.
        const stopped = [wasBusy ? "turn" : "", wasMapping ? "atlas build" : ""].filter(Boolean);
        this.emit({
          type: "command_output",
          text: stopped.length > 0 ? `⏹ stopped: ${stopped.join(", ")}.` : "⏹ nothing was running.",
        });
        break;
      }
      case "set_overdrive":
        this.overdriveEnabled = request.enabled;
        this.session.setOverdrive(request.enabled);
        break;
      case "set_model":
        this.handleSetModel(request.model);
        break;
      case "set_compact_limit":
        this.session.setAutoCompactLimit(request.limit);
        break;
      case "set_deletion_guard":
        this.session.setDeletionPolicy(!request.enabled);
        this.emit({
          type: "command_output",
          text: request.enabled
            ? "deletion guard on — destructive calls always ask"
            : "deletion guard off — deletions are allowed",
        });
        break;
      case "slash_command":
        // The wire type declares args as a string, but a buggy frontend that
        // sends an array (a natural-looking shape for CLI args) would otherwise
        // surface as a bare "args?.trim is not a function" TypeError from deep
        // inside whichever handler runs first. Reject malformed input here,
        // once, with a message that names the fix.
        if (typeof request.command !== "string" || (request.args !== undefined && typeof request.args !== "string")) {
          this.emit({
            type: "error",
            message: `slash_command requires a string command and (optionally) a single string args — got command: ${typeof request.command}, args: ${Array.isArray(request.args) ? "array" : typeof request.args}. Join multiple arguments into one space-separated string.`,
            fatal: false,
          });
          break;
        }
        this.handleSlash(request.command, request.args);
        break;
      case "bang_command":
        this.handleBang(request.cmd);
        break;
      case "list_sessions":
        this.emit({ type: "session_list", sessions: this.listSessions() });
        break;
      case "resume_session":
        this.resumeSession(request.id);
        break;
      case "delete_session":
        this.deleteSession(request.id);
        break;
      case "rename_session":
        this.renameSession(request.id, request.label);
        break;
      case "archive_session":
        this.archiveSession(request.id);
        break;
      case "stop_background": {
        const stopped = this.session.background.stop(request.taskId);
        this.emit({
          type: "command_output",
          text: stopped
            ? `⏹ background task ${request.taskId} stopped.`
            : `No running background task "${request.taskId}".`,
        });
        break;
      }
      case "set_modes":
        this.applyModes(request.active);
        break;
      case "reload_team":
        this.reloadTeam();
        break;
      case "generate_skill":
        this.startSkillGeneration(request.description, request.kind, {
          ...(request.model ? { model: request.model } : {}),
          ...(request.context ? { context: request.context } : {}),
          ...(request.enforce ? { enforce: request.enforce } : {}),
          ...(request.connection ? { connection: request.connection } : {}),
        });
        break;
      case "install_skill":
        this.installSkill(request.filename, request.text);
        break;
      case "export_skill":
        this.exportSkill(request.id);
        break;
      default:
        // The wire accepts any {type: string} object, so an unknown type can
        // arrive at runtime despite the exhaustive union above. Answer it —
        // a silently dropped frame is undebuggable from the frontend side.
        this.emit({
          type: "error",
          message: `Unknown request type "${(request as { type?: unknown }).type}"`,
          fatal: false,
        });
        break;
    }
  }

  private emitModesUpdated(): void {
    this.emit({ type: "modes_updated", modes: this.modeEngine.list() });
  }

  /**
   * The single toggle path for discipline skills, shared by the desktop's
   * `set_modes` request and the terminal's `/skills` command. Applies the
   * desired active set through the ModeEngine (nothing is locked; `conflicts:`
   * resolved most-recent-wins), surfaces every advisory message as
   * command_output, and re-emits modes_updated so all frontends stay in sync.
   * Session-only: the active set lives in memory and is never written to
   * settings.
   */
  private applyModes(active: string[]): string[] {
    const { messages } = this.modeEngine.setActive(active);
    for (const text of messages) this.emit({ type: "command_output", text });
    this.emitModesUpdated();
    return messages;
  }

  private emitTeamUpdated(): void {
    // Depth per card: spend, lessons, and verified work — the same sources
    // /crew reads, so a card answers "what has this member done and cost".
    const ledger = loadLedger(this.opts.cwd);
    this.emit({
      type: "team_updated",
      agents: this.team.map((a) => {
        const lessons = loadExperience(this.opts.cwd, a.id).lessons;
        const spend = ledger.members[a.id];
        return {
          id: a.id,
          name: a.name,
          role: a.role,
          ...(a.model !== undefined ? { model: a.model } : {}),
          ...(a.provider !== undefined ? { provider: a.provider } : {}),
          ...(a.baseUrl !== undefined ? { baseUrl: a.baseUrl } : {}),
          ...(a.emoji !== undefined ? { emoji: a.emoji } : {}),
          ...(a.color !== undefined ? { color: a.color } : {}),
          docCount: a.docs.length,
          docs: a.docs,
          ready: this.isBackpackReady(a),
          ...(spend ? { spend: formatLedgerEntry(spend) } : {}),
          lessonsPromoted: lessons.filter((l) => l.status === "promoted").length,
          lessonsCandidate: lessons.filter((l) => l.status === "candidate").length,
          tasksCompleted: summarizeRecord(readRecord(this.opts.cwd, a.id)).tasksCompleted,
        };
      }),
    });
  }

  /** Reload the crew from disk, update the live session roster, re-emit, and (re)launch backpack builds. */
  private reloadTeam(): void {
    const team = loadTeam(this.opts.cwd);
    this.team = team.agents;
    this.teamWarnings = team.warnings;
    for (const warning of team.warnings) {
      this.emit({ type: "error", message: warning, fatal: false });
    }
    this.session.setTeam(this.team);
    this.emitTeamUpdated();
    this.launchBackpackBuilds();
  }

  /** A backpack is ready when a distilled brief exists, or every doc reached at least the "noted" phase. */
  private isBackpackReady(agent: CrewAgent): boolean {
    if (agent.docs.length === 0) return false;
    const index = loadBackpackIndex(this.opts.cwd, agent.id);
    if (!index) return false;
    if (index.brief !== undefined) return true;
    return agent.docs.every((rel) => {
      const meta = index.docs[docKey(rel)];
      return meta !== undefined && (meta.phase === "noted" || meta.phase === "embedded");
    });
  }

  /** True when an agent's on-disk backpack is missing, stale (changed doc), or incomplete. */
  private needsBackpackBuild(agent: CrewAgent): boolean {
    if (agent.docs.length === 0) return false;
    const index = loadBackpackIndex(this.opts.cwd, agent.id);
    if (!index) return true;
    if (index.brief === undefined) return true;
    for (const rel of agent.docs) {
      let buf: Buffer;
      try {
        buf = readFileSync(join(this.opts.cwd, rel));
      } catch {
        continue; // a missing document cannot be (re)built — don't loop forever on it
      }
      if (index.docs[docKey(rel)]?.sha256 !== sha256(buf)) return true;
    }
    if (
      this.opts.settings.embeddings.enabled &&
      index.embeddings === undefined &&
      index.embeddingsAttempted === undefined &&
      index.chunks.length > 0
    ) {
      return true;
    }
    return false;
  }

  /** Launch one background backpack build per agent whose index is stale/incomplete. */
  private launchBackpackBuilds(): void {
    const settings = this.opts.settings;
    const apiKey = resolveApiKey(settings);
    // An Anthropic session without an explicit baseUrl has no OpenAI-compatible
    // embeddings endpoint — building against the DeepInfra default would send
    // the Anthropic key to the wrong host. Warn once and build without
    // embeddings (keyword retrieval still works).
    const anthropicNoEndpoint = settings.provider === "anthropic" && settings.baseUrl === undefined;
    if (anthropicNoEndpoint && settings.embeddings.enabled && !this.embedderWarned && this.team.some((a) => a.docs.length > 0)) {
      this.embedderWarned = true;
      this.emit({
        type: "error",
        message:
          "Backpack embeddings are disabled: the Anthropic provider has no embeddings endpoint. Set a baseUrl for an OpenAI-compatible embeddings host, or /settings embeddings.enabled false to silence this.",
        fatal: false,
      });
    }
    const embedder: Embedder | undefined =
      settings.embeddings.enabled && apiKey && !anthropicNoEndpoint
        ? createEmbedder({
            apiKey,
            baseUrl: settings.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
            model: settings.embeddings.model,
          })
        : undefined;

    for (const agent of this.team) {
      if (this.backpackBuilding.has(agent.id)) continue;
      if (!this.needsBackpackBuild(agent)) continue;
      this.backpackBuilding.add(agent.id);
      const session = this.session;
      session.background.launch({
        kind: "backpack",
        description: `indexing backpack for ${agent.id}`,
        start: (outputFile, onExit) => {
          const ac = new AbortController();
          void (async () => {
            try {
              const { warnings } = await buildBackpack({
                cwd: this.opts.cwd,
                agent,
                runInference: (o) => session.services.runInference(o),
                ...(embedder ? { embedder } : {}),
                onProgress: (p) =>
                  this.emit({
                    type: "backpack_progress",
                    agentId: p.agentId,
                    phase: p.phase,
                    done: p.done,
                    total: p.total,
                  }),
                signal: ac.signal,
              });
              writeFileSync(outputFile, warnings.length ? warnings.join("\n") : `backpack ready for ${agent.id}`);
              onExit(0);
            } catch (err) {
              writeFileSync(outputFile, `backpack build failed: ${(err as Error).message}`);
              onExit(1);
            } finally {
              this.backpackBuilding.delete(agent.id);
              this.emitTeamUpdated();
            }
          })();
          return { stop: () => ac.abort() };
        },
      });
    }
  }

  private handleSlash(command: string, args?: string, opts?: { unattended?: boolean }): void {
    // Case-insensitive: the scheduler's prompt regex and users both produce
    // mixed case ("/Mission run x"); the dispatch must not silently no-op.
    switch (command.replace(/^\//, "").toLowerCase()) {
      case "help":
        this.emit({ type: "command_output", text: renderHelp() });
        break;
      case "skills":
        this.handleSkills(args);
        break;
      case "clear":
        // Swapping the session mid-turn would leave the old turn streaming
        // into the queue while a new session takes over — same exclusivity
        // rule as startExclusive, refused with the same kind of notice.
        if (this.busy || this.session.isBusy()) {
          this.emit({
            type: "command_output",
            text: "⏳ busy — wait for the current turn to finish (or interrupt it) before /clear.",
          });
          break;
        }
        this.session = this.createSession();
        this.announceSession();
        this.emit({ type: "command_output", text: "Started a fresh session." });
        break;
      case "atlas":
        this.startAtlasBuild(args?.trim() === "force");
        break;
      case "compact":
        // Wrapped in a background_notification so the frontend shows a "working"
        // indicator — compaction runs outside a turn, so turn_started never fires
        // and the UI would otherwise look frozen. Flagged not stoppable: aborting
        // mid-summary would leave the history half-rewritten.
        this.startExclusive("compacting", async () => {
          this.emit({
            type: "background_notification",
            taskId: "compact",
            kind: "start",
            payload: { description: "Compacting conversation", stoppable: false },
          });
          try {
            const did = await this.session.maybeCompact(true);
            this.emit({
              type: "command_output",
              text: did ? "🗜 Conversation compacted." : "Nothing to compact yet.",
            });
          } finally {
            this.emit({
              type: "background_notification",
              taskId: "compact",
              kind: "exit",
              payload: { description: "Compacting conversation" },
            });
          }
        });
        break;
      case "tasks": {
        const tasks = this.session.tasks.list();
        this.emit({ type: "task_list_updated", tasks });
        this.emit({
          type: "command_output",
          text:
            tasks.length === 0
              ? "No tasks."
              : tasks.map((t) => `#${t.id} [${t.status}] ${t.subject}`).join("\n"),
        });
        break;
      }
      case "overdrive": {
        const arg = args?.trim();
        if (arg === "on" || arg === "off") {
          const enabled = arg === "on";
          this.overdriveEnabled = enabled;
          this.session.setOverdrive(enabled);
          this.emit({
            type: "command_output",
            text: enabled
              ? "⚡ OVERDRIVE engaged — the turn loop runs uncapped until the query is verifiably handled."
              : "OVERDRIVE disengaged — standard turn budgets apply.",
          });
        } else if (!arg) {
          this.emit({
            type: "command_output",
            text: `OVERDRIVE is ${this.session.isOverdrive() ? "ON" : "OFF"}. Usage: /overdrive on|off`,
          });
        } else {
          this.emit({ type: "command_output", text: "Usage: /overdrive on|off" });
        }
        break;
      }
      case "session":
        // The end-of-session bill: cost per model at that model's own rates,
        // API vs wall time, code churn, and the CURRENT context size (no % of a
        // window — the real limit varies per model/endpoint, so a percentage
        // would be confidently wrong; the raw number is always true).
        this.emit({
          type: "session_report",
          text: `${this.session.stats.format(this.opts.settings, Date.now(), this.session.contextBreakdown())}\n${this.extensionLines()}`,
        });
        break;
      case "sessions":
        this.emit({ type: "session_list", sessions: this.listSessions() });
        this.emit({
          type: "command_output",
          text:
            this.listSessions()
              .map((s) => `${s.id}  (updated ${s.updatedAt})${s.firstUserMessage ? `  ${s.firstUserMessage}` : ""}`)
              .join("\n") || "No saved sessions.",
        });
        break;
      case "styles": // deprecated alias for /skills
        this.handleSkills(args);
        break;
      case "debug":
        this.handleDebug(args);
        break;
      case "settings":
        this.handleSettings(args);
        break;
      case "build-crew":
        this.handleBuildCrew();
        break;
      case "crew":
        this.handleCrew(args);
        break;
      case "mission":
        this.handleMission(args, opts?.unattended === true);
        break;
      case "team":
        this.handleTeam(args);
        break;
      case "lab":
        this.handleLab(args);
        break;
      case "resume":
        if (args) this.resumeSession(args.trim());
        else this.emit({ type: "command_output", text: "Usage: /resume <session-id>" });
        break;
      default:
        this.emit({ type: "command_output", text: `Unknown command: /${command}. Try /help.` });
    }
  }

  /**
   * The `/skills` listing: every skill in the workspace — discipline skills
   * (always-on once enabled, freely toggleable, none locked) with their on/off
   * state, then on-demand action skills, then the loaded-extension summary.
   * Extension points must be discoverable in-product, not only in docs.
   */
  private renderSkills(): string {
    const lines = ["Skills (.magentra/skills/) — disciplines shape every turn once enabled; actions run on demand:"];
    for (const m of this.modeEngine.list()) {
      const badge = m.recommended ? " ★recommended" : "";
      lines.push(`  ${m.active ? "[on] " : "[off]"} ${m.id} — ${m.name}${badge} — ${m.description}`);
    }
    const actions = this.opts.skills ?? [];
    if (actions.length > 0) {
      lines.push("  On-demand:");
      for (const skill of actions) lines.push(`    /${skill.name.padEnd(18)} ${skill.description}`);
    }
    lines.push("");
    lines.push("Toggle a discipline with /skills on <id> or /skills off <id> (this session only — not saved to settings).");
    lines.push("", this.extensionLines());
    return lines.join("\n");
  }

  /** Loaded-extension summary lines, shared by /skills and /session. Only
   * user-facing features are reported here — hooks and MCP servers are internal
   * plumbing that isn't surfaced as a product feature yet, so they get no stats
   * line (a "0 configured" readout for a feature the user has no way to use only
   * misinforms). Add them back here if/when they ship as real features. */
  private extensionLines(): string {
    const disciplines = this.modeEngine.list();
    const activeDisciplines = disciplines.filter((m) => m.active).length;
    return [
      `  Skills loaded:         ${(this.opts.skills ?? []).length}`,
      `  Disciplines active:    ${activeDisciplines} of ${disciplines.length}`,
    ].join("\n");
  }

  /**
   * `/skills`: list every skill, or toggle a discipline (the desktop uses
   * set_modes / the Skills view). `/skills on|off <id>` builds the desired
   * active set and routes it through {@link applyModes} — the exact path a
   * desktop toggle takes. Nothing is locked; a conflict simply switches the
   * conflicting skill off with an advisory message. Toggles are session-only
   * (not persisted). `/styles` is a deprecated alias.
   */
  private handleSkills(args?: string): void {
    const tokens = args?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (tokens.length === 0) {
      this.emit({ type: "command_output", text: this.renderSkills() });
      return;
    }
    const [verb, id] = tokens;
    if ((verb !== "on" && verb !== "off") || !id) {
      this.emit({
        type: "command_output",
        text: "Usage: /skills [on|off <id>] — run /skills alone to list every skill.",
      });
      return;
    }
    const summary = this.modeEngine.list().find((m) => m.id === id);
    if (!summary) {
      const ids = this.modeEngine.list().map((m) => m.id).join(", ");
      this.emit({ type: "command_output", text: `Unknown skill "${id}". Disciplines: ${ids}.` });
      return;
    }
    const active = this.modeEngine.list().filter((m) => m.active).map((m) => m.id);
    const desired = verb === "on" ? [...new Set([...active, id])] : active.filter((x) => x !== id);
    this.applyModes(desired);
    this.emit({
      type: "command_output",
      text:
        verb === "on"
          ? `${id} on — ${summary.name} skill active`
          : `${id} off — ${summary.name} skill disabled`,
    });
  }

  /**
   * `/debug <prompt>`: activate the sticky debug skill (reproduce-first,
   * oracle-script debugging) and start a turn seeded with the workspace
   * [debug context] header plus the user's bug report. `/debug off` deactivates
   * it; `/debug` with no argument just turns it on and asks for the symptom.
   * Activation runs through {@link applyModes} — the same path /skills uses — so
   * `conflicts:` resolution is respected. Session-only (not persisted).
   */
  private handleDebug(args?: string): void {
    const trimmed = args?.trim() ?? "";
    const active = this.modeEngine.list().filter((m) => m.active).map((m) => m.id);
    if (trimmed === "off") {
      this.applyModes(active.filter((x) => x !== "debug"));
      this.emit({ type: "command_output", text: "🐛 debug mode off" });
      return;
    }
    const messages = this.applyModes([...new Set([...active, "debug"])]);
    if (messages.length > 0) return; // a refusal (conflict) was already surfaced
    if (trimmed === "") {
      this.emit({
        type: "command_output",
        text: "🐛 debug mode on — describe the bug (usage: /debug <what is broken>)",
      });
      return;
    }
    this.emit({ type: "command_output", text: "🐛 debug mode on" });
    this.startExclusive("debugging", () =>
      this.session.runTurn(buildDebugHeader(this.opts.cwd) + "\n\n" + trimmed),
    );
  }

  /** `/settings` lists the effective config; `/settings <key> <value>` persists and applies one. */
  private handleSettings(args?: string): void {
    const trimmed = args?.trim();
    if (!trimmed) {
      this.emit({ type: "command_output", text: this.renderSettings() });
      return;
    }
    // An optional leading "global" forces persistence to ~/.magentra/settings.json
    // regardless of workspace; without it the plain form keeps its project-or-global default.
    const forceGlobal = /^global(\s|$)/.test(trimmed);
    const body = forceGlobal ? trimmed.replace(/^global\s*/, "") : trimmed;
    const split = body.search(/\s/);
    if (split === -1) {
      this.emit({
        type: "command_output",
        text: 'Usage: /settings [global] <key> <value> — run "/settings" alone to list every setting.',
      });
      return;
    }
    const key = body.slice(0, split);
    const value = body.slice(split + 1).trim();
    try {
      const applied = setSetting(this.opts.cwd, key, value, forceGlobal ? "global" : "auto");
      const effect = this.applySettingLive(applied.key, applied.value);
      this.emit({
        type: "command_output",
        text: `Set ${applied.key} = ${JSON.stringify(applied.value)}\nWrote ${applied.file}\n${effect}`,
      });
    } catch (err) {
      this.emit({ type: "command_output", text: (err as Error).message });
    }
  }

  private renderSettings(): string {
    const entries = describeSettings(this.opts.cwd);
    const width = Math.max(...entries.map((e) => e.key.length));
    const lines = entries.map((e) => {
      const value = typeof e.value === "string" ? e.value : JSON.stringify(e.value);
      return `  ${e.key.padEnd(width)}  ${value}  (${e.source})`;
    });
    return [
      "Settings (effective value, then the layer it came from):",
      ...lines,
      "",
      'Change one with "/settings <key> <value>" — dot-path for nested keys, e.g. /settings search.enabled false.',
      'Prefix with "global" to save to ~/.magentra/settings.json instead of this project, e.g. /settings global apiKey <your-key>.',
      "retention.sessions caps saved transcripts; retention.tasks caps saved task lists/background outputs. Oldest files are pruned on session start and after foreground work.",
      'An optional key returns to its default with "auto" — e.g. /settings contextWindow auto restores the model-aware window.',
    ].join("\n");
  }

  /**
   * Mirror a just-persisted setting into the in-memory {@link Settings} (shared with the
   * live session, so a fresh session via /clear always sees it) and report when it takes
   * effect. Returns the human-readable timing note for the command output.
   */
  /**
   * Live model swap (set_model frame): persist it and push it into the running
   * session so the NEXT turn uses it — no engine restart, so the conversation
   * and session id survive. Silent on success (the frontend shows its own note);
   * only a rejected value surfaces a message.
   */
  private handleSetModel(model: string): void {
    const trimmed = typeof model === "string" ? model.trim() : "";
    if (!trimmed) return;
    try {
      const applied = setSetting(this.opts.cwd, "model", trimmed, "auto");
      this.applySettingLive(applied.key, applied.value);
    } catch (err) {
      this.emit({ type: "command_output", text: `model unchanged: ${(err as Error).message}` });
    }
  }

  private applySettingLive(key: string, value: string | number | boolean): string {
    setSettingPath(this.opts.settings as unknown as Record<string, unknown>, key, value);
    const topKey = key.split(".")[0] as keyof typeof settingsSchema.shape;
    if (topKey === "retention") this.gcStateFiles();
    // A passthrough key outside the schema can't reach here (setSetting rejects it),
    // but default to /clear timing rather than crash if one ever does.
    return SETTING_TIMING_NOTE[SETTING_TIMING[topKey] ?? "clear"];
  }

  /**
   * `/build-crew`: bootstraps a workspace crew of specialist agents when none exists.
   * If a crew (or partial/malformed crew) is already on disk, it reports the state and
   * does nothing — safe and idempotent. Otherwise it dispatches a general-purpose
   * subagent (via the same spawnAgent seam the auto-atlas uses) to design 2-4
   * specialists and Write their team files, then validates the result through the real
   * {@link loadTeam} loader and reports per-file success/failure.
   */
  private handleBuildCrew(): void {
    const existing = loadTeam(this.opts.cwd);
    if (existing.agents.length > 0 || existing.warnings.length > 0) {
      this.emit({ type: "command_output", text: renderCrewState(existing.agents, existing.warnings) });
      return;
    }

    const toolNames = this.opts.registry.list().map((t) => t.name);
    const atlas = loadAtlas(this.opts.cwd);
    // Route through the exclusive seam: the crew's child session must not run
    // concurrently with a live parent turn, and a second /build-crew while one is
    // in flight is refused (busy) — no overwrite, no double-spawn.
    this.startExclusive("/build-crew", async () => {
      this.emit({ type: "command_output", text: "🧭 designing a crew for this workspace…" });
      try {
        await this.session.spawnAgent({
          agentType: "general-purpose",
          description: "design the workspace crew",
          prompt: buildCrewPrompt({ toolNames, ...(atlas ? { atlas } : {}) }),
        });
      } catch (err) {
        this.emit({
          type: "command_output",
          text: `🧭 crew build failed (${(err as Error).message}) — run /build-crew again to retry.`,
        });
        return;
      }
      // Validate through the real loader — never a second parser.
      const built = loadTeam(this.opts.cwd);
      this.emit({ type: "command_output", text: renderCrewBuildResult(built.agents, built.warnings) });
      if (built.agents.length > 0) this.reloadTeam(); // hot-load the new roster live
    });
  }

  /**
   * `/crew` — the hirable-crew command family: roster with readiness + CV
   * summary, pack export (fails closed on secrets), pack hire (validated,
   * lessons re-earn trust), and per-member record/lessons inspection.
   */
  private handleCrew(args?: string): void {
    const say = (text: string) => this.emit({ type: "command_output", text });
    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = tokens[0]?.toLowerCase();

    if (sub === undefined) {
      if (this.team.length === 0) {
        say("No crew yet. /build-crew designs one; /crew hire <path> imports a member from a crew pack.");
        return;
      }
      const ledger = loadLedger(this.opts.cwd);
      const lines = this.team.map((a) => {
        const record = summarizeRecord(readRecord(this.opts.cwd, a.id));
        const lessons = loadExperience(this.opts.cwd, a.id).lessons;
        const promoted = lessons.filter((l) => l.status === "promoted").length;
        const candidates = lessons.filter((l) => l.status === "candidate").length;
        const cv =
          record.tasksCompleted > 0 || record.hires > 0
            ? ` — ${record.tasksCompleted} task${record.tasksCompleted === 1 ? "" : "s"} done across ${record.projects.length} project${record.projects.length === 1 ? "" : "s"}${record.chainOk ? "" : " ⚠ record chain broken"}`
            : " — no work history yet";
        const spend = ledger.members[a.id];
        const cost = spend ? ` · ${formatLedgerEntry(spend)}` : "";
        return `${a.emoji ?? "•"} ${a.id} — ${a.name}, ${a.role} [${this.isBackpackReady(a) ? "ready" : "building"}] ${promoted} promoted / ${candidates} candidate lesson${candidates === 1 ? "" : "s"}${cv}${cost}`;
      });
      say(lines.join("\n"));
      return;
    }

    if (sub === "export") {
      const id = tokens[1];
      if (!id) {
        say("Usage: /crew export <id> [dest-dir] [redact]");
        return;
      }
      const redact = tokens.includes("redact");
      const dest = tokens.slice(2).find((t) => t !== "redact");
      const result = exportCrewPack(this.opts.cwd, id, { ...(dest ? { dest } : {}), redact });
      if (!result.ok) {
        const findings = (result.findings ?? []).map((f) => `  - ${f.kind} in ${f.where}: ${f.sample}`);
        say(
          [
            ...result.warnings,
            ...(findings.length > 0
              ? [`Export refused — secret-shaped content found:`, ...findings, `Fix the sources, or re-run as: /crew export ${id} redact`]
              : []),
          ].join("\n") || "Export failed.",
        );
        return;
      }
      say([`📦 exported ${id} → ${result.path}`, ...result.warnings].join("\n"));
      return;
    }

    if (sub === "hire") {
      const asIdx = tokens.findIndex((t, i) => i >= 2 && t.toLowerCase() === "as");
      const path = (asIdx === -1 ? tokens.slice(1) : tokens.slice(1, asIdx)).join(" ");
      const asId = asIdx !== -1 ? tokens[asIdx + 1] : undefined;
      if (!path) {
        say("Usage: /crew hire <path-to-crewpack> [as <new-id>]");
        return;
      }
      const result = hireCrewPack(this.opts.cwd, path, {
        ...(asId !== undefined ? { asId } : {}),
        validToolNames: this.opts.registry.list().map((t) => t.name),
        currentEmbeddingModel: this.opts.settings.embeddings.model,
      });
      if (!result.ok) {
        say(["Hire refused:", ...result.errors.map((e) => `  - ${e}`)].join("\n"));
        return;
      }
      const cv = result.summary;
      say(
        [
          `🤝 hired ${result.name} as "${result.id}"`,
          `   backpack: ${result.backpackState} · lessons: ${result.lessonsImported?.promoted ?? 0} promoted, ${result.lessonsImported?.candidates ?? 0} on probation`,
          ...(cv ? [`   CV: ${cv.tasksCompleted} tasks across ${cv.projects.length} project(s), chain ${cv.chainOk ? "verified ✓" : "BROKEN ⚠"}`] : []),
          ...result.warnings.map((w) => `   ⚠ ${w}`),
        ].join("\n"),
      );
      this.reloadTeam();
      return;
    }

    if (sub === "record" || sub === "lessons") {
      const id = tokens[1];
      if (!id) {
        say(`Usage: /crew ${sub} <id>`);
        return;
      }
      if (sub === "record") {
        const entries = readRecord(this.opts.cwd, id);
        if (entries.length === 0) {
          say(`No service record for "${id}" yet — it starts with the first verified task.`);
          return;
        }
        const chain = verifyRecordChain(entries);
        const lines = entries.map((e) => {
          const bits = Object.entries(e.data)
            .filter(([k]) => k !== "project")
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" ");
          return `#${e.seq} ${e.ts.slice(0, 10)} [${String(e.data.project ?? "?")}] ${e.event}${bits ? ` ${bits}` : ""}`;
        });
        say([...lines, chain.ok ? "chain verified ✓" : `chain BROKEN at entry ${chain.brokenAt} ⚠`].join("\n"));
      } else {
        const lessons = loadExperience(this.opts.cwd, id).lessons;
        if (lessons.length === 0) {
          say(`No lessons for "${id}" yet — they are captured when its completed tasks are verified.`);
          return;
        }
        const fmt = (l: (typeof lessons)[number]) =>
          `  [${l.scope}] ${l.text} (+${l.confirmations}/-${l.contradictions}${l.origin === "imported" ? ", imported" : ""})`;
        const group = (status: string) => lessons.filter((l) => l.status === status).map(fmt);
        say(
          [
            `promoted (${group("promoted").length}):`,
            ...group("promoted"),
            `on probation (${group("candidate").length}):`,
            ...group("candidate"),
            ...(group("retired").length > 0 ? [`retired (${group("retired").length}):`, ...group("retired")] : []),
          ].join("\n"),
        );
      }
      return;
    }

    say("Usage: /crew | /crew export <id> [dest|redact] | /crew hire <path> [as <id>] | /crew record <id> | /crew lessons <id>");
  }

  /**
   * `/lab` — the one-file lab blueprint (magentricks.md). `load [path]`
   * compiles the blueprint into the canonical team/mission files (upsert
   * only — nothing it doesn't mention is touched) and hot-reloads the
   * roster; `save [path]` snapshots the current lab back into the blueprint;
   * bare `/lab` reports the state.
   */
  private handleLab(args?: string): void {
    const say = (text: string) => this.emit({ type: "command_output", text });
    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = tokens[0]?.toLowerCase();
    const defaultPath = findLabFile(this.opts.cwd) ?? join(this.opts.cwd, LAB_FILE_NAME);

    if (sub === undefined) {
      const { missions } = loadMissions(this.opts.cwd);
      say(
        [
          existsSync(defaultPath) ? `Blueprint: ${defaultPath}` : `No ${LAB_FILE_NAME} yet — /lab save writes one from the current lab.`,
          `Live lab: ${this.team.length} member${this.team.length === 1 ? "" : "s"}, ${missions.length} mission${missions.length === 1 ? "" : "s"}.`,
          "Usage: /lab load [path] (blueprint → lab) | /lab save [path] (lab → blueprint)",
        ].join("\n"),
      );
      return;
    }

    if (sub === "load") {
      const path = tokens[1] ?? defaultPath;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        say(`Cannot read ${path}. Write a blueprint there (or /lab save to generate one from the current lab).`);
        return;
      }
      const result = compileLab(this.opts.cwd, parseLabFile(text));
      const applied = result.created.length + result.updated.length;
      if (applied > 0) this.reloadTeam(); // missions are re-read per command; the roster hot-loads here
      say(
        [
          `🧪 lab loaded from ${path}:`,
          ...(result.created.length ? [`  created: ${result.created.join(", ")}`] : []),
          ...(result.updated.length ? [`  updated: ${result.updated.join(", ")}`] : []),
          ...(result.unchanged.length ? [`  unchanged: ${result.unchanged.join(", ")}`] : []),
          ...result.warnings.map((w) => `  ✗ ${w}`),
          ...(applied === 0 && result.warnings.length === 0 ? ["  (everything already matched)"] : []),
        ].join("\n"),
      );
      return;
    }

    if (sub === "save") {
      const path = tokens[1] ?? defaultPath;
      const snapshot = snapshotLab(this.opts.cwd);
      if (snapshot.members === 0 && snapshot.missions === 0) {
        say("Nothing to save — no crew or missions yet. /build-crew designs a crew; /mission new <id> scaffolds a mission.");
        return;
      }
      writeFileSync(path, snapshot.text);
      say(`🧪 lab saved → ${path} (${snapshot.members} member${snapshot.members === 1 ? "" : "s"}, ${snapshot.missions} mission${snapshot.missions === 1 ? "" : "s"}). Edit it and /lab load applies it.`);
      return;
    }

    say("Usage: /lab | /lab load [path] | /lab save [path]");
  }

  /**
   * `/team` — whole-crew distribution: `export [name] [redact]` packs every
   * member plus the mission files into one shareable `<name>.teampack.json`
   * (fails closed on secret-shaped content); `hire <path>` imports one —
   * members validated like standalone crew packs (collisions skipped, the
   * rest still hire), missions added without overwriting.
   */
  private handleTeam(args?: string): void {
    const say = (text: string) => this.emit({ type: "command_output", text });
    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = tokens[0]?.toLowerCase();

    if (sub === "export") {
      const redact = tokens.includes("redact");
      const name = tokens.slice(1).find((t) => t !== "redact");
      const result = exportTeamPack(this.opts.cwd, {
        ...(name ? { name } : {}),
        redact,
        modelHint: this.opts.settings.model,
      });
      if (!result.ok) {
        const findings = (result.findings ?? []).map(
          (f) => `  - ${f.kind} in ${f.member ? `[${f.member}] ` : ""}${f.where}: ${f.sample}`,
        );
        say(
          [
            ...result.warnings,
            ...(findings.length > 0
              ? ["Export refused — secret-shaped content found:", ...findings, `Fix the sources, or re-run as: /team export${name ? ` ${name}` : ""} redact`]
              : []),
          ].join("\n") || "Export failed.",
        );
        return;
      }
      say([`📦 team exported → ${result.path}`, ...result.warnings].join("\n"));
      return;
    }

    if (sub === "hire") {
      const path = tokens.slice(1).join(" ");
      if (!path) {
        say("Usage: /team hire <path-or-https-url>");
        return;
      }
      const hireFrom = (file: string): void => {
        const result = hireTeamPack(this.opts.cwd, file, {
          validToolNames: this.opts.registry.list().map((t) => t.name),
          currentEmbeddingModel: this.opts.settings.embeddings.model,
        });
        if (!result.ok && result.hired.length === 0 && result.errors.length > 0) {
          say(["Team hire refused:", ...result.errors.map((e) => `  - ${e}`)].join("\n"));
          return;
        }
        const lines = [
          `🤝 team${result.teamName ? ` "${result.teamName}"` : ""} hired — ${result.hired.length} member${result.hired.length === 1 ? "" : "s"}, ${result.missionsAdded.length} mission${result.missionsAdded.length === 1 ? "" : "s"} added`,
          ...result.hired.map((h) => `   ✓ ${h.id}${h.name ? ` — ${h.name}` : ""}${h.warnings.length ? ` (${h.warnings.join("; ")})` : ""}`),
          ...result.skipped.map((s) => `   ✗ ${s.id} skipped: ${s.reasons.join("; ")}`),
          ...result.missionsAdded.map((m) => `   🧪 mission ${m}`),
          ...result.warnings.map((w) => `   ⚠ ${w}`),
        ];
        say(lines.join("\n"));
        if (result.hired.length > 0) this.reloadTeam();
      };

      // Community loop: hire straight from a URL — download to a temp file,
      // then run the exact same validation path a local pack takes.
      if (/^https?:\/\//i.test(path)) {
        this.startExclusive("hiring a team pack", async () => {
          say(`⬇ downloading team pack from ${path} …`);
          let buf: Buffer;
          try {
            const res = await fetch(path, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
            if (!res.ok) {
              say(`Download failed: HTTP ${res.status} ${res.statusText}`);
              return;
            }
            buf = Buffer.from(await res.arrayBuffer());
          } catch (err) {
            say(`Download failed: ${(err as Error).message}`);
            return;
          }
          if (buf.length > 100 * 1024 * 1024) {
            say("Download refused: team pack exceeds 100MB.");
            return;
          }
          const tmp = join(this.opts.cwd, STATE_DIR_NAME, "tmp", `hire-${Date.now()}.teampack.json`);
          mkdirSync(dirname(tmp), { recursive: true });
          writeFileSync(tmp, buf);
          try {
            hireFrom(tmp);
          } finally {
            rmSync(tmp, { force: true });
          }
        });
        return;
      }

      hireFrom(path);
      return;
    }

    say("Usage: /team export [name] [redact] | /team hire <path-or-https-url>");
  }

  /** The cron prompt a scheduled mission fires with (re-reads the file at fire time). */
  private static missionRunPrompt(id: string): string {
    return `/mission run ${id}`;
  }

  /**
   * Runs one mission as a full orchestrator turn. Unattended runs (scheduler-
   * fired, or the /mission start loop) take the OVERDRIVE permission stance
   * (the deletion guard still fires and is auto-denied via the session's
   * unattended flag), never block on approvals or questions, honor the
   * mission's token budget, and end with a notification. Every run appends
   * to the mission's log; an active continuous mission re-arms its next run.
   */
  private runMission(mission: Mission, unattended: boolean): void {
    this.startExclusive("running a mission", async () => {
      const cwd = this.opts.cwd;
      const session = this.session;
      const settings = this.opts.settings;
      const savedBudget = settings.maxTokensPerTurn;
      this.emit({
        type: "command_output",
        text: `🧪 mission "${mission.name}" launched${unattended ? " (unattended)" : ""} — the lab is on it.`,
      });
      let ok = false;
      try {
        if (unattended) {
          // Nobody is present to answer an ask prompt, so the run takes the
          // allow-all stance; the session's unattended flag auto-denies
          // whatever still insists on asking (deletion guard, questions).
          // Stance only — the session's own OVERDRIVE identity is untouched.
          session.permissions.setOverdrive(true);
          session.setUnattended(true);
        }
        if (mission.budgetTokens !== undefined) settings.maxTokensPerTurn = mission.budgetTokens;
        const previousReport = existsSync(join(cwd, missionDeliverablePath(mission)));
        await session.runTurn(buildMissionPrompt(mission, { hasTeam: this.team.length > 0, previousReport }));
        ok = true;
      } finally {
        session.setUnattended(false);
        // Restore the stance to the session's own OVERDRIVE state.
        session.permissions.setOverdrive(session.isOverdrive());
        settings.maxTokensPerTurn = savedBudget;
        this.appendMissionLog(mission.id, {
          ts: new Date().toISOString(),
          unattended,
          ok,
          outputTokens: session.lastTurnUsage?.outputTokens ?? 0,
        });
        const looping = loadContinuousState(cwd).active[mission.id] !== undefined;
        // The run just (re)wrote the deliverable — refresh lastRunAt in the UI.
        this.emitMissionsUpdated();
        if (unattended) {
          this.emit({
            type: "background_notification",
            taskId: `mission:${mission.id}`,
            kind: "mission",
            payload: { id: mission.id, ok },
          });
          this.emit({
            type: "command_output",
            text: `🧪 mission "${mission.id}" run ${ok ? "finished" : "FAILED"} — report: ${missionDeliverablePath(mission)}${looping ? " · continuous: next run armed" : ""}`,
          });
        }
        if (looping) this.armContinuous(mission);
      }
    });
  }

  /** Append one run record to .magentra/missions/out/<id>/log.jsonl (best-effort). */
  private appendMissionLog(id: string, entry: Record<string, unknown>): void {
    try {
      const path = join(this.opts.cwd, STATE_DIR_NAME, "missions", "out", id, "log.jsonl");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: "a" });
    } catch {
      // the log is an audit convenience — never fail a run over it
    }
  }

  /**
   * (Re-)arms the single pending wakeup that continues a continuous mission:
   * any existing wakeup for it is replaced, so there is never more than one
   * next-run in flight regardless of how the current run was started.
   */
  private armContinuous(mission: Mission): void {
    const prompt = Engine.missionRunPrompt(mission.id);
    for (const job of this.scheduler.list()) {
      if (job.source === "wakeup" && job.prompt === prompt) this.scheduler.delete(job.id);
    }
    this.scheduler.scheduleWakeup({
      delaySeconds: mission.cooldownSeconds ?? 300,
      reason: `continuous mission ${mission.id}`,
      prompt,
    });
  }

  /** Re-arms the continuous-mission loops recorded on disk (called at startup — wakeups are not durable). */
  private rearmContinuousMissions(): void {
    const state = loadContinuousState(this.opts.cwd);
    const ids = Object.keys(state.active);
    const { missions, warnings } = loadMissions(this.opts.cwd);
    // A malformed mission file silently never runs; startup is the one moment
    // the user reliably sees output, so surface loader warnings here — not
    // only when someone happens to run /mission.
    for (const warning of warnings) {
      this.emit({ type: "error", message: `mission file skipped: ${warning}`, fatal: false });
    }
    if (ids.length === 0) return;
    for (const id of ids) {
      const mission = missions.find((m) => m.id === id);
      if (mission) {
        this.armContinuous(mission);
        this.emit({ type: "command_output", text: `🔁 continuous mission "${id}" re-armed (next run in ~${mission.cooldownSeconds ?? 300}s of idle time). /mission stop ${id} halts it.` });
      } else {
        delete state.active[id];
        saveContinuousState(this.opts.cwd, state);
        this.emit({ type: "error", message: `continuous mission "${id}" no longer exists — its loop was stopped`, fatal: false });
      }
    }
  }

  /**
   * `/mission` — the research-lab command family: list the standing missions,
   * scaffold a new one, launch one now (a full orchestrator turn built by
   * {@link buildMissionPrompt}), loop one continuously (start/stop), or put
   * one on its cron schedule (durable — survives restarts, fires when idle).
   */
  /**
   * The mission list as data: file fields plus live state (armed cron job,
   * running continuous loop, last deliverable write). Feeds both the /mission
   * text listing and the missions_updated event, so they can never disagree.
   */
  private missionSummaries(): {
    summaries: Extract<CoreEvent, { type: "missions_updated" }>["missions"];
    warnings: string[];
    missions: Mission[];
  } {
    const { missions, warnings } = loadMissions(this.opts.cwd);
    const scheduledIds = new Set(
      this.scheduler
        .list()
        .filter((j) => j.source === "cron")
        .map((j) => /^\/mission run (\S+)$/.exec(j.prompt)?.[1])
        .filter(Boolean),
    );
    const running = loadContinuousState(this.opts.cwd).active;
    const summaries = missions.map((m) => {
      const deliverable = missionDeliverablePath(m);
      let lastRunAt: string | undefined;
      try {
        lastRunAt = statSync(join(this.opts.cwd, deliverable)).mtime.toISOString();
      } catch {
        /* never ran (or deliverable moved) — no timestamp */
      }
      return {
        id: m.id,
        name: m.name,
        ...(m.description !== undefined ? { description: m.description } : {}),
        keywords: m.keywords,
        ...(m.schedule !== undefined ? { schedule: m.schedule } : {}),
        scheduled: scheduledIds.has(m.id),
        continuous: m.continuous,
        running: Boolean(running[m.id]),
        deliverable,
        ...(lastRunAt !== undefined ? { lastRunAt } : {}),
      };
    });
    return { summaries, warnings, missions };
  }

  private emitMissionsUpdated(): void {
    const { summaries, warnings } = this.missionSummaries();
    this.emit({ type: "missions_updated", missions: summaries, warnings });
  }

  private handleMission(args: string | undefined, unattended = false): void {
    const say = (text: string) => this.emit({ type: "command_output", text });
    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = tokens[0]?.toLowerCase();
    const { summaries, warnings, missions } = this.missionSummaries();

    if (sub === undefined) {
      const lines: string[] = [];
      if (missions.length === 0) {
        lines.push("No missions yet. /mission new <id> writes a starter file at .magentra/missions/<id>.md.");
      } else {
        for (const s of summaries) {
          const source = missions.find((m) => m.id === s.id);
          const bits = [
            s.keywords.length > 0 ? `keywords: ${s.keywords.join(", ")}` : "",
            s.continuous
              ? s.running
                ? `🔁 running continuously (cooldown ${source?.cooldownSeconds ?? 300}s)`
                : "continuous-capable (/mission start)"
              : "",
            s.schedule ? `cron ${s.schedule}${s.scheduled ? " (scheduled ✓)" : " (not scheduled)"}` : "",
            `→ ${s.deliverable}`,
          ].filter(Boolean);
          lines.push(`🧪 ${s.id} — ${s.name}${s.description ? `: ${s.description}` : ""}${bits.length ? ` [${bits.join(" · ")}]` : ""}`);
        }
        lines.push("");
        lines.push("Run one now with /mission run <id>; /mission start <id> loops a continuous one; /mission schedule <id> automates by cron.");
      }
      lines.push(...warnings.map((w) => `  ✗ ${w}`));
      say(lines.join("\n"));
      this.emit({ type: "missions_updated", missions: summaries, warnings });
      return;
    }

    if (sub === "new") {
      const id = tokens[1];
      if (!id || !/^[a-z0-9_-]+$/.test(id)) {
        say("Usage: /mission new <id> — the id is lowercase letters, digits, hyphen or underscore (it becomes the file name).");
        return;
      }
      const path = join(this.opts.cwd, STATE_DIR_NAME, "missions", `${id}.md`);
      if (missions.some((m) => m.id === id) || existsSync(path)) {
        say(`A mission "${id}" already exists — edit ${path} directly, or pick another id.`);
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, missionTemplate(id));
      say([`🧪 mission scaffold written → ${path}`, "Edit its keywords and charter, then launch it with /mission run " + id + ".", "", "Format reference:", MISSION_FILE_FORMAT.split("\n\n")[2] ?? ""].join("\n"));
      this.emitMissionsUpdated();
      return;
    }

    const id = tokens[1];
    const mission: Mission | undefined = id ? missions.find((m) => m.id === id) : undefined;
    const known = missions.map((m) => m.id).join(", ") || "(none — /mission new <id> creates one)";

    if (sub === "run") {
      if (!mission) {
        say(id ? `No mission "${id}". Missions here: ${known}.` : "Usage: /mission run <id>");
        return;
      }
      this.runMission(mission, unattended);
      return;
    }

    if (sub === "start") {
      if (!mission) {
        say(id ? `No mission "${id}". Missions here: ${known}.` : "Usage: /mission start <id>");
        return;
      }
      if (!mission.continuous) {
        say(`Mission "${mission.id}" is not marked continuous. Add "continuous: true" (and optionally "cooldown: 15m") to ${mission.sourcePath}, then /mission start ${mission.id} again.`);
        return;
      }
      const state = loadContinuousState(this.opts.cwd);
      if (state.active[mission.id]) {
        say(`Mission "${mission.id}" is already running continuously. /mission stop ${mission.id} halts it.`);
        return;
      }
      state.active[mission.id] = { startedAt: new Date().toISOString() };
      saveContinuousState(this.opts.cwd, state);
      say(
        `🔁 continuous mission "${mission.id}" started — it runs now, then again after every ~${mission.cooldownSeconds ?? 300}s of idle time until /mission stop ${mission.id}. Runs are unattended: nothing asks, destructive calls auto-denied${mission.budgetTokens ? `, budget ${mission.budgetTokens} output tokens per run` : ""}. The loop survives restarts.`,
      );
      // The loop is unattended from run one — it must never depend on a human.
      this.emitMissionsUpdated();
      this.runMission(mission, true);
      return;
    }

    if (sub === "stop") {
      if (!id) {
        say("Usage: /mission stop <id>");
        return;
      }
      const state = loadContinuousState(this.opts.cwd);
      if (!state.active[id]) {
        say(`Mission "${id}" is not running continuously.`);
        return;
      }
      delete state.active[id];
      saveContinuousState(this.opts.cwd, state);
      const prompt = Engine.missionRunPrompt(id);
      for (const job of this.scheduler.list()) {
        if (job.source === "wakeup" && job.prompt === prompt) this.scheduler.delete(job.id);
      }
      say(`🔁 continuous mission "${id}" stopped. A run already in flight finishes; no further runs are armed.`);
      this.emitMissionsUpdated();
      return;
    }

    if (sub === "schedule") {
      if (!mission) {
        say(id ? `No mission "${id}". Missions here: ${known}.` : "Usage: /mission schedule <id>");
        return;
      }
      if (!mission.schedule) {
        say(`Mission "${mission.id}" has no schedule. Add a frontmatter line like "schedule: 0 7 * * 1" (5-field cron) to ${mission.sourcePath}, then re-run /mission schedule ${mission.id}.`);
        return;
      }
      const prompt = Engine.missionRunPrompt(mission.id);
      if (this.scheduler.list().some((j) => j.prompt === prompt)) {
        say(`Mission "${mission.id}" is already scheduled (${mission.schedule}). /mission unschedule ${mission.id} removes it.`);
        return;
      }
      try {
        const { nextFire } = this.scheduler.create({ cron: mission.schedule, prompt, recurring: true, durable: true });
        say(`⏰ mission "${mission.id}" scheduled: ${mission.schedule}${nextFire ? ` — next fire ~${nextFire.toISOString().slice(0, 16)}Z` : ""} (fires when the session is idle; survives restarts). The mission file is re-read at every fire.`);
        this.emitMissionsUpdated();
      } catch (err) {
        say(`Cannot schedule "${mission.id}": ${(err as Error).message}`);
      }
      return;
    }

    if (sub === "unschedule") {
      if (!id) {
        say("Usage: /mission unschedule <id>");
        return;
      }
      const prompt = Engine.missionRunPrompt(id);
      const jobs = this.scheduler.list().filter((j) => j.prompt === prompt);
      for (const job of jobs) this.scheduler.delete(job.id);
      say(jobs.length > 0 ? `⏰ mission "${id}" unscheduled.` : `Mission "${id}" was not scheduled.`);
      if (jobs.length > 0) this.emitMissionsUpdated();
      return;
    }

    say("Usage: /mission | /mission new <id> | /mission run <id> | /mission start|stop <id> | /mission schedule|unschedule <id>");
  }

  private handleBang(cmd: string): void {
    // Never inject into a running turn: a user message spliced between an
    // assistant tool_use and its results corrupts the history. Defer instead.
    if (this.busy || this.session.isBusy()) {
      this.pendingBangs.push(cmd);
      this.emit({ type: "command_output", text: `⏳ ! ${cmd} — queued; runs when the current turn finishes.` });
      return;
    }
    this.runBang(cmd);
  }

  private flushPendingBangs(): void {
    while (this.pendingBangs.length > 0 && !this.busy && !this.session.isBusy()) {
      this.runBang(this.pendingBangs.shift()!);
    }
  }

  private runBang(cmd: string): void {
    exec(cmd, { cwd: this.opts.cwd, timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      let output = [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
      // Same ceiling as a tool result: a huge build log must not torch the context.
      const CAP = 40_000;
      if (output.length > CAP) {
        output = `${output.slice(0, CAP / 2)}\n[truncated — ${output.length - CAP} more chars omitted from the middle]\n${output.slice(output.length - CAP / 2)}`;
      }
      const exitCode = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      this.emit({ type: "command_output", text: output });
      this.session.addContextMessage(
        `<bash-input>! ${cmd}</bash-input>\n<bash-output exit-code="${exitCode}">\n${output}\n</bash-output>\n<system-reminder>The user ran this shell command directly; its output above is context, not a request.</system-reminder>`,
      );
    });
  }

  /**
   * Rotate append-only workspace state by mtime. Root and subagent transcripts
   * use the same cap; task-list JSON and background output share the task cap.
   * The live session and live background outputs are never candidates.
   */
  private gcStateFiles(): void {
    const stateDir = join(this.opts.cwd, STATE_DIR_NAME);
    const sessionsDir = join(stateDir, "sessions");
    const tasksDir = join(stateDir, "tasks");
    const currentSessionFile = `${this.session.id}.jsonl`;

    const removedSessions = this.pruneStateDirectory(
      sessionsDir,
      [".jsonl"],
      this.opts.settings.retention.sessions,
      new Set([currentSessionFile]),
    );
    // A transcript and its session task list are one continuity unit. Do not
    // leave task JSON behind when its transcript ages out.
    for (const file of removedSessions) {
      const taskFile = join(tasksDir, `${file.slice(0, -".jsonl".length)}.json`);
      try {
        rmSync(taskFile, { force: true });
      } catch (err) {
        this.emit({
          type: "error",
          message: `Could not prune ${taskFile}: ${(err as Error).message}`,
          fatal: false,
        });
      }
    }

    // Children moved here in 3.3. Bound this directory as well so detached
    // specialist histories do not become the new unbounded store.
    this.pruneStateDirectory(
      join(sessionsDir, "subagents"),
      [".jsonl"],
      this.opts.settings.retention.sessions,
      new Set(),
    );

    const protectedTasks = new Set<string>([`${this.session.id}.json`]);
    for (const task of this.session.background.list()) {
      if (task.status === "running") protectedTasks.add(basename(task.outputFile));
    }
    this.pruneStateDirectory(
      tasksDir,
      [".json", ".output"],
      this.opts.settings.retention.tasks,
      protectedTasks,
    );
  }

  /** Delete oldest matching files until at most `limit` remain. */
  private pruneStateDirectory(
    dir: string,
    suffixes: string[],
    limit: number,
    protectedFiles: Set<string>,
  ): string[] {
    let files: { name: string; mtimeMs: number }[];
    try {
      files = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix)))
        .map((entry) => ({ name: entry.name, mtimeMs: statSync(join(dir, entry.name)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }

    let excess = files.length - limit;
    if (excess <= 0) return [];
    const removed: string[] = [];
    for (let i = files.length - 1; i >= 0 && excess > 0; i--) {
      const file = files[i]!;
      if (protectedFiles.has(file.name)) continue;
      const path = join(dir, file.name);
      try {
        rmSync(path, { force: true });
        removed.push(file.name);
        excess--;
      } catch (err) {
        this.emit({
          type: "error",
          message: `Could not prune ${path}: ${(err as Error).message}`,
          fatal: false,
        });
      }
    }
    return removed;
  }

  private listSessions(): SessionSummary[] {
    const dir = join(this.opts.cwd, STATE_DIR_NAME, "sessions");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    return files
      .flatMap((f): SessionSummary[] => {
        const path = join(dir, f);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          return [];
        }
        // The human-readable label a picker shows beside the id — without it a
        // user can only tell sessions apart by timestamp.
        const firstUserMessage = Transcript.firstUserText(path);
        const meta = Transcript.latestMeta(path);
        const label = typeof meta?.label === "string" ? meta.label : undefined;
        let model = typeof meta?.model === "string" ? meta.model : undefined;
        // Transcripts written before the explicit model field can still expose
        // the latest model from their restored accounting snapshot.
        if (!model && typeof meta?.stats === "object" && meta.stats !== null) {
          const byModel = (meta.stats as Record<string, unknown>).byModel;
          if (typeof byModel === "object" && byModel !== null) {
            model = Object.keys(byModel).at(-1);
          }
        }
        return [{
          id: f.replace(/\.jsonl$/, ""),
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          cwd: this.opts.cwd,
          ...(firstUserMessage !== undefined ? { firstUserMessage } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(label !== undefined ? { label } : {}),
        }];
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  private resumeSession(id: string): void {
    if (this.busy || this.session.isBusy()) {
      this.emit({ type: "command_output", text: "⏳ busy — wait for the current turn to finish before resuming another session." });
      return;
    }
    if (id === this.session.id) {
      this.emit({ type: "command_output", text: `Session ${id} is already active.` });
      return;
    }
    const known = this.listSessions().find((session) => session.id === id);
    if (!known) {
      this.emit({ type: "error", message: `Cannot resume ${id}: no such session`, fatal: false });
      return;
    }
    const file = join(this.opts.cwd, STATE_DIR_NAME, "sessions", `${known.id}.jsonl`);
    try {
      const { messages, meta } = Transcript.replay(file);
      // Restore the session's accounting ledger from the latest meta
      // snapshot; transcripts that predate meta records (or carry a corrupt
      // one) fall back to fresh stats.
      this.session = this.createSession(id, messages, SessionStats.fromSnapshot(meta?.stats));
      if (typeof meta?.label === "string") this.session.label = meta.label;
      // The resumed session's own OVERDRIVE state wins over the engine's
      // current toggle; transcripts predating the flag leave it untouched.
      if (typeof meta?.overdrive === "boolean") {
        this.overdriveEnabled = meta.overdrive;
        this.session.setOverdrive(meta.overdrive);
      }
      this.announceSession();
      // Repaint the conversation in the UI. Replaces the old text-only note:
      // the frontend rebuilds the chat from this render-ready snapshot.
      this.emit({ type: "session_restored", sessionId: id, messages: reconstructForDisplay(messages) });
    } catch (err) {
      const reason =
        (err as NodeJS.ErrnoException).code === "ENOENT" ? "no such session" : (err as Error).message;
      this.emit({ type: "error", message: `Cannot resume ${id}: ${reason}`, fatal: false });
    }
  }

  /**
   * Names a saved session: appended as a `meta` record, so it travels with the
   * transcript (listSessions prefers meta.label over the first-message label,
   * and the active session preserves it across future turn-end snapshots).
   */
  private renameSession(id: string, label: string): void {
    const trimmed = label.trim().slice(0, 120);
    if (!trimmed) {
      this.emit({ type: "error", message: "Cannot rename: the label is empty.", fatal: false });
      return;
    }
    if (id === this.session.id) {
      this.session.label = trimmed;
      // Merge into the latest snapshot: a bare {label} record would otherwise
      // become the newest meta and hide stats/model/overdrive from resume.
      this.session.transcript.append({
        kind: "meta",
        data: { ...(Transcript.latestMeta(this.session.transcript.file) ?? {}), label: trimmed },
      });
    } else {
      const known = this.listSessions().find((session) => session.id === id);
      if (!known) {
        this.emit({ type: "error", message: `Cannot rename ${id}: no such session`, fatal: false });
        return;
      }
      const file = join(this.opts.cwd, STATE_DIR_NAME, "sessions", `${known.id}.jsonl`);
      new Transcript(join(this.opts.cwd, STATE_DIR_NAME), known.id).append({
        kind: "meta",
        data: { ...(Transcript.latestMeta(file) ?? {}), label: trimmed },
      });
    }
    this.emit({ type: "session_list", sessions: this.listSessions() });
  }

  /** Moves a saved session out of the resumable listing into sessions/archive/. */
  private archiveSession(id: string): void {
    if (id === this.session.id) {
      this.emit({ type: "command_output", text: "The active session cannot be archived." });
      return;
    }
    const known = this.listSessions().find((session) => session.id === id);
    if (!known) {
      this.emit({ type: "error", message: `Cannot archive ${id}: no such session`, fatal: false });
      return;
    }
    const dir = join(this.opts.cwd, STATE_DIR_NAME, "sessions");
    try {
      mkdirSync(join(dir, "archive"), { recursive: true });
      renameSync(join(dir, `${known.id}.jsonl`), join(dir, "archive", `${known.id}.jsonl`));
    } catch (err) {
      this.emit({ type: "error", message: `Cannot archive ${id}: ${(err as Error).message}`, fatal: false });
      return;
    }
    this.emit({ type: "session_list", sessions: this.listSessions() });
    this.emit({
      type: "command_output",
      text: `🗄 session ${known.id} archived (moved to .magentra/sessions/archive/ — move it back to restore).`,
    });
  }

  private deleteSession(id: string): void {
    if (id === this.session.id) {
      this.emit({ type: "command_output", text: "The active session cannot be deleted. Start or resume another session first." });
      return;
    }
    const known = this.listSessions().find((session) => session.id === id);
    if (!known) {
      this.emit({ type: "error", message: `Cannot delete ${id}: no such session`, fatal: false });
      return;
    }
    try {
      rmSync(join(this.opts.cwd, STATE_DIR_NAME, "sessions", `${known.id}.jsonl`));
    } catch (err) {
      this.emit({ type: "error", message: `Cannot delete ${id}: ${(err as Error).message}`, fatal: false });
      return;
    }
    try {
      rmSync(join(this.opts.cwd, STATE_DIR_NAME, "tasks", `${known.id}.json`), { force: true });
    } catch (err) {
      this.emit({
        type: "error",
        message: `Session ${known.id} was deleted, but its task file could not be removed: ${(err as Error).message}`,
        fatal: false,
      });
    }
    this.emit({ type: "session_list", sessions: this.listSessions() });
    this.emit({ type: "command_output", text: `Deleted session ${known.id}.` });
  }
}

/**
 * The single slash-command registry: /help renders from it and session_started
 * ships it to the frontend palette, so the two can never drift apart. `help`
 * holds extra sub-usage lines shown only in /help.
 */
const SLASH_COMMANDS: (SlashCommandInfo & { help?: string[] })[] = [
  { cmd: "/help", args: "", desc: "show this help" },
  { cmd: "/atlas", args: "[force]", desc: "map the codebase into .magentra/ATLAS.md (force overwrites hand edits)" },
  { cmd: "/clear", args: "", desc: "start a fresh session (history cleared)" },
  { cmd: "/compact", args: "", desc: "compact the conversation now" },
  { cmd: "/session", args: "", desc: "this session's usage: tokens per model, API/wall time, code churn, context now" },
  { cmd: "/tasks", args: "", desc: "show the task list" },
  { cmd: "/skills", args: "[on|off <id>]", desc: "list skills (disciplines + on-demand), or toggle a discipline (session only)" },
  { cmd: "/lab", args: "[load|save]", desc: "one-file lab blueprint (magentricks.md): load applies it, save snapshots it" },
  { cmd: "/build-crew", args: "", desc: "design a crew of specialist agents (if none exists yet)" },
  {
    cmd: "/crew", args: "[export|hire|record|lessons]", desc: "roster + readiness + service-record summary per member",
    help: [
      "  /crew export <id> [dest|redact]  pack a member into <id>.crewpack.json (fails closed on secrets)",
      "  /crew hire <path> [as <id>]      import a crew pack; knowledge arrives ready, lessons re-earn trust",
      "  /crew record <id>   a member's verified work history (hash-chained)",
      "  /crew lessons <id>  a member's experience ledger by status",
    ],
  },
  {
    cmd: "/team", args: "export|hire", desc: "whole-crew pack: export or hire everything at once",
    help: [
      "  /team export [name] [redact]  pack the WHOLE crew + missions into <name>.teampack.json",
      "  /team hire <path|url>         import a team pack (members validated, missions added)",
    ],
  },
  {
    cmd: "/mission", args: "[new|run|start|stop|schedule|unschedule <id>]", desc: "list the lab's missions (.magentra/missions/*.md)",
    help: [
      "  /mission new <id>    write a starter mission file",
      "  /mission run <id>    send the lab on a mission now (web sweep, tasks, report)",
      "  /mission start <id>  loop a continuous mission (unattended runs + cooldown) · stop halts",
      "  /mission schedule <id>    run it on its cron schedule (durable) · unschedule removes",
    ],
  },
  { cmd: "/overdrive", args: "[on|off]", desc: "fully-autonomous stance: nothing asks, self-verified completion" },
  { cmd: "/styles", args: "[on|off <id>]", desc: "deprecated alias for /skills" },
  { cmd: "/debug", args: "<prompt>", desc: "reproduce-first debugging mode (off: /debug off)" },
  { cmd: "/settings", args: "[global] [k v]", desc: "show settings, or set one (add global to save to ~/.magentra)" },
  { cmd: "/resume", args: "<session-id>", desc: "resume a previous session" },
  { cmd: "/sessions", args: "", desc: "list saved sessions" },
];

/** The /help text, rendered from the registry plus the non-slash affordances. */
function renderHelp(): string {
  const lines = ["Built-in commands:"];
  for (const spec of SLASH_COMMANDS) {
    const head = `${spec.cmd}${spec.args ? ` ${spec.args}` : ""}`;
    lines.push(`  ${head.padEnd(24)} ${spec.desc}`);
    if (spec.help) lines.push(...spec.help);
  }
  lines.push(
    "  ! <command>      run a shell command; output lands in the conversation",
    "  Esc              interrupt the current turn",
    "",
    "Glossary (crew, backpack, atlas, mission, skills, deletion guard): SETTINGS → GLOSSARY in the app.",
  );
  return lines.join("\n");
}

/**
 * The per-model rate card + context windows shipped in session_started: the
 * built-in table with user pricing overrides applied, so the frontend never
 * needs (and must never keep) a pricing copy of its own.
 */
function buildRateCard(
  settings: Settings,
): Extract<CoreEvent, { type: "session_started" }>["rateCard"] {
  const card: Extract<CoreEvent, { type: "session_started" }>["rateCard"] = {};
  for (const model of new Set([...Object.keys(MODEL_PRICING), ...Object.keys(settings.pricing ?? {})])) {
    const pricing = pricingFor(model, settings);
    if (!pricing) continue;
    card[model] = {
      input: pricing.input,
      output: pricing.output,
      ...(pricing.cacheRead !== undefined ? { cacheRead: pricing.cacheRead } : {}),
      ...(pricing.cacheWrite !== undefined ? { cacheWrite: pricing.cacheWrite } : {}),
      // The MODEL's intrinsic window (no settings override): the card describes
      // models; the override is a session concern the engine applies itself.
      contextWindow: contextWindowFor(model),
    };
  }
  return card;
}

/** Concatenated text of a message's text blocks. */
function textOf(msg: Msg): string {
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Flattens a tool_result's content (string or parts) to a display string. */
function flattenToolResult(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? (p.text ?? "") : "[image]")).join("\n");
}

/**
 * Turns stored message history into a render-ready paint list for the frontend:
 * pairs each assistant tool_use with its tool_result from the following user
 * message, and drops harness scaffolding (tool_result-only and system-reminder
 * user messages, including the compaction summary) that is not conversation.
 */
export function reconstructForDisplay(messages: Msg[]): RestoredMessage[] {
  const out: RestoredMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      const text = textOf(msg).trim();
      if (!text || text.startsWith("<system-reminder>")) continue;
      out.push({ role: "user", text });
      continue;
    }
    const thinking = msg.content
      .filter((b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking")
      .map((b) => b.thinking)
      .join("\n");
    const text = textOf(msg);
    const results = new Map<string, { content: string; isError: boolean }>();
    const next = messages[i + 1];
    if (next?.role === "user") {
      for (const b of next.content) {
        if (b.type === "tool_result") {
          results.set(b.toolUseId, { content: flattenToolResult(b.content), isError: b.isError ?? false });
        }
      }
    }
    const toolCalls = msg.content
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map((tu) => {
        const r = results.get(tu.id);
        return { tool: tu.name, input: tu.input, result: r?.content ?? "(no result recorded)", isError: r?.isError ?? false };
      });
    if (!text && !thinking && toolCalls.length === 0) continue;
    out.push({
      role: "assistant",
      text,
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }
  return out;
}

/** One roster line per loaded specialist: `✓ 🔍 reviewer — Argus, Code Reviewer [model @ endpoint]`. */
function crewRosterLines(agents: CrewAgent[]): string[] {
  return agents.map((a) => {
    const emoji = a.emoji ? `${a.emoji} ` : "";
    const endpoint = a.provider === "anthropic" ? "anthropic" : a.baseUrl;
    const runsOn = a.model || endpoint ? ` [${[a.model, endpoint].filter(Boolean).join(" @ ")}]` : "";
    return `  ✓ ${emoji}${a.id} — ${a.name}, ${a.role}${runsOn}`;
  });
}

/** One line per skipped file, carrying the loader's own `team/<file>: <reason>` warning. */
function crewWarningLines(warnings: string[]): string[] {
  return warnings.map((w) => `  ✗ ${w}`);
}

/** Report for `/build-crew` when a crew (valid, or only malformed files) is already present. */
function renderCrewState(agents: CrewAgent[], warnings: string[]): string {
  const lines: string[] = [];
  if (agents.length > 0) {
    lines.push(`crew already exists — ${agents.length} specialist${agents.length === 1 ? "" : "s"}:`);
    lines.push(...crewRosterLines(agents));
  }
  if (warnings.length > 0) {
    lines.push(
      agents.length > 0
        ? `${warnings.length} team file${warnings.length === 1 ? "" : "s"} could not be loaded:`
        : `no valid crew, but ${warnings.length} team file${warnings.length === 1 ? "" : "s"} could not be loaded:`,
    );
    lines.push(...crewWarningLines(warnings));
    lines.push("Fix the file(s) above (or remove them and run /build-crew) to design a fresh crew.");
  }
  return lines.join("\n");
}

/** Report after the `/build-crew` subagent returns: per-file ✓/✗ validated through loadTeam. */
function renderCrewBuildResult(agents: CrewAgent[], warnings: string[]): string {
  if (agents.length === 0) {
    const detail = warnings.length > 0 ? `\n${crewWarningLines(warnings).join("\n")}` : "";
    return `🧭 crew build failed — no valid team files were produced.${detail}\nRun /build-crew again to retry.`;
  }
  const lines = [
    `🧭 crew ready — ${agents.length} specialist${agents.length === 1 ? "" : "s"} written to .magentra/team/:`,
    ...crewRosterLines(agents),
  ];
  if (warnings.length > 0) {
    lines.push(`${warnings.length} file${warnings.length === 1 ? "" : "s"} skipped (malformed):`);
    lines.push(...crewWarningLines(warnings));
  }
  return lines.join("\n");
}

// ── Create-skill wizard: authoring prompt ────────────────────────────────────

/** The subagent persona for generate_skill: it writes exactly one file, no commentary. */
const SKILL_AUTHOR_ROLE = `You are a skill author for the MAGENTRA agent workbench. Your entire final
response must be EXACTLY the content of one skill .md file — no code fences, no
commentary before or after it. You may read a few workspace files first if the
skill should reference real project conventions, but keep it brief.`;

/** Optional knobs the wizard passes into skill authoring. */
type SkillGenOptions = {
  model?: string;
  context?: string;
  enforce?: "remind" | "block";
  connection?: { provider: "anthropic" | "openai-compat"; baseUrl?: string; apiKey: string; model: string };
};

/** The format the generator must produce, per kind — kept in one place so the wizard and validator agree. */
function buildSkillPrompt(
  description: string,
  kind: "discipline" | "action",
  takenIds: string[],
  opts: SkillGenOptions = {},
): string {
  const contextLine = opts.context && opts.context.trim()
    ? `\n\nWhen it should apply / extra detail from the user:\n"""\n${opts.context.trim()}\n"""`
    : "";
  const enforceLine =
    kind === "discipline" && opts.enforce === "block"
      ? `\n\nThe user wants this ENFORCED, not just advisory: include a "gate:" frontmatter line that blocks the relevant tools (e.g. Write, Edit) until the condition holds, with a short, specific refusal message.`
      : kind === "discipline"
        ? `\n\nThe user wants a REMINDER, not a hard block: rely on the directive and a short "## On turn start" reminder — do NOT add a gate: line.`
        : "";

  const common = `The user wants a new ${kind} skill. Their description:
"""
${description}
"""${contextLine}${enforceLine}

Already-taken skill ids (choose a DIFFERENT short kebab-case id): ${takenIds.join(", ")}.`;

  if (kind === "action") {
    return `${common}

Produce a Markdown file in this exact shape — slim frontmatter, then the
procedure as a well-structured Markdown body the agent will follow when the
skill is invoked:

---
name: <short-kebab-case-id>
description: <one line: when the agent should reach for this skill>
---

<the procedure: clear steps, headings and bullet lists welcome>`;
  }

  return `${common}

Produce a Markdown file in this exact shape — slim frontmatter (only the keys
shown; strings only, no YAML nesting), then Markdown sections. Only the section
headings listed are allowed at the "## " level (use ### or deeper inside text).

---
kind: discipline
name: <Display Name>
description: <one line: what this discipline changes about how the agent works>
why: <one line: why/when a user should enable it>
auto: <comma, separated, trigger, keywords>            (optional)
conflicts: <comma-separated skill ids>                 (optional)
gate: <Tool[, Tool]> requires <tasks-exist|never|repro-failed>: <refusal message>   (optional, repeatable)
---

<the directive: the rules the agent must follow while this skill is active —
this is the main body, before any "## " heading>

## Vocabulary
- <term>: <definition>          (optional section)

## On turn start
<a SHORT reminder (2-4 lines) injected once per conversation>   (optional section)

## After an error
<a SHORT nudge injected when a tool batch fails>                (optional section)

## Planning checklist
- <item>                        (optional section)

## Wrap-up checklist
- <item>                        (optional section)`;
}

/** Models love to wrap file output in a fence despite instructions — unwrap one if present. */
function stripCodeFence(raw: string): string {
  const text = raw.trim();
  const m = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(text);
  return m ? m[1]! : text;
}

/**
 * Coax a model's reply into the exact file the validator expects: unwrap a code
 * fence, then — the common failure — drop any preamble sentence the model wrote
 * before the actual `---` frontmatter, so a chatty-but-correct draft validates
 * instead of being thrown away over a leading "Here's your skill:".
 */
function repairSkillText(raw: string): string {
  const text = stripCodeFence(raw).trim();
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "---");
  return start > 0 ? lines.slice(start).join("\n").trim() : text;
}
