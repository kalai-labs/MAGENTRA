import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { STATE_DIR_NAME } from "@magentra/protocol";
import { writeFileAtomic } from "../util/fsAtomic.js";

/**
 * Fallback OpenAI-compatible endpoint for the provider and the backpack
 * embedder, used only when no `baseUrl` is configured. Any OpenAI-compatible
 * server works — set `baseUrl` to point at your own (a hosted `/v1` API, a
 * gateway, or a local server).
 */
export const DEFAULT_OPENAI_BASE_URL = "https://api.deepinfra.com/v1/openai";

/**
 * Env var the app writes and the engine reads when `apiKeyEnv` is unset and the
 * provider is OpenAI-compatible. The endpoint is the user's choice, so the name
 * is deliberately vendor-neutral.
 */
export const DEFAULT_API_KEY_ENV = "MAGENTRA_API_KEY";

/**
 * Env vars tried in order for an OpenAI-compatible endpoint when `apiKeyEnv` is
 * unset. `OPENAI_API_KEY` is the ecosystem convention; `DEEPINFRA_API_KEY` is a
 * legacy name workspaces provisioned by older builds were written with, kept
 * last so those `.env` files keep working without an edit.
 */
const OPENAI_COMPAT_KEY_ENV_VARS = [DEFAULT_API_KEY_ENV, "OPENAI_API_KEY", "DEEPINFRA_API_KEY"];

const permissionRuleSchema = z.string();
/** One "always allow" grant: `{ tool: "Bash", subject: "rm -rf ./tmp/build" }`.
 *  With `prefix: true` the subject is a command shape ("git push") covering
 *  every command that starts with it; prefix grants never override the
 *  deletion guard. */
const exactPermissionSchema = z.object({
  tool: z.string().min(1),
  subject: z.string().min(1),
  prefix: z.boolean().optional(),
});

export const settingsSchema = z
  .object({
    provider: z.enum(["anthropic", "openai-compatible"]).default("openai-compatible"),
    model: z.string().default("deepseek-ai/DeepSeek-V4-Flash"),
    /** Cheap model for WebFetch digestion and compaction summaries. */
    smallModel: z.string().optional(),
    /**
     * Whether the configured model can actually SEE images.
     *
     * Off by default, because most models cannot and a wrong "yes" is the
     * expensive direction: the agent captures a screenshot, receives content it
     * cannot interpret, and reports on a picture it never saw. With this off the
     * Read tool refuses image files outright and the evidence rung tells the
     * agent so, rather than leaving it to guess.
     */
    vision: z.boolean().default(false),
    baseUrl: z.string().optional(),
    /** Name of the env var holding the API key. */
    apiKeyEnv: z.string().optional(),
    /**
     * The API key itself, stored in the settings file (usually the global
     * ~/.magentra/settings.json). A SECRET: never printed by /settings (see
     * describeSettings redaction). An env var always wins over it (see resolveApiKey).
     */
    apiKey: z.string().optional(),
    /** Per-response output-token ceiling sent to the provider. Cutoffs at this
     * wall trigger the length-continuation path; a higher ceiling makes them
     * rarer. 32768 fits current models' output limits with headroom. */
    maxTokensPerResponse: z.number().int().positive().default(32768),
    /** Output-token budget per turn (input/context tokens are not counted — they are dominated by per-iteration context re-sends). */
    maxTokensPerTurn: z.number().int().positive().default(200_000),
    maxIterationsPerTurn: z.number().int().positive().default(50),
    /** Explicit override; when absent the engine uses the known window for the model (128k fallback). */
    contextWindow: z.number().int().positive().optional(),
    /** Bounds append-only workspace state; pruning runs whenever a root session starts. */
    retention: z
      .object({
        /** Top-level transcripts and legacy/subagent transcripts, newest first. */
        sessions: z.number().int().positive().default(100),
        /** Persisted task lists and background-task output files, newest first. */
        tasks: z.number().int().positive().default(100),
      })
      .default({ sessions: 100, tasks: 100 }),
    /**
     * Per-model rate card, $ per 1M tokens, overriding the built-in table in
     * pricing.ts (so a self-hosted or brand-new model can be priced without a
     * code change). All four token classes bill differently; cacheRead and
     * cacheWrite fall back to the input rate when a provider does not charge
     * for them separately. A model with no rate card anywhere reports token
     * counts with no cost estimate — never a guessed price.
     */
    pricing: z
      .record(
        z.string(),
        z.object({
          input: z.number().nonnegative(),
          output: z.number().nonnegative(),
          cacheRead: z.number().nonnegative().optional(),
          cacheWrite: z.number().nonnegative().optional(),
        }),
      )
      .default({}),
    /**
     * Clarify pre-layer: on a genuinely open-ended request ("build a game",
     * "improve this app"), the main model first asks the user up to three
     * shape-defining questions before any work starts. Root attended
     * sessions only; fail-open on any error.
     */
    clarify: z.boolean().default(true),
    // permissionMode was removed as a setting (2026-07-20): the permission
    // stance is now the session's OVERDRIVE flag alone. Old settings files
    // that still carry the key load fine — unknown keys are stripped.
    permissions: z
      .object({
        allow: z.array(permissionRuleSchema).default([]),
        deny: z.array(permissionRuleSchema).default([]),
        /**
         * Exact-subject grants written by the approval prompt's "Always allow".
         * Deliberately NOT the `allow` glob format: a command containing `*`
         * (`rm -rf ./tmp/*`) would widen into a pattern matching far more than
         * the user approved, so these are compared as literal strings only.
         * Like an explicit `allow` rule, an entry here overrides the deletion
         * guard — that is the point of the button.
         */
        allowExact: z.array(exactPermissionSchema).default([]),
      })
      .default({ allow: [], deny: [], allowExact: [] }),
    hooks: z
      .partialRecord(
        z.enum(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart"]),
        z.array(
          z.object({
            matcher: z.string().optional(),
            hooks: z.array(
              z.object({
                type: z.literal("command"),
                command: z.string(),
                timeout: z.number().int().positive().max(600).optional(),
              }),
            ),
          }),
        ),
      )
      .default({}),
    mcpServers: z.record(z.string(), z.unknown()).default({}),
    worktree: z.object({ baseRef: z.enum(["fresh", "head"]).default("fresh") }).default({ baseRef: "fresh" }),
    search: z
      .object({
        /** Master switch for the WebSearch tool; when false the tool refuses to run. */
        enabled: z.boolean().default(true),
        /** "duckduckgo" (default, no key), "brave", or "tavily". */
        provider: z.string().optional(),
        apiKeyEnv: z.string().optional(),
      })
      .default({ enabled: true }),
    embeddings: z
      .object({
        model: z.string().default("BAAI/bge-m3"),
        enabled: z.boolean().default(true),
      })
      .default({ model: "BAAI/bge-m3", enabled: true }),
    reuseCheck: z
      .object({
        // "gate" (the old refuse-once mode) was retired 2026-07-20: the check
        // never blocks anymore, it only reminds. Legacy value maps to "remind".
        mode: z.preprocess(
          (v) => (v === "gate" ? "remind" : v),
          z.enum(["remind", "off"]).default("remind"),
        ),
        /** How many of the closest existing matches to list. */
        maxHits: z.number().int().positive().max(10).default(5),
        /** Similarity at/above which the reminder is worded firmly (near-duplicate). */
        blockThreshold: z.number().min(0).max(1).default(0.75),
        /** Similarity at/above which a reminder is queued. */
        remindThreshold: z.number().min(0).max(1).default(0.5),
      })
      .default({ mode: "remind", maxHits: 5, blockThreshold: 0.75, remindThreshold: 0.5 }),
    /**
     * Skip TLS certificate verification for provider requests — the `verify=False`
     * escape hatch for self-signed certificates on servers you own (a home-lab
     * gateway, an LM box behind Caddy). Never enable for endpoints you don't
     * control: it disables man-in-the-middle protection process-wide.
     */
    allowInsecureTls: z.boolean().default(false),
    modes: z
      .object({
        /**
         * Discipline skills to activate at session start. Every skill is
         * optional and OFF unless listed here (or toggled in-session) — there
         * are no locked always-on skills.
         */
        active: z.array(z.string()).default([]),
      })
      .default({ active: [] }),
  })
  .passthrough();

export type Settings = z.infer<typeof settingsSchema>;

/** Hooks configuration keyed by lifecycle event (partial: only configured events present). */
export type Hooks = Settings["hooks"];
export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart";
export type HookMatcherEntry = NonNullable<Hooks[HookEvent]>[number];
export type HookCommand = HookMatcherEntry["hooks"][number];

export interface SettingsWarning {
  source: string;
  message: string;
}

/** Absolute path of the global settings file (~/.magentra/settings.json). */
export function globalSettingsPath(): string {
  return join(homedir(), STATE_DIR_NAME, "settings.json");
}

/** Absolute path of a workspace's project settings file (<cwd>/.magentra/settings.json). */
export function projectSettingsPath(cwd: string): string {
  return join(cwd, STATE_DIR_NAME, "settings.json");
}

/**
 * Env vars that override a settings key, and the dot-path they land on. Single
 * source of truth for both {@link applyEnvOverrides} and source attribution.
 */
// NOTE: contextWindow deliberately has NO env override. The window has exactly
// one storage (the `contextWindow` settings key) and one resolver
// (contextWindowFor) — a second write path was how a stale tiny window ended
// up shadowing a model's real one.
const ENV_OVERRIDES: ReadonlyArray<{ env: string; path: string; numeric?: boolean }> = [
  { env: "MAGENTRA_PROVIDER", path: "provider" },
  { env: "MAGENTRA_MODEL", path: "model" },
  { env: "MAGENTRA_SMALL_MODEL", path: "smallModel" },
  { env: "MAGENTRA_VISION", path: "vision" },
  { env: "MAGENTRA_BASE_URL", path: "baseUrl" },
  { env: "MAGENTRA_API_KEY_ENV", path: "apiKeyEnv" },
  { env: "MAGENTRA_MAX_ITERATIONS", path: "maxIterationsPerTurn", numeric: true },
  { env: "MAGENTRA_MAX_TOKENS_PER_TURN", path: "maxTokensPerTurn", numeric: true },
];

/**
 * Loads global (~/.magentra/settings.json) then project (.magentra/settings.json)
 * settings; project overrides global, env vars override both. Unknown keys warn,
 * never crash.
 */
export function loadSettings(cwd: string): { settings: Settings; warnings: SettingsWarning[] } {
  const warnings: SettingsWarning[] = [];
  const merged: Record<string, unknown> = {};

  for (const source of [globalSettingsPath(), projectSettingsPath(cwd)]) {
    const raw = readJson(source, warnings);
    if (raw) deepMerge(merged, raw);
  }

  applyEnvOverrides(merged);

  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    warnings.push({ source: "settings", message: parsed.error.message });
    return { settings: settingsSchema.parse({}), warnings };
  }
  const known = new Set(Object.keys(settingsSchema.shape));
  for (const key of Object.keys(merged)) {
    if (!known.has(key)) warnings.push({ source: "settings", message: `unknown key "${key}"` });
  }
  return { settings: parsed.data, warnings };
}

function readJson(path: string, warnings: SettingsWarning[]): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    warnings.push({ source: path, message: `invalid JSON: ${(err as Error).message}` });
    return undefined;
  }
}

function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(src)) {
    const existing = target[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

function applyEnvOverrides(target: Record<string, unknown>): void {
  for (const { env, path, numeric } of ENV_OVERRIDES) {
    const raw = process.env[env];
    if (raw === undefined || raw === "") continue;
    setSettingPath(target, path, numeric ? Number(raw) : raw);
  }
}

/** How an effective setting value came to be: schema default, a file layer, or an env var. */
export type SettingSourceKind = "default" | "global" | "project" | "env";

export interface EffectiveSetting {
  /** Dot-path to the leaf, e.g. "model" or "search.enabled". */
  key: string;
  value: unknown;
  source: SettingSourceKind;
}

/** Leaf keys whose value is a secret and must be masked before any display. */
const SECRET_KEYS = new Set(["apiKey"]);

/**
 * Mask a secret for display: first 3 + last 4 chars, e.g. `sk-…f3ab (redacted)`;
 * short values collapse to `(set, redacted)` so nothing recoverable leaks.
 */
function redactSecret(value: string): string {
  if (value.length <= 8) return "(set, redacted)";
  return `${value.slice(0, 3)}…${value.slice(-4)} (redacted)`;
}

/** Flatten a settings object to leaf dot-paths; arrays and empty objects are leaves. */
function flattenLeaves(obj: Record<string, unknown>, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
      for (const [k, v] of flattenLeaves(value as Record<string, unknown>, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/**
 * The effective merged settings, one entry per leaf, each attributed to the
 * layer it came from (env > project > global > default). Reuses {@link loadSettings}
 * for the merge and re-reads the raw file layers for attribution.
 */
export function describeSettings(cwd: string): EffectiveSetting[] {
  const discard: SettingsWarning[] = [];
  const globalLeaves = flattenLeaves(readJson(globalSettingsPath(), discard) ?? {});
  const projectLeaves = flattenLeaves(readJson(projectSettingsPath(cwd), discard) ?? {});
  const envPaths = new Set(ENV_OVERRIDES.filter((o) => process.env[o.env]).map((o) => o.path));
  const { settings } = loadSettings(cwd);

  const out: EffectiveSetting[] = [];
  for (const [key, value] of flattenLeaves(settings as unknown as Record<string, unknown>)) {
    let source: SettingSourceKind;
    if (envPaths.has(key)) source = "env";
    else if (projectLeaves.has(key)) source = "project";
    else if (globalLeaves.has(key)) source = "global";
    else source = "default";
    const shown = SECRET_KEYS.has(key) && typeof value === "string" ? redactSecret(value) : value;
    out.push({ key, value: shown, source });
  }
  return out;
}

/** Set a dot-path leaf on a plain object, creating intermediate objects as needed. */
export function setSettingPath(target: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = node[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/** Removes a (possibly nested) key so an optional setting can fall back to its default. */
export function deleteSettingPath(target: Record<string, unknown>, dotPath: string): void {
  const parts = dotPath.split(".");
  let node: Record<string, unknown> | undefined = target;
  for (let i = 0; i < parts.length - 1 && node; i++) {
    const next: unknown = node[parts[i]!];
    node = next !== null && typeof next === "object" && !Array.isArray(next) ? (next as Record<string, unknown>) : undefined;
  }
  if (node) delete node[parts[parts.length - 1]!];
}

/** Coerce a string argument to boolean/number where it plainly reads as one; otherwise leave it a string. */
export function coerceSettingValue(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw) && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

export interface AppliedSetting {
  file: string;
  key: string;
  value: string | number | boolean;
}

/** Which settings file {@link setSetting} writes to. */
export type SettingsTarget = "auto" | "global";

/**
 * Persist a single setting, validated through {@link settingsSchema}. With
 * `target: "auto"` (default) writes the project file when the cwd is a workspace
 * (has a `.magentra/` dir), else the global file; `target: "global"` always writes
 * the global file (~/.magentra/settings.json) — used for `/settings global …` and
 * the first-boot API-key prompt. A secret key (apiKey) always goes to the global
 * file — never the shareable project file. Creates the file if absent, at mode 0600 (it may
 * hold a secret); existing files keep their permissions. Throws with a clear
 * message (writing nothing) on an unknown key or a value the schema rejects.
 */
export function setSetting(
  cwd: string,
  dotPath: string,
  rawValue: string,
  target: SettingsTarget = "auto",
): AppliedSetting {
  const shape = settingsSchema.shape;
  const topKey = dotPath.split(".")[0]!;
  if (!(topKey in shape)) {
    throw new Error(`Unknown setting "${dotPath}". Valid keys: ${Object.keys(shape).sort().join(", ")}`);
  }

  const value = coerceSettingValue(rawValue);
  const file =
    target === "global" || SECRET_KEYS.has(topKey) || !existsSync(join(cwd, STATE_DIR_NAME))
      ? globalSettingsPath()
      : projectSettingsPath(cwd);
  const discard: SettingsWarning[] = [];
  const candidate: Record<string, unknown> = structuredClone(readJson(file, discard) ?? {});
  // "auto" unsets the key: the schema default (or model-aware resolution, for
  // contextWindow) takes over again. It must clear EVERY layer — settings
  // merge project over global, so a value left in the other file would
  // silently win right back.
  const unset = rawValue === "auto";
  if (unset) {
    for (const layer of [globalSettingsPath(), projectSettingsPath(cwd)]) {
      if (layer === file || !existsSync(layer)) continue;
      const other: Record<string, unknown> = structuredClone(readJson(layer, discard) ?? {});
      deleteSettingPath(other, dotPath);
      writeSettingsFile(layer, other);
    }
    deleteSettingPath(candidate, dotPath);
  } else {
    setSettingPath(candidate, dotPath, value);
  }

  const parsed = settingsSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path.join(".") === dotPath) ?? parsed.error.issues[0];
    const where = issue && issue.path.length ? `"${issue.path.join(".")}"` : `"${dotPath}"`;
    throw new Error(`Invalid value for ${where}: ${issue?.message ?? "does not match the settings schema"}`);
  }

  writeSettingsFile(file, candidate);
  return { file, key: dotPath, value };
}

/**
 * Persist a settings layer: atomically, at 0600.
 *
 * ATOMIC because this file has two writers — the engine (here) and the desktop
 * app, which writes the same `.magentra/settings.json` when a connection is
 * saved. A plain write leaves a window in which the other process reads a
 * truncated file, and the reader treats unparseable settings as "none", which
 * presents as a workspace that lost its endpoint and key.
 *
 * 0600 because the layer may hold `apiKey`. writeFileAtomic applies the mode to
 * the temporary file, so it takes effect on every write rather than only on
 * creation — a settings file that was created world-readable stops being one.
 */
function writeSettingsFile(file: string, contents: Record<string, unknown>): void {
  writeFileAtomic(file, `${JSON.stringify(contents, null, 2)}\n`, 0o600);
}

/**
 * Appends one exact-subject permission grant to `permissions.allowExact` and
 * persists it. Writes the project file when the cwd is a workspace, else the
 * global one — the same layering {@link setSetting} uses, so a grant made in a
 * workspace stays scoped to that workspace.
 *
 * Separate from {@link setSetting} because that writes a single scalar at a dot
 * path; this has to read the existing array, append, and dedupe. Returns false
 * when the grant was already present (nothing written).
 */
export function addExactPermission(cwd: string, tool: string, subject: string, prefix = false): boolean {
  const file = existsSync(join(cwd, STATE_DIR_NAME)) ? projectSettingsPath(cwd) : globalSettingsPath();
  const discard: SettingsWarning[] = [];
  const candidate: Record<string, unknown> = structuredClone(readJson(file, discard) ?? {});
  const permissions = (candidate.permissions ??= {}) as Record<string, unknown>;
  const existing = Array.isArray(permissions.allowExact) ? [...permissions.allowExact] : [];
  if (existing.some((e) => isSameGrant(e, tool, subject, prefix))) return false;
  existing.push({ tool, subject, ...(prefix ? { prefix: true } : {}) });
  permissions.allowExact = existing;

  const parsed = settingsSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`Could not save the permission grant: ${parsed.error.message}`);

  writeSettingsFile(file, candidate);
  return true;
}

function isSameGrant(entry: unknown, tool: string, subject: string, prefix: boolean): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { tool?: unknown }).tool === tool &&
    (entry as { subject?: unknown }).subject === subject &&
    ((entry as { prefix?: unknown }).prefix === true) === prefix
  );
}

/** Where a resolved key came from — surfaced so a wrong one can be explained. */
export interface ApiKeySource {
  key: string | undefined;
  /** The env var it came from, "settings" for a stored key, or undefined. */
  from: string | undefined;
  /** Set when `apiKeyEnv` names a variable that is not present in the environment. */
  danglingKeyEnv?: string;
}

/** A blank env var is not a key. Treating "" as "set" hands the provider an
 *  empty Bearer token, which comes back as an authentication failure. */
function envKey(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Resolves the API key for the configured provider, and says where it came from.
 *
 * Order: the configured `apiKeyEnv`, then the standard env names, then the key
 * stored in settings. An env var wins so a container or CI can override.
 *
 * The middle step is load-bearing and used to be missing. `apiKeyEnv` was a
 * PIN: naming a variable meant nothing else was consulted, so a stale pin left
 * behind by a previous provider — `DEEPINFRA_API_KEY`, say, after switching to
 * a different endpoint — sent resolution straight past the key the app had just
 * written into `MAGENTRA_API_KEY` and down to whatever `settings.apiKey` still
 * held. The result was one provider's key confidently sent to another's URL,
 * reported as "API key rejected", with the correct key sitting unused in the
 * environment the whole time.
 */
export function resolveApiKeySource(settings: Settings): ApiKeySource {
  const names =
    settings.provider === "anthropic" ? ["ANTHROPIC_API_KEY"] : [...OPENAI_COMPAT_KEY_ENV_VARS];
  const pinned = settings.apiKeyEnv;
  if (pinned) {
    const value = envKey(pinned);
    if (value !== undefined) return { key: value, from: pinned };
  }
  for (const name of names) {
    if (name === pinned) continue; // already tried
    const value = envKey(name);
    if (value !== undefined) {
      return {
        key: value,
        from: name,
        ...(pinned ? { danglingKeyEnv: pinned } : {}),
      };
    }
  }
  const stored = settings.apiKey?.trim() ? settings.apiKey : undefined;
  return {
    key: stored,
    from: stored !== undefined ? "settings" : undefined,
    ...(pinned ? { danglingKeyEnv: pinned } : {}),
  };
}

/** The resolved API key. See {@link resolveApiKeySource} for provenance. */
export function resolveApiKey(settings: Settings): string | undefined {
  return resolveApiKeySource(settings).key;
}
