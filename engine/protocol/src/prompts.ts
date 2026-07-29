import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STATE_DIR_NAME } from "./branding.js";

/**
 * The prompt registry: one place that knows every piece of model-facing prose
 * the engine sends, what it is for, and where it gets injected.
 *
 * Each prompt is declared once next to the code that uses it, with its default
 * text kept in the source so the repository stays readable on its own. The
 * registry adds two things on top: a catalog an external editor can enumerate,
 * and a per-prompt override read from a plain `.txt` file on disk.
 *
 * Overrides are re-read live (see {@link CACHE_TTL_MS}), so editing a file
 * changes the next turn's prompt without restarting the engine.
 */

/** Where a prompt reaches the model — used to group the catalog for an editor. */
export type PromptChannel =
  /** Concatenated into the main system prompt for every request. */
  | "system"
  /** A system-prompt section that only appears when a mode/feature is on. */
  | "system-conditional"
  /** Injected as a user-role `<system-reminder>` during a turn. */
  | "reminder"
  /** The `description` field of a tool definition, sent with every request. */
  | "tool"
  /** The system prompt of a separate, non-conversational inference call. */
  | "side-call"
  /** A user-role instruction of a separate, non-conversational inference call. */
  | "side-call-user"
  /** Text handed to a subagent as its role. */
  | "subagent";

export interface PromptMeta {
  /** Stable dotted id; also the override file name (`<id>.txt`). */
  id: string;
  /** Group heading in the editor — prompts that fire together live together. */
  group: string;
  /** Short human name. */
  label: string;
  /** How this prompt reaches the model. */
  channel: PromptChannel;
  /** One or two sentences: when it fires, what it is trying to achieve. */
  where: string;
  /** Names of `{{placeholder}}` slots the engine fills in at render time. */
  placeholders?: string[];
  /** The default text shipped with the engine. */
  text: string;
}

export interface PromptEntry extends PromptMeta {
  /** The shipped text, always. */
  defaultText: string;
  /** The text actually in use — the override when one exists, else the default. */
  currentText: string;
  overridden: boolean;
  /** True when the override is blank: the prompt is switched off. */
  disabled: boolean;
  /** Absolute path of this prompt's override file (whether or not it exists). */
  file: string;
}

const registry = new Map<string, PromptMeta>();

/** How long a resolved override is trusted before the file is stat-ed again. */
const CACHE_TTL_MS = 250;

interface CacheSlot {
  text: string | undefined;
  checkedAt: number;
  mtimeMs: number;
}

const cache = new Map<string, CacheSlot>();

/**
 * Directory holding the `.txt` override files. `MAGENTRA_PROMPTS_DIR` wins so a
 * frontend can point a session at an experiment set; otherwise overrides are
 * global to the user, matching how prompt tuning is actually done — you tune the
 * agent, not one repository.
 */
export function promptsDir(): string {
  const fromEnv = process.env.MAGENTRA_PROMPTS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), STATE_DIR_NAME, "prompts");
}

export function promptFile(id: string): string {
  return join(promptsDir(), `${id}.txt`);
}

/**
 * Declares a prompt and returns its id, so a call site reads
 * `promptText(SOME_PROMPT)` rather than repeating a string literal.
 *
 * Duplicate ids throw: two prompts sharing an override file would make the
 * editor lie about which one it is changing.
 */
export function definePrompt(meta: PromptMeta): string {
  const existing = registry.get(meta.id);
  if (existing && existing.text !== meta.text) {
    throw new Error(`duplicate prompt id: ${meta.id}`);
  }
  registry.set(meta.id, meta);
  return meta.id;
}

/** The override text for `id`, or undefined when no override file exists. */
function overrideText(id: string): string | undefined {
  const now = Date.now();
  const slot = cache.get(id);
  if (slot && now - slot.checkedAt < CACHE_TTL_MS) return slot.text;

  const file = promptFile(id);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cache.set(id, { text: undefined, checkedAt: now, mtimeMs: -1 });
    return undefined;
  }
  if (slot && slot.mtimeMs === mtimeMs) {
    slot.checkedAt = now;
    return slot.text;
  }
  let text: string | undefined;
  try {
    // A blank override file means DISABLED, not "no override" — it is how an
    // operator switches a prompt off. Resetting to the shipped default is a
    // separate action that deletes the file (see clearPromptOverride).
    text = readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
    if (!text.trim()) text = "";
  } catch {
    text = undefined;
  }
  cache.set(id, { text, checkedAt: now, mtimeMs });
  return text;
}

/**
 * The text in force for `id` right now: the override file when it exists and is
 * not blank, otherwise the shipped default. An unknown id throws — that can only
 * be a typo, and returning "" would silently delete a section of the prompt.
 */
export function promptText(id: string): string {
  const meta = registry.get(id);
  if (!meta) throw new Error(`unknown prompt id: ${id}`);
  return overrideText(id) ?? meta.text;
}

/**
 * {@link promptText} with `{{name}}` slots replaced. A slot with no matching
 * variable is left as written, so a user who mistypes a placeholder sees it in
 * the output instead of losing the sentence around it.
 */
export function renderPrompt(id: string, vars: Record<string, string | number>): string {
  return promptText(id).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/** Whether a prompt is switched off — its override exists and is blank. */
export function isPromptDisabled(id: string): boolean {
  return promptText(id).trim() === "";
}

/** Every declared prompt, with its default, its current text, and its file. */
export function promptCatalog(): PromptEntry[] {
  return [...registry.values()].map((meta) => {
    const override = overrideText(meta.id);
    return {
      ...meta,
      defaultText: meta.text,
      currentText: override ?? meta.text,
      overridden: override !== undefined,
      disabled: override !== undefined && override.trim() === "",
      file: promptFile(meta.id),
    };
  });
}

/**
 * Writes an override file.
 *
 * Text equal to the default removes the file instead, so "edited back to the
 * original" and "never edited" are one state rather than two that drift.
 *
 * Blank text is NOT that case: it is stored, and it disables the prompt. A
 * disabled section is dropped from the system prompt and a disabled reminder is
 * never injected, so emptying the box is how a prompt is switched off without
 * touching the code that would otherwise still emit it.
 */
export function writePromptOverride(id: string, text: string): void {
  const meta = registry.get(id);
  if (!meta) throw new Error(`unknown prompt id: ${id}`);
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (normalized.trim() && normalized === meta.text.replace(/\n+$/, "")) {
    clearPromptOverride(id);
    return;
  }
  const dir = promptsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(promptFile(id), normalized ? `${normalized}\n` : "", "utf8");
  cache.delete(id);
}

/** Deletes an override file, returning the prompt to its shipped default. */
export function clearPromptOverride(id: string): void {
  const file = promptFile(id);
  if (existsSync(file)) rmSync(file);
  cache.delete(id);
}

/**
 * Replaces a prompt's shipped default in memory.
 *
 * For authoring tools only. Defaults are resolved from source at module load,
 * so a tool that rewrites the source literal would otherwise keep serving the
 * stale text until the process restarts. Nothing in the engine calls this.
 */
export function setPromptDefault(id: string, text: string): void {
  const meta = registry.get(id);
  if (!meta) throw new Error(`unknown prompt id: ${id}`);
  meta.text = text;
}

/** Override files present on disk that no longer match a declared prompt. */
export function orphanedPromptFiles(): string[] {
  const dir = promptsDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".txt") && !registry.has(n.slice(0, -4)))
    .map((n) => join(dir, n));
}
