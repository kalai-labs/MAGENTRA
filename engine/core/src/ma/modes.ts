import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../config/frontmatter.js";
import { BUILTIN_SKILL_FILES } from "./builtin.js";

/**
 * Discipline skills: Markdown files that shape how the agent works — a
 * directive, shared vocabulary, turn injections, tool gates, checklists.
 * Eleven canonical disciplines ship built in; a workspace adds or overrides
 * them with `kind: discipline` files under .magentra/skills/ (the same folder
 * as on-demand action skills — see agent/skills.ts).
 *
 * Format: slim `---` frontmatter (hand-parsed, strings only) + a Markdown
 * body. The body before the first known `## ` heading is the directive; the
 * recognized sections are `## Vocabulary`, `## On turn start`,
 * `## After an error`, `## Planning checklist`, `## Wrap-up checklist`.
 *
 * Every discipline is optional and OFF by default — there are no locked
 * skills. {@link RECOMMENDED_SKILL_IDS} only powers a "Recommended" badge and
 * the one-click enable set in frontends; the engine never forces them on.
 */

export interface MaGate {
  tools: string[];
  /**
   * When the gate lets a call through: "tasks-exist" once the task list is
   * non-empty, "never" always blocks, "repro-failed" only once the session has
   * observed the designated repro script FAIL (the fail→pass oracle in the
   * debugger skill — see Session's repro-run tracking).
   */
  require: "tasks-exist" | "never" | "repro-failed";
  message: string;
}

export interface MaMode {
  id: string;
  name: string;
  description: string;
  /** Why a user would enable this skill — powers the "?" explainers in frontends. */
  why: string;
  version: number;
  auto: string[];
  source: "builtin" | "workspace";
  directive?: string;
  vocab: { term: string; def: string }[];
  injections: { event: "turn-start" | "after-error"; text: string }[];
  gates: MaGate[];
  checklists: { phase: "planning" | "wrap-up"; items: string[] }[];
  /** Ids of skills this one must not be simultaneously active with (see `conflicts:`). */
  conflicts: string[];
  /** Id of the skill this one merges onto (see `extends:`); a skill may extend itself by id. */
  extends?: string;
}

const SKILL_ID_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * The disciplines a fresh user is nudged toward: frontends badge them
 * "Recommended" and offer a one-click enable of the whole set. Advisory only —
 * the engine treats them exactly like any other optional skill.
 */
export const RECOMMENDED_SKILL_IDS: readonly string[] = [
  "headlights",
  "prover",
  "deepmodule",
  "surgeon",
  "sentinel",
  "obvious",
  "lexicon",
];

// Startup invariant: every recommended id must name a real builtin — a typo
// here would silently un-badge a discipline. Builtins are code, so fail loudly.
{
  const builtinIds = new Set(BUILTIN_SKILL_FILES.map((b) => b.id));
  const missing = RECOMMENDED_SKILL_IDS.filter((id) => !builtinIds.has(id));
  if (missing.length > 0) {
    throw new Error(`RECOMMENDED_SKILL_IDS names unknown builtin(s): ${missing.join(", ")}`);
  }
}

/** The frontmatter keys a discipline may carry; anything else is a hard error. */
const DISCIPLINE_KEYS = new Set([
  "kind",
  "id",
  "name",
  "description",
  "why",
  "version",
  "auto",
  "conflicts",
  "extends",
  "gate",
]);

/** Body `## ` headings the discipline parser understands. */
const SECTION_TITLES = new Map<string, "vocab" | "turn-start" | "after-error" | "planning" | "wrap-up">([
  ["vocabulary", "vocab"],
  ["on turn start", "turn-start"],
  ["after an error", "after-error"],
  ["planning checklist", "planning"],
  ["wrap-up checklist", "wrap-up"],
]);

const GATE_RE = /^(?<tools>[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+requires\s+(?<req>tasks-exist|never|repro-failed)\s*:\s*(?<msg>.+)$/;

/**
 * Tracks, per parsed skill, which optional frontmatter keys were explicitly
 * present in the source (as opposed to defaulted) — loadModes needs this to
 * decide, for a merged (`extends:`) skill, whether a metadata field comes from
 * the child or falls back to the base.
 */
const explicitKeysOf = new WeakMap<MaMode, Set<string>>();

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses a discipline-skill Markdown text into a MaMode. Throws Error with a
 * line-numbered message on any violation. `fileId` is the id derived from the
 * file name; frontmatter `id:` overrides it (builtins pass their id here).
 */
export function parseSkillMd(text: string, source: "builtin" | "workspace", fileId?: string): MaMode {
  const fm = parseFrontmatter(text);
  if (!fm.present) {
    throw new Error(`line 1: a discipline skill must open with "---" frontmatter (kind: discipline)`);
  }
  if ((fm.map.kind ?? "").trim() !== "discipline") {
    throw new Error(`line 1: frontmatter must declare "kind: discipline"`);
  }

  let id = fileId;
  let name: string | undefined;
  let description: string | undefined;
  let why: string | undefined;
  let version: number | undefined;
  let auto: string[] | undefined;
  let conflicts: string[] | undefined;
  let extendsId: string | undefined;
  const gates: MaGate[] = [];

  for (const entry of fm.entries) {
    if (!DISCIPLINE_KEYS.has(entry.key)) {
      throw new Error(
        `line ${entry.line}: unknown frontmatter key "${entry.key}" (allowed: ${[...DISCIPLINE_KEYS].join(", ")})`,
      );
    }
    switch (entry.key) {
      case "id":
        if (!SKILL_ID_RE.test(entry.value)) {
          throw new Error(`line ${entry.line}: id "${entry.value}" must match [a-z][a-z0-9_-]*`);
        }
        id = entry.value;
        break;
      case "name":
        name = entry.value;
        break;
      case "description":
        description = entry.value;
        break;
      case "why":
        why = entry.value;
        break;
      case "version": {
        const v = Number.parseInt(entry.value, 10);
        if (!Number.isFinite(v) || String(v) !== entry.value.trim()) {
          throw new Error(`line ${entry.line}: version "${entry.value}" is not an integer`);
        }
        version = v;
        break;
      }
      case "auto":
        auto = splitList(entry.value);
        break;
      case "conflicts":
        conflicts = splitList(entry.value);
        break;
      case "extends":
        if (!SKILL_ID_RE.test(entry.value)) {
          throw new Error(`line ${entry.line}: extends "${entry.value}" must match [a-z][a-z0-9_-]*`);
        }
        extendsId = entry.value;
        break;
      case "gate": {
        const m = GATE_RE.exec(entry.value);
        if (!m || !m.groups) {
          throw new Error(
            `line ${entry.line}: gate must be "<Tool[, Tool…]> requires <tasks-exist|never|repro-failed>: <message>"`,
          );
        }
        gates.push({
          tools: splitList(m.groups.tools!),
          require: m.groups.req as MaGate["require"],
          message: m.groups.msg!.trim(),
        });
        break;
      }
      default:
        break; // "kind" — already validated
    }
  }

  if (!id) throw new Error(`line 1: missing id — add "id: <slug>" to the frontmatter or name the file <slug>.md`);
  if (!SKILL_ID_RE.test(id)) throw new Error(`line 1: id "${id}" must match [a-z][a-z0-9_-]*`);

  // ── Body: directive preamble + recognized "## " sections. ────────────────
  const bodyLines = fm.body.replace(/\r/g, "").split("\n");
  let directive: string | undefined;
  const vocab: { term: string; def: string }[] = [];
  const injections: { event: "turn-start" | "after-error"; text: string }[] = [];
  const checklists: { phase: "planning" | "wrap-up"; items: string[] }[] = [];

  type Section = { kind: ReturnType<typeof SECTION_TITLES.get> | "directive"; start: number; lines: string[] };
  const sections: Section[] = [{ kind: "directive", start: 0, lines: [] }];
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]!;
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      const title = heading[1]!.trim().toLowerCase();
      const kind = SECTION_TITLES.get(title);
      if (!kind) {
        throw new Error(
          `line ${fm.bodyLine + i}: unknown section "## ${heading[1]!.trim()}" — a discipline body allows: ` +
            `Vocabulary, On turn start, After an error, Planning checklist, Wrap-up checklist ` +
            `(use ### or deeper for headings inside the directive)`,
        );
      }
      sections.push({ kind, start: i + 1, lines: [] });
      continue;
    }
    sections[sections.length - 1]!.lines.push(line);
  }

  for (const section of sections) {
    const text = trimBlankEdges(section.lines).join("\n");
    switch (section.kind) {
      case "directive":
        if (text) directive = text;
        break;
      case "vocab": {
        for (let li = 0; li < section.lines.length; li++) {
          const raw = section.lines[li]!;
          if (raw.trim() === "") continue;
          const m = /^- (.+)$/.exec(raw);
          const colon = m ? m[1]!.indexOf(":") : -1;
          if (!m || colon === -1) {
            throw new Error(`line ${fm.bodyLine + section.start + li}: vocabulary line must be "- term: definition"`);
          }
          vocab.push({ term: m[1]!.slice(0, colon).trim(), def: m[1]!.slice(colon + 1).trim() });
        }
        break;
      }
      case "turn-start":
      case "after-error":
        if (text) injections.push({ event: section.kind, text });
        break;
      case "planning":
      case "wrap-up": {
        const items = section.lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
        checklists.push({ phase: section.kind === "planning" ? "planning" : "wrap-up", items });
        break;
      }
    }
  }

  const explicit = new Set<string>();
  if (name !== undefined) explicit.add("name");
  if (version !== undefined) explicit.add("version");
  if (description !== undefined) explicit.add("description");
  if (why !== undefined) explicit.add("why");
  if (auto !== undefined) explicit.add("auto");
  if (conflicts !== undefined) explicit.add("conflicts");

  const mode: MaMode = {
    id,
    name: name ?? id,
    description: description ?? "",
    why: why ?? description ?? "",
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
  explicitKeysOf.set(mode, explicit);
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
 * Merges a workspace child skill onto its builtin base (the skill named by the
 * child's `extends:`). Metadata (name/description/why/version/auto/conflicts)
 * takes the child's value only where the child explicitly set it, otherwise
 * the base's; directive is the child's if present, else the base's; vocab is
 * the base's terms in order with child redefinitions applied in place, then
 * new child terms appended; injections and checklists are the base's followed
 * by the child's; gates are the base's unless the child declares any gate, in
 * which case the child's replace them entirely. The result carries the child's
 * id and "workspace" source.
 */
function mergeMode(base: MaMode, child: MaMode): MaMode {
  const explicit =
    explicitKeysOf.get(child) ?? new Set(["name", "version", "description", "why", "auto", "conflicts"]);

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
    why: explicit.has("why") ? child.why : base.why,
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
 * Lists candidate skill files under <cwd>/.magentra/skills: flat `<id>.md`
 * files and `<dir>/SKILL.md` one level deep. Shared shape with the action-
 * skill loader so both kinds live in one folder.
 */
export function listSkillFiles(cwd: string): { file: string; path: string; fallbackId: string }[] {
  const dir = join(cwd, ".magentra", "skills");
  if (!existsSync(dir)) return [];
  const out: { file: string; path: string; fallbackId: string }[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const skillPath = join(full, "SKILL.md");
      if (existsSync(skillPath)) out.push({ file: `${entry}/SKILL.md`, path: skillPath, fallbackId: entry });
    } else if (entry.toLowerCase().endsWith(".md")) {
      out.push({ file: entry, path: full, fallbackId: entry.slice(0, -3) });
    }
  }
  return out;
}

/**
 * Parses the builtin disciplines (a parse failure there is a programming bug —
 * let it throw), then any workspace `kind: discipline` skill files under
 * <cwd>/.magentra/skills/ (files of other kinds belong to the action-skill
 * loader and are skipped here). A workspace skill without `extends:` whose id
 * matches a builtin (or an earlier workspace skill) replaces it outright. One
 * with `extends: <id>` is merged onto the builtin named <id> (see mergeMode);
 * if no builtin has that id, a warning is recorded and the file loads as a
 * standalone skill under its own id. A file that fails to parse is skipped
 * with a warning rather than crashing the engine.
 */
export function loadModes(cwd: string): { modes: MaMode[]; warnings: string[] } {
  const warnings: string[] = [];
  const builtinsById = new Map<string, MaMode>();
  const byId = new Map<string, MaMode>();
  for (const builtin of BUILTIN_SKILL_FILES) {
    const mode = parseSkillMd(builtin.text, "builtin", builtin.id);
    builtinsById.set(mode.id, mode);
    byId.set(mode.id, mode);
  }

  for (const candidate of listSkillFiles(cwd)) {
    let text: string;
    try {
      text = readFileSync(candidate.path, "utf8");
    } catch {
      continue;
    }
    if ((parseFrontmatter(text).map.kind ?? "").trim() !== "discipline") continue; // an action skill
    try {
      const mode = parseSkillMd(text, "workspace", candidate.fallbackId);
      if (mode.extends !== undefined) {
        const base = builtinsById.get(mode.extends);
        if (!base) {
          warnings.push(`skills/${candidate.file}: extends unknown skill "${mode.extends}"`);
          byId.set(mode.id, mode);
        } else {
          byId.set(mode.id, mergeMode(base, mode));
        }
      } else {
        byId.set(mode.id, mode);
      }
    } catch (err) {
      warnings.push(`skills/${candidate.file}: ${(err as Error).message}`);
    }
  }

  return { modes: [...byId.values()], warnings };
}

export interface ModeSummary {
  id: string;
  name: string;
  description: string;
  /** Why a user would enable it — the "?" explainer. */
  why: string;
  active: boolean;
  builtin: boolean;
  /** Badged "Recommended" in frontends (see {@link RECOMMENDED_SKILL_IDS}); never forced on. */
  recommended: boolean;
  conflicts: string[];
}

/** Holds the loaded discipline skills and the active subset for a session. */
export class ModeEngine {
  private active: string[] = [];
  private modes: MaMode[];

  constructor(modes: MaMode[], active: string[]) {
    this.modes = modes;
    this.active = this.resolve(active).active;
  }

  /**
   * Swaps in a freshly loaded skill list (e.g. after install_skill) while
   * keeping the current active set where those ids still exist. In-place so
   * every session holding this instance sees the reload.
   */
  replaceModes(modes: MaMode[]): void {
    this.modes = modes;
    this.active = this.resolve(this.active).active;
  }

  list(): ModeSummary[] {
    return this.modes.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      why: m.why,
      active: this.active.includes(m.id),
      builtin: m.source === "builtin",
      recommended: RECOMMENDED_SKILL_IDS.includes(m.id),
      conflicts: m.conflicts,
    }));
  }

  /**
   * Applies a desired active set. Every skill is freely toggleable — nothing
   * is locked on. `conflicts:` is resolved most-recent-wins: requesting a
   * skill drops any earlier-requested skill that conflicts with it (in either
   * direction). Returns advisory messages describing what a conflict dropped,
   * for the caller to surface.
   */
  setActive(ids: string[]): { messages: string[] } {
    const { active, messages } = this.resolve(ids);
    this.active = active;
    return { messages };
  }

  private resolve(ids: string[]): { active: string[]; messages: string[] } {
    const byId = new Map(this.modes.map((m) => [m.id, m]));
    const messages: string[] = [];
    const accepted: string[] = [];

    for (const id of ids) {
      const mode = byId.get(id);
      if (!mode || accepted.includes(id)) continue;
      for (let i = accepted.length - 1; i >= 0; i--) {
        const earlierId = accepted[i]!;
        const earlier = byId.get(earlierId)!;
        if (mode.conflicts.includes(earlierId) || earlier.conflicts.includes(id)) {
          accepted.splice(i, 1);
          messages.push(`${id} on — ${earlierId} off (they conflict)`);
        }
      }
      accepted.push(id);
    }

    return { active: accepted, messages };
  }

  activeModes(): MaMode[] {
    return this.modes.filter((m) => this.active.includes(m.id));
  }

  promptSections(): string[] {
    return this.activeModes().map((m) => {
      const parts: string[] = [`# skill: ${m.name} (${m.id})${m.directive ? `\n${m.directive}` : ""}`];
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
   * True when an active skill enforces the repro-failed oracle (the debugger):
   * a gate whose `require` is "repro-failed". The session uses this to decide
   * whether its repro-run tracking should also drive the "rerun the repro"
   * verify nudge, keeping the check out of any specific skill id.
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

export { BUILTIN_SKILL_FILES } from "./builtin.js";
export type { BuiltinSkill } from "./builtin.js";
