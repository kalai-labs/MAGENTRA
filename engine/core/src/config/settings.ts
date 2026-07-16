import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { STATE_DIR_NAME } from "@magentra/protocol";

/** Default OpenAI-compatible endpoint (DeepInfra) used by the provider and the backpack embedder. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.deepinfra.com/v1/openai";

const permissionRuleSchema = z.string();

export const settingsSchema = z
  .object({
    provider: z.enum(["anthropic", "openai-compatible"]).default("openai-compatible"),
    model: z.string().default("deepseek-ai/DeepSeek-V4-Flash"),
    /** Cheap model for WebFetch digestion and compaction summaries. */
    smallModel: z.string().optional(),
    baseUrl: z.string().optional(),
    /** Name of the env var holding the API key. */
    apiKeyEnv: z.string().optional(),
    /**
     * The API key itself, stored in the settings file (usually the global
     * ~/.magentra/settings.json). A SECRET: never printed by /settings (see
     * describeSettings redaction). An env var always wins over it (see resolveApiKey).
     */
    apiKey: z.string().optional(),
    maxTokensPerResponse: z.number().int().positive().default(8192),
    /** Output-token budget per turn (input/context tokens are not counted — they are dominated by per-iteration context re-sends). */
    maxTokensPerTurn: z.number().int().positive().default(200_000),
    maxIterationsPerTurn: z.number().int().positive().default(50),
    contextWindow: z.number().int().positive().default(160_000),
    compactionThreshold: z.number().min(0.1).max(1).default(0.8),
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
    permissionMode: z.enum(["default", "acceptEdits", "plan", "bypass"]).default("default"),
    permissions: z
      .object({
        allow: z.array(permissionRuleSchema).default([]),
        deny: z.array(permissionRuleSchema).default([]),
      })
      .default({ allow: [], deny: [] }),
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
        /** "gate" refuses an un-searched new-file Write once, "remind" only nudges, "off" disables the check. */
        mode: z.enum(["gate", "remind", "off"]).default("gate"),
        /** How many of the closest existing matches to list. */
        maxHits: z.number().int().positive().max(10).default(5),
        /** Similarity at/above which a new-file Write is blocked (gate mode). */
        blockThreshold: z.number().min(0).max(1).default(0.75),
        /** Similarity at/above which a reminder is queued instead of a block. */
        remindThreshold: z.number().min(0).max(1).default(0.5),
      })
      .default({ mode: "gate", maxHits: 5, blockThreshold: 0.75, remindThreshold: 0.5 }),
    modes: z
      .object({
        /**
         * Optional modes to activate (grill, entropy, reshape). The seven core
         * quality modes are always on and need not be listed — see
         * CORE_MODE_IDS; any core id listed here is redundant and ignored.
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
const ENV_OVERRIDES: ReadonlyArray<{ env: string; path: string; numeric?: boolean }> = [
  { env: "MAGENTRA_PROVIDER", path: "provider" },
  { env: "MAGENTRA_MODEL", path: "model" },
  { env: "MAGENTRA_SMALL_MODEL", path: "smallModel" },
  { env: "MAGENTRA_BASE_URL", path: "baseUrl" },
  { env: "MAGENTRA_API_KEY_ENV", path: "apiKeyEnv" },
  { env: "MAGENTRA_PERMISSION_MODE", path: "permissionMode" },
  { env: "MAGENTRA_MAX_ITERATIONS", path: "maxIterationsPerTurn", numeric: true },
  { env: "MAGENTRA_MAX_TOKENS_PER_TURN", path: "maxTokensPerTurn", numeric: true },
  { env: "MAGENTRA_CONTEXT_WINDOW", path: "contextWindow", numeric: true },
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
  setSettingPath(candidate, dotPath, value);

  const parsed = settingsSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path.join(".") === dotPath) ?? parsed.error.issues[0];
    const where = issue && issue.path.length ? `"${issue.path.join(".")}"` : `"${dotPath}"`;
    throw new Error(`Invalid value for ${where}: ${issue?.message ?? "does not match the settings schema"}`);
  }

  mkdirSync(dirname(file), { recursive: true });
  // mode 0600 applies only when the file is created; Node ignores it for an
  // existing file. When a secret lands, chmod the file too so a pre-existing
  // world-readable settings file stops exposing the key (no-op on Windows).
  writeFileSync(file, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
  if (SECRET_KEYS.has(topKey)) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best-effort — the write itself must never fail over permissions polish
    }
  }
  return { file, key: dotPath, value };
}

/**
 * Resolves the API key for the configured provider. An env var always wins so a
 * container/CI can override — the configured `apiKeyEnv`, else the provider's
 * default env name — and only when none is set does the key stored in
 * `settings.apiKey` (from ~/.magentra/settings.json) apply.
 */
export function resolveApiKey(settings: Settings): string | undefined {
  const fromEnv = settings.apiKeyEnv
    ? process.env[settings.apiKeyEnv]
    : settings.provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : (process.env.DEEPINFRA_API_KEY ?? process.env.OPENAI_API_KEY);
  return fromEnv ?? settings.apiKey;
}
