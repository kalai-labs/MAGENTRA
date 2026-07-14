import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_MA_FILES } from "./builtin.js";

/**
 * The .ma style system: small text files that shape how the agent works
 * (a directive, shared vocabulary, turn injections, tool gates, checklists).
 * Eleven canonical styles ship built in; a workspace may override any of them
 * by id under .magentra/modes/.
 */

export interface MaGate {
  tools: string[];
  /**
   * When the gate lets a call through: "tasks-exist" once the task list is
   * non-empty, "never" always blocks, "repro-failed" only once the session has
   * observed the designated repro script FAIL (the fail→pass oracle in
   * debug.ma — see Session's repro-run tracking).
   */
  require: "tasks-exist" | "never" | "repro-failed";
  message: string;
}

export interface MaMode {
  id: string;
  name: string;
  description: string;
  version: number;
  auto: string[];
  source: "builtin" | "workspace";
  directive?: string;
  vocab: { term: string; def: string }[];
  injections: { event: "turn-start" | "after-error"; text: string }[];
  gates: MaGate[];
  checklists: { phase: "planning" | "wrap-up"; items: string[] }[];
  /** Ids of modes this one must not be simultaneously active with (see @conflicts). */
  conflicts: string[];
  /** Id of the mode this one merges onto (see @extends); a mode may extend itself by id. */
  extends?: string;
}

const MODE_ID_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * The core quality modes — always active in every session, regardless of
 * settings, /settings, or a set_modes toggle. They are the product's
 * non-disableable discipline; only the remaining builtins (grill, entropy,
 * reshape) are optional and freely toggleable. Single source of truth for the
 * "which modes are locked on" question — the settings default, the engine, the
 * ModeSummary.core flag, and the desktop chips all derive from this list.
 */
export const CORE_MODE_IDS: readonly string[] = [
  "headlights",
  "prover",
  "deepmodule",
  "surgeon",
  "sentinel",
  "obvious",
  "lexicon",
];

// Startup invariant: every core id must name a real builtin. resolve() filters
// the core set through byId.has(id), so a typo'd core id would silently vanish
// and quietly disable a locked discipline. These are builtins — a mismatch is a
// programmer error, not a config issue — so fail loudly at module load.
{
  const builtinIds = new Set(BUILTIN_MA_FILES.map((b) => b.id));
  const missing = CORE_MODE_IDS.filter((id) => !builtinIds.has(id));
  if (missing.length > 0) {
    throw new Error(`CORE_MODE_IDS names unknown builtin(s): ${missing.join(", ")} (not in BUILTIN_MA_FILES)`);
  }
}

/**
 * Tracks, per parsed mode, which optional @headers were explicitly present in
 * the source text (as opposed to defaulted by the parser) — loadModes needs
 * this to decide, for a merged (@extends) mode, whether a metadata field
 * should come from the child or fall back to the base. Keyed by the mode
 * object itself since it's only ever consulted immediately after parsing.
 */
const explicitHeadersOf = new WeakMap<MaMode, Set<string>>();

/** Parses a .ma text into a MaMode. Throws Error with a line-numbered message on any grammar violation. */
export function parseMaFile(text: string, source: "builtin" | "workspace"): MaMode {
  const lines = text.replace(/\r/g, "").split("\n");

  let id: string | undefined;
  let name: string | undefined;
  let version: number | undefined;
  let description: string | undefined;
  let auto: string[] | undefined;
  let conflicts: string[] | undefined;
  let extendsId: string | undefined;

  let sectionStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("::")) {
      sectionStart = i;
      break;
    }
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (line.startsWith("@")) {
      const sp = line.indexOf(" ");
      const key = sp === -1 ? line.slice(1) : line.slice(1, sp);
      const rest = sp === -1 ? "" : line.slice(sp + 1).trim();
      switch (key) {
        case "mode":
          if (!MODE_ID_RE.test(rest)) {
            throw new Error(`line ${i + 1}: @mode "${rest}" must match [a-z][a-z0-9_-]*`);
          }
          id = rest;
          break;
        case "extends":
          if (!MODE_ID_RE.test(rest)) {
            throw new Error(`line ${i + 1}: @extends "${rest}" must match [a-z][a-z0-9_-]*`);
          }
          extendsId = rest;
          break;
        case "name":
          name = rest;
          break;
        case "version": {
          const v = Number.parseInt(rest, 10);
          if (!Number.isFinite(v) || String(v) !== rest.trim()) {
            throw new Error(`line ${i + 1}: @version "${rest}" is not an integer`);
          }
          version = v;
          break;
        }
        case "description":
          description = rest;
          break;
        case "auto":
          auto = rest
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          break;
        case "conflicts":
          conflicts = rest
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          break;
        default:
          break; // unknown @keys ignored
      }
      continue;
    }
    throw new Error(`line ${i + 1}: expected a blank line, comment, or @key before the first "::" section`);
  }

  if (!id) throw new Error(`line 1: missing required @mode metadata`);

  let directive: string | undefined;
  const vocab: { term: string; def: string }[] = [];
  const injections: { event: "turn-start" | "after-error"; text: string }[] = [];
  const gates: MaGate[] = [];
  const checklists: { phase: "planning" | "wrap-up"; items: string[] }[] = [];

  for (let i = sectionStart; i < lines.length; ) {
    const header = lines[i]!;
    const lineNo = i + 1;
    const rest = header.slice(2).trim();
    const tokens = rest.split(/\s+/).filter(Boolean);
    const kind = tokens[0];
    const args = tokens.slice(1);

    let end = i + 1;
    while (end < lines.length && !lines[end]!.startsWith("::")) end++;
    const body = lines.slice(i + 1, end);

    switch (kind) {
      case "directive": {
        if (directive !== undefined) throw new Error(`line ${lineNo}: multiple ::directive sections`);
        directive = trimBlankEdges(body).join("\n");
        break;
      }
      case "vocab": {
        for (let bi = 0; bi < body.length; bi++) {
          const bl = body[bi]!;
          if (bl.trim() === "") continue;
          const colon = bl.indexOf(":");
          if (colon === -1) throw new Error(`line ${i + 2 + bi}: vocab line must be "term: definition"`);
          vocab.push({ term: bl.slice(0, colon).trim(), def: bl.slice(colon + 1).trim() });
        }
        break;
      }
      case "inject": {
        const event = args[0];
        if (event !== "turn-start" && event !== "after-error") {
          throw new Error(
            `line ${lineNo}: ::inject event must be "turn-start" or "after-error", got "${event ?? ""}"`,
          );
        }
        injections.push({ event, text: trimBlankEdges(body).join("\n").trim() });
        break;
      }
      case "gate": {
        if (args[0] !== "pre-tool") {
          throw new Error(`line ${lineNo}: ::gate only supports "pre-tool", got "${args[0] ?? ""}"`);
        }
        const toolsArg = args[1];
        if (!toolsArg) throw new Error(`line ${lineNo}: ::gate pre-tool requires a comma-separated tool list`);
        const tools = toolsArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        let require: "tasks-exist" | "never" | "repro-failed" | undefined;
        const messageParts: string[] = [];
        for (let bi = 0; bi < body.length; bi++) {
          const bl = body[bi]!;
          if (bl.trim() === "") continue;
          if (bl.startsWith("require ")) {
            const v = bl.slice("require ".length).trim();
            if (v !== "tasks-exist" && v !== "never" && v !== "repro-failed") {
              throw new Error(
                `line ${i + 2 + bi}: gate require must be "tasks-exist", "never", or "repro-failed", got "${v}"`,
              );
            }
            require = v;
          } else if (bl.startsWith("message ")) {
            messageParts.push(bl.slice("message ".length).trim());
          } else {
            throw new Error(`line ${i + 2 + bi}: unexpected line in ::gate body: "${bl}"`);
          }
        }
        if (!require) throw new Error(`line ${lineNo}: ::gate is missing "require"`);
        if (messageParts.length === 0) throw new Error(`line ${lineNo}: ::gate is missing "message"`);
        gates.push({ tools, require, message: messageParts.join(" ") });
        break;
      }
      case "checklist": {
        const phase = args[0];
        if (phase !== "planning" && phase !== "wrap-up") {
          throw new Error(`line ${lineNo}: ::checklist phase must be "planning" or "wrap-up", got "${phase ?? ""}"`);
        }
        const items = body.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
        checklists.push({ phase, items });
        break;
      }
      default:
        throw new Error(`line ${lineNo}: unknown section "::${kind ?? ""}"`);
    }

    i = end;
  }

  const explicit = new Set<string>();
  if (name !== undefined) explicit.add("name");
  if (version !== undefined) explicit.add("version");
  if (description !== undefined) explicit.add("description");
  if (auto !== undefined) explicit.add("auto");
  if (conflicts !== undefined) explicit.add("conflicts");

  const mode: MaMode = {
    id,
    name: name ?? id,
    description: description ?? "",
    version: version ?? 1,
    auto: auto ?? [],
    source,
    ...(directive !== undefined ? { directive } : {}),
    ...(extendsId !== undefined ? { extends: extendsId } : {}),
    vocab,
    injections,
    gates,
    checklists,
    conflicts: conflicts ?? [],
  };
  explicitHeadersOf.set(mode, explicit);
  return mode;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Merges a workspace child mode onto its builtin base (the mode named by the
 * child's @extends). Metadata (name/description/version/auto/conflicts) takes
 * the child's value only where the child's source explicitly set it,
 * otherwise the base's; directive is the child's if present, else the
 * base's; vocab is the base's terms in order with any child redefinitions
 * applied in place, then new child terms appended; injections and
 * checklists are the base's followed by the child's; gates are the base's
 * unless the child declares any gate, in which case the child's replace them
 * entirely. The result always carries the child's id and "workspace" source.
 */
function mergeMode(base: MaMode, child: MaMode): MaMode {
  const explicit = explicitHeadersOf.get(child) ?? new Set(["name", "version", "description", "auto", "conflicts"]);

  const vocab = base.vocab.map((v) => child.vocab.find((cv) => cv.term === v.term) ?? v);
  const baseTerms = new Set(base.vocab.map((v) => v.term));
  for (const v of child.vocab) {
    if (!baseTerms.has(v.term)) vocab.push(v);
  }

  const directive = child.directive ?? base.directive;

  return {
    id: child.id,
    name: explicit.has("name") ? child.name : base.name,
    description: explicit.has("description") ? child.description : base.description,
    version: explicit.has("version") ? child.version : base.version,
    auto: explicit.has("auto") ? child.auto : base.auto,
    source: "workspace",
    ...(directive !== undefined ? { directive } : {}),
    vocab,
    injections: [...base.injections, ...child.injections],
    gates: child.gates.length > 0 ? child.gates : base.gates,
    checklists: [...base.checklists, ...child.checklists],
    conflicts: explicit.has("conflicts") ? child.conflicts : base.conflicts,
  };
}

/**
 * Parses the eleven builtins (a parse failure there is a programming bug —
 * let it throw), then any workspace .md or .ma files at <cwd>/.magentra/modes/
 * (.md is the canonical extension — plain markdown anyone can read and edit;
 * .ma is the legacy alias and keeps loading forever. With both foo.ma and
 * foo.md present, the .md wins — files load in sorted order, later replaces).
 * A workspace mode without @extends whose id matches a builtin (or another
 * workspace mode already loaded) replaces it outright. A workspace mode with
 * @extends <id> is merged onto the builtin named <id> (see mergeMode); if no
 * builtin has that id, a warning is recorded and the file is loaded as a
 * standalone mode under its own id instead. A workspace file that fails to
 * parse is skipped with a warning rather than crashing the engine.
 */
export function loadModes(cwd: string): { modes: MaMode[]; warnings: string[] } {
  const warnings: string[] = [];
  const builtinsById = new Map<string, MaMode>();
  const byId = new Map<string, MaMode>();
  for (const builtin of BUILTIN_MA_FILES) {
    const mode = parseMaFile(builtin.text, "builtin");
    builtinsById.set(mode.id, mode);
    byId.set(mode.id, mode);
  }

  const dir = join(cwd, ".magentra", "modes");
  if (existsSync(dir)) {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".ma") || f.endsWith(".md"))
      .sort();
    for (const file of files) {
      try {
        const text = readFileSync(join(dir, file), "utf8");
        const mode = parseMaFile(text, "workspace");
        if (mode.extends !== undefined) {
          const base = builtinsById.get(mode.extends);
          if (!base) {
            warnings.push(`modes/${file}: extends unknown mode "${mode.extends}"`);
            byId.set(mode.id, mode);
          } else {
            byId.set(mode.id, mergeMode(base, mode));
          }
        } else {
          byId.set(mode.id, mode);
        }
      } catch (err) {
        warnings.push(`modes/${file}: ${(err as Error).message}`);
      }
    }
  }

  return { modes: [...byId.values()], warnings };
}

export interface ModeSummary {
  id: string;
  name: string;
  description: string;
  active: boolean;
  builtin: boolean;
  /** A core quality mode (see {@link CORE_MODE_IDS}): always active, locked on. */
  core: boolean;
  conflicts: string[];
  /**
   * Set on a core mode that is currently suspended: the id of the active
   * optional style whose @conflicts pushed it off. A suspended core reports
   * active:false, but this names why — and it returns automatically the moment
   * that optional is deactivated. Absent when the core is not suspended.
   */
  suspendedBy?: string;
}

/** Holds the loaded .ma modes and the active subset for a session/engine. */
export class ModeEngine {
  private active: string[] = [];
  /** Core id → the active optional style suspending it. Empty when no core is suspended. */
  private suspended = new Map<string, string>();

  constructor(
    private readonly modes: MaMode[],
    active: string[],
  ) {
    // The desired list from settings names optional modes only; core modes are
    // implied and unioned in. Constructor discards the advisory messages — a
    // config file listing (or omitting) core ids is not a user toggle.
    const resolved = this.resolve(active);
    this.active = resolved.active;
    this.suspended = resolved.suspended;
  }

  list(): ModeSummary[] {
    return this.modes.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      active: this.active.includes(m.id),
      builtin: m.source === "builtin",
      core: CORE_MODE_IDS.includes(m.id),
      conflicts: m.conflicts,
      ...(this.suspended.has(m.id) ? { suspendedBy: this.suspended.get(m.id)! } : {}),
    }));
  }

  /**
   * Applies a desired active set. Core modes are forced on by default and can
   * never be plainly turned off; optional modes are layered on with @conflicts
   * resolved. When a requested optional conflicts with a core mode, the core is
   * *suspended* for as long as that optional stays active (see {@link resolve})
   * rather than the optional being refused. Returns any advisory messages the
   * caller should surface — the suspension/restoration notices, and a refusal
   * when the request tried to plainly drop a still-active core mode.
   */
  setActive(ids: string[]): { messages: string[] } {
    const { active, messages, suspended } = this.resolve(ids);
    this.active = active;
    this.suspended = suspended;
    return { messages };
  }

  /**
   * Resolves a desired id list into the effective active set. Core modes
   * (present among the loaded modes) lead the result; unknown ids are dropped.
   *
   * @conflicts resolution:
   * - An optional that conflicts with a core mode is accepted and *suspends*
   *   that core: the core drops out of the active set (active:false, reported
   *   via `suspended`) for as long as the optional is active, and resumes
   *   automatically once the optional is no longer requested — the core is
   *   re-unioned every call, so restoration falls out naturally.
   * - Among two optional modes that conflict, the most recently requested wins.
   *
   * Messages diff against the currently-committed suspension state so a toggle
   * announces exactly what changed: a suspension when a core is newly pushed
   * off, a restoration when a previously-suspended core comes back, and the
   * "always on" refusal only when a core is plainly omitted while nothing
   * suspends it (a direct deactivation attempt).
   */
  private resolve(ids: string[]): { active: string[]; messages: string[]; suspended: Map<string, string> } {
    const byId = new Map(this.modes.map((m) => [m.id, m]));
    const messages: string[] = [];
    const corePresent = CORE_MODE_IDS.filter((id) => byId.has(id));
    const accepted: string[] = [...corePresent];
    const suspended = new Map<string, string>();

    for (const id of ids) {
      if (CORE_MODE_IDS.includes(id)) continue; // core already present; redundant, ignored
      const mode = byId.get(id);
      if (!mode || accepted.includes(id)) continue;

      // Suspend every currently-accepted core mode this optional conflicts with
      // (in either direction): the optional is a legitimate alternative style.
      for (const coreId of accepted.filter(
        (a) => CORE_MODE_IDS.includes(a) && (mode.conflicts.includes(a) || byId.get(a)!.conflicts.includes(id)),
      )) {
        accepted.splice(accepted.indexOf(coreId), 1);
        suspended.set(coreId, id);
      }
      // Most-recent-wins among optionals: drop earlier optional modes that conflict.
      for (let i = accepted.length - 1; i >= 0; i--) {
        const earlierId = accepted[i]!;
        if (CORE_MODE_IDS.includes(earlierId)) continue; // core never dropped this way
        const earlierMode = byId.get(earlierId)!;
        if (mode.conflicts.includes(earlierId) || earlierMode.conflicts.includes(id)) {
          accepted.splice(i, 1);
        }
      }
      accepted.push(id);
    }

    // Announce newly suspended cores (loud message so no silent disabling).
    for (const [coreId, optId] of suspended) {
      if (this.suspended.get(coreId) !== optId) {
        messages.push(`${optId} on — core mode ${coreId} suspended while ${optId} is active`);
      }
    }
    // Announce cores restored because their suspending optional went away.
    for (const [coreId, optId] of this.suspended) {
      if (!suspended.has(coreId)) {
        messages.push(`${optId} off — core mode ${coreId} restored`);
      }
    }
    // Refuse a plain deactivation: a core omitted from the request that neither
    // a new optional suspends nor was already suspended (which would be a
    // restoration, handled above). Direct "turn off surgeon" still lands here.
    const omittedCore = corePresent.filter(
      (id) => !ids.includes(id) && !suspended.has(id) && !this.suspended.has(id),
    );
    if (omittedCore.length > 0) {
      messages.push(`Core quality modes are always on and cannot be turned off: ${omittedCore.join(", ")}.`);
    }

    return { active: accepted, messages, suspended };
  }

  activeModes(): MaMode[] {
    return this.modes.filter((m) => this.active.includes(m.id));
  }

  promptSections(): string[] {
    return this.activeModes().map((m) => {
      const parts: string[] = [`# style: ${m.name} (${m.id}.ma)${m.directive ? `\n${m.directive}` : ""}`];
      if (m.vocab.length > 0) {
        parts.push(`Shared language:\n${m.vocab.map((v) => `- ${v.term} — ${v.def}`).join("\n")}`);
      }
      const planning = m.checklists.find((c) => c.phase === "planning");
      if (planning && planning.items.length > 0) {
        parts.push(`Before starting:\n${planning.items.map((i) => `- ${i}`).join("\n")}`);
      }
      const wrapup = m.checklists.find((c) => c.phase === "wrap-up");
      if (wrapup && wrapup.items.length > 0) {
        parts.push(`Before finishing:\n${wrapup.items.map((i) => `- ${i}`).join("\n")}`);
      }
      return parts.join("\n\n");
    });
  }

  turnStartInjections(): string[] {
    return this.activeModes().flatMap((m) =>
      m.injections.filter((inj) => inj.event === "turn-start").map((inj) => inj.text),
    );
  }

  afterErrorInjections(): string[] {
    return this.activeModes().flatMap((m) =>
      m.injections.filter((inj) => inj.event === "after-error").map((inj) => inj.text),
    );
  }

  gateFor(toolName: string): { mode: MaMode; gate: MaGate } | undefined {
    for (const mode of this.activeModes()) {
      const gate = mode.gates.find((g) => g.tools.includes(toolName));
      if (gate) return { mode, gate };
    }
    return undefined;
  }

  /**
   * True when an active style enforces the repro-failed oracle (debug.ma): a
   * gate whose `require` is "repro-failed". The session uses this to decide
   * whether its repro-run tracking should also drive the "rerun the repro"
   * verify nudge, keeping the check out of any specific mode id.
   */
  requiresReproOracle(): boolean {
    return this.activeModes().some((m) => m.gates.some((g) => g.require === "repro-failed"));
  }

  wrapupChecklist(): string {
    const items = this.activeModes().flatMap((m) =>
      m.checklists.filter((c) => c.phase === "wrap-up").flatMap((c) => c.items),
    );
    return items.length === 0 ? "" : items.map((i) => `- ${i}`).join("\n");
  }
}

export { BUILTIN_MA_FILES } from "./builtin.js";
export type { BuiltinMa } from "./builtin.js";
