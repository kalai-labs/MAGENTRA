/**
 * The brain compiler, typed — the ONE place the editor loads it.
 *
 * `tools/brain/compile.mjs` is the only judge of what a valid brain is. The
 * editor never re-implements a rule it holds: every read is its result, and
 * every save is a staged copy it compiled first (see model.ts). It is plain JS
 * with no declaration file, so its exports are declared here and the module is
 * imported by URL, the way tests/features/brain-*.test.ts load it.
 *
 * Nothing here changes compile.mjs. It is an entry file of the
 * `brain-controls-behavior` record, and the editor has no reason to touch it.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository this copy of the editor belongs to. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The brain the engine is built from. */
export const SHIPPED_BRAIN = join(REPO, "brain");

/** The module `npm run build` writes from SHIPPED_BRAIN. */
export const GENERATED_MODULE = join(REPO, "engine", "protocol", "src", "brain.generated.ts");

export const COMPILER_FILE = join(REPO, "tools", "brain", "compile.mjs");

export interface CompiledPrompt {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly channel: string;
  readonly where: string;
  readonly placeholders?: readonly string[];
  readonly order?: number;
  readonly enabled?: false;
  /** The body; "" when `enabled: false`. */
  readonly text: string;
}

export interface CompiledTool {
  readonly description: string;
  /** Parameter path → its exact text, sorted by path. */
  readonly params: Readonly<Record<string, string>>;
}

export interface Availability {
  readonly main: readonly string[];
  readonly overdrive: readonly string[];
}

/** A plain JSON object, as behavior.json holds. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

export interface CompileResult {
  readonly problems: readonly string[];
  readonly warnings?: readonly string[];
  readonly prompts?: readonly CompiledPrompt[];
  readonly tools?: Readonly<Record<string, CompiledTool>>;
  readonly availability?: Availability;
  readonly behavior?: JsonObject;
  readonly coreOrder?: readonly string[];
  /** The generated module text; absent when there are problems. */
  readonly source?: string;
}

export type BehaviorRule =
  | { readonly type: "bool"; readonly doc: string }
  | { readonly type: "int"; readonly min: number; readonly max: number; readonly doc: string }
  | { readonly type: "enum"; readonly values: readonly string[]; readonly doc: string }
  | { readonly type: "list"; readonly item: { readonly source: string; readonly flags: string }; readonly min: number; readonly max: number; readonly doc: string }
  | { readonly type: "overrides"; readonly sections: readonly string[]; readonly doc: string };

export interface BehaviorSpecData {
  readonly keys: Readonly<Record<string, BehaviorRule>>;
  readonly cross: readonly { readonly type: "lte"; readonly keys: readonly [string, string]; readonly doc: string }[];
}

/** A section node of BEHAVIOR_SPEC: its doc and children. A leaf is a rule. */
export interface BehaviorSectionNode {
  readonly doc: string;
  readonly fields: Readonly<Record<string, BehaviorSectionNode | { readonly type: string; readonly doc: string }>>;
}

export interface Claim {
  readonly prompt: string;
  readonly stance: "overdrive" | "both";
  readonly phrase: string;
  readonly keys: readonly string[];
}

interface CompilerModule {
  compileBrain(dir: string, opts?: { complete?: boolean }): CompileResult;
  behaviorProblems(value: unknown): string[];
  brainPromptIdsInSource(repo?: string): Map<string, string>;
  readonly BUILTIN_TOOLS: readonly string[];
  readonly GROUP_DIRS: Readonly<Record<string, string>>;
  readonly CHANNELS: readonly string[];
  readonly BEHAVIOR_SPEC: BehaviorSectionNode;
  readonly BEHAVIOR_SPEC_DATA: BehaviorSpecData;
  readonly CLAIMS: readonly Claim[];
}

/** tools/brain/compile.mjs, the real file. Importing it compiles nothing: its CLI runs only as the entry point. */
export const compiler = (await import(pathToFileURL(COMPILER_FILE).href)) as CompilerModule;

/** The folder a group string lives in, e.g. "3 · In-turn reminders" → "3-in-turn-reminders". */
export function groupDir(group: string): string | undefined {
  return compiler.GROUP_DIRS[group];
}

/** The group string of a folder, e.g. "3-in-turn-reminders" → "3 · In-turn reminders". */
export function groupOfDir(dir: string): string | undefined {
  return Object.entries(compiler.GROUP_DIRS).find(([, d]) => d === dir)?.[0];
}

/** The folder whose files carry `order:` and open the system prompt (compile.mjs CORE_DIR). */
export const CORE_DIR = "1-core-system";
