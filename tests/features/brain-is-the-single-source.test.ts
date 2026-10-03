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
 * ITEM 2 IS CHECKED AGAINST THE PRE-MIGRATION TEXTS, committed as fixtures in
 * `fixtures/brain-baseline/`: `catalog.json` is promptCatalog() outside groups 6
 * and 7 as dumped before the move (HEAD ce49931, 43 prompts), and
 * `addon-author.json` is that commit's buildAddonPrompt() and validator
 * feedback, evaluated. The prompts that were inline literals until this feature
 * registered them are compared against those literals, written out below as
 * HEAD built them, and their composition with the values around them is
 * checked through the real engine. The two pins (`system-prompt-is-pinned`,
 * `tool-wire-contract-is-pinned`, run unchanged — checklist 6) hold the
 * assembled system prompt and every tool's wire contract. Beside that, the
 * engine's runtime defaults equal a fresh compile of brain/ field for field;
 * the generated module on disk IS that fresh compile; every brain file
 * re-serialises to its own bytes from what the compiler read out of it; and
 * the compiler, given bodies built to tempt a trim, returns them byte for byte.
 * A drift anywhere fails a named test. Rewording a brain prompt on purpose
 * therefore fails here too, as it fails a pin: a person updates the fixture.
 *
 * CHECKLIST 6 IS THE TWO PIN TESTS THEMSELVES, run unchanged; the class here for
 * it proves the one fact their passing depends on: the wire pin covers the
 * REGISTERED tools, so withholding Agent and Workflow from what a session
 * offers leaves the pinned artifact — Agent and Workflow included — intact, and
 * every description in it is the brain file's text.
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

import { readApproved } from "../lib/approved.ts";
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
  "Every model-facing default outside the subagent.* group is read from brain/ and nowhere else, and moving it there changed no byte the model receives except the deliberate withholding of Agent and Workflow.";

/** The one documented exception: these stay literals in engine/core/src/agent/agents.ts. */
const SUBAGENT_GROUP = "6 · Subagents (Agent tool)";
const AGENTS_TS = "engine/core/src/agent/agents.ts";

/** The two tools availability.json ships withheld from both contexts. */
const WITHHELD = ["Agent", "Workflow"] as const;

const BRAIN_DIR = join(repoRoot(), "brain");
const COMPILER = join(repoRoot(), "tools", "brain", "compile.mjs");
const GENERATED = join(repoRoot(), "engine", "protocol", "src", "brain.generated.ts");

/** The refusal a withheld or switched-off tool gets, byte for byte (session.ts executeToolCalls). */
const switchedOff = (name: string): string =>
  `The ${name} tool is switched off in this workspace and cannot be called. Reach the goal another way, and do not retry it this turn.`;

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

    // And those bytes are the ones the model got before the move.
    assertPreMigrationTexts(t);
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

/* ---- checklist 6 ------------------------------------------------------ */

class ThePinsStillCoverTheWithheldToolsFromBrain extends BrainPureTest {
  readonly id = "the-wire-pin-still-holds-agent-and-workflow-and-every-pinned-text-is-brains";
  readonly whyItExists =
    "if the pinned contract followed the OFFERED tools, withholding Agent and Workflow would have passed as a contract change and been re-approved away; and a pinned description that no longer matches its brain file means the pin and the source have parted";

  override run(t: TestRun): void {
    const approved = JSON.parse(readApproved("tool-wire-contract-is-pinned", "tools.json")) as {
      name: string;
      description: string;
      inputSchema: unknown;
    }[];
    const pinnedNames = approved.map((tool) => tool.name);
    for (const name of WITHHELD) t.assert.ok(pinnedNames.includes(name), `the wire pin lost ${name} when it was withheld`);
    t.assert.deepEqual(pinnedNames, [...brainToolNames()], "the pin and brain/tools name the same tools");

    for (const tool of approved) {
      t.assert.equal(tool.description, toolDescription(tool.name), `the pinned description of ${tool.name} is not brain's`);
      for (const [path, text] of Object.entries(describedParams(tool.inputSchema))) {
        t.assert.equal(text, toolParam(tool.name, path), `the pinned ${tool.name} ${path} is not brain's`);
      }
    }
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
    // are the literals the code built before the move.
    await this.#engine.close();
    this.#engine = undefined;
    await assertComposedFormerLiterals(t, {
      workspace: this.tempDir("magentra-brain-ws-"),
      prompts: dir,
      writeFile: (path, contents) => this.writeFile(path, contents),
      started: (engine) => {
        this.#engine = engine;
      },
    });
  }
}

/* ---- checklist 2, against the pre-migration texts ---------------------- */

const BASELINE_DIR = join(repoRoot(), "tests", "features", "fixtures", "brain-baseline");

interface BaselinePrompt {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly channel: string;
  readonly where: string;
  readonly placeholders: readonly string[] | null;
  readonly text: string;
}

interface AddonAuthorBaseline {
  readonly feedbackError: string;
  readonly feedback: string;
  readonly cases: readonly { description: string; taken: string[]; context?: string; prompt: string }[];
}

/** fixtures/brain-baseline/catalog.json: promptCatalog() outside groups 6 and 7, dumped before the move (HEAD ce49931). */
const baselineCatalog = (): BaselinePrompt[] => JSON.parse(readFileSync(join(BASELINE_DIR, "catalog.json"), "utf8")) as BaselinePrompt[];

/** fixtures/brain-baseline/addon-author.json: HEAD ce49931's buildAddonPrompt() and retry feedback, evaluated before the move. */
const addonAuthorBaseline = (): AddonAuthorBaseline => JSON.parse(readFileSync(join(BASELINE_DIR, "addon-author.json"), "utf8")) as AddonAuthorBaseline;

/** renderPrompt's substitution — one pass, a function replacement, unknown slots kept — over the SHIPPED text, so this machine's overrides cannot move the answer. */
function renderDefault(id: string, vars: Record<string, string> = {}): string {
  return promptDefault(id).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** Values that would expose a second substitution pass or a `$&` expansion. */
const TRICKY = "a $& b $1 {{name}} c";

/**
 * Every prompt that was an inline literal before the move, with the literal
 * exactly as HEAD ce49931 built it (session.ts, engine.ts, addon.ts,
 * webFetch.ts), and what the brain default renders to with the same values.
 * The addon-author prompts are compared in the class below, from the fixture.
 */
const FORMER_LITERALS: readonly { id: string; rendered: string; head: string }[] = [
  { id: "reminder.steering", rendered: renderDefault("reminder.steering"), head: "<system-reminder>The user adds, mid-run — steer the ongoing work accordingly:</system-reminder>" },
  { id: "reminder.stop-hook", rendered: renderDefault("reminder.stop-hook", { reason: TRICKY }), head: `<system-reminder>Stop hook: ${TRICKY}</system-reminder>` },
  { id: "reminder.interrupted", rendered: renderDefault("reminder.interrupted"), head: "<system-reminder>The user interrupted this turn before it finished.</system-reminder>" },
  { id: "reminder.turn-error", rendered: renderDefault("reminder.turn-error"), head: "<system-reminder>This turn ended with an error before its tool calls completed.</system-reminder>" },
  { id: "reminder.post-tool-use-hook", rendered: renderDefault("reminder.post-tool-use-hook", { reason: TRICKY }), head: `<system-reminder>PostToolUse hook: ${TRICKY}</system-reminder>` },
  { id: "reminder.tool-failed", rendered: renderDefault("reminder.tool-failed", { error: TRICKY }), head: `Tool failed: ${TRICKY}` },
  { id: "reminder.tool-did-not-run", rendered: renderDefault("reminder.tool-did-not-run"), head: "Tool did not run." },
  {
    id: "vision.tool-image-unseen",
    rendered: renderDefault("vision.tool-image-unseen", { reason: TRICKY }),
    head: `[This tool returned an image. You have NOT seen it — ${TRICKY}. Do not describe it or draw conclusions from it.]`,
  },
  {
    id: "vision.tool-image-failed",
    rendered: renderDefault("vision.tool-image-failed", { error: TRICKY }),
    head: `[This tool returned an image, but the vision model could not look at it: ${TRICKY}. You have NOT seen it.]`,
  },
  {
    id: "reminder.wrapup-standards",
    rendered: promptDefault("reminder.wrapup-nudge").replace("</system-reminder>", () => `\n${renderDefault("reminder.wrapup-standards")}</system-reminder>`),
    head: promptDefault("reminder.wrapup-nudge").replace("</system-reminder>", `\nConfirm the diff complies with STANDARDS.md — name any deviation and why.</system-reminder>`),
  },
  { id: "vision.describe-request", rendered: renderDefault("vision.describe-request", { label: TRICKY }), head: `Describe this image (${TRICKY}).` },
  {
    id: "reminder.clarify-answers",
    rendered: renderDefault("reminder.clarify-answers"),
    head: "Clarify pre-layer: before starting, the user answered these questions — honor the answers as requirements. Unanswered questions are yours to decide sensibly:",
  },
  {
    id: "reminder.final-round",
    rendered: renderDefault("reminder.final-round"),
    head: "Final tool round: the per-turn iteration cap is reached after this response. Give your complete final answer now — further tool calls will be cut off.",
  },
  {
    id: "reminder.tool-switched-off",
    rendered: renderDefault("reminder.tool-switched-off", { name: "Glob" }),
    head: `The Glob tool is switched off in this workspace and cannot be called. Reach the goal another way, and do not retry it this turn.`,
  },
  { id: "reminder.pre-tool-use-hook", rendered: renderDefault("reminder.pre-tool-use-hook", { reason: TRICKY }), head: "PreToolUse hook blocked this call: " + TRICKY },
  {
    id: "reminder.approval-note",
    rendered: renderDefault("reminder.approval-note", { tool: "Bash", note: TRICKY }),
    head: `The user approved this Bash call but attached a note — read it and adjust your approach accordingly:\n${TRICKY}`,
  },
  {
    id: "reminder.shell-command",
    rendered: renderDefault("reminder.shell-command"),
    head: "<system-reminder>The user ran this shell command directly; its output above is context, not a request.</system-reminder>",
  },
  {
    id: "reminder.addon-resources",
    rendered: renderDefault("reminder.addon-resources", { files: `- notes.md\n- ${TRICKY}` }),
    head: `<system-reminder>Files bundled with this addon — read the ones its instructions point at, and run its scripts with Bash:\n- notes.md\n- ${TRICKY}</system-reminder>`,
  },
  {
    id: "webfetch.system",
    rendered: renderDefault("webfetch.system"),
    head: "You are given the readable text of a web page and a question about it. Answer the question using only the page content. Be concise and factual; if the page does not contain the answer, say so.",
  },

  // ---- brain-controls-behavior: the last instructional texts composed in code.
  // Each head is the literal as HEAD 32a5f67 built it (session.ts, engine.ts,
  // permissions.ts, reuseGate.ts, background.ts and the five tools), with the
  // values the code passes rendered in the same way.
  {
    id: "system.deletion-policy",
    rendered: renderDefault("system.deletion-policy"),
    head: `Deletion policy:
- The user has enabled "Allow deletions" in the app settings — a durable authorization for destructive local operations (deleting files or folders, forced git history rewrites, and similar). They run without an extra confirmation prompt.
- This is a license, not a directive: delete only what the task genuinely requires, keep the smallest possible blast radius, and still call out anything surprising you are about to remove.`,
  },
  {
    id: "vision.attached-unreadable",
    rendered: renderDefault("vision.attached-unreadable", { count: "3", reason: TRICKY }),
    head:
      `[The user attached 3 image(s) to this message, but they could not be read: ${TRICKY}. ` +
      `You have NOT seen them — do not describe them or draw conclusions from them; say what happened and ask the user how to proceed.]`,
  },
  {
    id: "vision.attached-malformed",
    rendered: renderDefault("vision.attached-malformed", { label: TRICKY }),
    head: `[The user attached "${TRICKY}", but it arrived malformed and was not read. You have NOT seen it.]`,
  },
  {
    id: "vision.attached-too-large",
    rendered: renderDefault("vision.attached-too-large", { label: TRICKY }),
    head: `[The user attached "${TRICKY}", but it is too large to send to the vision model. You have NOT seen it.]`,
  },
  {
    id: "vision.attached-failed",
    rendered: renderDefault("vision.attached-failed", { label: "shot.png", error: TRICKY }),
    head:
      `[The user attached "shot.png", but the vision model could not look at it: ${TRICKY}. ` +
      `You have NOT seen it — do not describe it or draw conclusions from it.]`,
  },
  {
    // The pre-existing literal never filled its two counts: the model received
    // `{{noiseLimit}}` and `{{noiseWindowSec}}` as written, and the move keeps
    // that byte for byte (the code still passes only the id).
    id: "reminder.monitor-noise-stop",
    rendered: renderDefault("reminder.monitor-noise-stop", { id: "monitor_0a1b2c3d" }),
    head: "<task-notification>Monitor monitor_0a1b2c3d was stopped automatically: more than {{noiseLimit}} events within {{noiseWindowSec}}s (too noisy). Narrow the command and restart if you still need it.</task-notification>",
  },
  {
    id: "reminder.background-exit",
    rendered: renderDefault("reminder.background-exit", { kind: "bash", id: "bash_0a1b2c3d", description: TRICKY, code: String(null), file: "/tmp/out.log" }),
    head: `<task-notification>Background bash task bash_0a1b2c3d ("${TRICKY}") finished with exit code ${null}. Output file: /tmp/out.log</task-notification>`,
  },
  {
    id: "reminder.permission-rule-denied",
    rendered: renderDefault("reminder.permission-rule-denied"),
    head: `Permission denied by settings rule. The user's configuration forbids this call; do not retry it verbatim.`,
  },
  {
    id: "reminder.permission-kill-overdrive",
    rendered: renderDefault("reminder.permission-kill-overdrive"),
    head: "Refused: this command stops processes by name, which stops every matching process on this computer, not only the ones this session started. In OVERDRIVE nothing asks, so a kill by name never runs. To stop a background command you started, use TaskStop with its task id; to stop one process, kill its pid. If the user wants every matching process stopped, say so in your answer: they can run it themselves or turn OVERDRIVE off.",
  },
  ...[undefined, TRICKY].flatMap((note) => {
    // `res.message ? `: ${res.message}` : "."` — the code's {{detail}}, with and without the user's note.
    const detail = note ? `: ${note}` : ".";
    return [
      {
        id: "reminder.permission-kill-declined",
        rendered: renderDefault("reminder.permission-kill-declined", { detail }),
        head: `The user declined this process kill${note ? `: ${note}` : "."} It stops processes by name — every matching process on this computer. To stop a background command you started, use TaskStop with its task id, or kill its pid; do not retry the same call.`,
      },
      {
        id: "reminder.permission-protected-declined",
        rendered: renderDefault("reminder.permission-protected-declined", { path: "/w/.env", detail }),
        head: `The user declined this edit to a protected path (/w/.env)${note ? `: ${note}` : "."} Edits to .magentra state and .env files always require approval; do not retry the same call.`,
      },
      {
        id: "reminder.permission-deletion-declined",
        rendered: renderDefault("reminder.permission-deletion-declined", { detail }),
        head: `The user declined this destructive tool call${note ? `: ${note}` : "."} Deletion calls always require approval; adjust your approach instead of retrying the same call.`,
      },
      {
        id: "reminder.permission-declined",
        rendered: renderDefault("reminder.permission-declined", { detail }),
        head: `The user declined this tool call${note ? `: ${note}` : "."} Adjust your approach instead of retrying the same call.`,
      },
    ];
  }),
  {
    id: "reminder.reuse-check-firm",
    rendered: renderDefault("reminder.reuse-check-firm", { target: "src/profile.ts", hits: `- src/user.ts — formatUserDisplayName (0.93)\n- ${TRICKY}` }),
    head:
      `Reuse check: src/profile.ts was just created, but very similar code already exists and no related search/read happened this session:\n` +
      `- src/user.ts — formatUserDisplayName (0.93)\n- ${TRICKY}` +
      "\nRead the closest match now. If it already covers this, extend it (Edit) and delete the new file; keep the new file only if it is genuinely distinct.",
  },
  {
    id: "reminder.reuse-check",
    rendered: renderDefault("reminder.reuse-check", { target: "src/profile.ts", hits: `- src/user.ts — formatUserDisplayName (0.61)\n- ${TRICKY}` }),
    head:
      `Reuse check: src/profile.ts was just created, but similar code may already exist:\n` +
      `- src/user.ts — formatUserDisplayName (0.61)\n- ${TRICKY}` +
      "\nIf one of these already covers it, extend that with Edit and remove the new file rather than keeping a parallel implementation.",
  },
  {
    id: "bash.foreground-sleep",
    rendered: renderDefault("bash.foreground-sleep"),
    head: "Foreground sleep is blocked. If you are waiting for something, run the wait in the background (run_in_background with an until-loop) so you keep working meanwhile.",
  },
  {
    id: "read.image-unseen",
    rendered: renderDefault("read.image-unseen", { file: "shot.png", reason: TRICKY }),
    head:
      `shot.png is an image and you cannot see it — ${TRICKY}. ` +
      `Do not describe or draw conclusions from it. Verify this change some other way, or say plainly that it stays unverified.`,
  },
  {
    id: "read.image-failed",
    rendered: renderDefault("read.image-failed", { file: "shot.png", error: TRICKY }),
    head: `Could not look at shot.png: ${TRICKY}. ` + `You have NOT seen this image — do not describe it or draw conclusions from it.`,
  },
  {
    // The code keeps the newline that puts the note on its own line after "File written: …".
    id: "write.replaced-note",
    rendered: `\n${renderDefault("write.replaced-note")}`,
    head: "\nnote: existing file replaced entirely — for incremental changes, use Edit instead of rewriting with Write.",
  },
  {
    id: "websearch.disabled",
    rendered: renderDefault("websearch.disabled"),
    head: 'Web search is disabled in settings ("search.enabled" is false). Do not retry; work without web search or ask the user to enable it.',
  },
];

/**
 * Model-facing texts with no pre-migration literal: brain-controls-behavior's
 * three OVERDRIVE refusals, sent only when a guard in brain/behavior.json is
 * set to "refuse" (never with the shipped "run"). Their bytes are the ones the
 * owner approved; rewording one fails here, as a reworded pin does.
 */
const NEW_TEXTS: readonly { id: string; text: string }[] = [
  {
    id: "reminder.overdrive-deletion-refused",
    text: "Refused by policy: in OVERDRIVE this workspace refuses calls that delete, and this one would delete ({{what}}). Nothing ran and nobody was asked. Do not retry it, and do not delete the same thing another way. Reach the goal without deleting; if the deletion is truly needed, say so in your answer so the user can do it.",
  },
  {
    id: "reminder.overdrive-protected-edit-refused",
    text: "Refused by policy: in OVERDRIVE this workspace refuses edits to .magentra state and .env files, and this edit targets one ({{path}}). The file was not changed and nobody was asked. Do not retry it, and do not change the file another way. Reach the goal without editing it; if the change is truly needed, say in your answer what it is so the user can make it.",
  },
  {
    id: "reminder.overdrive-outside-edit-refused",
    text: "Refused by policy: in OVERDRIVE this workspace refuses edits outside the workspace, and this edit targets a file outside it ({{path}}). The file was not changed and nobody was asked. Do not retry it, and do not change the file another way. Keep the work inside the workspace; if the change is truly needed, say in your answer what it is so the user can make it.",
  },
];

/** The ids brought into the registry from inline literals by this feature: FORMER_LITERALS plus the addon-author three. */
const ADDON_AUTHOR_IDS = ["addon-author.context-line", "addon-author.instruction", "addon-author.retry-feedback"] as const;

/**
 * Checklist 2 against the texts as they were before the move — run by
 * {@link RuntimeDefaultsAreAFreshCompileOfBrain}. The two pins hold only the
 * assembled system prompt and the tool wire, so a reminder, a finishing rung or
 * a side-call instruction reworded in the move — or a literal re-typed into
 * brain/ with one character off — would otherwise reach the model with nothing
 * failing.
 */
function assertPreMigrationTexts(t: TestRun): void {
  {
    const catalog = new Map(promptCatalog().map((e) => [e.id, e]));
    const baseline = baselineCatalog();
    t.assert.equal(baseline.length, 43, "the fixture is the pre-migration catalog outside the subagent and tool groups: 43 prompts");
    for (const before of baseline) {
      const now = catalog.get(before.id);
      t.assert.ok(now, `${before.id} was registered before the move and is gone`);
      t.assert.equal(now!.defaultText, before.text, `${before.id}: the default text changed in the move`);
      t.assert.equal(promptDefault(before.id), before.text, `${before.id}: promptDefault is not the pre-migration text`);
      t.assert.deepEqual(
        { group: now!.group, label: now!.label, channel: now!.channel, where: now!.where, placeholders: now!.placeholders ?? null },
        { group: before.group, label: before.label, channel: before.channel, where: before.where, placeholders: before.placeholders },
        `${before.id}: its catalog entry changed in the move`,
      );
    }

    for (const literal of FORMER_LITERALS) t.assert.equal(literal.rendered, literal.head, `${literal.id} does not render to the literal it replaced`);
    for (const added of NEW_TEXTS) t.assert.equal(promptDefault(added.id), added.text, `${added.id}: its default is not the approved text`);

    // Composed as engine.ts composes them (buildAddonPrompt, the retry feedback).
    const addon = addonAuthorBaseline();
    t.assert.equal(addon.cases.length >= 2, true);
    for (const c of addon.cases) {
      const context = c.context?.trim() ? `\n\n${renderDefault("addon-author.context-line", { context: c.context.trim() })}` : "";
      const prompt = renderDefault("addon-author.instruction", { description: c.description, context, taken: c.taken.join(", ") || "(none)" });
      t.assert.equal(prompt, c.prompt, `addon-author.instruction for ${JSON.stringify(c.description)} is not HEAD's buildAddonPrompt()`);
    }
    t.assert.equal(`\n\n${renderDefault("addon-author.retry-feedback", { error: addon.feedbackError })}`, addon.feedback, "addon-author.retry-feedback is not HEAD's validator feedback");

    // Nothing in brain/ escapes both checks: every id is either a pre-migration
    // prompt or a former literal compared above.
    const covered = new Set([...baseline.map((p) => p.id), ...FORMER_LITERALS.map((l) => l.id), ...ADDON_AUTHOR_IDS, ...NEW_TEXTS.map((n) => n.id)]);
    t.assert.deepEqual(
      brainPromptIdList().filter((id) => !covered.has(id)),
      [],
      "a brain prompt with no pre-migration text to compare against — add its old literal here",
    );
    t.assert.deepEqual(
      [...covered].filter((id) => !brainPromptIdList().includes(id)),
      [],
      "a pre-migration prompt or former literal that brain/ does not hold",
    );

    // And no side call's system prompt is a literal in code any more.
    for (const file of engineSources()) {
      const source = readFileSync(join(repoRoot(), file), "utf8");
      for (const match of source.matchAll(/runInference\(\{([\s\S]*?)\}\)/g)) {
        t.assert.doesNotMatch(match[1]!, /\bsystem\s*:\s*["'`]/, `${file}: a runInference call passes a literal system prompt`);
      }
    }
  }
}

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
 * The former literals as the real engine composes them — run by
 * {@link AnOverrideStillWinsOverBrain} on an engine of its own. Comparing a
 * brain text to its old literal does not prove the code still joins it to the
 * same neighbours: a dropped blank line before the user's extra detail, or a
 * reminder glued to the output it follows, changes the bytes the model reads
 * while every template still matches. And an emptied wrapper must drop its
 * prose and keep the value it wrapped.
 */
async function assertComposedFormerLiterals(
  t: TestRun,
  opts: { workspace: string; prompts: string; writeFile: (path: string, contents: string) => void; started: (engine: ScriptedEngine) => void },
): Promise<void> {
  const addon = addonAuthorBaseline();
  const withContext = addon.cases.find((c) => c.context !== undefined && c.taken.length > 0)!;
  const valid = "---\nname: audit-deps\ndescription: When the lockfile changes.\n---\nList each changed dependency.\n";

  const engine = await startScriptedEngine({
    workspace: opts.workspace,
    // A draft the validator rejects, then one it accepts; then two plain turns.
    turns: [{ text: "Here is your addon." }, { text: valid }, { text: "ok" }, { text: "ok" }],
    addons: withContext.taken.map((name) => ({ name, description: `${name} addon`, body: "Do it.", resources: [], source: "workspace" as const })),
  });
  opts.started(engine);

  // The create-addon wizard: HEAD's prompt, then HEAD's prompt + HEAD's feedback.
  engine.send({ type: "generate_addon", description: withContext.description, context: withContext.context! });
  const draft = await engine.waitFor((e) => e.type === "addon_draft");
  t.assert.equal(draft.type === "addon_draft" && draft.ok, true, `the second draft is valid: ${JSON.stringify(draft)}`);
  t.assert.equal(userTextWith(engine.provider.requests[0], "The user wants a new addon"), withContext.prompt, "the first attempt's instruction is HEAD's, byte for byte");
  t.assert.equal(
    userTextWith(engine.provider.requests[1], "The user wants a new addon"),
    withContext.prompt + addon.feedback,
    "the retry carries HEAD's validator feedback after a blank line",
  );
  t.assert.equal(addon.feedbackError, "the file must open with --- frontmatter", "the fixture's feedback is for the rejection this script provokes");

  // A `!` command, then a turn: the context message is HEAD's literal.
  engine.send({ type: "bang_command", cmd: "echo brain-one" });
  await engine.waitFor((e) => e.type === "command_output" && e.text === "brain-one");
  const first = await engine.runTurn("next");
  t.assert.deepEqual([...first.errors], []);
  t.assert.equal(
    userTextWith(engine.provider.requests[2], "! echo brain-one"),
    `<bash-input>! echo brain-one</bash-input>\n<bash-output exit-code="0">\nbrain-one\n</bash-output>\n<system-reminder>The user ran this shell command directly; its output above is context, not a request.</system-reminder>`,
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
  new ThePinsStillCoverTheWithheldToolsFromBrain(),
  new TheCompilerKeepsEveryByte(),
  new AToolAbsentFromMainIsWithheldAndRefused(),
  new AToolAbsentFromOverdriveIsWithheldOnlyWhileOverdriveIsOn(),
  new TheShippedBrainWithholdsAgentAndWorkflowInBoth(),
  new AChildSessionIsExempt(),
  new AnOverrideStillWinsOverBrain(),
  new TheCompilerFailsTheBuildNamingAnUnknownTool(),
  new TheBundledEngineBootsWithNoBrainBesideIt(),
);
