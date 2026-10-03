/**
 * The brain editor's core: read a brain folder, and change it safely.
 *
 * Both front doors — the page (server.ts) and the command line for agents
 * (cli.ts) — call exactly these functions with exactly these change objects,
 * so a person and an agent change a brain through one path.
 *
 * THE RULE (the `brain-editor` record's invariant). A change is applied to a
 * staged copy of the brain and compiled there by tools/brain/compile.mjs with
 * `{ complete: true }`. It is written only when
 *   - the staged brain has no problem the brain on disk did not already have,
 *   - every prompt, tool, knob and tool set the change touched compiles back to
 *     exactly what was asked, and
 *   - the brain on disk is still the revision the change was planned against.
 * Otherwise nothing on disk changes. In the shipped brain/ a change to tool
 * access or a knob value must also name the tests it moves (`acknowledge`),
 * because those tests check the shipped values and only the owner updates them.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { writeFileAtomic } from "../../../engine/core/src/util/fsAtomic.ts";
import {
  CORE_DIR,
  compiler,
  groupDir,
  groupOfDir,
  type Availability,
  type BehaviorRule,
  type BehaviorSectionNode,
  type CompileResult,
  type CompiledPrompt,
  type Json,
  type JsonObject,
} from "./compiler.ts";
import {
  FormatError,
  formatAvailability,
  formatParams,
  formatPrompt,
  formatToolDescription,
  normalizeText,
  replaceJsonValue,
  splitFrontmatter,
  splitParams,
  type ParamSection,
  type PromptFile,
} from "./format.ts";
import { probeBrain, type ProbeResult } from "./engine.ts";
import { holdersOf, isShippedBrain, promptUsers, type Holder } from "./project.ts";

/* =========================================================================
 * Reading
 * ========================================================================= */

export interface PromptItem {
  readonly id: string;
  readonly group: string;
  /** Its folder under prompts/, e.g. "3-in-turn-reminders". */
  readonly dir: string;
  /** Brain-relative path, "/"-separated. */
  readonly file: string;
  readonly label: string;
  readonly channel: string;
  readonly where: string;
  readonly placeholders: readonly string[];
  /** 1-core-system only: the section's place in the system prompt. */
  readonly order?: number;
  readonly enabled: boolean;
  /** The text as written, kept even while the prompt is switched off. */
  readonly text: string;
  /** The engine file that sends it; for a core section, how it joins the system prompt; null when nothing uses it. */
  readonly usedBy: string | null;
}

export interface ToolItem {
  readonly name: string;
  readonly description: string;
  /** In the file's own order. */
  readonly params: readonly ParamSection[];
  readonly offered: { readonly main: boolean; readonly overdrive: boolean };
}

export interface KnobItem {
  /** Dotted key, e.g. "finishing.nudgeBudget". */
  readonly key: string;
  readonly rule: BehaviorRule;
  readonly value: Json | undefined;
  /** The value overdrive.overrides sets for this key, when it sets one. */
  readonly overdriveValue: Json | undefined;
}

export interface BrokenFile {
  readonly file: string;
  /** The file as it is on disk, so it can be fixed with a file.write change. */
  readonly raw: string;
  readonly problems: readonly string[];
}

export interface BrainSnapshot {
  readonly dir: string;
  /** True for the repo's brain/, the one the engine is built from. */
  readonly shipped: boolean;
  /** A hash of every file in the folder. A change names the revision it was planned against. */
  readonly revision: string;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly prompts: readonly PromptItem[];
  readonly tools: readonly ToolItem[];
  readonly availability: Availability | null;
  readonly behavior: JsonObject | null;
  readonly knobs: readonly KnobItem[];
  /** Dotted section path → its doc, from BEHAVIOR_SPEC ("" = the whole file). */
  readonly sections: Readonly<Record<string, string>>;
  readonly coreOrder: readonly string[];
  readonly groups: readonly { readonly group: string; readonly dir: string }[];
  readonly channels: readonly string[];
  readonly builtinTools: readonly string[];
  /** The top-level sections overdrive.overrides may change. */
  readonly overridable: readonly string[];
  readonly brokenFiles: readonly BrokenFile[];
}

/** Every file under `dir`, brain-relative and "/"-separated, sorted. */
function listFiles(dir: string, sub = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, sub)).sort()) {
    if (name === ".DS_Store") continue;
    const rel = sub ? `${sub}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

/** The revision of a brain folder: every file's path and bytes, CRLF folded the way the compiler reads them. */
export function brainRevision(dir: string): string {
  const h = createHash("sha256");
  for (const rel of listFiles(dir)) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, "\n"));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** The brain-relative file a problem line names (`<file>: <message>`), when it names one. */
function problemFile(problem: string): string | undefined {
  const m = /^([^:]+): /.exec(problem);
  return m && m[1] !== "brain" ? m[1] : undefined;
}

function sectionDocs(node: BehaviorSectionNode, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  out[prefix] = node.doc;
  for (const [name, child] of Object.entries(node.fields)) {
    if ("fields" in child) sectionDocs(child, prefix ? `${prefix}.${name}` : name, out);
  }
  return out;
}

function getPath(obj: Json | undefined, path: string): Json | undefined {
  let at: Json | undefined = obj;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = (at as JsonObject)[key];
  }
  return at;
}

const OVERRIDABLE_RULE = compiler.BEHAVIOR_SPEC_DATA.keys["overdrive.overrides"];
const OVERRIDABLE: readonly string[] = OVERRIDABLE_RULE?.type === "overrides" ? OVERRIDABLE_RULE.sections : [];

/** Reads a brain folder: the compiler's result, plus what a person needs to edit it. */
export function loadBrain(dir: string): BrainSnapshot {
  return load(dir).snapshot;
}

/** loadBrain, plus the compiled module text when the brain compiles (what the engine probe loads). */
function load(dir: string): { snapshot: BrainSnapshot; source?: string } {
  const brainDir = resolve(dir);
  const shipped = isShippedBrain(brainDir);
  const result = compiler.compileBrain(brainDir, { complete: true });
  const users = promptUsers();
  const files = existsSync(brainDir) ? listFiles(brainDir) : [];
  const editorProblems: string[] = [];

  // Prompts: the compiler's list, located on disk, with the body of a switched-off prompt read back.
  const promptFiles = new Map<string, string>();
  for (const f of files) {
    const m = /^prompts\/([^/]+)\/([^/]+)\.md$/.exec(f);
    if (m) promptFiles.set(m[2]!, f);
  }
  const prompts: PromptItem[] = [];
  for (const p of result.prompts ?? []) {
    const file = promptFiles.get(p.id);
    if (file === undefined) continue;
    const split = splitFrontmatter(readFileSync(join(brainDir, file), "utf8"));
    if (split === undefined || (p.enabled !== false && split.body !== p.text)) {
      editorProblems.push(`${file}: the editor reads this file differently from the compiler — edit it as a raw file`);
      continue;
    }
    const dirName = file.split("/")[1]!;
    prompts.push({
      id: p.id,
      group: p.group,
      dir: dirName,
      file,
      label: p.label,
      channel: p.channel,
      where: p.where,
      placeholders: p.placeholders ?? [],
      ...(p.order !== undefined ? { order: p.order } : {}),
      enabled: p.enabled !== false,
      text: split.body,
      usedBy: users.get(p.id) ?? null,
    });
  }
  // A readable place in the system prompt: 1-based.
  for (const [i, id] of (result.coreOrder ?? []).entries()) {
    const at = prompts.findIndex((p) => p.id === id);
    if (at !== -1) prompts[at] = { ...prompts[at]!, usedBy: `the system prompt, section ${i + 1} of ${result.coreOrder!.length}` };
  }

  // Tools: the compiler's list, with params.md read back in its own order.
  const availability = result.availability ?? null;
  const tools: ToolItem[] = [];
  for (const [name, tool] of Object.entries(result.tools ?? {})) {
    const paramsFile = join(brainDir, "tools", name, "params.md");
    let params: ParamSection[] = [];
    if (existsSync(paramsFile)) {
      const split = splitParams(readFileSync(paramsFile, "utf8"));
      const same =
        split !== undefined &&
        split.length === Object.keys(tool.params).length &&
        split.every((s) => tool.params[s.path] === s.text);
      if (!same) {
        editorProblems.push(`tools/${name}/params.md: the editor reads this file differently from the compiler — edit it as a raw file`);
        continue;
      }
      params = split;
    }
    tools.push({
      name,
      description: tool.description,
      params,
      offered: { main: availability?.main.includes(name) ?? false, overdrive: availability?.overdrive.includes(name) ?? false },
    });
  }

  const behavior = result.behavior ?? null;
  const overrides = getPath(behavior ?? undefined, "overdrive.overrides");
  const knobs: KnobItem[] = Object.entries(compiler.BEHAVIOR_SPEC_DATA.keys).map(([key, rule]) => ({
    key,
    rule,
    value: getPath(behavior ?? undefined, key),
    overdriveValue: OVERRIDABLE.includes(key.split(".")[0]!) ? getPath(overrides, key) : undefined,
  }));

  const problems = [...result.problems, ...editorProblems];
  const broken = new Map<string, string[]>();
  for (const problem of problems) {
    const file = problemFile(problem);
    if (file !== undefined && files.includes(file)) broken.set(file, [...(broken.get(file) ?? []), problem]);
  }

  const snapshot: BrainSnapshot = {
    dir: brainDir,
    shipped,
    revision: existsSync(brainDir) ? brainRevision(brainDir) : "missing",
    problems,
    warnings: result.warnings ?? [],
    prompts,
    tools,
    availability,
    behavior,
    knobs,
    sections: sectionDocs(compiler.BEHAVIOR_SPEC),
    coreOrder: result.coreOrder ?? [],
    groups: Object.entries(compiler.GROUP_DIRS).map(([group, d]) => ({ group, dir: d })),
    channels: compiler.CHANNELS,
    builtinTools: compiler.BUILTIN_TOOLS,
    overridable: OVERRIDABLE,
    brokenFiles: [...broken].map(([file, list]) => ({ file, raw: readFileSync(join(brainDir, file), "utf8"), problems: list })),
  };
  return editorProblems.length === 0 && result.source !== undefined ? { snapshot, source: result.source } : { snapshot };
}

/**
 * What the built engine makes of the brain in `dir` as it is on disk: whether
 * it loads and the system prompt it sends. See engine.ts. Not part of loadBrain because it is a child process.
 */
export async function checkEngine(dir: string): Promise<ProbeResult> {
  const { source } = load(dir);
  if (source === undefined) return { available: false, reason: "the brain has problems; fix them first" };
  return probeBrain(source);
}

/* =========================================================================
 * Changing
 * ========================================================================= */

/** One edit. A list of them is applied in order, as one save. */
export type Change =
  | {
      readonly op: "prompt.update";
      readonly id: string;
      readonly text?: string;
      readonly label?: string;
      readonly where?: string;
      readonly channel?: string;
      readonly placeholders?: readonly string[];
      readonly order?: number;
      readonly enabled?: boolean;
    }
  | {
      readonly op: "prompt.create";
      readonly id: string;
      /** The group string ("3 · In-turn reminders") or its folder ("3-in-turn-reminders"). */
      readonly group: string;
      readonly label: string;
      readonly channel: string;
      readonly where: string;
      readonly text: string;
      readonly placeholders?: readonly string[];
      readonly order?: number;
      readonly enabled?: boolean;
    }
  | { readonly op: "prompt.delete"; readonly id: string }
  | {
      readonly op: "tool.update";
      readonly name: string;
      readonly description?: string;
      /** Parameter path → its new text, or null to remove that section. */
      readonly params?: Readonly<Record<string, string | null>>;
    }
  | { readonly op: "availability.update"; readonly tool: string; readonly main?: boolean; readonly overdrive?: boolean }
  | { readonly op: "behavior.set"; readonly key: string; readonly value: Json }
  /** Sets what OVERDRIVE changes for `key`; null removes that override. */
  | { readonly op: "behavior.override"; readonly key: string; readonly value: Json | null }
  /** The raw escape hatch: a whole brain file (null deletes it). Meant for fixing a file the editor cannot read. */
  | { readonly op: "file.write"; readonly path: string; readonly content: string | null };

export const CHANGE_OPS = [
  "prompt.update",
  "prompt.create",
  "prompt.delete",
  "tool.update",
  "availability.update",
  "behavior.set",
  "behavior.override",
  "file.write",
] as const;

export interface PlanOptions {
  /** The revision the change was planned against (BrainSnapshot.revision). Refused when the folder moved on since. */
  readonly expectRevision?: string;
  /** The holder test ids the caller accepts moving. Needed for every holder in the shipped brain. */
  readonly acknowledge?: readonly string[];
}

export type RefusalCode = "invalid-change" | "stale" | "breaks-brain" | "breaks-engine" | "mismatch" | "needs-acknowledge" | "busy";

export interface FileChange {
  readonly path: string;
  /** null: the file does not exist before. */
  readonly before: string | null;
  /** null: the file is deleted. */
  readonly after: string | null;
}

export interface Plan {
  readonly ok: boolean;
  readonly refusal?: { readonly code: RefusalCode; readonly message: string };
  readonly dir: string;
  readonly shipped: boolean;
  /** The revision on disk the plan was made against. */
  readonly revision: string;
  readonly files: readonly FileChange[];
  /** Every problem the brain would have after the change. */
  readonly problems: readonly string[];
  /** The ones the change would add. Any of these refuses the change. */
  readonly newProblems: readonly string[];
  /** The ones the change would fix. */
  readonly fixedProblems: readonly string[];
  readonly warnings: readonly string[];
  /** Warnings the change would add (prose that states a knob's old value). They never refuse a change. */
  readonly newWarnings: readonly string[];
  /** Items that would not compile back to what was asked. Any of these refuses the change. */
  readonly mismatches: readonly string[];
  /** Tests the change moves in the shipped brain, one entry per test. */
  readonly heldBy: readonly Holder[];
  /**
   * The built engine's answer about the staged brain (engine.ts). `loads`
   * false refuses the change. The two "changed" flags say whether the system
   * prompt and the tools' wire text differ from today's.
   */
  readonly engine: {
    readonly checked: boolean;
    readonly reason?: string;
    readonly loads?: boolean;
    readonly systemPromptChanged?: boolean;
    readonly toolsChanged?: boolean;
  };
  /** One plain line per change, saying what it does. */
  readonly summary: readonly string[];
}

export interface ApplyResult extends Plan {
  readonly applied: boolean;
  /** The revision on disk afterwards. */
  readonly newRevision: string;
}

class ChangeError extends Error {}

/** The files a plan would write, over the files on disk. */
class Overlay {
  readonly writes = new Map<string, string | null>();
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }
  read(path: string): string | null {
    if (this.writes.has(path)) return this.writes.get(path)!;
    const file = join(this.#dir, ...path.split("/"));
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }
  write(path: string, content: string | null): void {
    this.writes.set(path, content);
  }
}

/** What an item must compile back to; checked against the staged compile. Last change to an item wins. */
type Expectation =
  | { readonly kind: "prompt"; readonly id: string; readonly file: string; readonly want: PromptFile | null }
  | { readonly kind: "tool"; readonly name: string; readonly description: string; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: "availability"; readonly want: Availability }
  | { readonly kind: "behavior"; readonly key: string; readonly want: Json }
  | { readonly kind: "overrides"; readonly want: Json };

const FILE_PATH = /^(prompts\/[0-9a-z-]+\/[A-Za-z0-9._-]+\.md|tools\/[A-Za-z]+\/(description|params)\.md|availability\.json|behavior\.json)$/;

/** A brain-relative path a change may write, or a refusal. Nothing outside the brain folder, and only brain file shapes. */
function safePath(dir: string, path: string): string {
  if (!FILE_PATH.test(path) || path.split("/").some((s) => s === ".." || s === ".")) {
    throw new ChangeError(`"${path}" is not a brain file path (prompts/<group-folder>/<id>.md, tools/<Tool>/description.md or params.md, availability.json, behavior.json)`);
  }
  const full = resolve(dir, ...path.split("/"));
  if (!full.startsWith(dir + sep)) throw new ChangeError(`"${path}" is outside the brain folder`);
  return path;
}

const isString = (v: unknown): v is string => typeof v === "string";

function requireString(change: Record<string, unknown>, key: string, where: string): string {
  const v = change[key];
  if (!isString(v)) throw new ChangeError(`${where}: "${key}" must be a string`);
  return v;
}

function optionalString(change: Record<string, unknown>, key: string, where: string): string | undefined {
  const v = change[key];
  if (v === undefined) return undefined;
  if (!isString(v)) throw new ChangeError(`${where}: "${key}" must be a string`);
  return v;
}

function optionalStrings(change: Record<string, unknown>, key: string, where: string): string[] | undefined {
  const v = change[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every(isString)) throw new ChangeError(`${where}: "${key}" must be a list of strings`);
  return v;
}

function optionalBool(change: Record<string, unknown>, key: string, where: string): boolean | undefined {
  const v = change[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ChangeError(`${where}: "${key}" must be true or false`);
  return v;
}

function optionalInt(change: Record<string, unknown>, key: string, where: string): number | undefined {
  const v = change[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ChangeError(`${where}: "${key}" must be a whole number, 0 or more`);
  return v;
}

/** The fields each op accepts; parseChanges refuses any other. */
export const CHANGE_FIELDS: Record<(typeof CHANGE_OPS)[number], readonly string[]> = {
  "prompt.update": ["op", "id", "text", "label", "where", "channel", "placeholders", "order", "enabled"],
  "prompt.create": ["op", "id", "group", "label", "channel", "where", "text", "placeholders", "order", "enabled"],
  "prompt.delete": ["op", "id"],
  "tool.update": ["op", "name", "description", "params"],
  "availability.update": ["op", "tool", "main", "overdrive"],
  "behavior.set": ["op", "key", "value"],
  "behavior.override": ["op", "key", "value"],
  "file.write": ["op", "path", "content"],
};

/** Checks the shape of a change list from the outside world (JSON). */
export function parseChanges(input: unknown): Change[] {
  const list = Array.isArray(input) ? input : input !== null && typeof input === "object" && Array.isArray((input as { changes?: unknown }).changes) ? (input as { changes: unknown[] }).changes : undefined;
  if (list === undefined) throw new ChangeError('expected a list of changes, or { "changes": [...] }');
  if (list.length === 0) throw new ChangeError("the list of changes is empty");
  return list.map((raw, i) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ChangeError(`changes[${i}] must be an object`);
    const change = raw as Record<string, unknown>;
    const op = change.op;
    if (!isString(op) || !(CHANGE_OPS as readonly string[]).includes(op)) {
      throw new ChangeError(`changes[${i}]: "op" must be one of ${CHANGE_OPS.join(", ")}`);
    }
    const where = `changes[${i}] (${op})`;
    const unknown = Object.keys(change).filter((k) => !CHANGE_FIELDS[op as (typeof CHANGE_OPS)[number]].includes(k));
    if (unknown.length) throw new ChangeError(`${where}: unknown field(s) ${unknown.map((k) => `"${k}"`).join(", ")}`);
    switch (op) {
      case "prompt.update":
        requireString(change, "id", where);
        optionalString(change, "text", where);
        optionalString(change, "label", where);
        optionalString(change, "where", where);
        optionalString(change, "channel", where);
        optionalStrings(change, "placeholders", where);
        optionalInt(change, "order", where);
        optionalBool(change, "enabled", where);
        break;
      case "prompt.create":
        for (const k of ["id", "group", "label", "channel", "where", "text"]) requireString(change, k, where);
        optionalStrings(change, "placeholders", where);
        optionalInt(change, "order", where);
        optionalBool(change, "enabled", where);
        break;
      case "prompt.delete":
        requireString(change, "id", where);
        break;
      case "tool.update": {
        requireString(change, "name", where);
        optionalString(change, "description", where);
        const params = change.params;
        if (params !== undefined) {
          if (params === null || typeof params !== "object" || Array.isArray(params)) throw new ChangeError(`${where}: "params" must be an object of path → text (or null)`);
          for (const [path, text] of Object.entries(params)) {
            if (text !== null && !isString(text)) throw new ChangeError(`${where}: params["${path}"] must be a string or null`);
          }
        }
        break;
      }
      case "availability.update":
        requireString(change, "tool", where);
        optionalBool(change, "main", where);
        optionalBool(change, "overdrive", where);
        break;
      case "behavior.set":
      case "behavior.override":
        requireString(change, "key", where);
        if (!("value" in change)) throw new ChangeError(`${where}: "value" is missing`);
        break;
      case "file.write":
        requireString(change, "path", where);
        if (change.content !== null && !isString(change.content)) throw new ChangeError(`${where}: "content" must be a string, or null to delete the file`);
        break;
    }
    return change as unknown as Change;
  });
}

/** The prompt file's path for an id, in the overlay or on disk. */
function findPromptPath(snapshot: BrainSnapshot, overlay: Overlay, id: string): string | undefined {
  for (const [path, content] of overlay.writes) {
    if (content !== null && path.startsWith("prompts/") && path.endsWith(`/${id}.md`)) return path;
  }
  const known = snapshot.prompts.find((p) => p.id === id)?.file;
  if (known !== undefined && overlay.read(known) !== null) return known;
  return undefined;
}

/** The prompt in a file, as PromptFile. */
function readPrompt(content: string, path: string): PromptFile {
  const split = splitFrontmatter(content);
  if (!split) throw new ChangeError(`${path} cannot be read as a prompt file; fix it with a file.write change first`);
  const f = split.fields;
  const order = f.get("order");
  const placeholders = f.get("placeholders");
  return {
    id: f.get("id") ?? "",
    group: f.get("group") ?? "",
    label: f.get("label") ?? "",
    channel: f.get("channel") ?? "",
    where: f.get("where") ?? "",
    ...(placeholders !== undefined ? { placeholders: placeholders.split(/,\s*/) } : {}),
    ...(order !== undefined ? { order: Number(order) } : {}),
    ...(f.get("enabled") === "false" ? { enabled: false } : {}),
    text: split.body,
  };
}

function readTool(overlay: Overlay, name: string): { description: string; params: ParamSection[] } {
  const descPath = `tools/${name}/description.md`;
  const desc = overlay.read(descPath);
  const split = desc === null ? undefined : splitFrontmatter(desc);
  if (!split) throw new ChangeError(`${descPath} cannot be read; fix it with a file.write change first`);
  const paramsRaw = overlay.read(`tools/${name}/params.md`);
  const params = paramsRaw === null ? [] : splitParams(paramsRaw);
  if (params === undefined) throw new ChangeError(`tools/${name}/params.md cannot be read; fix it with a file.write change first`);
  return { description: split.body, params };
}

function readJson(overlay: Overlay, path: string): { text: string; value: JsonObject } {
  const text = overlay.read(path);
  if (text === null) throw new ChangeError(`${path} is missing; create it with a file.write change first`);
  try {
    return { text, value: JSON.parse(text) as JsonObject };
  } catch (err) {
    throw new ChangeError(`${path} is not valid JSON (${(err as Error).message}); fix it with a file.write change first`);
  }
}

/** `obj` with `path` set to `value`, or removed when value is null; empty sections left behind are dropped. */
function withPath(obj: JsonObject, keys: readonly string[], value: Json | null): JsonObject {
  const [head, ...rest] = keys;
  const out: Record<string, Json> = { ...obj };
  if (rest.length === 0) {
    if (value === null) delete out[head!];
    else out[head!] = value;
    return out;
  }
  const child = out[head!];
  const next = withPath(child !== null && typeof child === "object" && !Array.isArray(child) ? (child as JsonObject) : {}, rest, value);
  if (Object.keys(next).length === 0) delete out[head!];
  else out[head!] = next;
  return out;
}

/** Order-insensitive for object keys, order-sensitive for lists. */
function sameJson(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => sameJson((a as JsonObject)[k], (b as JsonObject)[k]));
}

const show = (v: unknown): string => JSON.stringify(v);

/** Applies one change to the overlay; returns its summary line and records what it must compile back to. */
function applyOne(snapshot: BrainSnapshot, overlay: Overlay, change: Change, expect: Map<string, Expectation>): string {
  switch (change.op) {
    case "prompt.update": {
      const path = findPromptPath(snapshot, overlay, change.id);
      if (path === undefined) throw new ChangeError(`no prompt with id "${change.id}" (prompt.create makes a new one)`);
      const now = readPrompt(overlay.read(path)!, path);
      const isCore = path.startsWith(`prompts/${CORE_DIR}/`);
      if (change.order !== undefined && !isCore) throw new ChangeError(`"${change.id}": order is only for system prompt sections (prompts/${CORE_DIR})`);
      const next: PromptFile = {
        ...now,
        ...(change.text !== undefined ? { text: normalizeText(change.text, "the text") } : {}),
        ...(change.label !== undefined ? { label: change.label } : {}),
        ...(change.where !== undefined ? { where: change.where } : {}),
        ...(change.channel !== undefined ? { channel: change.channel } : {}),
        ...(change.placeholders !== undefined ? { placeholders: change.placeholders } : {}),
        ...(change.order !== undefined ? { order: change.order } : {}),
        ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
      };
      overlay.write(path, formatPrompt(next));
      expect.set(`prompt:${change.id}`, { kind: "prompt", id: change.id, file: path, want: next });
      const what = [
        change.text !== undefined && "text",
        change.label !== undefined && "name",
        change.where !== undefined && "note",
        change.channel !== undefined && "channel",
        change.placeholders !== undefined && "placeholders",
        change.order !== undefined && `place (order ${change.order})`,
      ].filter(Boolean);
      const state = change.enabled === false ? "switched off" : change.enabled === true ? "switched on" : "";
      return `Prompt ${change.id}: ${[what.length ? `${what.join(", ")} changed` : "", state].filter(Boolean).join("; ") || "nothing changed"}`;
    }
    case "prompt.create": {
      const dir = groupDir(change.group) ?? (groupOfDir(change.group) !== undefined ? change.group : undefined);
      if (dir === undefined) {
        throw new ChangeError(`unknown group "${change.group}" (one of: ${snapshot.groups.map((g) => g.dir).join(", ")})`);
      }
      if (findPromptPath(snapshot, overlay, change.id) !== undefined) throw new ChangeError(`a prompt with id "${change.id}" already exists`);
      const path = safePath(snapshot.dir, `prompts/${dir}/${change.id}.md`);
      if (overlay.read(path) !== null) throw new ChangeError(`${path} already exists`);
      const want: PromptFile = {
        id: change.id,
        group: groupOfDir(dir)!,
        label: change.label,
        channel: change.channel,
        where: change.where,
        ...(change.placeholders !== undefined ? { placeholders: change.placeholders } : {}),
        ...(change.order !== undefined ? { order: change.order } : {}),
        ...(change.enabled === false ? { enabled: false } : {}),
        text: normalizeText(change.text, "the text"),
      };
      overlay.write(path, formatPrompt(want));
      expect.set(`prompt:${change.id}`, { kind: "prompt", id: change.id, file: path, want });
      return `Prompt ${change.id}: created in ${dir}`;
    }
    case "prompt.delete": {
      const path = findPromptPath(snapshot, overlay, change.id);
      if (path === undefined) throw new ChangeError(`no prompt with id "${change.id}"`);
      overlay.write(path, null);
      expect.set(`prompt:${change.id}`, { kind: "prompt", id: change.id, file: path, want: null });
      return `Prompt ${change.id}: deleted`;
    }
    case "tool.update": {
      if (!snapshot.builtinTools.includes(change.name)) throw new ChangeError(`unknown tool "${change.name}" (built-in tools only)`);
      const now = readTool(overlay, change.name);
      const description = change.description !== undefined ? normalizeText(change.description, "the description") : now.description;
      const params = [...now.params];
      for (const [path, text] of Object.entries(change.params ?? {})) {
        const at = params.findIndex((s) => s.path === path);
        if (text === null) {
          if (at === -1) throw new ChangeError(`tool ${change.name} has no parameter text "${path}" to remove`);
          params.splice(at, 1);
        } else if (at === -1) {
          params.push({ path, text: normalizeText(text, `parameter "${path}"`) });
        } else {
          params[at] = { path, text: normalizeText(text, `parameter "${path}"`) };
        }
      }
      overlay.write(`tools/${change.name}/description.md`, formatToolDescription(change.name, description));
      overlay.write(`tools/${change.name}/params.md`, formatParams(params) ?? null);
      expect.set(`tool:${change.name}`, {
        kind: "tool",
        name: change.name,
        description,
        params: Object.fromEntries(params.map((s) => [s.path, s.text])),
      });
      const parts = [change.description !== undefined && "description", ...Object.keys(change.params ?? {}).map((p) => `parameter ${p}`)].filter(Boolean);
      return `Tool ${change.name}: ${parts.length ? parts.join(", ") : "nothing"} changed`;
    }
    case "availability.update": {
      if (!snapshot.builtinTools.includes(change.tool)) throw new ChangeError(`unknown tool "${change.tool}" (built-in tools only)`);
      const { value } = readJson(overlay, "availability.json");
      const lists = { main: [...((value.main as string[] | undefined) ?? [])], overdrive: [...((value.overdrive as string[] | undefined) ?? [])] };
      const order = snapshot.builtinTools;
      const lines: string[] = [];
      for (const ctx of ["main", "overdrive"] as const) {
        const want = change[ctx];
        if (want === undefined) continue;
        const has = lists[ctx].includes(change.tool);
        if (want && !has) {
          lists[ctx].push(change.tool);
          lists[ctx].sort((a, b) => order.indexOf(a) - order.indexOf(b));
        }
        if (!want && has) lists[ctx] = lists[ctx].filter((t) => t !== change.tool);
        lines.push(`${want ? "offered" : "withheld"} ${ctx === "main" ? "normally" : "in OVERDRIVE"}`);
      }
      overlay.write("availability.json", formatAvailability(lists.main, lists.overdrive));
      expect.set("availability", { kind: "availability", want: lists });
      return `Tool access ${change.tool}: ${lines.join(", ") || "unchanged"}`;
    }
    case "behavior.set": {
      const rule = compiler.BEHAVIOR_SPEC_DATA.keys[change.key];
      if (rule === undefined) throw new ChangeError(`unknown behaviour key "${change.key}"`);
      if (rule.type === "overrides") throw new ChangeError(`"${change.key}" is changed key by key with behavior.override`);
      const { text, value } = readJson(overlay, "behavior.json");
      const next = replaceJsonValue(text, change.key, change.value) ?? `${JSON.stringify(withPath(value, change.key.split("."), change.value), null, 2)}\n`;
      overlay.write("behavior.json", next);
      expect.set(`behavior:${change.key}`, { kind: "behavior", key: change.key, want: change.value });
      return `Behaviour ${change.key}: ${show(getPath(value, change.key))} → ${show(change.value)}`;
    }
    case "behavior.override": {
      const rule = compiler.BEHAVIOR_SPEC_DATA.keys[change.key];
      if (rule === undefined || rule.type === "overrides") throw new ChangeError(`unknown behaviour key "${change.key}"`);
      if (!OVERRIDABLE.includes(change.key.split(".")[0]!)) {
        throw new ChangeError(`"${change.key}" cannot change in OVERDRIVE (only ${OVERRIDABLE.join(", ")} can)`);
      }
      const { text, value } = readJson(overlay, "behavior.json");
      const current = getPath(value, "overdrive.overrides");
      const base = current !== null && typeof current === "object" && !Array.isArray(current) ? (current as JsonObject) : {};
      const nextOverrides = withPath(base, change.key.split("."), change.value);
      const next =
        replaceJsonValue(text, "overdrive.overrides", nextOverrides) ??
        `${JSON.stringify(withPath(value, ["overdrive", "overrides"], nextOverrides), null, 2)}\n`;
      overlay.write("behavior.json", next);
      expect.set("overrides", { kind: "overrides", want: nextOverrides });
      return change.value === null
        ? `Behaviour ${change.key}: OVERDRIVE no longer changes it`
        : `Behaviour ${change.key}: in OVERDRIVE ${show(getPath(base, change.key) ?? getPath(value, change.key))} → ${show(change.value)}`;
    }
    case "file.write": {
      const path = safePath(snapshot.dir, change.path);
      overlay.write(path, change.content === null ? null : normalizeText(change.content, path));
      return change.content === null ? `File ${path}: deleted` : `File ${path}: written`;
    }
  }
}

/** Every way the staged compile differs from what the changes asked for. */
function mismatchesOf(expect: Map<string, Expectation>, staged: CompileResult, stagedDir: string): string[] {
  const out: string[] = [];
  const prompts = new Map<string, CompiledPrompt>((staged.prompts ?? []).map((p) => [p.id, p]));
  for (const e of expect.values()) {
    if (e.kind === "prompt") {
      const got = prompts.get(e.id);
      if (e.want === null) {
        if (got) out.push(`prompt ${e.id} is still there after being deleted`);
        continue;
      }
      if (!got) {
        out.push(`prompt ${e.id} does not compile (see the problems)`);
        continue;
      }
      const w = e.want;
      const disabled = w.enabled === false;
      const field = (name: string, a: unknown, b: unknown): void => {
        if (show(a) !== show(b)) out.push(`prompt ${e.id}: ${name} compiles to ${show(b)}, not ${show(a)}`);
      };
      field("text", disabled ? "" : w.text, got.text);
      field("name", w.label, got.label);
      field("note", w.where, got.where);
      field("channel", w.channel, got.channel);
      field("placeholders", w.placeholders && w.placeholders.length ? w.placeholders : undefined, got.placeholders);
      field("order", w.order, got.order);
      field("switched off", disabled, got.enabled === false);
      if (disabled) {
        const raw = existsSync(join(stagedDir, e.file)) ? splitFrontmatter(readFileSync(join(stagedDir, e.file), "utf8")) : undefined;
        if (raw?.body !== w.text) out.push(`prompt ${e.id}: the kept text of a switched-off prompt would not read back as written`);
      }
    } else if (e.kind === "tool") {
      const got = staged.tools?.[e.name];
      if (!got) {
        out.push(`tool ${e.name} does not compile (see the problems)`);
        continue;
      }
      if (got.description !== e.description) out.push(`tool ${e.name}: the description does not compile back to the text asked for`);
      if (!sameJson(got.params, e.params)) out.push(`tool ${e.name}: the parameter texts do not compile back to the texts asked for`);
    } else if (e.kind === "availability") {
      if (!sameJson(staged.availability as unknown as Json, e.want as unknown as Json)) out.push("tool access does not compile back to the lists asked for");
    } else if (e.kind === "behavior") {
      const got = getPath(staged.behavior, e.key);
      if (staged.behavior && !sameJson(got, e.want)) out.push(`behaviour ${e.key} compiles to ${show(got)}, not ${show(e.want)}`);
    } else {
      const got = getPath(staged.behavior, "overdrive.overrides");
      if (staged.behavior && !sameJson(got, e.want)) out.push(`overdrive.overrides compiles to ${show(got)}, not ${show(e.want)}`);
    }
  }
  return out;
}

/** A refused plan with nothing staged. */
function refused(snapshot: BrainSnapshot, code: RefusalCode, message: string): Plan {
  return {
    ok: false,
    refusal: { code, message },
    dir: snapshot.dir,
    shipped: snapshot.shipped,
    revision: snapshot.revision,
    files: [],
    problems: snapshot.problems,
    newProblems: [],
    fixedProblems: [],
    warnings: snapshot.warnings,
    newWarnings: [],
    mismatches: [],
    heldBy: [],
    engine: { checked: false, reason: "nothing was staged" },
    summary: [],
  };
}

/** Plans `changes` against a staged copy of the brain in `dir`. Writes nothing. */
async function stagePlan(dir: string, input: unknown, options: PlanOptions): Promise<Plan> {
  const { snapshot, source: currentSource } = load(dir);
  if (!existsSync(snapshot.dir)) return refused(snapshot, "invalid-change", `brain folder not found: ${snapshot.dir}`);
  if (options.expectRevision !== undefined && options.expectRevision !== snapshot.revision) {
    return refused(
      snapshot,
      "stale",
      `The brain changed on disk after this change was planned (planned against ${options.expectRevision}, now ${snapshot.revision}). Load it again and redo the change.`,
    );
  }
  const overlay = new Overlay(snapshot.dir);
  const expect = new Map<string, Expectation>();
  const summary: string[] = [];
  try {
    for (const change of parseChanges(input)) summary.push(applyOne(snapshot, overlay, change, expect));
  } catch (err) {
    if (err instanceof ChangeError || err instanceof FormatError) return refused(snapshot, "invalid-change", err.message);
    throw err;
  }

  // Only the files that really change.
  const files: FileChange[] = [];
  for (const [path, after] of overlay.writes) {
    const file = join(snapshot.dir, ...path.split("/"));
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (before !== after) files.push({ path, before, after });
  }

  // Stage: a full copy with the writes applied, compiled exactly as the build compiles.
  const stageRoot = mkdtempSync(join(tmpdir(), "magentra-brain-stage-"));
  let staged: CompileResult;
  let mismatches: string[];
  try {
    const stage = join(stageRoot, "brain");
    cpSync(snapshot.dir, stage, { recursive: true });
    for (const { path, after } of files) {
      const target = join(stage, ...path.split("/"));
      if (after === null) rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileAtomic(target, after);
      }
    }
    staged = compiler.compileBrain(stage, { complete: true });
    mismatches = mismatchesOf(expect, staged, stage);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const before = new Set(snapshot.problems);
  const after = new Set(staged.problems);
  const newProblems = staged.problems.filter((p) => !before.has(p));
  const fixedProblems = snapshot.problems.filter((p) => !after.has(p) && !p.includes("the editor reads this file differently"));
  const warnings = [...(staged.warnings ?? [])];

  // The engine's own answer, when it can be asked: does it still load?
  let engine: Plan["engine"] = { checked: false, reason: "the brain does not compile" };
  let engineError: string | undefined;
  if (files.length > 0 && staged.source !== undefined) {
    const [now, next] = await Promise.all([currentSource !== undefined ? probeBrain(currentSource) : undefined, probeBrain(staged.source)]);
    if (!next.available) {
      engine = { checked: false, reason: next.reason };
    } else {
      engine = {
        checked: true,
        loads: next.ok,
        systemPromptChanged: now?.available === true && now.ok && next.ok ? now.systemPrompt !== next.systemPrompt : undefined,
        toolsChanged: now?.available === true && now.ok && next.ok ? now.toolContractHash !== next.toolContractHash : undefined,
      };
      if (!next.ok && (now === undefined || (now.available && now.ok))) engineError = next.error ?? "the engine did not load";
      for (const p of next.unreadParams ?? []) {
        const known = now?.available === true ? (now.unreadParams ?? []) : [];
        if (!known.includes(p)) warnings.push(`tools/${p.split(" ")[0]}/params.md: no tool reads the parameter text "${p.split(" ").slice(1).join(" ")}", so it is never sent`);
      }
    }
  }
  const newWarnings = warnings.filter((w) => !snapshot.warnings.includes(w));

  const holders = new Map<string, Holder>();
  for (const f of files) {
    for (const h of holdersOf(f.path, snapshot.shipped)) if (!holders.has(h.test)) holders.set(h.test, h);
  }
  const heldBy = [...holders.values()];

  const base = {
    dir: snapshot.dir,
    shipped: snapshot.shipped,
    revision: snapshot.revision,
    files,
    problems: staged.problems,
    newProblems,
    fixedProblems,
    warnings,
    newWarnings,
    mismatches,
    heldBy,
    engine,
    summary,
  };
  let refusal: Plan["refusal"];
  if (newProblems.length > 0) {
    refusal = { code: "breaks-brain", message: `This change would break the brain: ${newProblems[0]}${newProblems.length > 1 ? ` (and ${newProblems.length - 1} more)` : ""}` };
  } else if (mismatches.length > 0) {
    refusal = { code: "mismatch", message: `The saved files would not say what was asked: ${mismatches[0]}` };
  } else if (engineError !== undefined) {
    refusal = { code: "breaks-engine", message: `The engine would not start with this brain: ${engineError}` };
  } else {
    const missing = heldBy.filter((h) => !(options.acknowledge ?? []).includes(h.test));
    if (missing.length > 0) {
      refusal = {
        code: "needs-acknowledge",
        message: `This changes values the tests hold in the shipped brain: ${missing.map((h) => h.test).join(", ")}. Those tests fail until the owner updates what they expect. Acknowledge ${missing.length === 1 ? "it" : "them"} to save anyway.`,
      };
    }
  }
  return { ok: refusal === undefined, ...(refusal ? { refusal } : {}), ...base };
}

/** What a change would do, written nowhere. */
export function planChanges(dir: string, changes: unknown, options: PlanOptions = {}): Promise<Plan> {
  return stagePlan(dir, changes, options);
}

/* ---- one writer at a time, across processes (the page and an agent's CLI) ---- */

const LOCK_STALE_MS = 30_000;

function lockPath(dir: string): string {
  return join(tmpdir(), `magentra-brain-editor-${createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 12)}.lock`);
}

function takeLock(dir: string): (() => void) | undefined {
  const lock = lockPath(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
        else return undefined;
      } catch {
        // gone between the two calls: try again
      }
    }
  }
  return undefined;
}

/**
 * Plans `changes` and, when the plan is ok, writes its files. Every file is
 * written atomically; if one write fails, the files already written are put
 * back, so a failed save leaves the brain as it was.
 */
export async function applyChanges(dir: string, changes: unknown, options: PlanOptions = {}): Promise<ApplyResult> {
  const release = takeLock(resolve(dir));
  if (release === undefined) {
    const snapshot = loadBrain(dir);
    return { ...refused(snapshot, "busy", "Another save to this brain is in progress. Try again in a moment."), applied: false, newRevision: snapshot.revision };
  }
  try {
    const plan = await stagePlan(dir, changes, options);
    if (!plan.ok || plan.files.length === 0) return { ...plan, applied: false, newRevision: plan.revision };
    // The folder must still be the one planned against: planning reads it once, and a writer may have come between.
    if (brainRevision(plan.dir) !== plan.revision) {
      return { ...plan, ok: false, refusal: { code: "stale", message: "The brain changed on disk while this change was being checked. Load it again and redo the change." }, applied: false, newRevision: brainRevision(plan.dir) };
    }
    const done: FileChange[] = [];
    try {
      for (const f of plan.files) {
        const target = join(plan.dir, ...f.path.split("/"));
        if (f.after === null) rmSync(target, { force: true });
        else writeFileAtomic(target, f.after);
        done.push(f);
      }
    } catch (err) {
      for (const f of done.reverse()) {
        const target = join(plan.dir, ...f.path.split("/"));
        if (f.before === null) rmSync(target, { force: true });
        else writeFileAtomic(target, f.before);
      }
      throw err;
    }
    return { ...plan, applied: true, newRevision: brainRevision(plan.dir) };
  } finally {
    release();
  }
}

/* =========================================================================
 * Profiles: a new brain folder, copied from an existing one
 * ========================================================================= */

export interface NewProfileResult {
  readonly ok: boolean;
  readonly dir: string;
  readonly message: string;
  readonly problems: readonly string[];
}

/**
 * Copies the brain at `from` into `to`, which must not exist yet (or be an
 * empty folder): a profile never overwrites anything. The copy is compiled
 * like the build compiles brain/, so a new profile starts complete.
 */
export function newProfile(from: string, to: string): NewProfileResult {
  const source = resolve(from);
  const target = resolve(to);
  if (!existsSync(source)) return { ok: false, dir: target, message: `no brain folder at ${source}`, problems: [] };
  if (target === source || target.startsWith(source + sep) || source.startsWith(target + sep)) {
    return { ok: false, dir: target, message: "the new profile must be a folder outside the brain it copies", problems: [] };
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    return { ok: false, dir: target, message: `${target} already exists and is not empty; a profile never overwrites a folder`, problems: [] };
  }
  cpSync(source, target, { recursive: true, filter: (src) => !src.endsWith(`${sep}.DS_Store`) });
  const result = compiler.compileBrain(target, { complete: true });
  return {
    ok: result.problems.length === 0,
    dir: target,
    message: result.problems.length === 0 ? `New profile created at ${target}` : `Copied to ${target}, but the copy has problems`,
    problems: result.problems,
  };
}
