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
// newlines in the body are part of the text. An empty body is an error, except
// in a prompt marked `enabled: false`.
//
// Prompt-only frontmatter keys beyond the metadata:
//   order: <int>     REQUIRED in prompts/1-core-system and allowed nowhere else;
//                    a non-negative integer, unique in that folder. It places
//                    the section in the system prompt (BRAIN_CORE_ORDER).
//   enabled: false   allowed on any prompt; the prompt registers BLANK (text
//                    ""), which is exactly a blank override: switched off.
//                    Only `false` is accepted — delete the line to enable it.
//
// behavior.json: the behaviour knobs. See BEHAVIOR_SPEC below and brain/README.md.
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

const PROMPT_KEYS = ["id", "group", "label", "channel", "where", "placeholders", "order", "enabled"];
const PROMPT_REQUIRED = ["id", "group", "label", "channel", "where"];
/** The folder whose files carry `order:` — the sections that open the system prompt. */
const CORE_DIR = "1-core-system";
const ORDER_RE = /^(0|[1-9][0-9]{0,5})$/;
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
function bodyOf(file, rest, problems, allowEmpty = false) {
  if (!rest.endsWith("\n")) {
    problems.add(file, "must end with a newline (the body loses exactly one trailing `\\n`)");
    return undefined;
  }
  const body = rest.slice(0, -1);
  if (body === "" && !allowEmpty) {
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

/**
 * Compiles brain/prompts. Fills `files` (id → its file) for the claim check.
 * A prompt marked `enabled: false` compiles to `text: ""` with `enabled: false`;
 * a 1-core-system prompt carries its `order`.
 */
function compilePrompts(brainDir, problems, files = new Map()) {
  const root = join(brainDir, "prompts");
  const prompts = [];
  const orders = new Map();
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
      if ("enabled" in fields && fields.enabled !== "false") {
        problems.add(file, `enabled: "${fields.enabled}" — only \`enabled: false\` is accepted; delete the line to enable the prompt`);
        continue;
      }
      const disabled = fields.enabled === "false";
      const body = bodyOf(file, rest, problems, disabled);
      if (body === undefined) continue;
      const { id, group, label, channel, where } = fields;
      let ok = true;
      const bad = (msg) => {
        problems.add(file, msg);
        ok = false;
      };
      let order;
      if (dirName === CORE_DIR) {
        if (!("order" in fields)) bad(`missing frontmatter key: order (required in ${CORE_DIR}: it places the section in the system prompt)`);
        else if (!ORDER_RE.test(fields.order)) bad(`order "${fields.order}" is not a non-negative integer`);
        else {
          order = Number(fields.order);
          if (orders.has(order)) bad(`order ${order} is also used by ${relative(brainDir, orders.get(order)).split(sep).join("/")}`);
        }
      } else if ("order" in fields) {
        bad(`order is only for prompts in ${CORE_DIR} (the system prompt's sections)`);
      }
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
      const slots = [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
      const undeclared = slots.filter((s) => !(placeholders ?? []).includes(s));
      if (undeclared.length) bad(`text has {{slot}}(s) not declared in placeholders: ${undeclared.join(", ")}`);
      if (seen.has(id)) bad(`duplicate prompt id "${id}" (also ${relative(brainDir, seen.get(id))})`);
      if (!ok) continue;
      seen.set(id, file);
      files.set(id, file);
      if (order !== undefined) orders.set(order, file);
      prompts.push({
        id,
        group,
        label,
        channel,
        where,
        ...(placeholders ? { placeholders } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(disabled ? { enabled: false } : {}),
        // Disabled registers blank: exactly what a blank override does.
        text: disabled ? "" : body,
      });
    }
  }
  prompts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return prompts;
}

/** The 1-core-system prompt ids in `order`, the sequence that opens the system prompt. */
function coreOrderOf(prompts) {
  return prompts
    .filter((p) => p.order !== undefined)
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id);
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

// ---------------------------------------------------------------------------
// BEHAVIOUR (brain/behavior.json)
//
// BEHAVIOR_SPEC is the one definition of every knob: its type, its range and a
// doc string. It holds NO values — the values live only in brain/behavior.json,
// so no knob is defined twice. render() emits it three ways: the BrainBehavior
// interface (and BrainBehaviorOverrides, the deep partial overdrive.overrides
// takes), BRAIN_BEHAVIOR (the validated file) and BRAIN_BEHAVIOR_SPEC (the flat
// rules as data). engine/protocol/src/brain.ts validates the runtime seam
// (EngineOptions.behavior) against BRAIN_BEHAVIOR_SPEC with behaviorProblems(),
// a line-for-line twin of the checker below, which runs on the same flat data.
// ---------------------------------------------------------------------------

class Section {
  constructor(doc, fields) {
    this.doc = doc;
    this.fields = fields;
  }
}

class Rule {
  constructor(props) {
    Object.assign(this, props);
  }
}

const section = (doc, fields) => new Section(doc, fields);
const bool = (doc) => new Rule({ type: "bool", doc });
const int = (min, max, doc) => new Rule({ type: "int", min, max, doc });
const oneOf = (values, doc) => new Rule({ type: "enum", values, doc });
/** A list of unique strings, each matching `item` (a RegExp, emitted as { source, flags }), `min..max` entries. */
const list = (item, min, max, doc) => new Rule({ type: "list", item, min, max, doc });
/** A deep partial of the named top-level sections (overdrive.overrides). */
const overridesOf = (sections, doc) => new Rule({ type: "overrides", sections, doc });

const EXTENSION = /^\.[a-z0-9+_-]+$/;
const WORD = /^[a-z0-9][a-z0-9._-]*$/;
const GUARD = ["run", "refuse"];

/** Top-level sections overdrive.overrides may change. `overdrive` itself is not one: OVERDRIVE cannot override itself. */
const OVERRIDABLE = ["finishing", "stall", "reminders", "clarify", "context", "tools", "evidence"];

export const BEHAVIOR_SPEC = section("The behaviour knobs the engine reads.", {
  finishing: section(
    "The end-of-turn ladder (session.ts runTurn, finishing.ts): which rungs run and how far they push. The ladder's order, its end_turn requirement and the DONE sentinel stay in code.",
    {
      nudgeBudget: int(
        0,
        10,
        "Per-turn budget shared by the error-recovery nudge (rung 4, reminder.recovery-nudge) and the wrap-up nudge (rung 9, reminder.wrapup-nudge). 0 switches both off. Finite so a model that keeps failing cannot loop the turn.",
      ),
      maxNamedFiles: int(1, 50, "How many changed files the runtime-evidence, browser-evidence and self-verify closing texts name before they write ' and N more'."),
      lengthCutoff: section("Rung 3: a response stopped at the output-token limit (settings.maxTokensPerResponse decides how often that happens).", {
        enabled: bool(
          "false: a text answer cut off at the output limit ends the turn as delivered instead of being resumed with reminder.length-continuation. A cut-off tool call is still refused with reminder.tool-cutoff (floor). Never affects the resume after a context-overflow compaction.",
        ),
        maxStreak: int(
          0,
          10,
          "Consecutive output-limit cutoffs a turn resumes (text) or rides through (tool calls) before it ends visibly. 0: the first cutoff ends the turn. Never affects the resume after a context-overflow compaction.",
        ),
      }),
      errorRecovery: section("Rung 4: the turn is ending right after a failed tool batch.", {
        enabled: bool(
          "false: such a turn is not nudged with reminder.recovery-nudge. The failed-batch flag is then never spent, so rungs 5 and 9 also skip that end, as they always do while it is set.",
        ),
      }),
      incompleteTasks: section("Rung 5: a clean end while tasks are still pending or in_progress.", {
        maxNudges: int(0, 3, "How many times per turn reminder.incomplete-tasks may fire. 0 switches the rung off."),
      }),
      runtimeEvidence: section("Rung 6: changed source that was never run, or ran only against the agent's own test doubles.", {
        maxNudges: int(0, 3, "How many times per turn finishing.runtime-evidence may fire. 0 switches the rung off."),
      }),
      browserEvidence: section("Rung 7: changed UI files that were never driven in a browser or seen in a screenshot.", {
        maxNudges: int(0, 3, "How many times per turn finishing.browser-evidence may fire. 0 switches the rung off."),
      }),
      selfVerify: section("Rung 8: the silent DONE-or-continue self-check (finishing.self-verify). Root sessions only: a subagent child never self-verifies, whatever these say.", {
        maxRounds: int(
          0,
          3,
          "Self-check rounds per turn. 0 switches the rung off. Steering re-arms the count. Ships 0 here and 1 in overdrive.overrides, which is today's 'self-verify only in OVERDRIVE'.",
        ),
        minToolCalls: int(0, 1000, "The least tool calls a turn must make before it is self-verified. 0 lets a turn with no tool calls self-verify too."),
        maxSymptoms: int(0, 20, "How many of the latest failures the agent reported the self-check quotes back (finishing.self-verify.symptoms). 0 drops that clause."),
        maxHedges: int(0, 20, "How many hedging sentences of the final answer the self-check quotes (finishing.self-verify.hedges). 0 drops that clause."),
      }),
      wrapUp: section("Rung 9: a bare final reply after substantial tool work gets reminder.wrapup-nudge (spends nudgeBudget).", {
        enabled: bool("false: a short final answer is never asked for a summary."),
        minToolCalls: int(0, 1000, "The least tool calls in a turn before a short final answer counts as a missing wrap-up."),
        answerShorterThanChars: int(0, 100000, "A final answer shorter than this many characters, after minToolCalls tool calls, gets the wrap-up nudge. 0: never."),
      }),
    },
  ),
  stall: section(
    "The stall detector (identical rounds: same calls, same results). It always runs: it is the only brake on a looping uncapped root turn. Each value either reminds or asks; none can loop.",
    {
      repeatRounds: int(2, 10, "How many identical rounds in a row count as a stall."),
      pivots: int(0, 5, "How many stalls get reminder.stall-pivot before every later stall gets reminder.stall-ask. The status line shows n/pivots."),
    },
  ),
  reminders: section("In-turn reminders the session injects on its own.", {
    planFirst: section("reminder.plan-first, at turn start while the task board is empty.", {
      enabled: bool("false: no turn-start nudge to lay out multi-step work with TaskCreate. Applies to child sessions exactly as to the root."),
    }),
    errorBatch: section("reminder.error-batch, after a tool batch with a failure.", {
      enabled: bool("false: failed batches carry no 'fix and continue' reminder. The failure itself is still reported in each tool_result."),
    }),
    silentReasoning: section("reminder.silent-reasoning, root sessions only.", {
      enabled: bool("false: long silent reasoning never asks for a sentence to the user."),
      thresholdChars: int(500, 1000000, "Characters of reasoning with no visible text before the reminder fires (once per silent stretch)."),
    }),
  }),
  clarify: section(
    "The clarify pre-layer: one side call before an open-ended request decides whether to ask shape questions first. Root sessions only, never with a named addon.",
    {
      enabled: bool("ANDed with the per-user settings.clarify, so brain can only switch clarify OFF, never force it on."),
      maxQuestions: int(1, 5, "How many of the verdict's questions are put to the user (AskUserQuestion takes at most 5)."),
      model: oneOf(["main", "small"], "Which configured model judges: main = settings.model, small = settings.smallModel (falling back to settings.model)."),
      skim: section("The 'Codebase overview' sent with the clarify call.", {
        enabled: bool("false: the clarify call gets no overview — cheaper and less grounded."),
        peekFiles: list(
          /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/,
          0,
          20,
          "Overview files the peek reads, richest first, when the import graph parses nothing. Bare file names in the workspace root.",
        ),
      }),
    },
  ),
  context: section("Context-window pressure. WHEN compaction fires stays the user's settings (compactionThreshold, contextWindow).", {
    overflowRecoveries: int(0, 5, "Compact-and-retry attempts per turn after a context overflow. 0: the first overflow errors out. Each costs a summarizer pass."),
    compaction: section("What a compaction keeps.", {
      keepTailMessages: int(1, 50, "Recent messages an automatic compaction keeps verbatim. The walk-back that keeps tool_use/tool_result pairs whole stays in code."),
      forceKeepTailMessages: int(1, 50, "Recent messages /compact and overflow recovery keep verbatim. Never more than keepTailMessages."),
    }),
  }),
  tools: section("Tool results.", {
    defaultOutputBytes: int(
      1000,
      1000000,
      "Byte cap on a tool result (head and tail kept) for a tool with no outputByteLimit of its own. Per-tool limits (Read's 250000) stay tool code.",
    ),
  }),
  evidence: section(
    "The plain-word detector lists the evidence rungs judge by. Entries are plain text, never regex: list entries are escaped and joined, so no entry can make a pattern catastrophic.",
    {
      codeExtensions: list(EXTENSION, 1, 200, "Suffixes (lower-case, leading dot) that mark a changed file as runnable source, for rung 6 and self-verify's closing-code clause."),
      uiExtensions: list(EXTENSION, 0, 100, "Suffixes of the files a user sees in a browser, for rung 7. Empty: rung 7 never fires."),
      uiExcludeInfixes: list(/^[a-z0-9_-]+$/, 0, 20, "Infixes that mark a UI file as a test or story, never the page (name.<infix>.ext). Empty: nothing excluded."),
      testDoubleMarkers: list(
        /^[^\r\n]{1,200}$/,
        0,
        500,
        "Plain substrings that mark written code as a self-written test double (rung 6's 'only your own doubles ran' shape). Empty: that shape is off.",
      ),
      browserRun: section("What counts as driving a browser (rung 7). Install commands and --version/--help stay code.", {
        tools: list(WORD, 1, 100, "Command words that drive a browser, matched as whole words, case-insensitively."),
        flags: list(/^--?[a-z0-9][a-z0-9-]*$/, 0, 20, "Command flags that drive a browser."),
        readOnlyHeads: list(WORD, 1, 100, "Command heads that only read or print their words (cat playwright.config.ts runs no browser)."),
      }),
      screenshotExtensions: list(/^\.[a-z0-9]+$/, 0, 20, "A successful Read of a file with one of these suffixes counts as having looked at the page."),
    },
  ),
  overdrive: section("What OVERDRIVE does beyond its prompt section (system.overdrive) and availability.json.", {
    overrides: overridesOf(
      OVERRIDABLE,
      "A deep partial of finishing, stall, reminders, clarify, context, tools and evidence, merged over those sections while OVERDRIVE is on (root sessions only). Validated by the same rules; a list replaces the whole list.",
    ),
    preTurnSnapshot: section("The `git stash create` taken before each OVERDRIVE turn (turn_finished.overdriveSnapshot). A failed snapshot never blocks a turn.", {
      enabled: bool("false: no snapshot before OVERDRIVE turns."),
      timeoutMs: int(1000, 120000, "Longest an OVERDRIVE turn waits for the snapshot. Never 0: execFile reads 0 as no timeout."),
    }),
    guards: section(
      "How each guard acts while OVERDRIVE is on: run (unasked, today) or refuse (with its own refusal text). Tighten-only: OVERDRIVE never asks. Deny rules and the kill-by-name refusal are fixed floors with no key.",
      {
        deletions: oneOf(
          GUARD,
          "A deletion at a non-protected path. refuse: refused with reminder.overdrive-deletion-refused, unless an explicit narrow allow rule or a literal grant covers the call. Worktree removal counts as a deletion and is refused too.",
        ),
        protectedDeletions: oneOf(
          GUARD,
          "A deletion of protected .magentra state. Decided before deletions, and its value wins. refuse: refused with reminder.overdrive-deletion-refused; no rule or grant passes it.",
        ),
        protectedEdits: oneOf(
          GUARD,
          "Write or Edit into .magentra/ or a .env file. Decided before outsideWorkspaceEdits, and its value wins. refuse: refused with reminder.overdrive-protected-edit-refused; no rule or grant passes it (a protected decision). Write and Edit only: a shell redirect is not covered.",
        ),
        outsideWorkspaceEdits: oneOf(
          GUARD,
          "Write or Edit outside the workspace. refuse: refused with reminder.overdrive-outside-edit-refused unless an explicit narrow allow rule or a literal grant covers it. Write and Edit only: a shell redirect is not covered.",
        ),
      },
    ),
  }),
});

/** Rules that tie two keys together, checked on the base AND on base + overdrive.overrides. */
export const BEHAVIOR_CROSS_RULES = Object.freeze([
  {
    type: "lte",
    keys: ["context.compaction.forceKeepTailMessages", "context.compaction.keepTailMessages"],
    doc: "A forced compaction (/compact, overflow recovery) exists to free more room than an automatic one, so it never keeps a longer tail.",
  },
]);

/** The spec as data: dotted path → rule (RegExp as { source, flags }), plus the cross rules. What brain.ts validates with. */
function flatSpec(node = BEHAVIOR_SPEC, prefix = "", keys = {}) {
  for (const [name, child] of Object.entries(node.fields)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (child instanceof Section) {
      flatSpec(child, path, keys);
      continue;
    }
    const { type, doc, ...rest } = child;
    const rule = { type };
    if (type === "int") Object.assign(rule, { min: rest.min, max: rest.max });
    if (type === "enum") rule.values = [...rest.values];
    if (type === "list") Object.assign(rule, { item: { source: rest.item.source, flags: rest.item.flags }, min: rest.min, max: rest.max });
    if (type === "overrides") rule.sections = [...rest.sections];
    rule.doc = doc;
    keys[path] = rule;
  }
  return keys;
}

export const BEHAVIOR_SPEC_DATA = Object.freeze({ keys: flatSpec(), cross: BEHAVIOR_CROSS_RULES });

// ---- the checker. brain.ts's behaviorProblems() is its line-for-line twin. --

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v) => JSON.stringify(v) ?? String(v);

/** The direct child names of section `prefix` ("" = root) in the flat spec, in spec order. */
function childrenOf(spec, prefix) {
  const out = [];
  for (const path of Object.keys(spec.keys)) {
    if (prefix !== "" && !path.startsWith(`${prefix}.`)) continue;
    const name = path.slice(prefix === "" ? 0 : prefix.length + 1).split(".")[0];
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function leafProblems(value, rule, shown, out) {
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
    const seen = new Set();
    value.forEach((item, i) => {
      if (typeof item !== "string") out.push(`${shown}[${i}] must be a string (got ${show(item)})`);
      else if (!pattern.test(item)) out.push(`${shown}[${i}]: ${JSON.stringify(item)} does not match /${rule.item.source}/${rule.item.flags}`);
      else if (seen.has(item)) out.push(`${shown} lists ${JSON.stringify(item)} twice`);
      else seen.add(item);
    });
  }
}

/**
 * Checks `value` against section `prefix` of the spec. `shownPrefix` is how
 * the section's path is written in a problem (overrides write theirs under
 * overdrive.overrides). `partial`: missing keys are allowed (an override).
 */
function sectionProblems(spec, value, prefix, shownPrefix, partial, out, only) {
  const shownSelf = shownPrefix === "" ? "the behaviour object" : shownPrefix;
  if (!isObject(value)) {
    out.push(`${shownSelf} must be an object (got ${show(value)})`);
    return;
  }
  const names = childrenOf(spec, prefix).filter((n) => only === undefined || only.includes(n));
  const at = (p, n) => (p === "" ? n : `${p}.${n}`);
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

const getPath = (obj, path) => path.split(".").reduce((o, k) => (isObject(o) ? o[k] : undefined), obj);

/**
 * `patch` merged over `base`: a section merges key by key, anything else — a
 * scalar, a list, the overdrive.overrides object — replaces the whole value.
 */
function mergeBehavior(spec, base, patch, prefix = "") {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    out[key] = spec.keys[path] === undefined && isObject(base[key]) && isObject(value) ? mergeBehavior(spec, base[key], value, path) : value;
  }
  return out;
}

function crossProblems(spec, value, out) {
  for (const rule of spec.cross) {
    if (rule.type === "lte") {
      const [a, b] = rule.keys;
      const va = getPath(value, a);
      const vb = getPath(value, b);
      if (va > vb) out.push(`${a} (${va}) must not be more than ${b} (${vb})`);
    }
  }
}

/**
 * Every problem with a COMPLETE behaviour object, each naming its dotted key:
 * unknown, missing, wrong type, out of range, not in the enum, a bad list
 * entry, then — only when the shape is sound — the cross rules, on the base
 * and on the base with overdrive.overrides merged in.
 */
export function behaviorProblems(value, spec = BEHAVIOR_SPEC_DATA) {
  const out = [];
  sectionProblems(spec, value, "", "", false, out, undefined);
  if (out.length > 0) return out;
  crossProblems(spec, value, out);
  // A rule already broken by the base is not reported again for OVERDRIVE.
  const overdrive = [];
  crossProblems(spec, mergeBehavior(spec, value, getPath(value, "overdrive.overrides")), overdrive);
  for (const p of overdrive) if (!out.includes(p)) out.push(`in OVERDRIVE (overdrive.overrides applied): ${p}`);
  return out;
}

/**
 * A validated behaviour object with its keys in spec order — what
 * BRAIN_BEHAVIOR is written as, whatever order the file used. Inside
 * overdrive.overrides the paths are the base's own.
 */
function canonical(spec, value, prefix = "") {
  const rule = spec.keys[prefix];
  if ((rule !== undefined && rule.type !== "overrides") || !isObject(value)) return value;
  const overrides = rule?.type === "overrides";
  const names = overrides ? childrenOf(spec, "").filter((n) => rule.sections.includes(n)) : childrenOf(spec, prefix);
  const out = {};
  for (const name of names) {
    if (name in value) out[name] = canonical(spec, value[name], overrides || prefix === "" ? name : `${prefix}.${name}`);
  }
  return out;
}

// ---- claims: model-facing prose that states a knob's value ------------------

const GUARD_KEYS = ["deletions", "protectedDeletions", "protectedEdits", "outsideWorkspaceEdits"].map((k) => `overdrive.guards.${k}`);
const allRun = (values) => values.every((v) => v === "run");

/**
 * Prose a prompt sends the model that is only true for some knob values. When
 * the phrase is in the prompt's TEXT (never its `where`, which no model reads)
 * and `holds` is false for the knobs' values, the compiler prints a WARNING —
 * never a failure — naming the prompt file and the phrase to reword. A phrase
 * that is not (or no longer) in the text claims nothing. `stance`: "overdrive"
 * checks base + overdrive.overrides only (the prompt is sent only in OVERDRIVE);
 * "both" checks the base and that.
 */
export const CLAIMS = Object.freeze([
  { prompt: "system.overdrive", stance: "overdrive", phrase: "Every call runs the moment you make it", keys: GUARD_KEYS, holds: allRun },
  { prompt: "system.overdrive", stance: "overdrive", phrase: "Only two things can still stop a call", keys: GUARD_KEYS, holds: allRun },
  { prompt: "system.overdrive", stance: "overdrive", phrase: "deletions at any path", keys: GUARD_KEYS.slice(0, 2), holds: allRun },
  { prompt: "system.overdrive", stance: "overdrive", phrase: "edits to `.magentra` state and `.env` files", keys: [GUARD_KEYS[2]], holds: allRun },
  { prompt: "system.overdrive", stance: "overdrive", phrase: "writes outside the workspace", keys: [GUARD_KEYS[3]], holds: allRun },
  { prompt: "system.harness", stance: "both", phrase: "if an OVERDRIVE section appears, not even on those", keys: GUARD_KEYS.slice(0, 3), holds: allRun },
  { prompt: "system.deletion-policy", stance: "overdrive", phrase: "They run without an extra confirmation prompt", keys: GUARD_KEYS.slice(0, 2), holds: allRun },
  { prompt: "reminder.stall-ask", stance: "both", phrase: "strategy pivots have not produced progress either", keys: ["stall.pivots"], holds: ([pivots]) => pivots >= 1 },
]);

function claimWarnings(behavior, prompts, files, problems) {
  const warnings = [];
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const overdrive = mergeBehavior(BEHAVIOR_SPEC_DATA, behavior, behavior.overdrive.overrides);
  for (const claim of CLAIMS) {
    const prompt = byId.get(claim.prompt);
    if (!prompt || !prompt.text.includes(claim.phrase)) continue;
    const stances = claim.stance === "overdrive" ? [["", overdrive]] : [["", behavior], [" in OVERDRIVE (overdrive.overrides applied)", overdrive]];
    for (const [label, b] of stances) {
      const values = claim.keys.map((k) => getPath(b, k));
      if (claim.holds(values)) continue;
      const where = relative(problems.brainDir, files.get(claim.prompt)).split(sep).join("/");
      const state = claim.keys.map((k, i) => `${k} = ${JSON.stringify(values[i])}`).join(", ");
      warnings.push(`${where}: says "${claim.phrase}", which is not true${label} with ${state} — reword the prompt`);
      break;
    }
  }
  return warnings;
}

/**
 * brain/behavior.json, validated. Required only in `complete` mode (the CLI,
 * so `npm run build`); a partial brain for a one-rule test may omit it.
 */
function compileBehavior(brainDir, problems, complete) {
  const file = join(brainDir, "behavior.json");
  if (!existsSync(file)) {
    if (complete) problems.add(file, "missing file");
    return undefined;
  }
  let data;
  try {
    data = JSON.parse(readText(file, problems));
  } catch (err) {
    problems.add(file, `not valid JSON: ${err.message}`);
    return undefined;
  }
  const found = behaviorProblems(data);
  for (const p of found) problems.add(file, p);
  return found.length ? undefined : canonical(BEHAVIOR_SPEC_DATA, data);
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
 * Compiles a brain folder. Returns `{ problems, warnings, prompts, tools,
 * availability, behavior, coreOrder, source }`; `source` is the generated
 * module text, undefined when there are problems. `warnings` never stop the
 * compile: each is prose that states a knob value the brain no longer has
 * (CLAIMS). `behavior` is brain/behavior.json in spec order; `coreOrder` the
 * 1-core-system ids by `order`.
 *
 * `complete: true` (what the CLI, and so `npm run build`, passes) also requires
 * a folder for every built-in tool, a file for every prompt id the engine's
 * source names, and brain/behavior.json. Without it a partial brain compiles,
 * which is what a test exercising one rule at a time needs.
 */
export function compileBrain(brainDir, { complete = false } = {}) {
  const dir = resolve(brainDir);
  const problems = new Problems(dir);
  if (!isDir(dir)) {
    problems.add(undefined, `brain folder not found: ${dir}`);
    return { problems: problems.list };
  }
  const files = new Map();
  const prompts = compilePrompts(dir, problems, files);
  const tools = compileTools(dir, problems);
  const availability = compileAvailability(dir, problems);
  const behavior = compileBehavior(dir, problems, complete);
  if (complete) completenessProblems(dir, prompts, tools, problems);
  const coreOrder = coreOrderOf(prompts);
  const warnings = behavior ? claimWarnings(behavior, prompts, files, problems) : [];
  const result = { prompts, tools, availability, ...(behavior ? { behavior } : {}), coreOrder, warnings };
  if (problems.list.length) return { problems: problems.list, ...result };
  return { problems: [], ...result, source: render(prompts, tools, availability, behavior, coreOrder) };
}

/** A TypeScript type for one spec node; `optional` writes every key `?:` (the overrides partial). */
function tsTypeOf(node, indent, optional) {
  if (node instanceof Rule) {
    if (node.type === "bool") return "boolean";
    if (node.type === "int") return "number";
    if (node.type === "enum") return node.values.map((v) => JSON.stringify(v)).join(" | ");
    if (node.type === "list") return "readonly string[]";
    return "BrainBehaviorOverrides";
  }
  const pad = "  ".repeat(indent + 1);
  const lines = ["{"];
  for (const [name, child] of Object.entries(node.fields)) {
    lines.push(`${pad}/** ${docOf(child)} */`);
    lines.push(`${pad}readonly ${name}${optional ? "?" : ""}: ${tsTypeOf(child, indent + 1, optional)};`);
  }
  lines.push(`${"  ".repeat(indent)}}`);
  return lines.join("\n");
}

/** One line of JSDoc for a spec node: its range, then its doc string. */
function docOf(node) {
  let range = "";
  if (node instanceof Rule) {
    if (node.type === "int") range = `${node.min}..${node.max}. `;
    if (node.type === "list") range = `${node.min}..${node.max} unique entries matching /${node.item.source}/. `;
  }
  const text = `${range}${node.doc}`;
  if (text.includes("*/")) throw new Error(`behaviour doc contains "*/": ${text}`);
  return text;
}

function renderBehaviorTypes() {
  const overridable = section("", Object.fromEntries(OVERRIDABLE.map((name) => [name, BEHAVIOR_SPEC.fields[name]])));
  return `/** brain/behavior.json — ${BEHAVIOR_SPEC.doc} Generated from BEHAVIOR_SPEC in tools/brain/compile.mjs. */
export interface BrainBehavior ${tsTypeOf(BEHAVIOR_SPEC, 0, false)}

/** overdrive.overrides: a deep partial of the sections OVERDRIVE may change. A list replaces the whole list. */
export interface BrainBehaviorOverrides ${tsTypeOf(overridable, 0, true)}

/** One knob's rule. A list item pattern is a RegExp's { source, flags }. */
export type BrainBehaviorRule =
  | { readonly type: "bool"; readonly doc: string }
  | { readonly type: "int"; readonly min: number; readonly max: number; readonly doc: string }
  | { readonly type: "enum"; readonly values: readonly string[]; readonly doc: string }
  | {
      readonly type: "list";
      readonly item: { readonly source: string; readonly flags: string };
      readonly min: number;
      readonly max: number;
      readonly doc: string;
    }
  | { readonly type: "overrides"; readonly sections: readonly string[]; readonly doc: string };

/** A rule tying two knobs: keys[0] <= keys[1]. */
export interface BrainBehaviorCrossRule {
  readonly type: "lte";
  readonly keys: readonly [string, string];
  readonly doc: string;
}

export interface BrainBehaviorSpec {
  /** Dotted key → its rule, for every leaf of BrainBehavior, in spec order. */
  readonly keys: Readonly<Record<string, BrainBehaviorRule>>;
  readonly cross: readonly BrainBehaviorCrossRule[];
}`;
}

function render(prompts, tools, availability, behavior, coreOrder) {
  const j = (v) => JSON.stringify(v, null, 2);
  const behaviorValue =
    behavior === undefined
      ? "\n// No brain/behavior.json in this (partial) brain, so no BRAIN_BEHAVIOR.\n"
      : `\n/** brain/behavior.json, validated against BRAIN_BEHAVIOR_SPEC, keys in spec order. */\nexport const BRAIN_BEHAVIOR: BrainBehavior = ${j(behavior)};\n`;
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
  /** 1-core-system only: the section's place in the system prompt (BRAIN_CORE_ORDER). */
  readonly order?: number;
  /** Present only as \`enabled: false\`: the prompt registers blank, i.e. switched off. */
  readonly enabled?: false;
  /** The body; "" when \`enabled: false\`. */
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

/** The brain/prompts/1-core-system ids sorted by their \`order:\` — the sections that open the system prompt, in sequence. */
export const BRAIN_CORE_ORDER: readonly string[] = ${j(coreOrder)};

${renderBehaviorTypes()}

/** The behaviour rules as data: what engine/protocol/src/brain.ts validates an override with. */
export const BRAIN_BEHAVIOR_SPEC: BrainBehaviorSpec = ${j(BEHAVIOR_SPEC_DATA)};
${behaviorValue}`;
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
  for (const w of result.warnings ?? []) process.stderr.write(`brain: warning: ${w}\n`);
  if (result.problems.length) {
    process.stderr.write(`brain: ${result.problems.length} problem(s) in ${args.brain}\n`);
    for (const p of result.problems) process.stderr.write(`  ${p}\n`);
    process.exit(1);
  }
  const current = existsSync(args.out) ? readFileSync(args.out, "utf8") : undefined;
  const summary = `${result.prompts.length} prompt(s), ${Object.keys(result.tools).length} tool(s), ${Object.keys(BEHAVIOR_SPEC_DATA.keys).length} behaviour key(s)`;
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
