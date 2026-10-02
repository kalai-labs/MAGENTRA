#!/usr/bin/env node
// Compiles brain/ into engine/protocol/src/brain.generated.ts.
//
// brain/ is the single source of MAGENTRA's model-facing defaults (see
// brain/README.md). The engine never reads brain/ at run time: this script turns
// it into a TypeScript module that tsc compiles into engine/protocol/dist, which
// the app bundle (app/scripts/bundle-engine.js) inlines into engine.cjs. A
// packaged install therefore carries the defaults with no brain/ folder.
//
// Plain Node, no dependencies, runs on Node 20. Root `npm run build` runs it
// before `tsc -b`.
//
//   node tools/brain/compile.mjs [--brain <dir>] [--out <file>] [--check]
//
//   --brain  the brain folder to read (default: <repo>/brain)
//   --out    the module to write (default: <repo>/engine/protocol/src/brain.generated.ts)
//   --check  compile and validate only; write nothing, exit 1 when --out is out of date
//
// Exit code 1 with one line per problem on stderr when the brain is invalid.
// Every problem names the file, and an unknown tool names the tool.
//
// ---------------------------------------------------------------------------
// FILE RULES (the contract the round-trip depends on — keep README in step)
//
// Every .md file is read as UTF-8; a leading BOM is dropped and CRLF is folded
// to LF before anything else, so a Windows autocrlf checkout compiles to the
// same bytes as a macOS one. A lone CR left after that is an error.
//
// Frontmatter: the file's first line is exactly `---`; then `key: value` lines
// (key = [a-z]+, exactly one space after the colon, value non-empty, no leading
// or trailing whitespace, one physical line); then a line exactly `---`.
// Unknown, duplicate or missing keys are errors.
//
// Body (prompts and tool descriptions): everything after the closing `---\n`,
// with EXACTLY ONE trailing `\n` removed. The file must end with `\n`. Nothing
// else is trimmed — leading blank lines, trailing spaces and extra trailing
// newlines in the body are part of the text. An empty body is an error.
//
// params.md: NO frontmatter. The first line is a heading `## <path>`. A heading
// is a line starting with `## ` at column 0; the path runs to end of line, has
// no whitespace, and is either `(root)` (the .describe() on the schema object
// itself) or dot-separated field names (array elements are transparent:
// questions.options.label). A section's raw content is every line after its
// heading up to the next heading or EOF. The last section's raw content must
// end with `\n` and loses exactly that one `\n`; every other section's raw
// content must end with `\n\n` (the text's own line end plus ONE blank
// separator line) and loses exactly those two characters. The remainder is the
// .describe() text, byte for byte; it must be non-empty. Because a heading
// always ends a section, a .describe() text containing a line that starts with
// `## ` cannot be expressed and is rejected (it would read as a heading).
// Duplicate paths are errors.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The built-in tool names the brain may describe and availability.json may
 * list: exactly the tools createDefaultRegistry() in engine/tools/src/index.ts
 * registers. This compiler runs BEFORE tsc and cannot import the registry, and
 * the folders under brain/tools cannot be the source of truth either (a typo'd
 * folder would then define itself as known) — so the list is fixed here.
 * Adding a built-in tool means adding its name here AND its brain/tools folder.
 * MCP tools (mcp__*) are never built-in and never listed.
 * The tool-registry-contract test pins the same 27 names from the other side.
 */
export const BUILTIN_TOOLS = Object.freeze([
  "Addon",
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterWorktree",
  "ExitWorktree",
  "Glob",
  "GraphQuery",
  "Grep",
  "Monitor",
  "PushNotification",
  "Read",
  "ScheduleWakeup",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

/** Prompt group string → its folder under brain/prompts. Group 6 (subagent.*) is absent on purpose. */
export const GROUP_DIRS = Object.freeze({
  "1 · Core system prompt": "1-core-system",
  "2 · Conditional system sections": "2-conditional-system",
  "3 · In-turn reminders": "3-in-turn-reminders",
  "4 · End-of-turn rungs": "4-end-of-turn-rungs",
  "5 · Background inference calls": "5-background-inference",
  "7 · Tool descriptions": "7-tool-descriptions",
});

export const CHANNELS = Object.freeze([
  "system",
  "system-conditional",
  "reminder",
  "tool",
  "side-call",
  "side-call-user",
  "subagent",
]);

const PROMPT_KEYS = ["id", "group", "label", "channel", "where", "placeholders"];
const PROMPT_REQUIRED = ["id", "group", "label", "channel", "where"];
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const NAME_RE = /^\w+$/;
const PARAM_SEGMENT = "-?[A-Za-z_][A-Za-z0-9_-]*";
const PARAM_PATH_RE = new RegExp(`^(\\(root\\)|${PARAM_SEGMENT}(\\.${PARAM_SEGMENT})*)$`);

class Problems {
  constructor(brainDir) {
    this.brainDir = brainDir;
    this.list = [];
  }
  add(file, message) {
    const where = file ? relative(this.brainDir, file).split(sep).join("/") : "brain";
    this.list.push(`${where}: ${message}`);
  }
}

/** Reads a brain text file: BOM dropped, CRLF folded to LF. */
function readText(file, problems) {
  let text = readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n");
  if (text.includes("\r")) problems.add(file, "contains a carriage return that is not part of a CRLF line end");
  return text;
}

/**
 * Splits `---\n<frontmatter>\n---\n<body>` and parses the frontmatter.
 * Returns undefined (after recording the problem) when the shape is wrong.
 */
function parseFrontmatter(file, text, allowedKeys, problems) {
  if (!text.startsWith("---\n")) {
    problems.add(file, "must start with a frontmatter line `---`");
    return undefined;
  }
  const close = text.indexOf("\n---\n", 3);
  if (close === -1) {
    problems.add(file, "frontmatter has no closing `---` line");
    return undefined;
  }
  const head = text.slice(4, close);
  const rest = text.slice(close + 5);
  const fields = {};
  let ok = true;
  for (const line of head.split("\n")) {
    const m = /^([a-z]+): (.*)$/.exec(line);
    if (!m) {
      problems.add(file, `frontmatter line is not \`key: value\`: ${JSON.stringify(line)}`);
      ok = false;
      continue;
    }
    const [, key, value] = m;
    if (!allowedKeys.includes(key)) {
      problems.add(file, `unknown frontmatter key "${key}" (allowed: ${allowedKeys.join(", ")})`);
      ok = false;
      continue;
    }
    if (key in fields) {
      problems.add(file, `duplicate frontmatter key "${key}"`);
      ok = false;
      continue;
    }
    if (value === "" || value !== value.trim()) {
      problems.add(file, `frontmatter "${key}" is empty or has leading/trailing whitespace`);
      ok = false;
      continue;
    }
    fields[key] = value;
  }
  return ok ? { fields, rest } : undefined;
}

/** The body rule: the file must end with `\n`, and exactly one is removed. */
function bodyOf(file, rest, problems) {
  if (!rest.endsWith("\n")) {
    problems.add(file, "must end with a newline (the body loses exactly one trailing `\\n`)");
    return undefined;
  }
  const body = rest.slice(0, -1);
  if (body === "") {
    problems.add(file, "body is empty");
    return undefined;
  }
  return body;
}

function listDir(dir) {
  return readdirSync(dir).filter((n) => n !== ".DS_Store" && n !== ".gitkeep").sort();
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function compilePrompts(brainDir, problems) {
  const root = join(brainDir, "prompts");
  const prompts = [];
  if (!isDir(root)) {
    problems.add(root, "missing folder");
    return prompts;
  }
  const dirToGroup = new Map(Object.entries(GROUP_DIRS).map(([g, d]) => [d, g]));
  const seen = new Map();
  for (const dirName of listDir(root)) {
    const dir = join(root, dirName);
    if (!isDir(dir)) {
      if (dirName !== "README.md") problems.add(dir, "only group folders belong in brain/prompts");
      continue;
    }
    const dirGroup = dirToGroup.get(dirName);
    if (dirGroup === undefined) {
      problems.add(dir, `unknown group folder (known: ${[...dirToGroup.keys()].join(", ")})`);
      continue;
    }
    for (const fileName of listDir(dir)) {
      const file = join(dir, fileName);
      if (!fileName.endsWith(".md") || isDir(file)) {
        problems.add(file, "only <id>.md prompt files belong in a group folder");
        continue;
      }
      const parsed = parseFrontmatter(file, readText(file, problems), PROMPT_KEYS, problems);
      if (!parsed) continue;
      const { fields, rest } = parsed;
      const missing = PROMPT_REQUIRED.filter((k) => !(k in fields));
      if (missing.length) {
        problems.add(file, `missing frontmatter key(s): ${missing.join(", ")}`);
        continue;
      }
      const text = bodyOf(file, rest, problems);
      if (text === undefined) continue;
      const { id, group, label, channel, where } = fields;
      let ok = true;
      const bad = (msg) => {
        problems.add(file, msg);
        ok = false;
      };
      if (!ID_RE.test(id)) bad(`id "${id}" is not a dotted lower-case id`);
      if (fileName !== `${id}.md`) bad(`file name must be "${id}.md" (its id)`);
      if (id.startsWith("subagent.")) bad(`id "${id}": subagent.* prompts stay in engine/core/src/agent/agents.ts`);
      if (id.startsWith("tool.")) bad(`id "${id}": tool descriptions live in brain/tools/<Name>/description.md`);
      if (group !== dirGroup) bad(`group "${group}" does not match its folder "${dirName}" (expects "${dirGroup}")`);
      if (!CHANNELS.includes(channel)) bad(`unknown channel "${channel}" (known: ${CHANNELS.join(", ")})`);
      let placeholders;
      if ("placeholders" in fields) {
        placeholders = fields.placeholders.split(/,\s*/);
        for (const name of placeholders) if (!NAME_RE.test(name)) bad(`placeholder "${name}" is not a \\w+ name`);
        if (new Set(placeholders).size !== placeholders.length) bad("placeholders lists a name twice");
      }
      // Every {{slot}} in the text must be a declared placeholder. A declared
      // placeholder with no slot is allowed (system.identity ships that way).
      const slots = [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
      const undeclared = slots.filter((s) => !(placeholders ?? []).includes(s));
      if (undeclared.length) bad(`text has {{slot}}(s) not declared in placeholders: ${undeclared.join(", ")}`);
      if (seen.has(id)) bad(`duplicate prompt id "${id}" (also ${relative(brainDir, seen.get(id))})`);
      if (!ok) continue;
      seen.set(id, file);
      prompts.push({ id, group, label, channel, where, ...(placeholders ? { placeholders } : {}), text });
    }
  }
  prompts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return prompts;
}

function parseParams(file, text, problems) {
  const params = {};
  if (!text.startsWith("## ")) {
    problems.add(file, "must start with a `## <path>` heading (params.md has no frontmatter)");
    return undefined;
  }
  if (!text.endsWith("\n")) {
    problems.add(file, "must end with a newline");
    return undefined;
  }
  // Heading positions: offset 0, and every `\n## `.
  const starts = [0];
  for (let i = text.indexOf("\n## "); i !== -1; i = text.indexOf("\n## ", i + 1)) starts.push(i + 1);
  let ok = true;
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : text.length;
    const lineEnd = text.indexOf("\n", start);
    const path = text.slice(start + 3, lineEnd);
    const raw = text.slice(lineEnd + 1, end);
    const last = k + 1 === starts.length;
    if (!PARAM_PATH_RE.test(path)) {
      problems.add(file, `heading "## ${path}" is not a parameter path (dotted field names, or (root))`);
      ok = false;
      continue;
    }
    const tail = last ? "\n" : "\n\n";
    if (!raw.endsWith(tail)) {
      problems.add(
        file,
        last
          ? `section "${path}" must end with a newline`
          : `section "${path}" must end with its text's newline plus ONE blank line before the next heading`,
      );
      ok = false;
      continue;
    }
    const body = raw.slice(0, -tail.length);
    if (body === "") {
      problems.add(file, `section "${path}" is empty`);
      ok = false;
      continue;
    }
    if (path in params) {
      problems.add(file, `duplicate section "${path}"`);
      ok = false;
      continue;
    }
    params[path] = body;
  }
  return ok ? params : undefined;
}

function compileTools(brainDir, problems) {
  const root = join(brainDir, "tools");
  const tools = {};
  if (!isDir(root)) {
    problems.add(root, "missing folder");
    return tools;
  }
  for (const name of listDir(root)) {
    const dir = join(root, name);
    if (!isDir(dir)) {
      if (name !== "README.md") problems.add(dir, "only <ToolName>/ folders belong in brain/tools");
      continue;
    }
    if (!BUILTIN_TOOLS.includes(name)) {
      problems.add(dir, `unknown tool "${name}" — not a built-in tool (BUILTIN_TOOLS in tools/brain/compile.mjs)`);
      continue;
    }
    const entries = listDir(dir);
    const strays = entries.filter((e) => e !== "description.md" && e !== "params.md");
    for (const s of strays) problems.add(join(dir, s), "only description.md and params.md belong in a tool folder");
    const descFile = join(dir, "description.md");
    if (!entries.includes("description.md")) {
      problems.add(descFile, `tool "${name}" has no description.md`);
      continue;
    }
    const parsed = parseFrontmatter(descFile, readText(descFile, problems), ["name"], problems);
    if (!parsed) continue;
    if (parsed.fields.name === undefined) {
      problems.add(descFile, "missing frontmatter key: name");
      continue;
    }
    if (parsed.fields.name !== name) {
      problems.add(descFile, `frontmatter name "${parsed.fields.name}" does not match its folder "${name}"`);
      continue;
    }
    const description = bodyOf(descFile, parsed.rest, problems);
    if (description === undefined) continue;
    let params = {};
    if (entries.includes("params.md")) {
      const paramsFile = join(dir, "params.md");
      const p = parseParams(paramsFile, readText(paramsFile, problems), problems);
      if (!p) continue;
      params = p;
    }
    const sorted = {};
    for (const k of Object.keys(params).sort()) sorted[k] = params[k];
    tools[name] = { description, params: sorted };
  }
  return tools;
}

function compileAvailability(brainDir, problems) {
  const file = join(brainDir, "availability.json");
  if (!existsSync(file)) {
    problems.add(file, "missing file");
    return undefined;
  }
  let data;
  try {
    data = JSON.parse(readText(file, problems));
  } catch (err) {
    problems.add(file, `not valid JSON: ${err.message}`);
    return undefined;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    problems.add(file, 'must be an object { "main": [...], "overdrive": [...] }');
    return undefined;
  }
  let ok = true;
  for (const key of Object.keys(data)) {
    if (key !== "main" && key !== "overdrive") {
      problems.add(file, `unknown context "${key}" (known: main, overdrive)`);
      ok = false;
    }
  }
  const out = {};
  for (const key of ["main", "overdrive"]) {
    const list = data[key];
    if (!Array.isArray(list) || list.some((n) => typeof n !== "string")) {
      problems.add(file, `"${key}" must be an array of tool names`);
      ok = false;
      continue;
    }
    for (const name of list) {
      if (!BUILTIN_TOOLS.includes(name)) {
        problems.add(file, `"${key}" names unknown tool "${name}" — not a built-in tool (MCP tools are never listed)`);
        ok = false;
      }
    }
    if (new Set(list).size !== list.length) {
      problems.add(file, `"${key}" lists a tool twice`);
      ok = false;
    }
    out[key] = [...list];
  }
  return ok ? out : undefined;
}

/** Every `.ts` file under `dir`, skipping the generated module, node_modules and dist. */
function sourceFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (isDir(p)) {
      if (name !== "node_modules" && name !== "dist") out.push(...sourceFilesUnder(p));
    } else if (name.endsWith(".ts") && name !== "brain.generated.ts") {
      out.push(p);
    }
  }
  return out;
}

/**
 * The prompt ids the engine's source names with `brainPrompt("<id>")`, each
 * with the first file that names it. Read from the source rather than imported,
 * because this runs before tsc.
 */
export function brainPromptIdsInSource(repo = REPO) {
  const ids = new Map();
  const engine = join(repo, "engine");
  if (!isDir(engine)) return ids;
  for (const pkg of readdirSync(engine).sort()) {
    const src = join(engine, pkg, "src");
    if (!isDir(src)) continue;
    for (const file of sourceFilesUnder(src)) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bbrainPrompt\("([^"]+)"\)/g)) {
        if (!ids.has(m[1])) ids.set(m[1], relative(repo, file).split(sep).join("/"));
      }
    }
  }
  return ids;
}

/**
 * What a brain the engine will be built from must hold, beyond being valid: a
 * folder for every built-in tool, and a file for every prompt id the engine's
 * source names. Without this a deleted file compiles cleanly and the engine
 * fails only when its module is imported.
 */
function completenessProblems(dir, prompts, tools, problems) {
  for (const name of BUILTIN_TOOLS) {
    if (!(name in tools) && !isDir(join(dir, "tools", name))) {
      problems.add(join(dir, "tools", name), `built-in tool "${name}" has no folder (BUILTIN_TOOLS in tools/brain/compile.mjs)`);
    }
  }
  const have = new Set(prompts.map((p) => p.id));
  for (const [id, file] of brainPromptIdsInSource()) {
    if (!have.has(id)) problems.add(join(dir, "prompts"), `no prompt file for id "${id}" (named by brainPrompt in ${file})`);
  }
}

/**
 * Compiles a brain folder. Returns `{ problems, prompts, tools, availability,
 * source }`; `source` is the generated module text, undefined when there are
 * problems.
 *
 * `complete: true` (what the CLI, and so `npm run build`, passes) also requires
 * a folder for every built-in tool and a file for every prompt id the engine's
 * source names. Without it a partial brain compiles, which is what a test
 * exercising one rule at a time needs.
 */
export function compileBrain(brainDir, { complete = false } = {}) {
  const dir = resolve(brainDir);
  const problems = new Problems(dir);
  if (!isDir(dir)) {
    problems.add(undefined, `brain folder not found: ${dir}`);
    return { problems: problems.list };
  }
  const prompts = compilePrompts(dir, problems);
  const tools = compileTools(dir, problems);
  const availability = compileAvailability(dir, problems);
  if (complete) completenessProblems(dir, prompts, tools, problems);
  if (problems.list.length) return { problems: problems.list, prompts, tools, availability };
  return { problems: [], prompts, tools, availability, source: render(prompts, tools, availability) };
}

function render(prompts, tools, availability) {
  const j = (v) => JSON.stringify(v, null, 2);
  return `// GENERATED by tools/brain/compile.mjs from brain/ — DO NOT EDIT, and do not commit (gitignored).
// Edit the files under brain/ and run \`npm run build\`.
import type { PromptChannel } from "./prompts.js";

export interface BrainPromptDefault {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly channel: PromptChannel;
  readonly where: string;
  readonly placeholders?: readonly string[];
  readonly text: string;
}

export interface BrainToolDefault {
  /** The description TEMPLATE, {{slots}} unfilled. */
  readonly description: string;
  /** Parameter path ("(root)", "a", "a.b") → its exact .describe() text. */
  readonly params: Readonly<Record<string, string>>;
}

export interface BrainAvailabilityDefault {
  readonly main: readonly string[];
  readonly overdrive: readonly string[];
}

/** brain/prompts/<group-dir>/<id>.md, sorted by id. */
export const BRAIN_PROMPTS: readonly BrainPromptDefault[] = ${j(prompts)};

/** brain/tools/<Name>/{description,params}.md, keyed by tool name. */
export const BRAIN_TOOLS: Readonly<Record<string, BrainToolDefault>> = ${j(tools)};

/** The built-in tool names availability applies to (BUILTIN_TOOLS in tools/brain/compile.mjs). */
export const BRAIN_BUILTIN_TOOLS: readonly string[] = ${j(BUILTIN_TOOLS)};

/** brain/availability.json. */
export const BRAIN_AVAILABILITY: BrainAvailabilityDefault = ${j(availability)};
`;
}

function parseArgs(argv) {
  const args = { brain: join(REPO, "brain"), out: join(REPO, "engine", "protocol", "src", "brain.generated.ts"), check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--brain" || a === "--out") {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      args[a.slice(2)] = resolve(v);
    } else if (a === "--check") {
      args.check = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`brain: ${err.message}\n`);
    process.exit(2);
  }
  const result = compileBrain(args.brain, { complete: true });
  if (result.problems.length) {
    process.stderr.write(`brain: ${result.problems.length} problem(s) in ${args.brain}\n`);
    for (const p of result.problems) process.stderr.write(`  ${p}\n`);
    process.exit(1);
  }
  const current = existsSync(args.out) ? readFileSync(args.out, "utf8") : undefined;
  const summary = `${result.prompts.length} prompt(s), ${Object.keys(result.tools).length} tool(s)`;
  if (args.check) {
    if (current !== result.source) {
      process.stderr.write(`brain: ${relative(process.cwd(), args.out)} is out of date (${summary})\n`);
      process.exit(1);
    }
    process.stdout.write(`brain: ok, ${summary}\n`);
    return;
  }
  // Write only on change, so an unchanged brain does not force a tsc -b rebuild downstream.
  if (current !== result.source) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, result.source, "utf8");
  }
  process.stdout.write(`brain: ${summary} → ${relative(process.cwd(), args.out)}${current === result.source ? " (unchanged)" : ""}\n`);
}

/** Whether this module is the script node was asked to run. Realpaths on both
 *  sides: argv[1] keeps a symlinked path (macOS /tmp, a Windows junction) as
 *  typed while import.meta.url is resolved, and a mismatch would skip the
 *  compile silently with exit 0. */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
