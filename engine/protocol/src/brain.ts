import {
  BRAIN_AVAILABILITY,
  BRAIN_BUILTIN_TOOLS,
  BRAIN_TOOLS,
} from "./brain.generated.js";

/**
 * Tool prose and per-context tool sets from brain/ (see brain/README.md).
 *
 * brain/ is compiled by tools/brain/compile.mjs into brain.generated.ts before
 * tsc runs; nothing here touches the disk. Prompt defaults are seeded into the
 * prompt registry by prompts.ts — this module covers the two things that are
 * not registry prompts: a tool's description TEMPLATE and its parameters'
 * `.describe()` texts, and availability.json.
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
