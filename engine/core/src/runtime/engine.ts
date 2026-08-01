import { exec } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  PROTOCOL_VERSION,
  STATE_DIR_NAME,
  definePrompt,
  promptTextIfEnabled,
  type ConnectionSpec,
  type CoreEvent,
  type FrontendRequest,
  type ImageAttachment,
  type PermissionDecision,
  type RestoredMessage,
  type SessionSummary,
  type SlashCommandInfo,
} from "@magentra/protocol";
import type { ContentBlock, Msg, Provider } from "@magentra/providers";
import { AsyncQueue } from "../util/asyncQueue.js";
import { CronScheduler } from "../scheduling/cron.js";
import { HookRunner } from "../agent/hooks.js";
import { parseFrontmatter } from "../config/frontmatter.js";
import { ADDON_ENTRY, ADDONS_DIR, addonInvocationHeader, loadAddons } from "../agent/addons.js";
import { BUILTIN_ADDONS } from "../agent/builtinAddons.js";
import {
  createProviderForEndpoint,
  endpointSpecFromSettings,
  type EndpointSpec,
} from "../config/providerFactory.js";
import { Session } from "./session.js";
import { SessionStats } from "./sessionStats.js";
import {
  DEFAULT_API_KEY_ENV,
  describeSettings,
  resolveApiKey,
  setSetting,
  setSettingPath,
  settingsSchema,
  type Settings,
} from "../config/settings.js";
import { MODEL_PRICING, contextWindowFor, pricingFor } from "../config/pricing.js";
import type { Addon } from "../agent/addons.js";
import type { ToolRegistry } from "../agent/tool.js";
import { Transcript, stripSystemReminders } from "../state/transcript.js";

/** Ceilings on the images one user message may carry. The desktop app enforces
 *  its own, smaller caps at the picker; these exist because the engine must not
 *  trust a frontend — an unbounded batch of base64 would be paid for in vision
 *  calls before anything noticed. */
const MAX_IMAGES_PER_MESSAGE = 8;
/** ~9 MB of base64, i.e. roughly a 6.5 MB image. */
const MAX_IMAGE_DATA_CHARS = 9_000_000;

/** When a just-persisted setting takes effect, relative to the running session. */
type SettingTiming = "session" | "nextTurn" | "restart" | "clear";

/** The human-readable note reported for each timing after `/settings <key> <value>`. */
const SETTING_TIMING_NOTE: Record<SettingTiming, string> = {
  session: "Applied to the current session.",
  nextTurn: "Takes effect on the next turn.",
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
 *   nextTurn — the running session re-reads it at the start of the next turn
 *   restart  — wired outside the Engine (hooks, MCP); only a restart reads it
 *   clear    — a fresh session via /clear picks it up
 */
export const SETTING_TIMING: Record<keyof typeof settingsSchema.shape, SettingTiming> = {
  // The five connection keys are "session" because applySettingLive rebuilds the
  // provider from them on the spot (see CONNECTION_SETTING_KEYS). They used to
  // say "restart", which was true then and is a lie now — and the note this map
  // prints is the only thing telling the user whether their change took.
  provider: "session",
  model: "nextTurn",
  smallModel: "nextTurn",
  vision: "nextTurn",
  // The vision endpoint is resolved per describe call, from a client cached on
  // the connection itself — so a change is live the next time an image is
  // looked at, with no provider rebuild to schedule.
  visionConnection: "session",
  baseUrl: "session",
  apiKeyEnv: "session",
  apiKey: "session",
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
  allowInsecureTls: "session",
  reuseCheck: "clear",
};

/**
 * The settings keys that describe WHERE inference happens. Changing any of them
 * rebuilds the provider inside the running session, so this set and the "session"
 * timings above are two statements of the same fact — keep them in step.
 */
const CONNECTION_SETTING_KEYS: ReadonlySet<keyof typeof settingsSchema.shape> = new Set([
  "provider",
  "baseUrl",
  "apiKey",
  "apiKeyEnv",
  "allowInsecureTls",
]);

export interface EngineOptions {
  cwd: string;
  settings: Settings;
  provider: Provider;
  registry: ToolRegistry;
  addons?: Addon[];
  /**
   * Constructs the Provider for a resolved endpoint. Defaults to the real
   * factory; injectable so tests hand out FakeProviders without touching the
   * network.
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
  /** Chain of ALL outstanding exclusive work (turns, /compact); idle() awaits it. */
  private turnPromise: Promise<void> = Promise.resolve();
  /** True while exclusive session work is in flight — set synchronously so a same-tick send is refused. */
  private busy = false;
  private readonly scheduler: CronScheduler;
  private readonly hookRunner: HookRunner;
  /**
   * Engine-level memory of the OVERDRIVE toggle so a /clear-created fresh
   * session inherits it — the UI persists the state and re-sends it on link,
   * but the engine must not lose it between those two moments.
   */
  private overdriveEnabled = false;
  /** `!` commands received mid-turn, run in order once the engine goes idle. */
  private readonly pendingBangs: string[] = [];

  constructor(private readonly opts: EngineOptions) {
    this.scheduler = new CronScheduler({
      stateDir: join(this.opts.cwd, STATE_DIR_NAME),
      isIdle: () => !this.session.isBusy(),
      // A scheduled prompt that reads as a slash command routes as one;
      // anything else starts a plain user turn.
      enqueue: (prompt) => {
        const slash = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
        if (slash) this.handleSlash(slash[1]!, slash[2]);
        else this.send({ type: "user_message", text: prompt });
      },
    });
    this.hookRunner = new HookRunner({ cwd: this.opts.cwd, hooks: this.opts.settings.hooks });
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
      ...(this.opts.addons ? { addons: this.opts.addons } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(initialMessages ? { initialMessages } : {}),
      ...(stats ? { stats } : {}),
    });
    session.services.cron = this.scheduler;
    if (this.overdriveEnabled) session.setOverdrive(true);
    return session;
  }

  start(): void {
    this.announceSession();
    this.publishModelCatalog();
  }

  /**
   * Fetches the endpoint's real model catalog in the background to populate the
   * UI's model picker. Best-effort — a catalog-less endpoint changes nothing.
   *
   * It deliberately does NOT warn when the configured model is absent from the
   * catalog: many valid models are simply not listed in /models (custom ids,
   * gated models, aliases), so that warning fired constantly on models that
   * answered fine. A genuinely bad model surfaces a real error on the first turn
   * — that is the honest signal, not a preemptive guess.
   */
  private publishModelCatalog(): void {
    const provider = this.opts.provider;
    if (!provider.listModels) return;
    void provider
      .listModels()
      .then((models) => {
        if (models.length === 0) return;
        this.emit({ type: "model_catalog", models });
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
      // Addons ride in the command list as `/<name>`, so the frontend's slash
      // popup lists them next to the built-ins with no extra wiring.
      commands: [...SLASH_COMMANDS.map(({ cmd, args, desc }) => ({ cmd, args, desc })), ...this.addonCommands()],
      rateCard: buildRateCard(this.opts.settings),
      sessionId: this.session.id,
      cwd: this.opts.cwd,
      model: this.opts.settings.model,
      overdrive: this.session.isOverdrive(),
      addons: this.addonSummaries(),
    });
    this.emit({ type: "task_list_updated", tasks: this.session.tasks.list() });
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

  /** Resolves when ALL outstanding exclusive work (turn, /compact) completes. */
  idle(): Promise<void> {
    return this.turnPromise;
  }

  /**
   * Stop every background job (detached bash processes, monitors, background
   * agents). Interrupt alone does NOT reap these — they are spawned detached (own
   * process group) precisely so they outlive a turn — so shutdown must call this,
   * or closing a workspace leaves orphaned processes (e.g. a dev server) running.
   */
  stopBackgroundJobs(): void {
    this.session.background.stopAll();
  }

  // ── Addons ─────────────────────────────────────────────────────────────────

  /** The installed roster, in the shape the wire and the UI both want. */
  private addonSummaries(): { name: string; description: string; builtin: boolean }[] {
    return (this.opts.addons ?? []).map((a) => ({
      name: a.name,
      description: a.description,
      builtin: a.source === "builtin",
    }));
  }

  /** Installed addons as slash commands, so `/<name>` invokes one from the composer. */
  private addonCommands(): SlashCommandInfo[] {
    return (this.opts.addons ?? []).map((a) => ({
      cmd: `/${a.name}`,
      args: "[args]",
      desc: a.description,
    }));
  }

  /**
   * Announce the roster AND the refreshed command registry.
   *
   * The registry travels because the frontend's palette is built from what the
   * engine sends, never derived — and it was only ever sent on session_started.
   * An addon installed mid-session therefore appeared in the Addons view but not
   * under `/` until the next restart, even though the engine would have
   * dispatched it happily. Same list the announcement builds, so the two cannot
   * disagree.
   */
  private emitAddonsUpdated(): void {
    this.emit({
      type: "addons_updated",
      addons: this.addonSummaries(),
      commands: [...SLASH_COMMANDS.map(({ cmd, args, desc }) => ({ cmd, args, desc })), ...this.addonCommands()],
    });
  }

  /**
   * Reloads the roster from disk in place. The array is mutated rather than
   * replaced because the live Session captured this exact reference at
   * construction — reassigning it would leave the running session on the old
   * list until the next /clear.
   */
  private reloadAddons(): Addon[] {
    const loaded = loadAddons(this.opts.cwd);
    if (this.opts.addons) {
      this.opts.addons.length = 0;
      this.opts.addons.push(...loaded);
    } else {
      this.opts.addons = loaded;
    }
    return loaded;
  }

  /**
   * `/<addon-name>` — the same invocation path the model's Addon tool takes,
   * reached by the user typing a slash command. The addon's instructions enter
   * the conversation and the turn runs, so "/magentron refactor the loader"
   * behaves exactly like asking for the work with that addon already loaded.
   *
   * Returns false when no addon owns the name, letting the caller fall through
   * to the unknown-command message.
   */
  private handleAddonCommand(name: string, args?: string): boolean {
    const addon = (this.opts.addons ?? []).find((a) => a.name === name);
    if (!addon) return false;
    const trimmed = args?.trim() ?? "";
    const body = addon.body.includes("$ARGUMENTS")
      ? addon.body.replaceAll("$ARGUMENTS", trimmed)
      : addon.body + (trimmed ? `\nARGUMENTS: ${trimmed}` : "");
    this.emit({ type: "command_output", text: `🧩 ${addon.name} loaded — following its instructions.` });
    this.startExclusive(`running /${addon.name}`, () =>
      this.session.runTurn(addonInvocationHeader(addon.name) + body),
    );
    return true;
  }

  // ── Create-addon wizard ────────────────────────────────────────────────────

  /**
   * generate_addon: author an addon .md from the user's plain-language
   * description with one focused inference call, validate it, and retry with the
   * error appended (up to 3 attempts) before giving up. Emits addon_draft either
   * way — the frontend previews the text or shows the failure. Backgrounded and
   * stoppable, never tied to a turn.
   */
  private addonGenBusy = false;

  private startAddonGeneration(description: string, opts: AddonGenOptions = {}): void {
    if (this.addonGenBusy) {
      this.emit({ type: "command_output", text: "🧩 an addon generation is already running." });
      return;
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      this.emit({ type: "addon_draft", ok: false, error: "Describe the addon first — the description was empty." });
      return;
    }
    this.addonGenBusy = true;
    this.emit({
      type: "background_notification",
      taskId: "addon-gen",
      kind: "start",
      payload: { description: "generating addon" },
    });
    void this.generateAddon(description.trim(), opts)
      .then((draft) => this.emit({ type: "addon_draft", ...draft }))
      .catch((err: Error) => this.emit({ type: "addon_draft", ok: false, error: err.message }))
      .finally(() => {
        this.addonGenBusy = false;
        this.emit({
          type: "background_notification",
          taskId: "addon-gen",
          kind: "exit",
          payload: { description: "generating addon" },
        });
      });
  }

  private async generateAddon(
    description: string,
    opts: AddonGenOptions = {},
  ): Promise<{ ok: boolean; text?: string; suggestedFilename?: string; error?: string }> {
    const takenNames = (this.opts.addons ?? []).map((a) => a.name);
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
      // file needs no tools, and runInference is one focused call on the chosen
      // model (defaulting to the session's main model — addon authoring wants
      // the capable model, not smallModel).
      const authorRole = promptTextIfEnabled(ADDON_AUTHOR_ROLE);
      if (authorRole === undefined) {
        return {
          ok: false,
          error: "Addon authoring is switched off — addon-author.role is empty in the prompt registry.",
        };
      }
      const raw = await this.session.runInference({
        system: authorRole,
        user: buildAddonPrompt(description, takenNames, opts) + feedback,
        maxTokens: 4096,
        model: authorModel,
        ...(authorProvider ? { provider: authorProvider } : {}),
      });
      const text = repairAddonText(raw);
      const check = validateAddonText(text);
      if (check.ok) return { ok: true, text, suggestedFilename: check.filename };
      lastError = check.error;
      feedback = `\n\nYour previous attempt was rejected by the validator:\n${check.error}\nReturn ONLY the corrected file, starting with the "---" line — no sentence before it.`;
    }
    return { ok: false, error: `Generation failed validation after 3 attempts: ${lastError}` };
  }

  /**
   * install_addon: re-validate (never trust a stale draft), write into
   * .magentra/addons/, and reload the roster in place so the live session can
   * invoke the new addon on its very next request.
   */
  private installAddon(filename: string, text: string): void {
    if (!/^[a-z][a-z0-9_-]*\.md$/.test(filename)) {
      this.emit({ type: "error", message: `install_addon: filename "${filename}" must match <slug>.md`, fatal: false });
      return;
    }
    const check = validateAddonText(text);
    if (!check.ok) {
      this.emit({ type: "error", message: `install_addon: ${check.error}`, fatal: false });
      return;
    }
    const dir = join(this.opts.cwd, ".magentra", ADDONS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), text.endsWith("\n") ? text : text + "\n");

    this.reloadAddons();
    this.emitAddonsUpdated();
    const name = filename.slice(0, -3);
    this.emit({
      type: "command_output",
      text: `🧩 installed the ${name} addon (.magentra/${ADDONS_DIR}/${filename}) — invoke it with /${name} or let the agent reach for it`,
    });
  }

  /**
   * export_addon: hand the app an addon's .md text so it can save it anywhere.
   * A workspace file wins (it may be a customized override); otherwise the
   * built-in's shipped text — so every addon in the list can be exported, not
   * just user-authored ones.
   */
  private exportAddon(name: string): void {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      this.emit({ type: "addon_export", ok: false, name: String(name), error: "invalid addon name" });
      return;
    }
    const dir = join(this.opts.cwd, ".magentra", ADDONS_DIR);
    for (const rel of [`${name}.md`, join(name, ADDON_ENTRY)]) {
      const p = join(dir, rel);
      try {
        if (statSync(p).isFile()) {
          this.emit({ type: "addon_export", ok: true, name, filename: `${name}.md`, text: readFileSync(p, "utf8") });
          return;
        }
      } catch {
        // not this candidate — try the next / fall through to built-ins
      }
    }
    const builtin = BUILTIN_ADDONS.find((b) => b.name === name);
    if (builtin) {
      this.emit({ type: "addon_export", ok: true, name, filename: `${name}.md`, text: builtin.text });
      return;
    }
    this.emit({ type: "addon_export", ok: false, name, error: `no source found for addon "${name}"` });
  }

  /**
   * The single seam for starting exclusive session work — a user turn, /compact,
   * or /compact. Two invariants it exists to hold:
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
        this.startExclusive("sending another message", async () =>
          this.session.runTurn(await this.withImageDescriptions(request.text, request.images)),
        );
        break;
      case "steer_message":
        // The frontend saw a busy turn; if it ended in the meantime, the
        // steering text is just the next user message. Either way the images
        // are described first — a running turn must not be steered by a
        // reference to a picture nothing has looked at yet.
        void this.withImageDescriptions(request.text, request.images).then((text) => {
          if (this.session.isBusy()) this.session.steer(text);
          else this.startExclusive("sending another message", () => this.session.runTurn(text));
        });
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
        // the turn, every subagent, and every background job.
        const wasBusy = this.busy || this.session.isBusy();
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
        const stopped = [wasBusy ? "turn" : ""].filter(Boolean);
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
      case "set_connection":
        this.handleSetConnection(request.connection);
        break;
      case "set_vision":
        // Refused rather than stored when there is no endpoint behind it: a
        // frontend showing ON while every image fails at the wall is worse than
        // a switch that says why it would not move.
        if (request.enabled && !this.opts.settings.visionConnection) {
          this.emit({
            type: "error",
            message: "Vision cannot be switched on: this workspace has no vision model. Choose one in the connection wizard.",
            fatal: false,
          });
          break;
        }
        this.opts.settings.vision = request.enabled;
        this.emit({
          type: "command_output",
          text: request.enabled
            ? `👁 vision on — images go to ${this.opts.settings.visionConnection?.model ?? "the vision model"}`
            : "👁 vision off — images cannot be attached or read",
        });
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
      case "generate_addon":
        this.startAddonGeneration(request.description, {
          ...(request.model ? { model: request.model } : {}),
          ...(request.context ? { context: request.context } : {}),
          ...(request.connection ? { connection: request.connection } : {}),
        });
        break;
      case "install_addon":
        this.installAddon(request.filename, request.text);
        break;
      case "export_addon":
        this.exportAddon(request.name);
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

  private handleSlash(command: string, args?: string): void {
    // Case-insensitive: the scheduler's prompt regex and users both produce
    // mixed case ("/Compact"); the dispatch must not silently no-op.
    switch (command.replace(/^\//, "").toLowerCase()) {
      case "help":
        this.emit({ type: "command_output", text: renderHelp() });
        break;
      case "addons":
        this.emit({ type: "command_output", text: this.renderAddons() });
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
              text: did ? "Conversation compacted." : "Nothing to compact yet.",
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
              ? "⚡ OVERDRIVE engaged — nothing asks (deletions, .magentra and .env edits, writes outside the workspace all run), and the turn self-verifies before it ends."
              : "OVERDRIVE disengaged — deletions and edits to .magentra/.env ask again; turns end without the self-verify pass.",
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
      case "settings":
        this.handleSettings(args);
        break;
      case "resume":
        if (args) this.resumeSession(args.trim());
        else this.emit({ type: "command_output", text: "Usage: /resume <session-id>" });
        break;
      default: {
        // An installed addon owns its own `/<name>`; only a name no addon
        // claims is an unknown command.
        const name = command.replace(/^\//, "").toLowerCase();
        if (this.handleAddonCommand(name, args)) break;
        this.emit({ type: "command_output", text: `Unknown command: /${command}. Try /help.` });
      }
    }
  }

  /**
   * The `/addons` listing: every installed addon and how to invoke it. Nothing
   * to toggle — an addon is always available, and only its description is in
   * context until it is invoked. Extension points must be discoverable
   * in-product, not only in docs.
   */
  private renderAddons(): string {
    const addons = this.opts.addons ?? [];
    if (addons.length === 0) {
      return `No addons installed. Drop a Markdown file in .magentra/${ADDONS_DIR}/ (or a directory with an ${ADDON_ENTRY}) and it loads on the next /clear.`;
    }
    const lines = [
      `Addons (.magentra/${ADDONS_DIR}/) — procedures the agent loads on demand; invoke one yourself with /<name>:`,
    ];
    for (const addon of addons) {
      lines.push(`  /${addon.name.padEnd(18)} ${addon.description}`);
      // Name the actual file, not just the tier: the next thing a user wants
      // after reading this list is to open the one they mean to edit.
      const origin = addon.path ? relative(this.opts.cwd, addon.path) : "built-in";
      const extras = addon.resources.length > 0 ? `, ${addon.resources.length} bundled file(s)` : "";
      lines.push(`   ${" ".repeat(18)} (${origin}${extras})`);
    }
    lines.push("", this.extensionLines());
    return lines.join("\n");
  }

  /** Loaded-extension summary lines, shared by /addons and /session. Only
   * user-facing features are reported here — hooks and MCP servers are internal
   * plumbing that isn't surfaced as a product feature yet, so they get no stats
   * line (a "0 configured" readout for a feature the user has no way to use only
   * misinforms). Add them back here if/when they ship as real features. */
  private extensionLines(): string {
    return `  Addons installed:      ${(this.opts.addons ?? []).length}`;
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
   * Turn a user turn's attached images into text before it reaches the session.
   *
   * The main model is never handed a picture: each image goes to the configured
   * vision endpoint and its DESCRIPTION is folded into the message, ahead of
   * what the user typed. So the conversation — and the transcript, and any later
   * compaction — holds words that can be checked, not bytes that only one
   * endpoint could read.
   *
   * Nothing here can fail the turn. An image that cannot be looked at becomes a
   * plain note saying so, and the typed text still runs: losing the message
   * because a vision server was down would be the worse outcome.
   */
  private async withImageDescriptions(text: string, images: ImageAttachment[] | undefined): Promise<string> {
    if (!images || images.length === 0) return text;

    const rejected = (reason: string): string => {
      this.emit({ type: "error", message: `Image attachment: ${reason}`, fatal: false });
      return [
        `[The user attached ${images.length} image(s) to this message, but they could not be read: ${reason}. ` +
          `You have NOT seen them — do not describe them or draw conclusions from them; say what happened and ask the user how to proceed.]`,
        text,
      ]
        .filter((part) => part.trim() !== "")
        .join("\n\n");
    };

    const unusable = this.session.visionUnavailableReason();
    if (unusable) return rejected(unusable);
    if (images.length > MAX_IMAGES_PER_MESSAGE) {
      return rejected(`too many images (${images.length}; the limit is ${MAX_IMAGES_PER_MESSAGE} per message)`);
    }

    const blocks: string[] = [];
    for (const image of images) {
      const label = typeof image.name === "string" && image.name.trim() !== "" ? image.name.trim() : "attached image";
      if (typeof image.data !== "string" || image.data === "" || typeof image.mediaType !== "string") {
        blocks.push(`[The user attached "${label}", but it arrived malformed and was not read. You have NOT seen it.]`);
        continue;
      }
      if (image.data.length > MAX_IMAGE_DATA_CHARS) {
        blocks.push(
          `[The user attached "${label}", but it is too large to send to the vision model. You have NOT seen it.]`,
        );
        continue;
      }
      // Announced BEFORE the call, not after: describing runs inside the turn
      // lock and can take seconds, and an interface that shows nothing at all
      // while it happens reads as a message that was swallowed.
      this.emit({
        type: "command_output",
        text: `🖼 looking at ${label} with ${this.opts.settings.visionConnection?.model ?? "the vision model"}…`,
      });
      try {
        blocks.push(
          await this.session.describeImageForContext({ data: image.data, mediaType: image.mediaType, label }),
        );
      } catch (err) {
        const message = (err as Error).message;
        this.emit({ type: "error", message: `Could not look at ${label}: ${message}`, fatal: false });
        blocks.push(
          `[The user attached "${label}", but the vision model could not look at it: ${message}. ` +
            `You have NOT seen it — do not describe it or draw conclusions from it.]`,
        );
      }
    }
    return [...blocks, text].filter((part) => part.trim() !== "").join("\n\n");
  }

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

  /**
   * Mirror a just-persisted setting into the in-memory {@link Settings} (shared with the
   * live session, so a fresh session via /clear always sees it) and report when it takes
   * effect. Returns the human-readable timing note for the command output.
   */
  private applySettingLive(key: string, value: string | number | boolean): string {
    setSettingPath(this.opts.settings as unknown as Record<string, unknown>, key, value);
    const topKey = key.split(".")[0] as keyof typeof settingsSchema.shape;
    if (topKey === "retention") this.gcStateFiles();
    // Node reads the TLS flag per connection, so this one lands on the process,
    // not on the provider instance.
    if (topKey === "allowInsecureTls") this.applyInsecureTls(this.opts.settings.allowInsecureTls === true);
    // Anything that names the endpoint rebuilds the provider on the spot, which
    // is why SETTING_TIMING calls these "session": /settings baseUrl and a
    // set_connection frame are two doors into the same swap, and a user who
    // edits the endpoint by command should not have to guess that this one
    // change needs a restart while the model does not.
    if (CONNECTION_SETTING_KEYS.has(topKey)) this.rebuildProvider();
    // A passthrough key outside the schema can't reach here (setSetting rejects it),
    // but default to /clear timing rather than crash if one ever does.
    return SETTING_TIMING_NOTE[SETTING_TIMING[topKey] ?? "clear"];
  }

  /**
   * Live connection swap (set_connection frame): re-point the whole session at a
   * different API — provider shape, endpoint, key, model, context window — with
   * the conversation intact.
   *
   * The frame is the session's connection truth from here on. It is written into
   * the in-memory settings and into this process's environment, because those
   * are what every OTHER consumer resolves from, including the host named in
   * provider error messages. Rebuilding only the chat provider would leave
   * those pointed at the previous API.
   *
   * Nothing is persisted here. The app writes `.env` and
   * `.magentra/settings.json` before it sends this frame (that is what a later
   * restart boots from), so writing again would be a second, racing writer on
   * the same files.
   */
  private handleSetConnection(connection: ConnectionSpec | undefined): void {
    if (!connection || typeof connection !== "object") {
      this.emit({ type: "error", message: "set_connection needs a connection object", fatal: false });
      return;
    }
    const settings = this.opts.settings as unknown as Record<string, unknown>;
    settings.provider = connection.provider === "anthropic" ? "anthropic" : "openai-compatible";
    if (typeof connection.baseUrl === "string" && connection.baseUrl.trim() !== "") {
      settings.baseUrl = connection.baseUrl.replace(/\/+$/, "");
    } else {
      delete settings.baseUrl;
    }
    if (typeof connection.model === "string" && connection.model.trim() !== "") {
      settings.model = connection.model.trim();
    }
    if (typeof connection.contextWindow === "number" && Number.isInteger(connection.contextWindow)) {
      settings.contextWindow = connection.contextWindow;
    } else {
      delete settings.contextWindow;
    }

    // The key: one storage (the environment), so resolveApiKeySource keeps being
    // the only thing that answers "which key". A stale `apiKeyEnv` pin from the
    // previous provider is cleared for the same reason the app clears it on
    // save — it names a variable this connection does not use.
    const key = typeof connection.apiKey === "string" ? connection.apiKey.trim() : "";
    delete settings.apiKeyEnv;
    const keyVar = connection.provider === "anthropic" ? "ANTHROPIC_API_KEY" : DEFAULT_API_KEY_ENV;
    if (key) {
      process.env[keyVar] = key;
      delete settings.apiKey;
    } else {
      // A keyless endpoint must stop sending the old key — including the one a
      // stored settings value or an inherited shell variable would supply.
      for (const name of [keyVar, "MAGENTRA_API_KEY", "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"]) {
        delete process.env[name];
      }
      delete settings.apiKey;
    }

    // The vision endpoint travels with the connection because it is saved with
    // it. ABSENT MEANS CLEARED — leaving a previous vision model in place would
    // keep describing images through an endpoint the user removed, and would
    // leave `vision` switched on with nothing behind it.
    if (connection.vision && typeof connection.vision.model === "string" && connection.vision.model.trim() !== "") {
      const vision = connection.vision;
      settings.visionConnection = {
        provider: vision.provider === "anthropic" ? "anthropic" : "openai-compatible",
        model: vision.model.trim(),
        ...(typeof vision.baseUrl === "string" && vision.baseUrl.trim() !== ""
          ? { baseUrl: vision.baseUrl.replace(/\/+$/, "") }
          : {}),
        ...(typeof vision.apiKey === "string" && vision.apiKey.trim() !== "" ? { apiKey: vision.apiKey.trim() } : {}),
        ...(typeof vision.contextWindow === "number" && Number.isInteger(vision.contextWindow)
          ? { contextWindow: vision.contextWindow }
          : {}),
        ...(vision.insecureTls === true ? { allowInsecureTls: true } : {}),
      };
      settings.vision = vision.enabled === true;
    } else {
      delete settings.visionConnection;
      settings.vision = false;
    }

    // Process-wide, so it is the OR of both endpoints: Node reads this per TLS
    // connection, and a self-signed vision box needs it as much as a
    // self-signed main one.
    const insecure =
      (connection.insecureTls === true && connection.provider !== "anthropic") ||
      (connection.vision?.insecureTls === true && connection.vision.provider !== "anthropic");
    settings.allowInsecureTls = insecure;
    this.applyInsecureTls(insecure);

    this.rebuildProvider();
    // The new endpoint has its own catalog; the picker must stop offering the
    // previous API's models.
    this.publishModelCatalog();
  }

  /**
   * Rebuild the session provider from the current settings, in place. Shared by
   * the set_connection frame and by /settings on any connection key.
   *
   */
  private rebuildProvider(): void {
    const spec = endpointSpecFromSettings(this.opts.settings, resolveApiKey(this.opts.settings));
    const provider = (this.opts.providerFactory ?? createProviderForEndpoint)(spec);
    // opts.provider is what publishModelCatalog and every new session read.
    this.opts.provider = provider;
    this.session.setProvider(provider);
  }

  /**
   * The `verify=False` escape hatch, toggled live. Node reads this variable per
   * TLS connection, so flipping it here covers every later provider fetch — the
   * same mechanism bootstrapEngine uses at boot, and just as loud, because it
   * disables man-in-the-middle protection process-wide.
   */
  private applyInsecureTls(enabled: boolean): void {
    if (enabled) {
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      this.emit({
        type: "error",
        message:
          "allowInsecureTls is ON — TLS certificate verification is disabled for this engine. Only use with servers you own.",
        fatal: false,
      });
      return;
    }
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
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
  { cmd: "/clear", args: "", desc: "start a fresh session (history cleared)" },
  { cmd: "/compact", args: "", desc: "compact the conversation now" },
  { cmd: "/session", args: "", desc: "this session's usage: tokens per model, API/wall time, code churn, context now" },
  { cmd: "/tasks", args: "", desc: "show the task list" },
  { cmd: "/addons", args: "", desc: "list installed addons; invoke one with /<name>" },
  { cmd: "/overdrive", args: "[on|off]", desc: "fully-autonomous stance: nothing asks, self-verified completion" },
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
    "Glossary (addons, deletion guard): SETTINGS → GLOSSARY in the app.",
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
      // Strip injected reminders so a restored session shows the user's own
      // words, not the harness scaffolding appended to them. `textOf` joins all
      // text blocks, so a real message + appended reminder block lands here as
      // one string — stripping (not a startsWith skip) is what cleans it.
      const text = stripSystemReminders(textOf(msg));
      if (!text) continue;
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

// ── Create-addon wizard: authoring prompt ────────────────────────────────────

/** The persona behind generate_addon: it writes exactly one file, no commentary. */
const ADDON_AUTHOR_ROLE = definePrompt({
  id: "addon-author.role",
  group: "5 · Background inference calls",
  label: "Addon author role",
  channel: "subagent",
  where:
    "Role of the call behind the create-addon wizard (generate_addon). Its entire reply is written straight to a .md file, so any commentary corrupts the output.",
  text: `You are an addon author for the MAGENTRA agent workbench. An addon is a
procedure a coding agent loads on demand: its description decides WHEN the agent
reaches for it, and its body is the method the agent then follows.

An addon exists to buy PREDICTABILITY — the same process every run. Judge every
line you write by that: it earns its place only if it changes what the agent
actually does. A line the agent would already obey ("be careful", "be thorough")
costs tokens and buys nothing.

Your entire final response must be EXACTLY the content of one addon .md file —
no code fences, no commentary before or after it.`,
});

/** Optional knobs the wizard passes into addon authoring. */
type AddonGenOptions = {
  model?: string;
  context?: string;
  connection?: { provider: "anthropic" | "openai-compat"; baseUrl?: string; apiKey: string; model: string };
};

/**
 * The format the generator must produce — one place, so the wizard and the
 * validator agree.
 *
 * The "Writing the body" rules below are MAGENTRA's adaptation of the
 * skill-authoring principles set out by Mat Pocock in his "writing great skills"
 * reference: predictability as the root virtue, completion criteria that are
 * checkable, positive phrasing over prohibition, leading words that recruit the
 * model's existing priors, and pruning anything the agent already does by
 * default. Credited here rather than in the prompt text — the model needs the
 * rule, not its provenance, and every token in a side-call prompt is paid on
 * every generation.
 */
function buildAddonPrompt(description: string, takenNames: string[], opts: AddonGenOptions = {}): string {
  const contextLine =
    opts.context && opts.context.trim()
      ? `\n\nWhen it should apply / extra detail from the user:\n"""\n${opts.context.trim()}\n"""`
      : "";

  return `The user wants a new addon. Their description:
"""
${description}
"""${contextLine}

Already-taken addon names (choose a DIFFERENT short kebab-case name): ${takenNames.join(", ") || "(none)"}.

Produce a Markdown file in this exact shape — frontmatter with exactly these two
keys, then the procedure as the body:

---
name: <short-kebab-case-name>
description: <one line, on ONE physical line: the CONDITION for reaching for this addon — what kind of task, and what trigger words. This is the only text the agent sees before invoking, so it must be enough to decide. Name each DISTINCT situation once; two phrasings of the same situation are one trigger, not two. Say so plainly if following it costs noticeably more tokens.>
---

<the procedure the agent follows once this addon is loaded: concrete steps,
headings and bullet lists welcome. Write instructions to the agent, not prose
about the addon.>

Writing the body — these are what make an addon repeatable:
- **End every step on a checkable condition.** "Run the suite and report the
  actual output" beats "test it"; "every call site listed" beats "review the
  call sites". An agent that cannot tell done from not-done stops early.
- **State the target behaviour rather than the ban.** "Prefer X" steers; "don't
  do Y" names Y and makes it more available. Keep a prohibition only where it is
  a hard guardrail, and pair it with what to do instead.
- **Reach for a word the model already knows.** One vivid, familiar term
  ("reconnaissance pass", "smoke test", "dry run") anchors a whole behaviour more
  reliably than three sentences describing it.
- **Say each thing once.** The same instruction in two places is two places to
  fall out of step.

Hard rules:
- The frontmatter has ONLY \`name:\` and \`description:\`, and each value sits on
  ONE physical line. The parser is line-based: it splits a line at its FIRST
  colon, so punctuation inside a value — colons included — is safe, but a value
  that wraps onto a second line is lost.
- The body must be non-empty and must stand on its own: an agent reading only
  this file has to know what to do.
- Use \`$ARGUMENTS\` in the body if the addon should accept an argument from the
  user; it is substituted at invocation.`;
}

/**
 * Validates a candidate addon text; returns the suggested filename on success.
 * Shared by generation (each attempt) and installation (never trust a draft the
 * user may have edited), so both agree on what a loadable addon is.
 */
function validateAddonText(text: string): { ok: true; filename: string } | { ok: false; error: string } {
  const fm = parseFrontmatter(text);
  if (!fm.present) return { ok: false, error: "the file must open with --- frontmatter" };
  if (!fm.map.name) return { ok: false, error: "frontmatter needs a name: key" };
  if (!fm.map.description) return { ok: false, error: "frontmatter needs a description: key" };
  const slug = fm.map.name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || !/^[a-z]/.test(slug)) {
    return { ok: false, error: "name: must yield a [a-z][a-z0-9_-]* slug" };
  }
  if (fm.body.trim().length === 0) return { ok: false, error: "the Markdown body (the procedure) is empty" };
  return { ok: true, filename: `${slug}.md` };
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
 * instead of being thrown away over a leading "Here's your addon:".
 */
function repairAddonText(raw: string): string {
  const text = stripCodeFence(raw).trim();
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "---");
  return start > 0 ? lines.slice(start).join("\n").trim() : text;
}
