import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { definePrompt, renderPrompt } from "@magentra/protocol";
import { parseFrontmatter } from "../config/frontmatter.js";
import { BUILTIN_ADDONS } from "./builtinAddons.js";

/**
 * The header that carries an invoked addon into the conversation.
 *
 * ONE definition for both entry paths — the `Addon` tool and the `/<name>`
 * slash command. It was previously the same sentence written out at both call
 * sites, in two packages, so an edit to either changed the behaviour of half the
 * ways an addon can be invoked.
 *
 * The precedence clause is the load-bearing part. It used to say only that the
 * addon's instructions "take priority over general guidance", which named no
 * limit: a procedure written to be relentless (an interview addon, a checklist
 * that insists on every step) then kept going through the user's own attempts to
 * redirect it — delegating a decision back to the agent, or asking it to stop —
 * because nothing in the system said the user ranked above a loaded addon.
 */
const ADDON_INVOKE_HEADER = definePrompt({
  id: "addon.invoke-header",
  group: "2 · Injected reminders",
  label: "Addon invocation header",
  channel: "reminder",
  where:
    "Prepended to an addon's body every time one is invoked, by the Addon tool and by the /<name> slash command alike. `{{name}}` is the addon's name.",
  placeholders: ["name"],
  text: `The "{{name}}" addon was invoked. Follow its instructions below for this task — they outrank your default behaviour.

The user outranks them in turn. When their message asks for something these instructions do not allow for — handing a decision back to you, telling you to stop or move on, or narrowing what they want — follow the user and adapt the procedure to fit. An addon shapes how you work; the user decides what you are working on.`,
});

/**
 * The `<system-reminder>` + `<command-name>` preamble an invoked addon's body is
 * prefixed with. Both invocation paths call this, so they cannot drift.
 */
export function addonInvocationHeader(name: string): string {
  return (
    `<system-reminder>${renderPrompt(ADDON_INVOKE_HEADER, { name })}</system-reminder>\n` +
    `<command-name>/${name}</command-name>\n`
  );
}

/** Directory name addons live under, inside a workspace's or the user's `.magentra`. */
export const ADDONS_DIR = "addons";

/** Filename that marks a directory as one addon. */
export const ADDON_ENTRY = "ADDON.md";

/** How many sibling files of one addon are advertised to the model. */
const MAX_RESOURCES = 24;

/**
 * An addon: a procedure the model loads on demand through the Addon tool.
 *
 * Every addon is always discoverable — its `name` and `description` ride in the
 * system prompt, and its `body` is only paid for when the model actually invokes
 * it. There is no enabled/disabled state and nothing is ever injected into a
 * turn automatically.
 */
export interface Addon {
  name: string;
  description: string;
  body: string;
  /** Absolute path of the file the body came from; absent for a built-in. */
  path?: string;
  /**
   * Sibling files that live alongside a directory addon, as paths relative to
   * the workspace. Reference notes and runnable scripts both land here: the
   * Addon tool lists them so the model knows what it may Read or run with Bash.
   * Empty for a flat `<name>.md` addon and for every built-in.
   */
  resources: string[];
  source: "builtin" | "global" | "workspace";
}

interface Candidate {
  path: string;
  /** Directory holding the addon, when it is a directory addon. */
  dir?: string;
  fallbackName: string;
}

/**
 * Candidate addon files in one directory: a flat `<name>.md`, or a
 * `<name>/ADDON.md` one level down. A directory without an ADDON.md is skipped
 * — it may be anything, and guessing would load a README as an addon.
 */
function listAddonFiles(dir: string): Candidate[] {
  if (!existsSync(dir)) return [];
  const out: Candidate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const entryPath = join(full, ADDON_ENTRY);
      if (existsSync(entryPath)) out.push({ path: entryPath, dir: full, fallbackName: entry });
    } else if (entry.toLowerCase().endsWith(".md")) {
      out.push({ path: full, fallbackName: entry.slice(0, -3) });
    }
  }
  return out;
}

/**
 * Everything in an addon's directory except its own ADDON.md, one level of
 * nesting included so `references/` and `scripts/` subfolders are visible.
 * Bounded: an addon that ships a whole tree advertises only the first slice, and
 * the model can always list the rest itself.
 */
function listResources(dir: string, cwd: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_RESOURCES) return;
      const full = join(current, entry);
      if (current === dir && entry === ADDON_ENTRY) continue;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth > 0) walk(full, depth - 1);
      } else {
        out.push(relative(cwd, full));
      }
    }
  };
  walk(dir, 1);
  return out;
}

/** Reads one candidate into an Addon, or undefined when it is unreadable. */
function readAddon(candidate: Candidate, source: Addon["source"], cwd: string): Addon | undefined {
  let text: string;
  try {
    text = readFileSync(candidate.path, "utf8");
  } catch {
    return undefined;
  }
  const fm = parseFrontmatter(text);
  const body = fm.body.trim();
  if (!body) return undefined;
  return {
    name: fm.map.name?.trim() || candidate.fallbackName,
    description: fm.map.description?.trim() || firstLine(body) || candidate.fallbackName,
    body,
    path: candidate.path,
    resources: candidate.dir ? listResources(candidate.dir, cwd) : [],
    source,
  };
}

/**
 * Loads every addon available to a workspace, in increasing precedence:
 * the built-ins that ship with the app, then `~/.magentra/addons`, then
 * `<cwd>/.magentra/addons`. An addon whose name repeats one already loaded
 * REPLACES it, so a workspace can override a built-in by name.
 *
 * Unreadable or empty-bodied files are skipped rather than failing the load —
 * one malformed addon must never stop a session from starting.
 */
export function loadAddons(cwd: string): Addon[] {
  const byName = new Map<string, Addon>();

  for (const builtin of BUILTIN_ADDONS) {
    const fm = parseFrontmatter(builtin.text);
    const body = fm.body.trim();
    byName.set(builtin.name, {
      name: fm.map.name?.trim() || builtin.name,
      description: fm.map.description?.trim() || firstLine(body) || builtin.name,
      body,
      resources: [],
      source: "builtin",
    });
  }

  const tiers: { dir: string; source: Addon["source"] }[] = [
    { dir: join(homedir(), ".magentra", ADDONS_DIR), source: "global" },
    { dir: join(cwd, ".magentra", ADDONS_DIR), source: "workspace" },
  ];
  for (const tier of tiers) {
    for (const candidate of listAddonFiles(tier.dir)) {
      const addon = readAddon(candidate, tier.source, cwd);
      if (addon) byName.set(addon.name, addon);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}
