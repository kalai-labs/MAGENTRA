import {
  BRAIN_AVAILABILITY,
  BRAIN_BEHAVIOR,
  BRAIN_BEHAVIOR_SPEC,
  BRAIN_BUILTIN_TOOLS,
  BRAIN_TOOLS,
  type BrainBehavior,
  type BrainBehaviorRule,
  type BrainBehaviorSpec,
} from "./brain.generated.js";

export type {
  BrainBehavior,
  BrainBehaviorCrossRule,
  BrainBehaviorOverrides,
  BrainBehaviorRule,
  BrainBehaviorSpec,
} from "./brain.generated.js";

/**
 * Tool prose, per-context tool sets and behaviour knobs from brain/ (see
 * brain/README.md).
 *
 * brain/ is compiled by tools/brain/compile.mjs into brain.generated.ts before
 * tsc runs; nothing here touches the disk. Prompt defaults are seeded into the
 * prompt registry by prompts.ts — this module covers what is not a registry
 * prompt: a tool's description TEMPLATE and its parameters' `.describe()`
 * texts, availability.json, and behavior.json.
 *
 * Every accessor throws on an unknown key. They run at module load in
 * engine/tools (a tool definition is a module-level constant), so a missing or
 * misspelled brain entry fails the import instead of sending the model
 * something else.
 */

const readParams = new Set<string>();

/**
 * The description template of built-in tool `name` — brain/tools/<name>/description.md,
 * `{{slots}}` unfilled. Assign it to `ToolDefinition.description`; the registry
 * fills the slots from `descriptionVars` and applies `tool.<name>` overrides.
 */
export function toolDescription(name: string): string {
  const tool = BRAIN_TOOLS[name];
  if (!tool) throw new Error(`unknown brain tool: ${name} (no brain/tools/${name}/description.md)`);
  return tool.description;
}

/**
 * The exact `.describe()` text for one parameter of built-in tool `name`:
 * the `## <path>` section of brain/tools/<name>/params.md. `path` is the field's
 * dotted path with array elements transparent (`questions.options.label`), or
 * `(root)` for a `.describe()` on the schema object itself.
 */
export function toolParam(name: string, path: string): string {
  const text = BRAIN_TOOLS[name]?.params[path];
  if (text === undefined) {
    throw new Error(`unknown brain tool param: ${name} ${path} (no "## ${path}" in brain/tools/${name}/params.md)`);
  }
  readParams.add(`${name} ${path}`);
  return text;
}

/**
 * Throws unless the text of {@link toolParam}`(name, path)` contains each of
 * `facts` (as `String()` writes it). For a parameter whose text states a value
 * the code owns — a default, a cap: call it once at module load next to the
 * constant, so changing the constant without its params.md section fails the
 * import instead of sending the model a stale number.
 */
export function assertToolParamStates(name: string, path: string, ...facts: (string | number)[]): void {
  const text = toolParam(name, path);
  for (const fact of facts) {
    if (!text.includes(String(fact))) {
      throw new Error(
        `brain tool param ${name} ${path} does not state ${JSON.stringify(String(fact))}, the value the code uses — update brain/tools/${name}/params.md`,
      );
    }
  }
}

/** The tools that have a brain/tools folder, sorted. */
export function brainToolNames(): string[] {
  return Object.keys(BRAIN_TOOLS).sort();
}

/**
 * Every params.md section no {@link toolParam} call has read so far, as
 * `"<Tool> <path>"`. Once every tool module has loaded, a non-empty answer means
 * a section reaches no schema — a typo or an orphan that silently does nothing.
 */
export function unreadToolParams(): string[] {
  const out: string[] = [];
  for (const name of brainToolNames()) {
    for (const path of Object.keys(BRAIN_TOOLS[name]!.params)) {
      if (!readParams.has(`${name} ${path}`)) out.push(`${name} ${path}`);
    }
  }
  return out;
}

/** The tool set offered to a ROOT session, per context. */
export interface ToolAvailability {
  /** Offered while OVERDRIVE is off. */
  readonly main: readonly string[];
  /** Offered while OVERDRIVE is on. */
  readonly overdrive: readonly string[];
}

/** The built-in tool names availability applies to. Any other name (MCP's mcp__*, a test's own tool) is always offered. */
export function builtinToolNames(): readonly string[] {
  return BRAIN_BUILTIN_TOOLS;
}

export function isBuiltinTool(name: string): boolean {
  return BRAIN_BUILTIN_TOOLS.includes(name);
}

/** brain/availability.json as shipped. */
export function brainAvailability(): ToolAvailability {
  return { main: [...BRAIN_AVAILABILITY.main], overdrive: [...BRAIN_AVAILABILITY.overdrive] };
}

/**
 * An override on top of the shipped availability: a context it names replaces
 * that context's list, a context it omits keeps brain/availability.json. Throws
 * on a name that is not a built-in tool — the same rule the brain compiler
 * applies to availability.json.
 */
export function resolveToolAvailability(override?: Partial<ToolAvailability>): ToolAvailability {
  const shipped = brainAvailability();
  const resolved: ToolAvailability = {
    main: override?.main ? [...override.main] : shipped.main,
    overdrive: override?.overdrive ? [...override.overdrive] : shipped.overdrive,
  };
  for (const context of ["main", "overdrive"] as const) {
    for (const name of resolved[context]) {
      if (!isBuiltinTool(name)) throw new Error(`unknown tool in tool availability (${context}): ${name}`);
    }
  }
  return resolved;
}

/** The shipped availability with `names` added to BOTH contexts — how a test opts a withheld tool back in. */
export function toolAvailabilityWith(...names: string[]): ToolAvailability {
  const shipped = brainAvailability();
  const add = (list: readonly string[]): string[] => [...list, ...names.filter((n) => !list.includes(n))];
  return resolveToolAvailability({ main: add(shipped.main), overdrive: add(shipped.overdrive) });
}

/**
 * Whether a root session offers tool `name` in the current context. A name that
 * is not a built-in tool is always offered: availability never filters MCP
 * tools or tools an embedder registered itself.
 */
export function isToolOffered(name: string, availability: ToolAvailability, overdrive: boolean): boolean {
  if (!isBuiltinTool(name)) return true;
  return (overdrive ? availability.overdrive : availability.main).includes(name);
}

/* ---- behavior.json ------------------------------------------------------ */

/** A deep partial: every key optional, and a list (or any other non-object) replaced whole. */
type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * The runtime seam on top of brain/behavior.json: `EngineOptions.behavior` and
 * `SessionOptions.behavior`. An embedder/test value like toolAvailability —
 * never a setting, never persisted. Merged over the shipped object by
 * {@link resolveBehavior}: a section merges key by key; a list, and
 * `overdrive.overrides` as a whole, REPLACE the shipped value.
 */
export type BehaviorOverride = DeepPartial<BrainBehavior>;

type Bag = Record<string, unknown>;

const isObject = (v: unknown): v is Bag => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown): string => JSON.stringify(v) ?? String(v);

// The checker below is the line-for-line twin of tools/brain/compile.mjs's
// (childrenOf, leafProblems, sectionProblems, mergeBehavior, crossProblems,
// behaviorProblems). Both run on the same data — BRAIN_BEHAVIOR_SPEC is that
// file's spec, emitted — and write the same problem text for the same input.

/** The direct child names of section `prefix` ("" = root) in the flat spec, in spec order. */
function childrenOf(spec: BrainBehaviorSpec, prefix: string): string[] {
  const out: string[] = [];
  for (const path of Object.keys(spec.keys)) {
    if (prefix !== "" && !path.startsWith(`${prefix}.`)) continue;
    const name = path.slice(prefix === "" ? 0 : prefix.length + 1).split(".")[0]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function leafProblems(value: unknown, rule: BrainBehaviorRule, shown: string, out: string[]): void {
  if (rule.type === "bool") {
    if (typeof value !== "boolean") out.push(`${shown} must be true or false (got ${show(value)})`);
  } else if (rule.type === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) out.push(`${shown} must be an integer (got ${show(value)})`);
    else if (value < rule.min || value > rule.max) out.push(`${shown}: ${value} is out of range ${rule.min}..${rule.max}`);
  } else if (rule.type === "enum") {
    if (typeof value !== "string" || !rule.values.includes(value)) {
      out.push(`${shown}: ${show(value)} is not one of ${rule.values.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  } else if (rule.type === "list") {
    if (!Array.isArray(value)) {
      out.push(`${shown} must be a list of strings (got ${show(value)})`);
      return;
    }
    if (value.length < rule.min || value.length > rule.max) out.push(`${shown}: ${value.length} entries is out of range ${rule.min}..${rule.max}`);
    const pattern = new RegExp(rule.item.source, rule.item.flags);
    const seen = new Set<string>();
    value.forEach((item: unknown, i) => {
      if (typeof item !== "string") out.push(`${shown}[${i}] must be a string (got ${show(item)})`);
      else if (!pattern.test(item)) out.push(`${shown}[${i}]: ${JSON.stringify(item)} does not match /${rule.item.source}/${rule.item.flags}`);
      else if (seen.has(item)) out.push(`${shown} lists ${JSON.stringify(item)} twice`);
      else seen.add(item);
    });
  }
}

function sectionProblems(
  spec: BrainBehaviorSpec,
  value: unknown,
  prefix: string,
  shownPrefix: string,
  partial: boolean,
  out: string[],
  only: readonly string[] | undefined,
): void {
  const shownSelf = shownPrefix === "" ? "the behaviour object" : shownPrefix;
  if (!isObject(value)) {
    out.push(`${shownSelf} must be an object (got ${show(value)})`);
    return;
  }
  const names = childrenOf(spec, prefix).filter((n) => only === undefined || only.includes(n));
  const at = (p: string, n: string): string => (p === "" ? n : `${p}.${n}`);
  for (const key of Object.keys(value)) {
    if (!names.includes(key)) out.push(`unknown key "${at(shownPrefix, key)}"`);
  }
  for (const name of names) {
    const path = at(prefix, name);
    const shown = at(shownPrefix, name);
    if (!(name in value)) {
      if (!partial) out.push(`missing key "${shown}"`);
      continue;
    }
    const rule = spec.keys[path];
    if (rule === undefined) sectionProblems(spec, value[name], path, shown, partial, out, undefined);
    else if (rule.type === "overrides") sectionProblems(spec, value[name], "", shown, true, out, rule.sections);
    else leafProblems(value[name], rule, shown, out);
  }
}

const getPath = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), obj);

/** `patch` merged over `base`: a section merges key by key; a scalar, a list or overdrive.overrides replaces the whole value. */
function mergeBehavior(spec: BrainBehaviorSpec, base: unknown, patch: unknown, prefix = ""): unknown {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out: Bag = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    out[key] = spec.keys[path] === undefined && isObject(base[key]) && isObject(value) ? mergeBehavior(spec, base[key], value, path) : value;
  }
  return out;
}

function crossProblems(spec: BrainBehaviorSpec, value: unknown, out: string[]): void {
  for (const rule of spec.cross) {
    if (rule.type === "lte") {
      const [a, b] = rule.keys;
      const va = getPath(value, a) as number;
      const vb = getPath(value, b) as number;
      if (va > vb) out.push(`${a} (${va}) must not be more than ${b} (${vb})`);
    }
  }
}

/**
 * Every problem with a COMPLETE behaviour object, each naming its dotted key —
 * the same checks, in the same words, as the brain compiler applies to
 * brain/behavior.json (without its `behavior.json: ` prefix). Empty = valid.
 */
export function behaviorProblems(value: unknown): string[] {
  const spec = BRAIN_BEHAVIOR_SPEC;
  const out: string[] = [];
  sectionProblems(spec, value, "", "", false, out, undefined);
  if (out.length > 0) return out;
  crossProblems(spec, value, out);
  // A rule already broken by the base is not reported again for OVERDRIVE.
  const overdrive: string[] = [];
  crossProblems(spec, mergeBehavior(spec, value, getPath(value, "overdrive.overrides")), overdrive);
  for (const p of overdrive) if (!out.includes(p)) out.push(`in OVERDRIVE (overdrive.overrides applied): ${p}`);
  return out;
}

/** A plain copy of JSON data, so freezing it never freezes an object a caller still holds. */
function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => cloneJson(v)) as T;
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneJson(v)])) as T;
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const SHIPPED_BEHAVIOR: BrainBehavior = deepFreeze(cloneJson(BRAIN_BEHAVIOR));

/**
 * Every object {@link resolveBehavior} has returned, the shipped one included:
 * already validated and deep-frozen, so handing one back in (a subagent child
 * gets its parent's) returns it as is. Membership is the only way past the
 * check — a look-alike object built elsewhere is merged and validated like any
 * override, so no caller can slip an unvalidated value into a session.
 */
const RESOLVED = new WeakSet<object>([SHIPPED_BEHAVIOR]);

/** brain/behavior.json as shipped: one deep-frozen object. */
export function brainBehavior(): BrainBehavior {
  return SHIPPED_BEHAVIOR;
}

/** Every knob's rule as data (dotted key → rule), plus the cross rules — what an override is validated against. */
export function brainBehaviorSpec(): BrainBehaviorSpec {
  return BRAIN_BEHAVIOR_SPEC;
}

/**
 * The behaviour a session runs with: the shipped object, or `override` merged
 * over it (a section merges key by key; a list and `overdrive.overrides`
 * replace the whole value) and validated with the compiler's own rules. Throws
 * `invalid behaviour override: <problem>; …`, each problem naming its dotted
 * key. The result is deep-frozen and shares nothing with `override`.
 * `undefined` is the shipped object; an object this function already returned
 * (the shipped one included) comes back unchanged, since it was validated then.
 */
export function resolveBehavior(override?: BehaviorOverride): BrainBehavior {
  if (override === undefined) return SHIPPED_BEHAVIOR;
  if (RESOLVED.has(override)) return override as BrainBehavior;
  const merged = mergeBehavior(BRAIN_BEHAVIOR_SPEC, SHIPPED_BEHAVIOR, override);
  const problems = behaviorProblems(merged);
  if (problems.length > 0) throw new Error(`invalid behaviour override: ${problems.join("; ")}`);
  const resolved = deepFreeze(cloneJson(merged)) as BrainBehavior;
  RESOLVED.add(resolved);
  return resolved;
}

const overdriveBehaviors = new WeakMap<BrainBehavior, BrainBehavior>();

/**
 * What a session reads right now: `resolved` itself, or — while OVERDRIVE is
 * on — `resolved` with its `overdrive.overrides` merged over it. Pass
 * `overdrive && !child`: the overrides apply to ROOT sessions only. The same
 * object comes back for the same `resolved` every time, so a cache keyed by it
 * holds.
 */
export function effectiveBehavior(resolved: BrainBehavior, overdrive: boolean): BrainBehavior {
  if (!overdrive) return resolved;
  let out = overdriveBehaviors.get(resolved);
  if (out === undefined) {
    out = deepFreeze(cloneJson(mergeBehavior(BRAIN_BEHAVIOR_SPEC, resolved, resolved.overdrive.overrides))) as BrainBehavior;
    overdriveBehaviors.set(resolved, out);
  }
  return out;
}

/**
 * The shipped behaviour with `override` merged in, validated — how a test
 * changes one knob (the twin of {@link toolAvailabilityWith}). Pass the result
 * as `EngineOptions.behavior`.
 */
export function behaviorWith(override: BehaviorOverride): BrainBehavior {
  return resolveBehavior(override);
}
