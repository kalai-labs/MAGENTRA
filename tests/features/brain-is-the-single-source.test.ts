/**
 * `brain-is-the-single-source`.
 *
 * brain/ holds every model-facing default outside the subagent.* group — the
 * system and conditional sections, the in-turn reminders, the finishing rungs,
 * the side-call instructions, every tool description and every parameter
 * `.describe()` text — plus availability.json, the built-in tool set a ROOT
 * session is offered per context. `tools/brain/compile.mjs` turns it into
 * `engine/protocol/src/brain.generated.ts` before `tsc -b`, so `dist/` and the
 * bundled `engine.cjs` carry the defaults and nothing reads brain/ at run time.
 * The code keeps logic and schema SHAPE; call sites name prose by id
 * (`brainPrompt`, `toolDescription`, `toolParam`), and each accessor throws at
 * module load on a key brain/ does not hold.
 *
 * THREE KINDS IN ONE FILE, all three the record declares:
 *   - `pure` for checklist 1, 2, 3, 5 (the shipped half) and 6: the registry,
 *     the catalog and the compiler as functions of the committed brain/ and
 *     source files, read and never written.
 *   - `fs` for the round-trip property on crafted brain files (checklist 2),
 *     for checklist 5 driven through a real Session on the scripted provider,
 *     and for the override that must still win on top: each one writes a temp
 *     workspace or a temp brain.
 *   - `proc` for checklist 4 — "fails the build" is an exit code, so the real
 *     compiler is spawned — and checklist 7, which bundles and boots engine.cjs.
 *
 * ITEM 2 IS CHECKED AGAINST BRAIN ITSELF, never against copied prose: the
 * engine's runtime defaults equal a fresh compile of brain/ field for field;
 * the generated module on disk IS that fresh compile; every brain file
 * re-serialises to its own bytes from what the compiler read out of it; the
 * compiler, given bodies built to tempt a trim, returns them byte for byte; and
 * the texts the code composes around values reach the model as their brain
 * templates filled in. Rewording a brain prompt on purpose moves no assertion
 * here — only a text that no longer comes from brain/ does.
 *
 * CHECKLIST 7 IS `artifact = true` (docs/decisions/0010): it runs the real
 * bundler and boots what it produced, so it is withheld unless asked for —
 * `npm run test:artifacts` or MAGENTRA_ARTIFACT_TESTS=1.
 *
 * WHAT IS FAKED: the model, and only the model (`scriptedEngine.ts`). Every
 * assertion on a session is on what the real Session put into the provider's
 * request — the offered tool list, the tool_result the model was handed — or on
 * the tool's own `tool_call_finished`, never on what the script said.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { zodToJsonSchema, type AnyToolDefinition } from "@magentra/core";
import {
  brainAvailability,
  brainPromptIdList,
  brainToolNames,
  builtinToolNames,
  coreSectionOrder,
  isPromptDisabled,
  isToolOffered,
  promptCatalog,
  promptDefault,
  promptText,
  resolveToolAvailability,
  toolAvailabilityWith,
  toolDescription,
  toolParam,
  unreadToolParams,
  type CoreEvent,
  type ToolAvailability,
} from "@magentra/protocol";
import type { Msg, StreamRequest } from "@magentra/providers";
import { createDefaultRegistry } from "@magentra/tools";

import { withExclusiveLock } from "../lib/exclusive.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "brain-is-the-single-source";

/** Verbatim from the record. The base fails every test here if these ever differ. */
const INVARIANT =
  "Every model-facing default outside the subagent.* group is read from brain/ and nowhere else, and Agent and Workflow are withheld by default.";

/** The one documented exception: these stay literals in engine/core/src/agent/agents.ts. */
const SUBAGENT_GROUP = "6 · Subagents (Agent tool)";
const AGENTS_TS = "engine/core/src/agent/agents.ts";

/** The two tools availability.json ships withheld from both contexts. */
const WITHHELD = ["Agent", "Workflow"] as const;

const BRAIN_DIR = join(repoRoot(), "brain");
const COMPILER = join(repoRoot(), "tools", "brain", "compile.mjs");
const GENERATED = join(repoRoot(), "engine", "protocol", "src", "brain.generated.ts");

/** The refusal a withheld or switched-off tool gets: brain's template with the tool's name filled in (session.ts executeToolCalls). */
const switchedOff = (name: string): string => promptDefault("reminder.tool-switched-off").replace(/\{\{name\}\}/g, () => name);

/* ---- the compiler, imported as it is -------------------------------- */

interface CompiledPrompt {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly channel: string;
  readonly where: string;
  readonly placeholders?: readonly string[];
  readonly order?: number;
  readonly text: string;
}

interface CompiledTool {
  readonly description: string;
  readonly params: Readonly<Record<string, string>>;
}

interface CompileResult {
  readonly problems: readonly string[];
  readonly prompts?: readonly CompiledPrompt[];
  readonly tools?: Readonly<Record<string, CompiledTool>>;
  readonly availability?: ToolAvailability;
  readonly source?: string;
}

interface CompilerModule {
  compileBrain(dir: string): CompileResult;
  readonly BUILTIN_TOOLS: readonly string[];
  readonly GROUP_DIRS: Readonly<Record<string, string>>;
}

/**
 * `tools/brain/compile.mjs`, the real file, loaded the way `npm run build`
 * runs it. A computed specifier because the compiler is plain JS with no types;
 * its exports are declared above.
 */
const compiler = (await import(pathToFileURL(COMPILER).href)) as CompilerModule;

/** A successful compile, or a thrown list of the problems that stopped it. */
function compileOk(dir: string): Required<Omit<CompileResult, "problems">> {
  const result = compiler.compileBrain(dir);
  if (result.problems.length > 0 || result.source === undefined) {
    throw new Error(`brain at ${dir} does not compile:\n  ${result.problems.join("\n  ")}`);
  }
  return result as Required<Omit<CompileResult, "problems">>;
}

/**
 * The params.md sections no tool module read, taken once, right after the tool
 * modules loaded and before any test here calls `toolParam` itself — a test's
 * own reads would otherwise mark every section read.
 */
const UNREAD_AT_LOAD = unreadToolParams();

/* ---- small readers ---------------------------------------------------- */

/** A brain text file as the compiler reads it: BOM dropped, CRLF folded. */
function readBrainText(file: string): string {
  let text = readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, "\n");
}

/** Entries of a brain folder, without the dotfiles git needs to keep it. */
function entriesOf(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort();
}

/** Every prompt file under brain/prompts, as `{ folder, id, file }`. */
function promptFiles(): { folder: string; id: string; file: string }[] {
  const root = join(BRAIN_DIR, "prompts");
  const out: { folder: string; id: string; file: string }[] = [];
  for (const folder of entriesOf(root)) {
    const dir = join(root, folder);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of entriesOf(dir)) {
      if (name.endsWith(".md")) out.push({ folder, id: name.slice(0, -3), file: join(dir, name) });
    }
  }
  return out;
}

/** The folders under brain/tools — one per tool, by contract. */
function toolFolders(): string[] {
  const root = join(BRAIN_DIR, "tools");
  return entriesOf(root).filter((name) => statSync(join(root, name)).isDirectory());
}

/** Every `.ts` file under a source root, repo-relative with `/` separators. Generated modules are not source. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".generated.ts")) {
        out.push(relative(repoRoot(), full).split(sep).join("/"));
      }
    }
  };
  walk(join(repoRoot(), root));
  return out.sort();
}

/** The engine's source: every package's `src/`. */
function engineSources(): string[] {
  const engine = join(repoRoot(), "engine");
  return entriesOf(engine)
    .filter((pkg) => existsSync(join(engine, pkg, "src")))
    .flatMap((pkg) => sourceFiles(join("engine", pkg, "src")));
}

/**
 * Every `.describe()` text in a JSON Schema, keyed by the brain's param path:
 * dotted property names, array elements transparent, `(root)` for the schema
 * object's own description. The same convention params.md is written in.
 */
function describedParams(schema: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: unknown, path: string | undefined): void => {
    if (node === null || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n["description"] === "string") {
      const key = path ?? "(root)";
      if (key in out) throw new Error(`two descriptions at one param path "${key}" — the brain's path convention cannot tell them apart`);
      out[key] = n["description"];
    }
    if (n["properties"] && typeof n["properties"] === "object") {
      for (const [name, child] of Object.entries(n["properties"] as Record<string, unknown>)) walk(child, path ? `${path}.${name}` : name);
    }
    if (n["items"]) walk(n["items"], path);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(n[key])) for (const child of n[key] as unknown[]) walk(child, path);
    }
  };
  walk(schema, undefined);
  return out;
}

/** Keys sorted, so two records compare on content rather than on insertion order. */
function sorted(record: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/* ---- checklist 1 ------------------------------------------------------ */

abstract class BrainPureTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

class CatalogAndBrainFilesAreOneToOne extends BrainPureTest {
  readonly id = "the-catalog-outside-the-subagent-group-and-the-brain-files-are-one-to-one";
  readonly whyItExists =
    "a prompt registered from a literal left in code, or a brain file no call site registers, means the text the model receives and the text a person edits in brain/ are two different things — and both still look like the single source";

  override run(t: TestRun): void {
    // tool.<Name> registers when a registry registers the tool.
    const registry = createDefaultRegistry();
    const catalog = promptCatalog();

    const outside = catalog.filter((e) => e.group !== SUBAGENT_GROUP);
    const toolEntries = outside.filter((e) => e.id.startsWith("tool."));
    const proseEntries = outside.filter((e) => !e.id.startsWith("tool."));

    // brain/prompts: one file per non-tool prompt, no id in two folders.
    const files = promptFiles();
    const fileIds = files.map((f) => f.id).sort();
    t.assert.equal(new Set(fileIds).size, fileIds.length, `an id has a file in two group folders: ${fileIds.join(", ")}`);
    t.assert.deepEqual(
      proseEntries.map((e) => e.id).sort(),
      fileIds,
      "the catalog's prompts outside group 6 and brain/prompts' files must be the same set — an id on one side only was registered from somewhere else, or reaches no call site",
    );
    t.assert.deepEqual(brainPromptIdList(), fileIds, "the registry's brain-seeded ids are exactly the files brain/prompts holds");

    // Each entry sits in the folder its group names.
    const folderOf = new Map(files.map((f) => [f.id, f.folder]));
    for (const entry of proseEntries) {
      t.assert.equal(folderOf.get(entry.id), compiler.GROUP_DIRS[entry.group], `${entry.id} (group "${entry.group}") is filed in the wrong folder`);
    }

    // brain/tools: one folder per registered tool's description prompt.
    t.assert.deepEqual(
      toolEntries.map((e) => e.id).sort(),
      toolFolders().map((name) => `tool.${name}`),
      "every tool.<Name> prompt in the catalog must have its brain/tools/<Name> folder, and every folder a registered tool",
    );
    t.assert.deepEqual(
      registry.list().map((tool) => `tool.${tool.name}`).sort(),
      toolEntries.map((e) => e.id).sort(),
    );

    // Seeding registers every brain file, so registration alone cannot show a
    // file nothing reads: each one must be named by a brainPrompt("<id>") call,
    // or be a core section, which buildSystemPrompt() assembles by walking
    // coreSectionOrder() (brain-controls-behavior: brain decides which core
    // sections exist), so a section added only in brain reaches every request.
    const named = new Set<string>(coreSectionOrder());
    for (const file of engineSources()) {
      for (const line of readFileSync(join(repoRoot(), file), "utf8").split("\n")) {
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        for (const m of line.matchAll(/\bbrainPrompt\(\s*"([^"]+)"\s*\)/g)) named.add(m[1]!);
      }
    }
    t.assert.deepEqual(
      fileIds.filter((id) => !named.has(id)),
      [],
      "a brain/prompts file that no brainPrompt(\"<id>\") call names is an edit that reaches no model call",
    );

    // The exception is exactly subagent.*, and nothing else hides in group 6.
    const group6 = catalog.filter((e) => e.group === SUBAGENT_GROUP);
    t.assert.ok(group6.length > 0, "the subagent.* prompts register from agents.ts, so group 6 cannot be empty");
    for (const entry of group6) t.assert.match(entry.id, /^subagent\./, `${entry.id} is in group 6 but is not a subagent.* prompt`);
    for (const entry of outside) t.assert.doesNotMatch(entry.id, /^subagent\./, `${entry.id} is a subagent.* prompt outside group 6`);
  }
}

class NoDefinePromptCarriesLiteralText extends BrainPureTest {
  readonly id = "no-definePrompt-call-outside-agents-ts-carries-literal-text";
  readonly whyItExists =
    "a definePrompt({ text: \"...\" }) left at a call site registers its default from code, so editing the brain file for that id either changes nothing or throws duplicate prompt id — the brain would stop being the source without any pin noticing";

  override run(t: TestRun): void {
    const sites: { file: string; line: number; args: string }[] = [];
    for (const file of engineSources()) {
      const source = readFileSync(join(repoRoot(), file), "utf8");
      // An alias would hide every call from the scan below.
      t.assert.doesNotMatch(source, /\bdefinePrompt\s+as\s+\w/, `${file} imports definePrompt under another name`);
      for (const match of source.matchAll(/\bdefinePrompt\s*\(/g)) {
        const at = match.index;
        const lineStart = source.lastIndexOf("\n", at) + 1;
        const before = source.slice(lineStart, at);
        // A doc comment that names the call, or the declaration itself.
        if (/^\s*(\*|\/\/)/.test(before) || /function\s+$/.test(before)) continue;
        sites.push({ file, line: source.slice(0, at).split("\n").length, args: callArguments(source, at + match[0].length) });
      }
    }

    const outside = sites.filter((s) => s.file !== AGENTS_TS);
    t.assert.deepEqual(
      outside.map((s) => s.file).sort(),
      ["engine/core/src/agent/tool.ts", "engine/protocol/src/prompts.ts"],
      "outside agents.ts, definePrompt is called only where brain text is registered: the protocol's seeding loop and registerToolPrompt (whose text is the tool's brain description)",
    );
    for (const site of outside) {
      t.assert.doesNotMatch(
        site.args,
        /\btext\s*:\s*["'`]/,
        `${site.file}:${site.line} registers a prompt with literal text; its default belongs in brain/`,
      );
    }
    t.assert.ok(sites.some((s) => s.file === AGENTS_TS), "the scan must see agents.ts' own calls, or it is not reading the engine at all");
  }
}

/** The source of a call's argument list, from just after `(` to its matching `)`. */
function callArguments(source: string, from: number): string {
  let depth = 1;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(from, i);
    }
  }
  return source.slice(from);
}

/* ---- checklist 2 ------------------------------------------------------ */

class RuntimeDefaultsAreAFreshCompileOfBrain extends BrainPureTest {
  readonly id = "the-engines-defaults-are-a-fresh-compile-of-brain-and-every-file-round-trips";
  readonly whyItExists =
    "a generated module left stale by an edit that skipped the compile, or a compiler that trims one trailing space, ships text the brain file does not say — the model receives something no one reviewed, and the files on disk still read correctly";

  override run(t: TestRun): void {
    const fresh = compileOk(BRAIN_DIR);

    // The generated module on disk is exactly what brain/ compiles to now.
    t.assert.equal(
      readFileSync(GENERATED, "utf8"),
      fresh.source,
      "engine/protocol/src/brain.generated.ts is not a fresh compile of brain/ — run `npm run build`",
    );

    // The engine's runtime defaults are those bytes, field for field.
    createDefaultRegistry();
    const catalog = new Map(promptCatalog().map((e) => [e.id, e]));
    for (const p of fresh.prompts) {
      const entry = catalog.get(p.id);
      t.assert.ok(entry, `${p.id} is in brain/ but the engine never registered it`);
      if (!entry) continue;
      t.assert.equal(entry.defaultText, p.text, `${p.id}: the engine's default is not brain's text`);
      t.assert.deepEqual(
        { group: entry.group, label: entry.label, channel: entry.channel, where: entry.where, placeholders: entry.placeholders ?? null },
        { group: p.group, label: p.label, channel: p.channel, where: p.where, placeholders: p.placeholders ? [...p.placeholders] : null },
        `${p.id}: the engine's catalog metadata is not brain's`,
      );
    }
    const registry = new Map(createDefaultRegistry().list().map((tool) => [tool.name, tool]));
    for (const [name, tool] of Object.entries(fresh.tools)) {
      t.assert.equal(registry.get(name)?.description, tool.description, `${name}: the registered description template is not brain's`);
      t.assert.equal(catalog.get(`tool.${name}`)?.defaultText, tool.description, `tool.${name}: the catalog default is not brain's`);
    }

    // Round trip: what the compiler read re-serialises to each file's bytes —
    // nothing trimmed, nothing added.
    const byId = new Map(fresh.prompts.map((p) => [p.id, p]));
    for (const { id, file } of promptFiles()) {
      const p = byId.get(id)!;
      const head = [`id: ${p.id}`, `group: ${p.group}`, `label: ${p.label}`, `channel: ${p.channel}`, `where: ${p.where}`];
      if (p.placeholders) head.push(`placeholders: ${p.placeholders.join(", ")}`);
      if (p.order !== undefined) head.push(`order: ${p.order}`);
      t.assert.equal(`---\n${head.join("\n")}\n---\n${p.text}\n`, readBrainText(file), `${relative(repoRoot(), file)} does not round-trip`);
    }
    for (const name of toolFolders()) {
      const tool = fresh.tools[name]!;
      const dir = join(BRAIN_DIR, "tools", name);
      t.assert.equal(`---\nname: ${name}\n---\n${tool.description}\n`, readBrainText(join(dir, "description.md")), `brain/tools/${name}/description.md does not round-trip`);
      const paramsFile = join(dir, "params.md");
      if (!existsSync(paramsFile)) {
        t.assert.deepEqual(tool.params, {}, `${name} has params but no params.md`);
        continue;
      }
      const text = readBrainText(paramsFile);
      const order = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
      t.assert.deepEqual([...order].sort(), Object.keys(tool.params).sort(), `brain/tools/${name}/params.md: headings and compiled params disagree`);
      t.assert.equal(order.map((path) => `## ${path}\n${tool.params[path]}\n`).join("\n"), text, `brain/tools/${name}/params.md does not round-trip`);
    }

    // And no side call's system prompt is a literal in code any more.
    for (const file of engineSources()) {
      const source = readFileSync(join(repoRoot(), file), "utf8");
      for (const match of source.matchAll(/runInference\(\{([\s\S]*?)\}\)/g)) {
        t.assert.doesNotMatch(match[1]!, /\bsystem\s*:\s*["'`]/, `${file}: a runInference call passes a literal system prompt`);
      }
    }
  }
}

/* ---- checklist 3 ------------------------------------------------------ */

class EveryWireDescriptionComesFromBrain extends BrainPureTest {
  readonly id = "every-registered-tool-has-one-brain-folder-and-every-wire-description-comes-from-it";
  readonly whyItExists =
    "a .describe(\"...\") literal left in a tool's schema keeps being sent while its params.md section is edited to no effect, and a params.md section whose path matches no field is an edit that silently reaches nothing";

  override run(t: TestRun): void {
    const tools = createDefaultRegistry().list();
    const names = tools.map((tool) => tool.name).sort();
    const fresh = compileOk(BRAIN_DIR);

    t.assert.deepEqual(toolFolders(), names, "brain/tools must hold exactly one folder per registered tool");
    t.assert.deepEqual(brainToolNames(), names, "the compiled brain must describe exactly the registered tools");
    t.assert.deepEqual([...builtinToolNames()].sort(), names, "the compiler's fixed BUILTIN_TOOLS and the registry must agree");

    for (const tool of tools) {
      t.assert.equal(tool.description, toolDescription(tool.name), `${tool.name}'s description template is not brain/tools/${tool.name}/description.md`);
      const wire = describedParams(zodToJsonSchema(tool.inputSchema));
      t.assert.deepEqual(
        sorted(wire),
        sorted(fresh.tools[tool.name]!.params),
        `${tool.name}: the .describe() texts on the wire and brain/tools/${tool.name}/params.md are not the same set of paths and texts`,
      );
      for (const [path, text] of Object.entries(wire)) {
        t.assert.equal(toolParam(tool.name, path), text, `${tool.name} ${path}`);
      }
    }
    t.assert.deepEqual(UNREAD_AT_LOAD, [], "a params.md section that no tool module reads is an edit that reaches nothing");

    // And no literal survives in the tools' source.
    const toolSources = sourceFiles(join("engine", "tools", "src"));
    for (const file of toolSources) {
      const source = readFileSync(join(repoRoot(), file), "utf8");
      for (const match of source.matchAll(/\.describe\(\s*(?!toolParam\()/g)) {
        t.assert.fail(`${file}:${source.slice(0, match.index).split("\n").length} has a .describe() that is not toolParam(...)`);
      }
      t.assert.doesNotMatch(source, /^\s*description\s*:\s*["'`]/m, `${file} defines a description as a literal`);
    }
    for (const name of names) {
      t.assert.ok(
        toolSources.some((file) => readFileSync(join(repoRoot(), file), "utf8").includes(`toolDescription("${name}")`)),
        `no source in engine/tools/src reads toolDescription("${name}")`,
      );
    }
  }
}

/* ---- checklist 5, the shipped half ------------------------------------- */

class TheShippedAvailabilityWithholdsAgentAndWorkflow extends BrainPureTest {
  readonly id = "the-shipped-availability-withholds-agent-and-workflow-and-filters-only-built-in-tools";
  readonly whyItExists =
    "availability that also filtered MCP tools would switch off every server a user connected, and an override that accepted a misspelled name would withhold nothing while reading as if it did";

  override run(t: TestRun): void {
    const registry = createDefaultRegistry();
    const builtins = [...builtinToolNames()].sort();
    const shipped = brainAvailability();
    const expected = builtins.filter((name) => !(WITHHELD as readonly string[]).includes(name));

    t.assert.deepEqual([...shipped.main].sort(), expected, "main must ship every built-in tool except Agent and Workflow");
    t.assert.deepEqual([...shipped.overdrive].sort(), expected, "overdrive must ship every built-in tool except Agent and Workflow");
    t.assert.equal(expected.length, 25);

    for (const overdrive of [false, true]) {
      for (const name of WITHHELD) t.assert.equal(isToolOffered(name, shipped, overdrive), false, `${name} offered with overdrive=${overdrive}`);
      t.assert.equal(isToolOffered("mcp__server__tool", shipped, overdrive), true, "an MCP tool is never filtered by availability");
      t.assert.deepEqual(
        registry.offered(shipped, overdrive).map((tool) => tool.name).sort(),
        registry.enabled().map((tool) => tool.name).filter((name) => !(WITHHELD as readonly string[]).includes(name)).sort(),
      );
    }
    t.assert.deepEqual(
      registry.offered(undefined, false).map((tool) => tool.name),
      registry.enabled().map((tool) => tool.name),
      "no availability (a subagent child) means no filter",
    );

    // An override replaces the context it names and keeps the other.
    const onlyRead = resolveToolAvailability({ main: ["Read"] });
    t.assert.deepEqual(onlyRead.main, ["Read"]);
    t.assert.deepEqual([...onlyRead.overdrive].sort(), expected);
    const withAgent = toolAvailabilityWith("Agent");
    t.assert.equal(withAgent.main.includes("Agent") && withAgent.overdrive.includes("Agent"), true, "toolAvailabilityWith adds to both contexts");
    t.assert.equal(withAgent.main.includes("Workflow"), false);

    t.assert.throws(() => resolveToolAvailability({ main: ["Agnet"] }), { message: "unknown tool in tool availability (main): Agnet" });
    t.assert.throws(() => resolveToolAvailability({ overdrive: ["mcp__server__tool"] }), {
      message: "unknown tool in tool availability (overdrive): mcp__server__tool",
    });
  }
}

/* ---- checklist 2, the compiler's byte rule ------------------------------ */

abstract class BrainFsTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A minimal brain the compiler accepts, built from `files` (path → contents) under a temp dir. */
  protected brainOf(files: Record<string, string>): string {
    const dir = this.tempDir("magentra-brain-");
    for (const [path, contents] of Object.entries(files)) this.writeFile(join(dir, ...path.split("/")), contents);
    return dir;
  }
}

const AVAILABILITY_READ_ONLY = `${JSON.stringify({ main: ["Read"], overdrive: ["Read"] })}\n`;

class TheCompilerKeepsEveryByte extends BrainFsTest {
  readonly id = "the-compiler-returns-each-body-byte-for-byte-including-the-whitespace-a-trim-would-take";
  readonly whyItExists =
    "a compiler that trimmed the body, collapsed a blank line or kept the file's final newline would change a prompt by one invisible byte on its way to the model, and every brain file would still look right in an editor";

  override run(t: TestRun): void {
    // Bodies built to tempt every shortcut: a leading blank line, a line that
    // is exactly `---`, a trailing space, a second trailing newline, a slot.
    const edgeText = "\n  indented first line\n---\nmiddle {{who}} line   \n\n";
    const crlfText = "line one\nline two";
    const descText = "Reads a file.\n\n## Usage\n- keep {{maxLines}}\n";
    const params = {
      file_path: "The absolute path\nsecond line",
      limit: "Lines to read, default {{maxTimeout}} — literal here\n",
      "questions.options.label": "last section",
    };
    const dir = this.brainOf({
      "availability.json": AVAILABILITY_READ_ONLY,
      "prompts/3-in-turn-reminders/reminder.edge.md":
        `---\nid: reminder.edge\ngroup: 3 · In-turn reminders\nlabel: Edge\nchannel: reminder\nwhere: A test fixture.\nplaceholders: who\n---\n${edgeText}\n`,
      // Saved on Windows: a BOM and CRLF line ends, which must compile to the same bytes as LF.
      "prompts/4-end-of-turn-rungs/rung.crlf.md":
        `﻿---\r\nid: rung.crlf\r\ngroup: 4 · End-of-turn rungs\r\nlabel: Crlf\r\nchannel: reminder\r\nwhere: A test fixture.\r\n---\r\n${crlfText.replace(/\n/g, "\r\n")}\r\n`,
      "tools/Read/description.md": `---\nname: Read\n---\n${descText}\n`,
      "tools/Read/params.md": `## file_path\n${params.file_path}\n\n## limit\n${params.limit}\n\n## questions.options.label\n${params["questions.options.label"]}\n`,
    });

    const result = compileOk(dir);
    const byId = new Map(result.prompts.map((p) => [p.id, p]));
    t.assert.equal(byId.get("reminder.edge")?.text, edgeText, "the body must be everything after `---\\n` minus exactly one trailing newline");
    t.assert.deepEqual(byId.get("reminder.edge")?.placeholders, ["who"]);
    t.assert.equal(byId.get("rung.crlf")?.text, crlfText, "a BOM and CRLF must compile to the LF text, nothing more");
    t.assert.equal(result.tools["Read"]?.description, descText, "a description keeps its own `## ` headings and its trailing newline");
    t.assert.deepEqual(sorted(result.tools["Read"]!.params), sorted(params), "each params.md section is its text exactly; {{…}} in a param is literal");
    t.assert.deepEqual(result.availability, { main: ["Read"], overdrive: ["Read"] });

    // And what cannot be expressed is refused, by file, rather than compiled to something else.
    const refused = (files: Record<string, string>): readonly string[] => compiler.compileBrain(this.brainOf({ "availability.json": AVAILABILITY_READ_ONLY, "prompts/.gitkeep": "", ...files })).problems;
    t.assert.deepEqual(
      refused({ "tools/Read/description.md": "---\nname: Read\n---\nno final newline" }),
      ["tools/Read/description.md: must end with a newline (the body loses exactly one trailing `\\n`)"],
    );
    t.assert.deepEqual(
      refused({ "tools/Read/description.md": "---\nname: Read\n---\nok\n", "tools/Read/params.md": "## file_path\ntext with\n## a heading inside it\n" }),
      [
        "tools/Read/params.md: section \"file_path\" must end with its text's newline plus ONE blank line before the next heading",
        "tools/Read/params.md: heading \"## a heading inside it\" is not a parameter path (dotted field names, or (root))",
      ],
    );
    const group6 = refused({
      "tools/Read/description.md": "---\nname: Read\n---\nok\n",
      "prompts/6-subagents/subagent.x.md": "---\nid: subagent.x\ngroup: 6 · Subagents (Agent tool)\nlabel: X\nchannel: subagent\nwhere: w\n---\nx\n",
    });
    t.assert.equal(group6.length, 1, `group 6 has no brain folder: ${group6.join(" | ")}`);
    t.assert.match(group6[0]!, /^prompts\/6-subagents: unknown group folder/);
  }
}

/* ---- checklist 5, through a real Session --------------------------------- */

/** The tool names a request offered the model. */
function offeredIn(request: StreamRequest | undefined): string[] {
  if (!request) throw new Error("the provider received fewer requests than the script expected");
  return request.tools.map((tool) => tool.name).sort();
}

/** The tool_result the model was handed for `id`, from the request that carried it. */
function toolResultFor(requests: readonly StreamRequest[], id: string): { text: string; isError: boolean } {
  for (const request of requests) {
    for (const message of request.messages as Msg[]) {
      for (const block of message.content) {
        if (block.type === "tool_result" && block.toolUseId === id) {
          const text = typeof block.content === "string" ? block.content : block.content.map((part) => part.text ?? "").join("");
          return { text, isError: block.isError === true };
        }
      }
    }
  }
  throw new Error(`no request carried a tool_result for ${id}`);
}

type Finished = Extract<CoreEvent, { type: "tool_call_finished" }>;

abstract class ScriptedSessionTest extends BrainFsTest {
  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  #scripted = 0;

  /**
   * The script is read as the exact sequence of model calls — the tool call,
   * the reply, the recovery nudge an error batch earns, OVERDRIVE's self-verify
   * — so a test ends by proving every entry was consumed, none left over.
   */
  protected scriptConsumed(t: TestRun, engine: ScriptedEngine): void {
    t.assert.equal(engine.provider.requests.length, this.#scripted, "every scripted model call was consumed, in the turns the script meant");
  }

  protected async start(
    turns: readonly FakeTurn[],
    toolAvailability?: Partial<ToolAvailability>,
    extraTools?: readonly AnyToolDefinition[],
  ): Promise<ScriptedEngine> {
    // A test may start a second engine; the first must not outlive it.
    await this.#engine?.close();
    this.#scripted = turns.length;
    this.redirectHome();
    // Overrides are global to the user; this machine's must not decide what is offered.
    this.setEnv("MAGENTRA_PROMPTS_DIR", this.tempDir("magentra-no-overrides-"));
    this.#engine = await startScriptedEngine({
      workspace: this.tempDir("magentra-brain-ws-"),
      turns,
      permissions: "allow_once",
      ...(toolAvailability !== undefined ? { toolAvailability } : {}),
      ...(extraTools !== undefined ? { extraTools } : {}),
    });
    return this.#engine;
  }

  protected async setOverdrive(engine: ScriptedEngine, enabled: boolean): Promise<void> {
    engine.send({ type: "set_overdrive", enabled });
    await engine.waitFor((e) => e.type === "overdrive_changed" && e.enabled === enabled);
  }

  /** One user turn that must end cleanly; returns its tool_call_finished events by id. */
  protected async turn(t: TestRun, engine: ScriptedEngine, text: string): Promise<Map<string, Finished>> {
    const outcome = await engine.runTurn(text);
    t.assert.deepEqual([...outcome.errors], [], `the turn must not error: ${outcome.errors.join(" | ")}`);
    return new Map(outcome.toolResults.map((r) => [r.id, r]));
  }
}

const SHIPPED_MAIN = (): string[] => [...brainAvailability().main].sort();

class AToolAbsentFromMainIsWithheldAndRefused extends ScriptedSessionTest {
  readonly id = "a-tool-absent-from-main-is-not-offered-and-a-call-to-it-is-refused-by-name";
  readonly whyItExists =
    "filtering only the schema list would still RUN a withheld tool the model names from memory or an earlier transcript, so 'not available' would hold until the model asked for it anyway";

  override async run(t: TestRun): Promise<void> {
    const main = SHIPPED_MAIN().filter((name) => name !== "Glob");
    const engine = await this.start(
      [
        { toolCalls: [{ id: "g_main", name: "Glob", input: { pattern: "*.md" } }] },
        { text: "Glob is unavailable." },
        { text: "Understood." },
        { toolCalls: [{ id: "g_overdrive", name: "Glob", input: { pattern: "*.md" } }] },
        { text: "Found nothing." },
        { text: "Verified." },
      ],
      { main },
    );

    const first = await this.turn(t, engine, "list the markdown files");
    const requests = engine.provider.requests;
    t.assert.deepEqual(offeredIn(requests[0]), main, "main's list, and only it, is what the model is offered");
    t.assert.equal(offeredIn(requests[0]).includes("Glob"), false);
    t.assert.equal(first.get("g_main")?.isError, true, "a call to a withheld tool must not run");
    t.assert.deepEqual(toolResultFor(requests, "g_main"), { text: switchedOff("Glob"), isError: true }, "it is refused by name, with the switched-off text");

    // OVERDRIVE's list was not overridden, so it still offers Glob — and runs it.
    await this.setOverdrive(engine, true);
    const before = requests.length;
    const second = await this.turn(t, engine, "list them again");
    t.assert.ok(offeredIn(requests[before]).includes("Glob"), "with OVERDRIVE on, the overdrive list applies");
    t.assert.equal(second.get("g_overdrive")?.isError, false, "and a call to it runs");
    this.scriptConsumed(t, engine);
  }
}

class AToolAbsentFromOverdriveIsWithheldOnlyWhileOverdriveIsOn extends ScriptedSessionTest {
  readonly id = "a-tool-absent-from-overdrive-is-withheld-only-while-overdrive-is-on";
  readonly whyItExists =
    "a session that read the overdrive list once at boot, or applied it regardless of the toggle, would withhold a tool for the whole session or never — the list has to follow OVERDRIVE as it is switched";

  override async run(t: TestRun): Promise<void> {
    const overdrive = SHIPPED_MAIN().filter((name) => name !== "Grep");
    const engine = await this.start(
      [
        { toolCalls: [{ id: "grep_off", name: "Grep", input: { pattern: "x" } }] },
        { text: "Nothing matched." },
        { toolCalls: [{ id: "grep_on", name: "Grep", input: { pattern: "x" } }] },
        { text: "Grep is unavailable." },
        { text: "Understood." },
        { text: "Verified." },
        { text: "Back to normal." },
      ],
      { overdrive },
    );
    const requests = engine.provider.requests;

    const off = await this.turn(t, engine, "search for x");
    t.assert.ok(offeredIn(requests[0]).includes("Grep"), "OVERDRIVE off: main applies, and main offers Grep");
    t.assert.equal(off.get("grep_off")?.isError, false, "and the call runs");

    await this.setOverdrive(engine, true);
    let at = requests.length;
    const on = await this.turn(t, engine, "search for x again");
    t.assert.deepEqual(offeredIn(requests[at]), overdrive, "OVERDRIVE on: the overdrive list is what is offered");
    t.assert.deepEqual(toolResultFor(requests, "grep_on"), { text: switchedOff("Grep"), isError: true }, "and a call to Grep is refused by name");
    t.assert.equal(on.get("grep_on")?.isError, true);

    await this.setOverdrive(engine, false);
    at = requests.length;
    await this.turn(t, engine, "anything else?");
    t.assert.ok(offeredIn(requests[at]).includes("Grep"), "OVERDRIVE off again: Grep is offered again");
    this.scriptConsumed(t, engine);
  }
}

class TheShippedBrainWithholdsAgentAndWorkflowInBoth extends ScriptedSessionTest {
  readonly id = "with-the-shipped-brain-agent-and-workflow-are-withheld-and-refused-in-both-contexts";
  readonly whyItExists =
    "the default this feature ships is subagents OFF; an engine that forgot to apply availability when no override is given would offer Agent and Workflow to every root session while every test that opts in still passed";

  override async run(t: TestRun): Promise<void> {
    const calls = (suffix: string): FakeTurn => ({
      toolCalls: [
        { id: `agent_${suffix}`, name: "Agent", input: { description: "look", prompt: "Look.", subagent_type: "explore" } },
        { id: `workflow_${suffix}`, name: "Workflow", input: { script: "export default async () => 'x'" } },
      ],
    });
    const engine = await this.start([calls("main"), { text: "Both unavailable." }, { text: "Understood." }, calls("od"), { text: "Both unavailable." }, { text: "Understood." }, { text: "Verified." }]);
    const requests = engine.provider.requests;
    const expected = SHIPPED_MAIN();

    await this.turn(t, engine, "delegate this");
    t.assert.deepEqual(offeredIn(requests[0]), expected, "main offers the 25 shipped tools");
    for (const name of WITHHELD) t.assert.equal(offeredIn(requests[0]).includes(name), false, `${name} is withheld from main`);
    t.assert.deepEqual(toolResultFor(requests, "agent_main"), { text: switchedOff("Agent"), isError: true });
    t.assert.deepEqual(toolResultFor(requests, "workflow_main"), { text: switchedOff("Workflow"), isError: true });

    await this.setOverdrive(engine, true);
    const at = requests.length;
    await this.turn(t, engine, "delegate this, autonomously");
    t.assert.deepEqual(offeredIn(requests[at]), expected, "overdrive offers the same 25");
    t.assert.deepEqual(toolResultFor(requests, "agent_od"), { text: switchedOff("Agent"), isError: true });
    t.assert.deepEqual(toolResultFor(requests, "workflow_od"), { text: switchedOff("Workflow"), isError: true });
    this.scriptConsumed(t, engine);

    // The same shipped brain never filters an MCP tool: availability lists
    // built-in tools only, so a filter that treated every unlisted name as
    // withheld would switch off every server a user connected.
    await this.assertMcpToolIsOfferedAndRuns(t);
  }

  async assertMcpToolIsOfferedAndRuns(t: TestRun): Promise<void> {
    const name = "mcp__stub__echo";
    const stub: AnyToolDefinition = {
      name,
      description: 'MCP tool "echo" from server "stub".',
      permissionClass: "network",
      inputSchema: z.record(z.string(), z.unknown()),
      rawInputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "stub ran" }),
    };
    const engine = await this.start(
      [
        { toolCalls: [{ id: "m_main", name, input: {} }] },
        { text: "done" },
        { toolCalls: [{ id: "m_od", name, input: {} }] },
        { text: "done" },
        { text: "DONE" },
      ],
      undefined,
      [stub],
    );
    const requests = engine.provider.requests;
    await this.turn(t, engine, "call the stub");
    t.assert.deepEqual(offeredIn(requests[0]), [...SHIPPED_MAIN(), name].sort(), "main offers the shipped tools and the MCP tool");
    t.assert.deepEqual(toolResultFor(requests, "m_main"), { text: "stub ran", isError: false }, "the MCP call ran");

    await this.setOverdrive(engine, true);
    const at = requests.length;
    await this.turn(t, engine, "again, autonomously");
    t.assert.deepEqual(offeredIn(requests[at]), [...SHIPPED_MAIN(), name].sort(), "overdrive offers it too");
    t.assert.deepEqual(toolResultFor(requests, "m_od"), { text: "stub ran", isError: false }, "the MCP call ran in overdrive");
    this.scriptConsumed(t, engine);
  }
}

class AChildSessionIsExempt extends ScriptedSessionTest {
  readonly id = "a-subagent-child-keeps-its-agent-type-tools-whatever-the-root-withholds";
  readonly whyItExists =
    "applying availability inside a child would strip a subagent of the tools its type is defined by — an explore child without the Glob its root withholds, a general-purpose child without the Workflow the shipped brain withholds — so opting Agent in would hand the model a subagent that is not the type it asked for";

  override async run(t: TestRun): Promise<void> {
    const main = [...SHIPPED_MAIN().filter((name) => name !== "Glob"), "Agent"];
    const engine = await this.start(
      [
        { toolCalls: [{ id: "a1", name: "Agent", input: { description: "probe the tree", prompt: "Report what you find.", subagent_type: "explore" } }] },
        { toolCalls: [{ id: "child_glob", name: "Glob", input: { pattern: "*.none" } }] },
        { text: "nothing there" },
        { toolCalls: [{ id: "a2", name: "Agent", input: { description: "do it all", prompt: "Report back.", subagent_type: "general-purpose" } }] },
        { text: "reported" },
        { text: "done" },
      ],
      { main },
    );
    // The offered sets are asserted before the turn's errors: a child that is
    // wrongly filtered gets its call refused, which costs the script a call,
    // and "script exhausted" would otherwise be the first thing reported.
    const outcome = await engine.runTurn("delegate a look");
    const finished = new Map(outcome.toolResults.map((r) => [r.id, r]));
    const requests = engine.provider.requests;
    const registered = createDefaultRegistry().list().map((tool) => tool.name);

    t.assert.equal(offeredIn(requests[0]).includes("Glob"), false, "the root withholds Glob");
    t.assert.equal(offeredIn(requests[0]).includes("Agent"), true, "and offers Agent, opted in");
    t.assert.equal(offeredIn(requests[0]).includes("Workflow"), false, "and withholds Workflow, as shipped");

    // The explore child: its type's read-only set, Glob included although the root withholds it.
    t.assert.deepEqual(offeredIn(requests[1]), ["Glob", "Grep", "Read", "TaskGet", "TaskList"], "the explore child is offered its agent type's set");
    t.assert.equal(finished.get("child_glob")?.subagent, true, "the Glob call is the child's");
    t.assert.equal(finished.get("child_glob")?.isError, false, "and it runs");

    // The general-purpose child: every registered tool but Agent, Workflow included although the shipped brain withholds it.
    t.assert.deepEqual(
      offeredIn(requests[4]),
      registered.filter((name) => name !== "Agent").sort(),
      "the general-purpose child is offered every tool but Agent — availability does not reach it",
    );
    t.assert.deepEqual([...outcome.errors], [], `the turn must not error: ${outcome.errors.join(" | ")}`);
    this.scriptConsumed(t, engine);
  }
}

/* ---- overrides still apply on top --------------------------------------- */

class AnOverrideStillWinsOverBrain extends BrainFsTest {
  readonly id = "an-override-file-still-replaces-a-brain-default-for-the-next-request";
  readonly whyItExists =
    "seeding the registry from the generated module could have bypassed the override lookup, so ~/.magentra/prompts/<id>.txt would be silently ignored for every prompt that moved into brain/";

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const dir = this.tempDir("magentra-prompts-");
    this.setEnv("MAGENTRA_PROMPTS_DIR", dir);
    const toolOverride = "Read override from the test.";
    const sectionOverride = "Section override from the test.";
    this.writeFile(join(dir, "tool.Read.txt"), `${toolOverride}\n`);
    this.writeFile(join(dir, "system.communication.txt"), `${sectionOverride}\n`);

    // tool.Read registers when a registry registers the tool — not at import.
    createDefaultRegistry();
    // The registry trusts a resolved override for 250 ms; wait until it reads these.
    const deadline = Date.now() + 5_000;
    while (promptText("system.communication") !== sectionOverride || promptText("tool.Read") !== toolOverride) {
      if (Date.now() > deadline) throw new Error("the registry never picked up the override files");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const brainDefault = compileOk(BRAIN_DIR).prompts.find((p) => p.id === "system.communication")!.text;
    this.#engine = await startScriptedEngine({ workspace: this.tempDir("magentra-brain-ws-"), turns: [{ text: "ok" }] });
    const outcome = await this.#engine.runTurn("hello");
    t.assert.deepEqual([...outcome.errors], []);
    const request = this.#engine.provider.requests[0]!;
    t.assert.equal(request.tools.find((tool) => tool.name === "Read")?.description, toolOverride, "the tool.Read override is the description sent");
    t.assert.ok(request.system.includes(sectionOverride), "the system.communication override is in the system prompt");
    t.assert.equal(request.system.includes(brainDefault), false, "and brain's default for it is not");

    // A blank override is an override too: on a wrapper the code composes, it
    // drops the prose and keeps the value — and with none, the composed bytes
    // are the brain templates joined to their values.
    await this.#engine.close();
    this.#engine = undefined;
    await assertComposedTexts(t, {
      workspace: this.tempDir("magentra-brain-ws-"),
      prompts: dir,
      writeFile: (path, contents) => this.writeFile(path, contents),
      started: (engine) => {
        this.#engine = engine;
      },
    });
  }
}

/** renderPrompt's substitution — one pass, a function replacement, unknown slots kept — over the SHIPPED text, so this machine's overrides cannot move the answer. */
function renderDefault(id: string, vars: Record<string, string> = {}): string {
  return promptDefault(id).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** A create-addon request with context and taken names, and the rejection the script below provokes. */
const ADDON_CASE = { description: "Audit $& the {{taken}} deps $1", taken: ["one", "two"], context: "  when the lockfile changes \n" } as const;
const ADDON_REJECTION = "the file must open with --- frontmatter";

/* ---- the composed bytes, through the real engine ----------------------- */

/** The text of the user message in `request` that contains `needle`. */
function userTextWith(request: StreamRequest | undefined, needle: string): string {
  if (!request) throw new Error("the provider received fewer requests than the script expected");
  for (const message of request.messages as Msg[]) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.includes(needle)) return block.text;
    }
  }
  throw new Error(`no user message in the request contains ${JSON.stringify(needle)}`);
}

/**
 * The texts the code composes around values, as the real engine composes them
 * — run by {@link AnOverrideStillWinsOverBrain} on an engine of its own. A
 * template that renders exactly does not prove the code still joins it to the
 * same neighbours: a dropped blank line before the user's extra detail, or a
 * reminder glued to the output it follows, changes the bytes the model reads.
 * And an emptied wrapper must drop its prose and keep the value it wrapped.
 */
async function assertComposedTexts(
  t: TestRun,
  opts: { workspace: string; prompts: string; writeFile: (path: string, contents: string) => void; started: (engine: ScriptedEngine) => void },
): Promise<void> {
  // engine.ts buildAddonPrompt() and the retry feedback, from their brain templates.
  const instruction = renderDefault("addon-author.instruction", {
    description: ADDON_CASE.description,
    context: `\n\n${renderDefault("addon-author.context-line", { context: ADDON_CASE.context.trim() })}`,
    taken: ADDON_CASE.taken.join(", "),
  });
  const feedback = `\n\n${renderDefault("addon-author.retry-feedback", { error: ADDON_REJECTION })}`;
  const valid = "---\nname: audit-deps\ndescription: When the lockfile changes.\n---\nList each changed dependency.\n";

  const engine = await startScriptedEngine({
    workspace: opts.workspace,
    // A draft the validator rejects, then one it accepts; then two plain turns.
    turns: [{ text: "Here is your addon." }, { text: valid }, { text: "ok" }, { text: "ok" }],
    addons: ADDON_CASE.taken.map((name) => ({ name, description: `${name} addon`, body: "Do it.", resources: [], source: "workspace" as const })),
  });
  opts.started(engine);

  // The create-addon wizard: the instruction, then the instruction + the validator feedback.
  engine.send({ type: "generate_addon", description: ADDON_CASE.description, context: ADDON_CASE.context });
  const draft = await engine.waitFor((e) => e.type === "addon_draft");
  t.assert.equal(draft.type === "addon_draft" && draft.ok, true, `the second draft is valid: ${JSON.stringify(draft)}`);
  t.assert.equal(userTextWith(engine.provider.requests[0], ADDON_CASE.description), instruction, "the first attempt's instruction is brain's template, filled");
  t.assert.equal(
    userTextWith(engine.provider.requests[1], ADDON_CASE.description),
    instruction + feedback,
    "the retry carries the validator feedback after a blank line",
  );

  // A `!` command, then a turn: the output, then the shell-command reminder on its own line.
  engine.send({ type: "bang_command", cmd: "echo brain-one" });
  await engine.waitFor((e) => e.type === "command_output" && e.text === "brain-one");
  const first = await engine.runTurn("next");
  t.assert.deepEqual([...first.errors], []);
  t.assert.equal(
    userTextWith(engine.provider.requests[2], "! echo brain-one"),
    `<bash-input>! echo brain-one</bash-input>\n<bash-output exit-code="0">\nbrain-one\n</bash-output>\n${promptDefault("reminder.shell-command")}`,
  );

  // Switched off, the reminder goes and the command and its output stay.
  opts.writeFile(join(opts.prompts, "reminder.shell-command.txt"), "");
  const deadline = Date.now() + 5_000;
  while (!isPromptDisabled("reminder.shell-command")) {
    if (Date.now() > deadline) throw new Error("the registry never read the blank override");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  engine.send({ type: "bang_command", cmd: "echo brain-two" });
  await engine.waitFor((e) => e.type === "command_output" && e.text === "brain-two");
  const second = await engine.runTurn("again");
  t.assert.deepEqual([...second.errors], []);
  t.assert.equal(
    userTextWith(engine.provider.requests[3], "! echo brain-two"),
    `<bash-input>! echo brain-two</bash-input>\n<bash-output exit-code="0">\nbrain-two\n</bash-output>`,
    "an emptied wrapper drops its prose and keeps the value it wrapped",
  );
  t.assert.equal(engine.provider.requests.length, 4, "every scripted model call was consumed");
}

/* ---- checklist 4 ------------------------------------------------------ */

abstract class BrainProcTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #dirs: string[] = [];

  protected makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#dirs = [];
  }
}

class TheCompilerFailsTheBuildNamingAnUnknownTool extends BrainProcTest {
  readonly id = "an-availability-entry-or-tool-folder-naming-an-unknown-tool-fails-the-build-with-that-name";
  readonly whyItExists =
    "a misspelled tool in availability.json would withhold nothing, and a misspelled brain/tools folder would describe nothing, while the build stayed green — the build has to stop and say which name it did not know";

  /** Run the real compiler on `brain`, writing to a file of its own. */
  async #compile(brain: string): Promise<{ code: number | null; stderr: string; out: string }> {
    const out = join(this.makeDir("magentra-brain-out-"), "brain.generated.ts");
    const child: ProcHandle = this.spawn(process.execPath, [COMPILER, "--brain", brain, "--out", out], { label: "brain compiler" });
    const exit = await child.exited();
    return { code: exit.code, stderr: child.stderr(), out };
  }

  #copyOfBrain(): string {
    const copy = join(this.makeDir("magentra-brain-copy-"), "brain");
    cpSync(BRAIN_DIR, copy, { recursive: true });
    return copy;
  }

  override async run(t: TestRun): Promise<void> {
    // The build runs the compiler first, and `&&` lets nothing past a failure.
    const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    t.assert.equal(pkg.scripts["build"], "node tools/brain/compile.mjs && tsc -b");

    // Control: the shipped brain, copied, compiles to the module the engine was built from.
    const control = await this.#compile(this.#copyOfBrain());
    t.assert.equal(control.code, 0, `the unmodified brain must compile:\n${control.stderr}`);
    t.assert.equal(readFileSync(control.out, "utf8"), readFileSync(GENERATED, "utf8"), "the CLI's output for the shipped brain is the committed build's generated module");

    // An availability entry naming a tool that does not exist.
    const misspelled = this.#copyOfBrain();
    const availability = JSON.parse(readFileSync(join(misspelled, "availability.json"), "utf8")) as { main: string[]; overdrive: string[] };
    writeFileSync(join(misspelled, "availability.json"), `${JSON.stringify({ ...availability, main: [...availability.main, "Agnet"] }, null, 2)}\n`);
    const badEntry = await this.#compile(misspelled);
    t.assert.equal(badEntry.code, 1, "an unknown tool in availability.json must fail the compile");
    t.assert.match(badEntry.stderr, /availability\.json: "main" names unknown tool "Agnet"/, `the error must name the tool:\n${badEntry.stderr}`);
    t.assert.equal(existsSync(badEntry.out), false, "a failed compile writes nothing");

    // A tools folder for a tool that does not exist.
    const strayFolder = this.#copyOfBrain();
    mkdirSync(join(strayFolder, "tools", "Bashh"));
    writeFileSync(join(strayFolder, "tools", "Bashh", "description.md"), "---\nname: Bashh\n---\nRuns things.\n");
    const badFolder = await this.#compile(strayFolder);
    t.assert.equal(badFolder.code, 1, "a brain/tools folder for an unknown tool must fail the compile");
    t.assert.match(badFolder.stderr, /tools\/Bashh: unknown tool "Bashh"/, `the error must name the tool:\n${badFolder.stderr}`);
    t.assert.equal(existsSync(badFolder.out), false, "a failed compile writes nothing");
  }
}

/* ---- checklist 7 ------------------------------------------------------ */

const BUNDLER = "app/scripts/bundle-engine.js";
const BUNDLE = "app/build-resources/engine/engine.cjs";

class TheBundledEngineBootsWithNoBrainBesideIt extends BrainProcTest {
  readonly id = "the-bundled-engine-boots-and-answers-session-started-with-no-brain-folder-beside-it";
  readonly whyItExists =
    "an engine that read brain/ from disk at run time would work in every checkout and die on first launch of an installed app, which ships engine.cjs alone";
  override readonly artifact = true;
  /** esbuild over the whole engine is not a 60-second job on a cold cache. */
  override readonly timeoutMs: number = 240_000;

  override async run(t: TestRun): Promise<void> {
    const elsewhere = this.makeDir("magentra-packaged-brain-");
    const alone = join(elsewhere, "engine.cjs");
    // One fixed output directory that other features' bundler runs rewrite — see exclusive.ts.
    await withExclusiveLock("bundle-engine", async () => {
      const bundler = this.spawn(process.execPath, [join(repoRoot(), BUNDLER)], { label: "bundle-engine" });
      const exit = await bundler.exited();
      t.assert.equal(exit.code, 0, `the bundler must succeed:\n${bundler.stderr()}`);
      copyFileSync(join(repoRoot(), BUNDLE), alone);
    });
    t.assert.deepEqual(readdirSync(elsewhere), ["engine.cjs"], "the bundle is alone, as shipped — no brain/ beside it");
    // Alone is not enough on THIS machine: a bundle that baked in the checkout's
    // absolute path would still find brain/ here, and nowhere else.
    t.assert.equal(readFileSync(alone, "utf8").includes(repoRoot()), false, "the bundle must not carry this checkout's absolute path");

    const home = this.makeDir("magentra-packaged-home-");
    const workspace = this.makeDir("magentra-packaged-ws-");
    mkdirSync(join(workspace, ".magentra"), { recursive: true });
    writeFileSync(
      join(workspace, ".magentra", "settings.json"),
      `${JSON.stringify({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "model-one", contextWindow: 200_000 }, null, 2)}\n`,
    );
    const engine = this.spawn(process.execPath, [alone, "--serve", "--cwd", workspace], {
      cwd: elsewhere,
      label: "bundled engine",
      env: { HOME: home, USERPROFILE: home, NODE_PATH: undefined, MAGENTRA_PROMPTS_DIR: undefined },
    });
    const line = await engine.nextLine((l) => l.includes('"session_started"'), 30_000);
    const frame = JSON.parse(line) as { type?: string; sessionId?: unknown };
    t.assert.equal(frame.type, "session_started", "the bundled engine answers with session_started");
    t.assert.equal(typeof frame.sessionId, "string");
    t.assert.doesNotMatch(engine.stderr(), /unknown brain|brain\.generated|Cannot find module/, engine.stderr());
  }
}

registerFeatureTests(
  new CatalogAndBrainFilesAreOneToOne(),
  new NoDefinePromptCarriesLiteralText(),
  new RuntimeDefaultsAreAFreshCompileOfBrain(),
  new EveryWireDescriptionComesFromBrain(),
  new TheShippedAvailabilityWithholdsAgentAndWorkflow(),
  new TheCompilerKeepsEveryByte(),
  new AToolAbsentFromMainIsWithheldAndRefused(),
  new AToolAbsentFromOverdriveIsWithheldOnlyWhileOverdriveIsOn(),
  new TheShippedBrainWithholdsAgentAndWorkflowInBoth(),
  new AChildSessionIsExempt(),
  new AnOverrideStillWinsOverBrain(),
  new TheCompilerFailsTheBuildNamingAnUnknownTool(),
  new TheBundledEngineBootsWithNoBrainBesideIt(),
);
