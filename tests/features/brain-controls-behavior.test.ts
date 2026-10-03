/**
 * `brain-controls-behavior`.
 *
 * brain/behavior.json holds the behaviour knobs the engine used to hard-code —
 * the finishing ladder's rungs and bounds, the stall detector, clarify's
 * limits, what OVERDRIVE does beyond its prompt section (its overrides, its
 * pre-turn snapshot, its tighten-only guards) and the detector lists the
 * evidence rungs judge by. `tools/brain/compile.mjs` validates it against one
 * spec and compiles it into brain.generated.ts with the rest of brain/; the
 * engine reads every value from the resolved behaviour object, and
 * `EngineOptions.behavior` is the one runtime seam (validated by the same
 * emitted spec, never persisted). The last instructional texts still composed
 * in code moved into brain/prompts; their composition through the real engine
 * is checked here against their brain templates, never against copied prose,
 * so rewording a prompt moves no assertion in this file.
 *
 * TWO KINDS, both the record declares:
 *   - `pure` reads the committed brain/, the engine's own source and the
 *     functions of the built engine with a behaviour object handed in: every
 *     key is read and no replaced constant survives (checklist 1), the shipped
 *     values are the constants they replaced (2), the runtime checker is the
 *     compiler's twin (4), and the detector lists rebuild yesterday's
 *     detectors exactly.
 *   - `fs` writes temp brains and temp workspaces: the compiler run on a brain
 *     with one bad value (4), and the real Engine on the scripted provider with
 *     a knob changed in a temp brain copy and compiled by the real compiler,
 *     its `behavior` handed in through `EngineOptions.behavior` (3, 7, 8, 11).
 *     Checklists 9 and 10 relink the built engine's own prompt modules against
 *     the module the compiler generated from a temp brain — the same
 *     brain.generated module `npm run build` would compile, with its types
 *     stripped instead of compiled — so "reordering a file changes the
 *     assembled prompt" is shown on the real assembly code without rebuilding
 *     the tree.
 *
 * WHAT CHECKLIST 2's BYTE-IDENTITY RESTS ON. The in-suite tests prove the
 * shipped values are yesterday's constants and that each rung keeps its bound
 * and its text. That every provider request, every event and every file is
 * byte-identical to the build before this feature is proven by the
 * equivalence recorder (`equivalence.mjs compare <before> <after>`, 70
 * scenarios over the real Engine of both trees), which is dev tooling and not
 * part of `npm test`.
 *
 * WHAT IS FAKED: the model, and only the model (`scriptedEngine.ts`). Every
 * assertion on a session is on what the real Session put into the provider's
 * requests, on the events it emitted, or on the files on disk — never on what
 * the script said.
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { buildSystemPrompt, type PromptEnvironment, type Settings } from "@magentra/core";
import {
  behaviorProblems,
  behaviorWith,
  brainBehavior,
  brainBehaviorSpec,
  effectiveBehavior,
  promptDefault,
  renderPrompt,
  resolveBehavior,
  toolAvailabilityWith,
  type BehaviorOverride,
  type BrainBehavior,
  type BrainBehaviorSpec,
  type CoreEvent,
} from "@magentra/protocol";
import type { Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type FakeToolCall, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "brain-controls-behavior";

/** Verbatim from the record. The base fails every test here if these ever differ. */
const INVARIANT =
  "Every behaviour knob the engine reads comes from brain/behavior.json, the shipped values reproduce the previous behaviour exactly, and changing a value changes that behaviour on the next build.";

const BRAIN_DIR = join(repoRoot(), "brain");
const COMPILER = join(repoRoot(), "tools", "brain", "compile.mjs");

/* ---- the compiler and the built engine's modules, imported as they are ---- */

interface CompiledPrompt {
  readonly id: string;
  readonly text: string;
  readonly order?: number;
  readonly enabled?: false;
}

interface CompileResult {
  readonly problems: readonly string[];
  readonly warnings?: readonly string[];
  readonly prompts?: readonly CompiledPrompt[];
  readonly behavior?: BrainBehavior;
  readonly coreOrder?: readonly string[];
  readonly source?: string;
}

interface Claim {
  readonly prompt: string;
  readonly phrase: string;
  readonly keys: readonly string[];
}

interface CompilerModule {
  compileBrain(dir: string, opts?: { complete?: boolean }): CompileResult;
  behaviorProblems(value: unknown): string[];
  readonly BEHAVIOR_SPEC_DATA: BrainBehaviorSpec;
  readonly CLAIMS: readonly Claim[];
}

/** `tools/brain/compile.mjs`, the real file — plain JS, its exports declared above. */
const compiler = (await import(pathToFileURL(COMPILER).href)) as CompilerModule;

/** The evidence detectors as the built engine compiles them from a behaviour object (engine/core/src/runtime/finishing.ts). */
interface FinishingModule {
  codeFilesAmong(paths: Iterable<string>, b: BrainBehavior): string[];
  uiFilesAmong(paths: Iterable<string>, b: BrainBehavior): string[];
  isScreenshotPath(path: string, b: BrainBehavior): boolean;
  looksLikeBrowserRun(command: string, b: BrainBehavior): boolean;
  looksLikeTestDouble(text: string, b: BrainBehavior): boolean;
  findHedges(text: string, b: BrainBehavior): string[];
}

const finishing = (await import(pathToFileURL(join(repoRoot(), "engine", "core", "dist", "runtime", "finishing.js")).href)) as FinishingModule;

/** A successful compile of `dir`, or a thrown list of the problems that stopped it. */
function compileOk(dir: string, complete = false): CompileResult & { behavior: BrainBehavior; source: string } {
  const result = compiler.compileBrain(dir, { complete });
  if (result.problems.length > 0 || result.source === undefined || result.behavior === undefined) {
    throw new Error(`brain at ${dir} does not compile:\n  ${result.problems.join("\n  ")}`);
  }
  return result as CompileResult & { behavior: BrainBehavior; source: string };
}

/* ---- small helpers ------------------------------------------------------ */

type Bag = Record<string, unknown>;

/** A plain, mutable copy of JSON data. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Sets `path` (dotted) in `obj`, creating the sections on the way. */
function setPath(obj: Bag, path: string, value: unknown): void {
  const keys = path.split(".");
  let at: Bag = obj;
  for (const key of keys.slice(0, -1)) {
    if (typeof at[key] !== "object" || at[key] === null) at[key] = {};
    at = at[key] as Bag;
  }
  at[keys[keys.length - 1]!] = value;
}

function deletePath(obj: Bag, path: string): void {
  const keys = path.split(".");
  let at: Bag = obj;
  for (const key of keys.slice(0, -1)) at = at[key] as Bag;
  delete at[keys[keys.length - 1]!];
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` is `template` with each `{{slot}}` filled by something. */
function fillsTemplate(text: string, template: string): boolean {
  const parts = template.split(/\{\{\w+\}\}/);
  return new RegExp(`^${parts.map(escapeRegExp).join("[\\s\\S]+?")}$`).test(text);
}

/**
 * The slot values `text` fills `template` with, or undefined when it does not
 * fit. Slots named in `fixed` must hold exactly that value.
 */
function templateMatch(text: string, template: string, fixed: Readonly<Record<string, string>> = {}): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = template
    .split(/(\{\{\w+\}\})/)
    .map((part) => {
      const slot = /^\{\{(\w+)\}\}$/.exec(part)?.[1];
      if (slot === undefined) return escapeRegExp(part);
      if (slot in fixed) return escapeRegExp(fixed[slot]!);
      names.push(slot);
      return "([\\s\\S]+?)";
    })
    .join("");
  const found = new RegExp(`^${pattern}$`).exec(text);
  if (!found) return undefined;
  return Object.fromEntries(names.map((name, i) => [name, found[i + 1]!]));
}

/** Every text block of every user message in a history. */
function userTexts(messages: readonly Msg[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])));
}

/** The tool_result text for the call `id` in a history. */
function toolResultText(messages: readonly Msg[], id: string): string {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.toolUseId === id) {
        return typeof block.content === "string" ? block.content : block.content.map((p) => p.text ?? "").join("");
      }
    }
  }
  throw new Error(`no tool_result for ${id} in the history`);
}

/** How many user text blocks of `messages` contain `needle`. */
const countIn = (messages: readonly Msg[], needle: string): number => userTexts(messages).filter((t) => t.includes(needle)).length;

const call = (id: string, name: string, input: unknown): FakeToolCall => ({ id, name, input });
const bash = (id: string, command: string): FakeTurn => ({ toolCalls: [call(id, "Bash", { command, description: "run a command" })] });
const say = (text: string, extra: Partial<FakeTurn> = {}): FakeTurn => ({ text, ...extra });

/** A final answer long enough that the wrap-up rung never mistakes it for a bare reply. */
const FINAL =
  "Summary: the requested change is complete. I described what changed, what was run to check it, and what remains open, in plain words so the user can act on it without reading the transcript.";

/** The `command_output` lines the rungs announce themselves with — unchanged bytes since before this feature. */
const NOTE = {
  nudge: "↻ auto-recovery: nudging the agent to continue after a failed tool call",
  tasks: "↻ tasks incomplete — continuing",
  evidence: "↻ nothing was run — verifying the change for real",
  browser: "↻ the page was never opened in a browser — checking it the way the user will",
  verify: "⚡ overdrive: self-verifying against the original query",
  wrapUp: "↻ requesting a work summary",
  resume: "↻ continuing after output-length cutoff",
  overflowResume: "↻ the response hit the model's context window — compacted older history (1/2), resuming",
  stallAsk: "⚡ still stalled after pivots — asking the user",
  stallPivot: (n: number, of: number): string => `⚡ stall detected — forcing strategy pivot ${n}/${of}`,
} as const;

/** The self-verify rung's injected message opens with its text up to the `{{closing}}` slot (finishing.self-verify). */
const SELF_CHECK = promptDefault("finishing.self-verify").split("{{")[0]!.trim();

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/* ---- the engine's source, comments removed ------------------------------ */

/** Every `.ts` source file under engine/<pkg>/src, repo-relative with `/`. The generated module is data, not a reader. */
function engineSources(): string[] {
  const out: string[] = [];
  const engine = join(repoRoot(), "engine");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && name !== "brain.generated.ts") out.push(relative(repoRoot(), full).split(sep).join("/"));
    }
  };
  for (const pkg of readdirSync(engine).sort()) {
    const src = join(engine, pkg, "src");
    if (existsSync(src) && statSync(src).isDirectory()) walk(src);
  }
  return out;
}

/**
 * A source file as code only: printed back by the TypeScript printer with
 * comments removed, so a knob named in a comment is not mistaken for a read and
 * a constant mentioned in history is not mistaken for a definition. Literals
 * keep their source text (`10_000` stays `10_000`).
 */
function codeOf(file: string): string {
  const text = readFileSync(join(repoRoot(), file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

/* ======================================================================== */
/* pure                                                                      */
/* ======================================================================== */

abstract class BehaviorPureTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ------------------------------------------------------- */

class EveryKeyIsReadByTheEngine extends BehaviorPureTest {
  readonly id = "every-behaviour-key-is-read-by-the-engine-under-its-full-dotted-path";
  readonly whyItExists =
    "a key in behavior.json that no engine code reads is a knob the owner can turn with nothing happening — the build stays green, the value validates, and the behaviour is still the constant in session.ts";

  override run(t: TestRun): void {
    const sources = engineSources().filter((f) => f !== "engine/protocol/src/brain.ts");
    const code = sources.map((f) => ({ file: f, code: codeOf(f) }));
    const spec = brainBehaviorSpec();
    const keys = Object.keys(spec.keys);
    t.assert.ok(keys.length >= 40, `the spec names ${keys.length} keys; behavior.json holds more than forty`);

    for (const key of keys) {
      if (spec.keys[key]!.type === "overrides") {
        // The one key no rung reads directly: it is merged over the base by
        // effectiveBehavior, which the session calls for the stance in force.
        t.assert.ok(
          code.some((c) => c.file.startsWith("engine/core/src/runtime/") && /\beffectiveBehavior\(/.test(c.code)),
          `${key} is applied by effectiveBehavior(), and no runtime file calls it`,
        );
        continue;
      }
      // The full path off a behaviour object — `b.finishing.nudgeBudget`,
      // `this.behavior.overdrive.guards.deletions` — never a destructured leaf.
      const read = new RegExp(`(?:^|[^\\w$])${escapeRegExp(key)}(?![\\w$])`, "m");
      const readers = code.filter((c) => read.test(c.code)).map((c) => c.file);
      t.assert.ok(readers.length > 0, `behaviour key ${key} is read nowhere in engine/*/src — a knob that changes nothing`);
    }
  }
}

/**
 * The constants and literals the knobs replaced, by the file that held them at
 * HEAD 32a5f67. Each must be gone from code, or the knob and the constant are
 * two definitions of one value and the constant wins wherever it is still read.
 */
const REPLACED: readonly { key: string; file: string; gone: readonly string[] }[] = [
  { key: "finishing.nudgeBudget", file: "engine/core/src/runtime/session.ts", gone: ["MAX_AUTO_NUDGES"] },
  { key: "finishing.lengthCutoff.maxStreak", file: "engine/core/src/runtime/session.ts", gone: ["MAX_CUTOFF_STREAK"] },
  { key: "context.overflowRecoveries", file: "engine/core/src/runtime/session.ts", gone: ["MAX_OVERFLOW_RECOVERIES"] },
  { key: "reminders.silentReasoning.thresholdChars", file: "engine/core/src/runtime/session.ts", gone: ["SILENT_REASONING_LIMIT"] },
  { key: "clarify.maxQuestions", file: "engine/core/src/runtime/session.ts", gone: ["CLARIFY_MAX_QUESTIONS"] },
  { key: "clarify.skim.peekFiles", file: "engine/core/src/runtime/session.ts", gone: ["CLARIFY_PEEK_FILES", '"README.txt"'] },
  { key: "tools.defaultOutputBytes", file: "engine/core/src/runtime/session.ts", gone: ["DEFAULT_OUTPUT_LIMIT"] },
  { key: "evidence.screenshotExtensions", file: "engine/core/src/runtime/session.ts", gone: ["jpe?g"] },
  { key: "overdrive.preTurnSnapshot.timeoutMs", file: "engine/core/src/runtime/session.ts", gone: ["timeout: 10_000"] },
  { key: "stall.repeatRounds", file: "engine/core/src/runtime/session.ts", gone: ["identicalRounds >= 2"] },
  { key: "stall.pivots", file: "engine/core/src/runtime/session.ts", gone: ["pivotCount < 2", "/2`"] },
  { key: "context.compaction.keepTailMessages", file: "engine/core/src/runtime/session.ts", gone: ["force ? 2 : 6"] },
  { key: "finishing.wrapUp.minToolCalls", file: "engine/core/src/runtime/session.ts", gone: ["totalToolCallsThisTurn >= 5"] },
  { key: "finishing.wrapUp.answerShorterThanChars", file: "engine/core/src/runtime/session.ts", gone: ["assistantTextLength(assistant) < 150"] },
  { key: "finishing.selfVerify.minToolCalls", file: "engine/core/src/runtime/session.ts", gone: ["totalToolCallsThisTurn > 0"] },
  { key: "finishing.selfVerify.maxSymptoms", file: "engine/core/src/runtime/session.ts", gone: ["reportedSymptoms.length > 6"] },
  { key: "finishing.maxNamedFiles", file: "engine/core/src/runtime/finishing.ts", gone: ["MAX_NAMED_FILES"] },
  { key: "finishing.selfVerify.maxHedges", file: "engine/core/src/runtime/finishing.ts", gone: [".slice(0, 5)"] },
  { key: "evidence.codeExtensions", file: "engine/core/src/runtime/finishing.ts", gone: ["CODE_FILE_EXTENSIONS", '".dart"'] },
  { key: "evidence.uiExtensions", file: "engine/core/src/runtime/finishing.ts", gone: ["UI_FILE_EXTENSIONS"] },
  { key: "evidence.uiExcludeInfixes", file: "engine/core/src/runtime/finishing.ts", gone: ["test|spec|stories"] },
  { key: "evidence.testDoubleMarkers", file: "engine/core/src/runtime/finishing.ts", gone: ["TEST_DOUBLE_MARKERS", '"jest.fn("', '"monkeypatch.setitem"'] },
  { key: "evidence.browserRun.tools", file: "engine/core/src/runtime/finishing.ts", gone: ["BROWSER_RUN", "wkhtmltoimage", "chromedp"] },
  { key: "evidence.browserRun.readOnlyHeads", file: "engine/core/src/runtime/finishing.ts", gone: ["NOT_A_RUN", "|egrep|"] },
];

class NoReplacedConstantSurvives extends BehaviorPureTest {
  readonly id = "no-constant-or-literal-a-knob-replaced-is-still-defined-in-engine-code";
  readonly whyItExists =
    "a knob added beside the constant it was meant to replace leaves two definitions of one value; the brain edit validates and the constant still decides wherever the code was not switched over";

  override run(t: TestRun): void {
    const keys = new Set(Object.keys(brainBehaviorSpec().keys));
    for (const row of REPLACED) {
      t.assert.ok(keys.has(row.key), `${row.key} is a knob in behavior.json`);
      const code = codeOf(row.file);
      for (const literal of row.gone) {
        t.assert.equal(code.includes(literal), false, `${row.file} still holds ${JSON.stringify(literal)}, which ${row.key} replaced`);
      }
    }
    // And no engine file outside the protocol's accessor defines one of the old names again.
    const names = REPLACED.flatMap((r) => r.gone).filter((g) => /^[A-Z_]+$/.test(g));
    for (const file of engineSources()) {
      const code = codeOf(file);
      for (const name of names) t.assert.doesNotMatch(code, new RegExp(`\\b${name}\\b`), `${file} defines or reads ${name}`);
    }
  }
}

/* ---- checklist 2 ------------------------------------------------------- */

/**
 * The values the engine hard-coded at HEAD 32a5f67, each beside the constant
 * or literal it was (session.ts S:, finishing.ts F:). A person updates this
 * table when a knob is changed on purpose.
 */
const PRE_FEATURE: BrainBehavior = {
  finishing: {
    nudgeBudget: 3, // S:99 MAX_AUTO_NUDGES
    maxNamedFiles: 8, // F:113 MAX_NAMED_FILES
    lengthCutoff: { enabled: true, maxStreak: 3 }, // S:1482 unconditional; S:107 MAX_CUTOFF_STREAK
    errorRecovery: { enabled: true }, // S:1510 unconditional
    incompleteTasks: { maxNudges: 1 }, // S:1539 once-per-turn fuse
    runtimeEvidence: { maxNudges: 1 }, // S:1578 once-per-turn fuse
    browserEvidence: { maxNudges: 1 }, // S:1611 once-per-turn fuse
    // S:1643 `totalToolCallsThisTurn > 0 && this.overdrive`, once per turn: off in the
    // attended stance (0 here), one round in OVERDRIVE (overdrive.overrides below).
    selfVerify: { maxRounds: 0, minToolCalls: 1, maxSymptoms: 6, maxHedges: 5 }, // S:1707 `> 6`; F:242 `.slice(0, 5)`
    wrapUp: { enabled: true, minToolCalls: 5, answerShorterThanChars: 150 }, // S:1665-1666
  },
  stall: { repeatRounds: 3, pivots: 2 }, // S:1739 `identicalRounds >= 2`; S:1741 `pivotCount < 2`
  reminders: {
    planFirst: { enabled: true }, // S:1212
    errorBatch: { enabled: true }, // S:1713
    silentReasoning: { enabled: true, thresholdChars: 8000 }, // S:225 SILENT_REASONING_LIMIT
  },
  clarify: {
    enabled: true, // ANDed with settings.clarify (S:1260)
    maxQuestions: 5, // S:2840 CLARIFY_MAX_QUESTIONS
    model: "main", // S:1087 `model: this.settings.model`
    skim: {
      enabled: true, // S:1075 unconditional
      peekFiles: ["README.md", "README", "readme.md", "README.txt", "package.json", "pyproject.toml"], // S:189
    },
  },
  context: {
    overflowRecoveries: 2, // S:114 MAX_OVERFLOW_RECOVERIES
    compaction: { keepTailMessages: 6, forceKeepTailMessages: 2 }, // S:2680 `force ? 2 : 6`
  },
  tools: { defaultOutputBytes: 40_000 }, // S:74 DEFAULT_OUTPUT_LIMIT
  evidence: {
    // F:33 CODE_FILE_EXTENSIONS
    codeExtensions: [
      ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
      ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".m", ".mm", ".swift",
      ".php", ".lua", ".dart", ".ex", ".exs", ".erl", ".hs", ".clj",
      ".sh", ".bash", ".zsh", ".ps1", ".sql",
      ".vue", ".svelte", ".html", ".htm", ".css", ".scss", ".sass", ".less",
    ],
    uiExtensions: [".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".jsx", ".tsx"], // F:76
    uiExcludeInfixes: ["test", "spec", "stories"], // F:85
    // F:61 TEST_DOUBLE_MARKERS
    testDoubleMarkers: [
      "unittest.mock", "MagicMock", "AsyncMock", "mock.patch", "@patch(", "patch.object(",
      "monkeypatch.setattr", "monkeypatch.setitem",
      "jest.mock(", "jest.fn(", "vi.mock(", "vi.fn(", "sinon.stub(", "sinon.fake", "sinon.mock(",
      "class Fake", "class Mock", "class Stub", "class Dummy",
      "def fake_", "def mock_", "def stub_",
    ],
    browserRun: {
      tools: ["playwright", "puppeteer", "selenium", "webdriver", "cypress", "chromedp", "wkhtmltoimage"], // F:92 BROWSER_RUN
      flags: ["--headless", "--screenshot"], // F:92 BROWSER_RUN
      // F:95 NOT_A_RUN
      readOnlyHeads: [
        "cat", "less", "more", "head", "tail", "grep", "egrep", "rg", "ag", "ls", "dir", "find", "echo", "printf",
        "which", "where", "type", "code", "vi", "vim", "nano", "open", "stat", "wc", "file",
      ],
    },
    screenshotExtensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"], // S:2369 `jpe?g`
  },
  overdrive: {
    overrides: { finishing: { selfVerify: { maxRounds: 1 } } }, // S:1643 `&& this.overdrive`
    preTurnSnapshot: { enabled: true, timeoutMs: 10_000 }, // S:1268; S:629 `timeout: 10_000`
    guards: { deletions: "run", protectedDeletions: "run", protectedEdits: "run", outsideWorkspaceEdits: "run" }, // P:266, P:304, P:354
  },
};

class TheShippedValuesAreTheOldConstants extends BehaviorPureTest {
  readonly id = "the-shipped-behaviour-is-the-table-of-constants-the-engine-hard-coded-before";
  readonly whyItExists =
    "moving a constant into a file is where a 3 becomes a 2 or a list loses an entry, and the knob being read correctly then changes behaviour for every user while every structural test stays green";

  override run(t: TestRun): void {
    t.assert.deepEqual(clone(brainBehavior()), clone(PRE_FEATURE), "brain/behavior.json is the pre-feature constant table");
  }
}

class TheGeneratedBehaviourIsAFreshCompile extends BehaviorPureTest {
  readonly id = "the-engines-behaviour-and-spec-are-a-fresh-compile-of-brain-behavior-json";
  readonly whyItExists =
    "the engine carries behavior.json as compiled into brain.generated.ts; a stale generated module, or a runtime spec that is not the compiler's, means an edit to the file changes nothing or validates differently from the build";

  override run(t: TestRun): void {
    const fresh = compileOk(BRAIN_DIR, true);
    t.assert.deepEqual(clone(brainBehavior()), clone(fresh.behavior), "brainBehavior() is what the compiler makes of brain/behavior.json now");
    t.assert.deepEqual(clone(brainBehaviorSpec()), clone(compiler.BEHAVIOR_SPEC_DATA), "the runtime validates against the compiler's own spec, emitted");
    t.assert.equal(Object.isFrozen(brainBehavior()) && Object.isFrozen(brainBehavior().evidence.codeExtensions), true, "the shipped object is deep-frozen: nothing at run time can move a knob");
    t.assert.equal(resolveBehavior(), brainBehavior(), "no override is the shipped singleton itself");
    for (const [key, rule] of Object.entries(brainBehaviorSpec().keys)) {
      t.assert.ok(typeof rule.doc === "string" && rule.doc.trim().length > 0, `${key} carries a doc line for the owner`);
    }
  }
}

/** The pre-feature detectors, written out as HEAD 32a5f67 had them (finishing.ts, session.ts:2369). */
const OLD = {
  code: new Set(PRE_FEATURE.evidence.codeExtensions),
  ui: new Set(PRE_FEATURE.evidence.uiExtensions),
  uiExclude: /\.(?:test|spec|stories)\.[^.\\/]+$/i,
  browserRun: /\b(?:playwright|puppeteer|selenium|webdriver|cypress|chromedp|wkhtmltoimage)\b|--headless\b|--screenshot\b/i,
  notARun: /^(?:cat|less|more|head|tail|grep|egrep|rg|ag|ls|dir|find|echo|printf|which|where|type|code|vi|vim|nano|open|stat|wc|file)$/i,
  install:
    /^(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|remove|rm|uninstall|update|up)\b|pip3?\s+install\b|python3?\s+-m\s+(?:pip|playwright)\s+install\b|(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:-y\s+)?playwright\s+install\b|playwright\s+install\b|brew\s+install\b|apt(?:-get)?\s+install\b)/i,
  screenshot: /\.(?:png|jpe?g|gif|webp|bmp)$/i,
};

const extOf = (path: string): string => {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
};

function oldLooksLikeBrowserRun(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some((segment) => {
    const s = segment.trim().replace(/^(?:sudo|env|time|nohup)\s+/, "");
    if (!OLD.browserRun.test(s)) return false;
    const head = s.split(/\s+/)[0]?.split(/[\\/]/).pop() ?? "";
    if (OLD.notARun.test(head) || OLD.install.test(s)) return false;
    return !/(?:^|\s)--?(?:version|help|v|h)\b/.test(s);
  });
}

class TheDetectorListsRebuildTheOldDetectors extends BehaviorPureTest {
  readonly id = "the-evidence-detectors-built-from-the-shipped-lists-judge-every-sample-as-the-old-ones-did";
  readonly whyItExists =
    "the browser-run, read-only-head, UI-exclude and screenshot detectors are regexes rebuilt from word lists; one escaped hyphen or an extname where a regex was used turns a run into a non-run, and the evidence rung then fires on a turn that already opened the page";

  override run(t: TestRun): void {
    const b = brainBehavior();
    const paths = [
      "src/a.ts", "src/A.TS", "lib/x.py", "y.go", "z.rs", "page.html", "s.CSS", "v.vue", "app.jsx", "t.tsx", "server.js",
      "README.md", "package.json", "config.yaml", "notes.txt", "a.test.tsx", "b.spec.vue", "c.stories.jsx", "d.Test.html",
      "e.test.html.bak", "Makefile", ".bashrc", "run.sh", "q.sql", "w.dart",
    ];
    const oldCode = paths.filter((p) => OLD.code.has(extOf(p)));
    const oldUi = paths.filter((p) => !OLD.uiExclude.test(p) && OLD.ui.has(extOf(p)));
    t.assert.deepEqual(finishing.codeFilesAmong(paths, b), oldCode, "the same files count as runnable source");
    t.assert.deepEqual(finishing.uiFilesAmong(paths, b), oldUi, "the same files count as pages, tests and stories excluded");

    for (const shot of ["a.png", "a.PNG", "b.jpg", "c.jpeg", "d.JPG", "e.gif", "f.webp", "g.bmp", "x.png.txt", ".png", "h.svg", "i.jpe", "j.tiff", "dir/k.Webp", "l.jpgg"]) {
      t.assert.equal(finishing.isScreenshotPath(shot, b), OLD.screenshot.test(shot), `screenshot ${shot}`);
    }
    for (const command of [
      "npx playwright test", "cat playwright.config.ts", "npm install playwright", "chromium --headless --screenshot=x.png http://x",
      "echo --headless", "node run.js --headless", "python -m selenium.run", "wkhtmltoimage a.html a.png", "npx cypress run",
      "playwright --version", "ls && npx cypress run", "grep webdriver x", "foo --screenshotx", "sudo chromedp shot",
      "egrep puppeteer log", "/usr/bin/playwright test", "pip install selenium", "npx playwright install chromium", "Puppeteer-run",
    ]) {
      t.assert.equal(finishing.looksLikeBrowserRun(command, b), oldLooksLikeBrowserRun(command), `browser run: ${command}`);
    }
    for (const text of ["const f = jest.fn();", "from unittest.mock import patch", "class FakeClient:", "def stub_api():", "real code", "sinon.fakeTimers", "mock.patched"]) {
      t.assert.equal(finishing.looksLikeTestDouble(text, b), PRE_FEATURE.evidence.testDoubleMarkers.some((m) => text.includes(m)), `test double: ${text}`);
    }

    // And a list changed through the seam changes the detector it builds (checklist 3, for the detectors).
    t.assert.equal(finishing.isScreenshotPath("b.jpg", behaviorWith({ evidence: { screenshotExtensions: [".png"] } })), false, "a screenshot list without .jpg no longer counts a .jpg");
    t.assert.deepEqual(finishing.codeFilesAmong(["x.py", "y.ts"], behaviorWith({ evidence: { codeExtensions: [".ts"] } })), ["y.ts"]);
    t.assert.equal(finishing.looksLikeBrowserRun("npx cypress run", behaviorWith({ evidence: { browserRun: { tools: ["playwright"] } } })), false);
    t.assert.equal(finishing.looksLikeTestDouble("const f = jest.fn();", behaviorWith({ evidence: { testDoubleMarkers: [] } })), false, "an empty marker list switches the stand-in shape off");
    t.assert.deepEqual(finishing.uiFilesAmong(["a.test.tsx"], behaviorWith({ evidence: { uiExcludeInfixes: [] } })), ["a.test.tsx"]);

    const hedges = "It should work now. It might still fail. It is not verified. It is untested. It could still hang. I am not sure. It may remain broken.";
    t.assert.equal(finishing.findHedges(hedges, b).length, 5, "five hedges quoted, as before");
    t.assert.deepEqual(finishing.findHedges(hedges, behaviorWith({ finishing: { selfVerify: { maxHedges: 2 } } })), finishing.findHedges(hedges, b).slice(0, 2));
  }
}

/* ---- checklist 4, the runtime half ------------------------------------- */

/** One bad behaviour object each: a change to the shipped one, and the dotted key its problem must name. */
const BAD: readonly { label: string; edit: (b: Bag) => void; names: string; asOverride: boolean }[] = [
  { label: "unknown key", edit: (b) => setPath(b, "finishing.nudgeBudgt", 3), names: 'unknown key "finishing.nudgeBudgt"', asOverride: true },
  { label: "missing key", edit: (b) => deletePath(b, "stall.pivots"), names: 'missing key "stall.pivots"', asOverride: false },
  { label: "wrong type", edit: (b) => setPath(b, "finishing.nudgeBudget", "3"), names: "finishing.nudgeBudget must be an integer", asOverride: true },
  { label: "not an integer", edit: (b) => setPath(b, "stall.repeatRounds", 2.5), names: "stall.repeatRounds must be an integer", asOverride: true },
  { label: "out of range", edit: (b) => setPath(b, "finishing.nudgeBudget", 11), names: "finishing.nudgeBudget: 11 is out of range 0..10", asOverride: true },
  { label: "a counter out of range", edit: (b) => setPath(b, "finishing.selfVerify.maxRounds", 4), names: "finishing.selfVerify.maxRounds: 4 is out of range 0..3", asOverride: true },
  { label: "boolean", edit: (b) => setPath(b, "reminders.planFirst.enabled", "yes"), names: "reminders.planFirst.enabled must be true or false", asOverride: true },
  { label: "a guard that would loosen", edit: (b) => setPath(b, "overdrive.guards.deletions", "workspace-only"), names: 'overdrive.guards.deletions: "workspace-only" is not one of', asOverride: true },
  { label: "a guard that would ask", edit: (b) => setPath(b, "overdrive.guards.protectedEdits", "ask"), names: 'overdrive.guards.protectedEdits: "ask" is not one of', asOverride: true },
  { label: "enum", edit: (b) => setPath(b, "clarify.model", "large"), names: 'clarify.model: "large" is not one of', asOverride: true },
  { label: "list item", edit: (b) => setPath(b, "evidence.codeExtensions", [".ts", "TS"]), names: "evidence.codeExtensions[1]", asOverride: true },
  { label: "duplicate", edit: (b) => setPath(b, "evidence.screenshotExtensions", [".png", ".png"]), names: 'evidence.screenshotExtensions lists ".png" twice', asOverride: true },
  { label: "peek file with a separator", edit: (b) => setPath(b, "clarify.skim.peekFiles", ["../secret"]), names: "clarify.skim.peekFiles[0]", asOverride: true },
  { label: "cross rule", edit: (b) => setPath(b, "context.compaction.forceKeepTailMessages", 7), names: "context.compaction.forceKeepTailMessages (7) must not be more than context.compaction.keepTailMessages (6)", asOverride: true },
  { label: "overrides: unknown key", edit: (b) => setPath(b, "overdrive.overrides", { finishing: { nudgeBudgt: 1 } }), names: 'unknown key "overdrive.overrides.finishing.nudgeBudgt"', asOverride: true },
  { label: "overrides: range", edit: (b) => setPath(b, "overdrive.overrides", { finishing: { selfVerify: { maxRounds: 9 } } }), names: "overdrive.overrides.finishing.selfVerify.maxRounds: 9 is out of range 0..3", asOverride: true },
  { label: "overrides: a section that is not overridable", edit: (b) => setPath(b, "overdrive.overrides", { overdrive: { guards: { deletions: "run" } } }), names: 'unknown key "overdrive.overrides.overdrive"', asOverride: true },
  { label: "overrides: cross rule in OVERDRIVE only", edit: (b) => setPath(b, "overdrive.overrides", { context: { compaction: { forceKeepTailMessages: 9 } } }), names: "in OVERDRIVE (overdrive.overrides applied): context.compaction.forceKeepTailMessages (9)", asOverride: true },
  { label: "dropped: turn.capRootTurns", edit: (b) => setPath(b, "turn", { capRootTurns: true }), names: 'unknown key "turn"', asOverride: true },
  { label: "dropped: stall.afterPivots", edit: (b) => setPath(b, "stall.afterPivots", "end"), names: 'unknown key "stall.afterPivots"', asOverride: true },
  { label: "dropped: clarify.maxTokens", edit: (b) => setPath(b, "clarify.maxTokens", 2000), names: 'unknown key "clarify.maxTokens"', asOverride: true },
  { label: "dropped: summary budget", edit: (b) => setPath(b, "context.compaction.summary", { maxTokens: 8192 }), names: 'unknown key "context.compaction.summary"', asOverride: true },
  { label: "dropped: overdrive.selfVerify", edit: (b) => setPath(b, "overdrive.selfVerify", true), names: 'unknown key "overdrive.selfVerify"', asOverride: true },
];

class TheRuntimeCheckerIsTheCompilersTwin extends BehaviorPureTest {
  readonly id = "an-override-is-refused-with-the-compilers-own-words-naming-the-dotted-key";
  readonly whyItExists =
    "EngineOptions.behavior is validated at run time and behavior.json at build time; two checkers that drift let a test or an embedder run a value the build would reject, or reject one it accepts, and an error that does not name the key leaves the owner guessing which line is wrong";

  override run(t: TestRun): void {
    t.assert.deepEqual(behaviorProblems(clone(brainBehavior())), [], "the shipped object is valid");
    for (const bad of BAD) {
      const value = clone(brainBehavior()) as unknown as Bag;
      bad.edit(value);
      const atBuild = compiler.behaviorProblems(value);
      const atRun = behaviorProblems(value);
      t.assert.ok(atBuild.length > 0, `${bad.label}: the compiler accepts it`);
      t.assert.deepEqual(atRun, atBuild, `${bad.label}: the runtime checker does not say what the compiler says`);
      t.assert.ok(atBuild.some((p) => p.includes(bad.names)), `${bad.label}: no problem names ${bad.names}:\n  ${atBuild.join("\n  ")}`);
      if (bad.asOverride) {
        t.assert.throws(
          () => resolveBehavior(value as BehaviorOverride),
          (err: unknown) => err instanceof Error && err.message.startsWith("invalid behaviour override: ") && err.message.includes(bad.names),
          `${bad.label}: resolveBehavior must refuse it, naming ${bad.names}`,
        );
      }
    }
  }
}

/* ---- checklist 7, the pure half ---------------------------------------- */

class OverridesApplyOnlyInOverdrive extends BehaviorPureTest {
  readonly id = "overdrive-overrides-merge-over-the-base-only-when-overdrive-is-on-and-replace-lists-whole";
  readonly whyItExists =
    "the overrides are how brain makes OVERDRIVE push harder than the attended stance; merged into the base they would change every attended turn too, and merged key by key into a list they would leave half of yesterday's list in force";

  override run(t: TestRun): void {
    const base = brainBehavior();
    t.assert.equal(effectiveBehavior(base, false), base, "attended: the base object itself");
    const od = effectiveBehavior(base, true);
    t.assert.equal(od.finishing.selfVerify.maxRounds, 1, "shipped OVERDRIVE self-verifies once");
    t.assert.equal(base.finishing.selfVerify.maxRounds, 0, "the attended base never self-verifies");
    t.assert.equal(effectiveBehavior(base, true), od, "the same object for the same stance, so caches keyed by it hold");
    t.assert.equal(Object.isFrozen(od), true);
    const { overrides: _o, ...odRest } = od.overdrive;
    const { overrides: _b, ...baseRest } = base.overdrive;
    t.assert.deepEqual(clone({ ...od, overdrive: odRest, finishing: { ...od.finishing, selfVerify: base.finishing.selfVerify } }), clone({ ...base, overdrive: baseRest }), "nothing else moves");

    const custom = behaviorWith({ overdrive: { overrides: { finishing: { nudgeBudget: 1 }, evidence: { screenshotExtensions: [".png"] } } } });
    t.assert.equal(custom.finishing.nudgeBudget, 3);
    t.assert.equal(effectiveBehavior(custom, true).finishing.nudgeBudget, 1);
    t.assert.deepEqual([...effectiveBehavior(custom, true).evidence.screenshotExtensions], [".png"], "a list in an override replaces the whole list");
    t.assert.equal(effectiveBehavior(custom, true).finishing.selfVerify.maxRounds, 0, "an override object replaces the shipped overrides whole");
  }
}

/* ---- amendment 6: claims are warnings ---------------------------------- */

class EveryClaimGuardsRealProse extends BehaviorPureTest {
  readonly id = "every-claim-names-a-real-prompt-and-real-knobs-and-the-shipped-brain-warns-about-none";
  readonly whyItExists =
    "a claim on a prompt or a knob that does not exist checks nothing, so moving a guard to refuse could leave 'every call runs' in the OVERDRIVE section with no warning — and a shipped brain that already warns trains the owner to ignore the warning";

  override run(t: TestRun): void {
    const compiled = compileOk(BRAIN_DIR, true);
    t.assert.deepEqual([...(compiled.warnings ?? [])], [], "the shipped brain states no knob value it does not have");
    const ids = new Set((compiled.prompts ?? []).map((p) => p.id));
    t.assert.ok(compiler.CLAIMS.length > 0);
    const keys = new Set(Object.keys(brainBehaviorSpec().keys));
    for (const claim of compiler.CLAIMS) {
      t.assert.ok(ids.has(claim.prompt), `claim on unknown prompt ${claim.prompt}`);
      for (const key of claim.keys) t.assert.ok(keys.has(key), `the claim on ${claim.prompt} reads ${key}, which is not a knob`);
    }
  }
}

/* ======================================================================== */
/* fs                                                                        */
/* ======================================================================== */

abstract class BehaviorFsTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A copy of the shipped brain/ in a temp dir — the brain a person would edit. */
  protected brainCopy(): string {
    const copy = join(this.tempDir("magentra-brain-knob-"), "brain");
    cpSync(BRAIN_DIR, copy, { recursive: true });
    return copy;
  }

  /** behavior.json of `brain` with each dotted key set to its value. */
  protected editBehavior(brain: string, knobs: Readonly<Record<string, unknown>>): void {
    const file = join(brain, "behavior.json");
    const json = JSON.parse(readFileSync(file, "utf8")) as Bag;
    for (const [key, value] of Object.entries(knobs)) setPath(json, key, value);
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }

  /** Replaces the text of prompt `id` in `brain`, keeping its frontmatter. */
  protected setPromptText(brain: string, id: string, text: string): string {
    const prompts = join(brain, "prompts");
    const folder = readdirSync(prompts).find((name) => existsSync(join(prompts, name, `${id}.md`)));
    if (folder === undefined) throw new Error(`no prompt file for ${id} in ${brain}`);
    const file = join(prompts, folder, `${id}.md`);
    const source = readFileSync(file, "utf8");
    const end = source.indexOf("\n---\n", 3) + "\n---\n".length;
    writeFileSync(file, `${source.slice(0, end)}${text}\n`);
    return `${id}.md`;
  }

  /**
   * The behaviour the next build would carry if behavior.json said `knobs`:
   * a temp copy of brain/ edited, then compiled by the real compiler with the
   * build's own `complete` checks.
   */
  protected compiledBehavior(knobs: Readonly<Record<string, unknown>>): BrainBehavior {
    const brain = this.brainCopy();
    this.editBehavior(brain, knobs);
    return compileOk(brain, true).behavior;
  }
}

/* ---- checklist 4, the build half --------------------------------------- */

class TheCompilerRejectsABadValueNamingTheKey extends BehaviorFsTest {
  readonly id = "the-compiler-rejects-an-unknown-key-a-wrong-type-and-an-out-of-range-value-naming-the-key";
  readonly whyItExists =
    "a typo in behavior.json that the build accepted would leave the knob at whatever the code fell back to while the owner believed it changed, and a rejection that does not name the key sends them hunting through a forty-key file";

  override run(t: TestRun): void {
    const cases: readonly { knobs: Record<string, unknown>; names: string }[] = [
      { knobs: { "finishing.nudgeBudgt": 1 }, names: 'unknown key "finishing.nudgeBudgt"' },
      { knobs: { "finishing.nudgeBudget": "1" }, names: "finishing.nudgeBudget must be an integer" },
      { knobs: { "finishing.nudgeBudget": 99 }, names: "finishing.nudgeBudget: 99 is out of range 0..10" },
      { knobs: { "overdrive.guards.deletions": "workspace-only" }, names: 'overdrive.guards.deletions: "workspace-only" is not one of "run", "refuse"' },
    ];
    for (const c of cases) {
      const brain = this.brainCopy();
      this.editBehavior(brain, c.knobs);
      const result = compiler.compileBrain(brain, { complete: true });
      t.assert.equal(result.source, undefined, `${JSON.stringify(c.knobs)} must fail the compile`);
      t.assert.ok(
        result.problems.some((p) => p.includes("behavior.json") && p.includes(c.names)),
        `the problem names behavior.json and ${c.names}:\n  ${result.problems.join("\n  ")}`,
      );
    }

    // Prose that states a knob's value is a WARNING, never a failure (amendment 6).
    // The prose is written into the temp brain from the compiler's own claim
    // table, so this holds whatever the shipped section says.
    const moved = compiler.CLAIMS.find((c) => c.prompt === "system.overdrive" && c.keys.includes("overdrive.guards.deletions"));
    const still = compiler.CLAIMS.find((c) => c.prompt === "system.overdrive" && !c.keys.includes("overdrive.guards.deletions"));
    t.assert.ok(moved && still, "the claim table has a deletion claim and a non-deletion claim on the OVERDRIVE section");
    const brain = this.brainCopy();
    const file = this.setPromptText(brain, "system.overdrive", `${moved!.phrase}.\n${still!.phrase}.`);
    this.editBehavior(brain, { "overdrive.guards.deletions": "refuse" });
    const warned = compiler.compileBrain(brain, { complete: true });
    t.assert.deepEqual([...warned.problems], [], "a claim never fails the build");
    t.assert.notEqual(warned.source, undefined, "the module is still generated");
    const warnings = warned.warnings ?? [];
    t.assert.ok(
      warnings.some((w) => w.includes(file) && w.includes(JSON.stringify(moved!.phrase)) && w.includes("overdrive.guards.deletions") && w.includes("reword the prompt")),
      `the warning names the prompt file, the phrase and the key:\n  ${warnings.join("\n  ")}`,
    );
    t.assert.equal(warnings.some((w) => w.includes(still!.phrase)), false, "a claim on a guard that did not move stays silent");
  }
}

/* ---- the engine on a changed brain --------------------------------------- */

interface Run {
  readonly engine: ScriptedEngine;
  readonly workspace: string;
}

/**
 * The real Engine on the scripted provider, with `behavior` handed in exactly
 * as the next build's brain.generated module would carry it.
 */
abstract class BehaviorEngineTest extends BehaviorFsTest {
  /** Each test boots several engines and runs real tool rounds. */
  override readonly timeoutMs: number = 180_000;

  #engines: ScriptedEngine[] = [];
  #workspaces: string[] = [];
  #isolated = false;

  /** HOME and the prompt-override dir pointed at empty temp dirs, so this machine's settings and overrides cannot move an answer. */
  protected isolate(): void {
    if (this.#isolated) return;
    this.redirectHome();
    this.setEnv("MAGENTRA_PROMPTS_DIR", this.tempDir("magentra-prompts-"));
    this.#isolated = true;
  }

  /**
   * A workspace made outside the kind's own dirs: Bash spawns a real shell
   * there, and on Windows its handle outlives the child by a moment. Closed
   * engines first, then a removal that forgives EPERM/EBUSY (tearDown).
   */
  protected workspaceDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "magentra-knob-ws-"));
    this.#workspaces.push(dir);
    return dir;
  }

  protected async start(opts: {
    turns: readonly FakeTurn[] | ((ws: string) => readonly FakeTurn[]);
    behavior?: BehaviorOverride;
    overdrive?: boolean;
    settings?: Partial<Settings>;
    agent?: boolean;
    permissions?: "allow_once" | "deny";
    setup?: (ws: string) => void;
  }): Promise<Run> {
    this.isolate();
    const workspace = this.workspaceDir();
    opts.setup?.(workspace);
    const turns = typeof opts.turns === "function" ? opts.turns(workspace) : opts.turns;
    const engine = await startScriptedEngine({
      workspace,
      turns: [...turns],
      ...(opts.behavior !== undefined ? { behavior: opts.behavior } : {}),
      ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
      ...(opts.agent ? { toolAvailability: toolAvailabilityWith("Agent") } : {}),
      ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
    });
    this.#engines.push(engine);
    if (opts.overdrive) engine.send({ type: "set_overdrive", enabled: true });
    return { engine, workspace };
  }

  /** The root session's history as it stands after the turn (FakeProvider records the LIVE array). */
  protected history(engine: ScriptedEngine): readonly Msg[] {
    const last = engine.provider.requests[engine.provider.requests.length - 1];
    if (!last) throw new Error("the provider received no request");
    return last.messages as Msg[];
  }

  override async tearDown(): Promise<void> {
    for (const engine of this.#engines) await engine.close();
    this.#engines = [];
    for (const dir of this.#workspaces) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#workspaces = [];
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

/** Four failing rounds, each followed by a bare reply — a model that keeps failing. */
const FAILING_ROUNDS: readonly FakeTurn[] = [
  bash("e1", "exit 3"), say("short"),
  bash("e2", "exit 4"), say("short"),
  bash("e3", "exit 5"), say("short"),
  bash("e4", "exit 6"), say("short"),
  say(FINAL),
];

class ALowerNudgeBudgetStopsSooner extends BehaviorEngineTest {
  readonly id = "a-lower-nudge-budget-in-brain-stops-the-recovery-nudges-sooner";
  readonly whyItExists =
    "the nudge budget is how hard a turn pushes a failing model before it gives up; read from anywhere but the brain, a budget of 1 still burns three extra model calls on a model that cannot recover";

  override async run(t: TestRun): Promise<void> {
    const shipped = await this.start({ turns: FAILING_ROUNDS });
    const a = await shipped.engine.runTurn("Run the checks.");
    t.assert.deepEqual([...a.errors], []);
    t.assert.equal(a.notes.filter((n) => n === NOTE.nudge).length, 3, "shipped: three recovery nudges");
    t.assert.equal(shipped.engine.provider.requests.length, 8, "shipped: four failing rounds and four replies");
    t.assert.equal(countIn(this.history(shipped.engine), promptDefault("reminder.recovery-nudge")), 3);

    const one = await this.start({ turns: FAILING_ROUNDS, behavior: this.compiledBehavior({ "finishing.nudgeBudget": 1 }) });
    const b = await one.engine.runTurn("Run the checks.");
    t.assert.deepEqual([...b.errors], []);
    t.assert.equal(b.notes.filter((n) => n === NOTE.nudge).length, 1, "nudgeBudget 1: one nudge");
    t.assert.equal(one.engine.provider.requests.length, 4, "nudgeBudget 1: the turn ends after the second failing round");
    t.assert.equal(b.stopReason, "end_turn");
  }
}

/** A rung, the script that makes it fire once, and the knobs that switch it off. */
interface RungCase {
  readonly rung: string;
  readonly note: string;
  readonly knobs: Readonly<Record<string, unknown>>;
  readonly turns: (ws: string) => readonly FakeTurn[];
  /** Model calls with the rung firing once, and with it off. */
  readonly requests: readonly [on: number, off: number];
}

const RUNGS: readonly RungCase[] = [
  {
    rung: "error recovery",
    note: NOTE.nudge,
    knobs: { "finishing.errorRecovery.enabled": false },
    turns: () => [bash("x1", "exit 3"), say("short"), say(FINAL)],
    requests: [3, 2],
  },
  {
    rung: "incomplete tasks",
    note: NOTE.tasks,
    knobs: { "finishing.incompleteTasks.maxNudges": 0 },
    turns: () => [{ toolCalls: [call("t1", "TaskCreate", { subject: "Write the parser", description: "parser" })] }, say(FINAL), say(FINAL)],
    requests: [3, 2],
  },
  {
    rung: "runtime evidence",
    note: NOTE.evidence,
    knobs: { "finishing.runtimeEvidence.maxNudges": 0 },
    turns: (ws) => [{ toolCalls: [call("w1", "Write", { file_path: join(ws, "src", "app.ts"), content: "export const answer = 42;\n" })] }, say(FINAL), say(FINAL)],
    requests: [3, 2],
  },
  {
    rung: "runtime evidence, by its code list",
    note: NOTE.evidence,
    knobs: { "evidence.codeExtensions": [".ts"] },
    turns: (ws) => [{ toolCalls: [call("w1", "Write", { file_path: join(ws, "app.py"), content: "answer = 42\n" })] }, say(FINAL), say(FINAL)],
    requests: [3, 2],
  },
  {
    rung: "browser evidence",
    note: NOTE.browser,
    knobs: { "finishing.browserEvidence.maxNudges": 0 },
    turns: (ws) => [
      { toolCalls: [call("w1", "Write", { file_path: join(ws, "index.html"), content: "<h1>hi</h1>\n" })] },
      bash("b1", "echo served on 8080"),
      say(FINAL),
      say(FINAL),
    ],
    requests: [4, 3],
  },
  {
    rung: "wrap-up",
    note: NOTE.wrapUp,
    knobs: { "finishing.wrapUp.enabled": false },
    turns: () => [bash("c1", "echo 1"), bash("c2", "echo 2"), bash("c3", "echo 3"), bash("c4", "echo 4"), bash("c5", "echo 5"), say("ok"), say(FINAL)],
    requests: [7, 6],
  },
];

class ARungSwitchedOffDoesNotFire extends BehaviorEngineTest {
  readonly id = "a-finishing-rung-switched-off-in-brain-does-not-fire-and-costs-no-model-call";
  readonly whyItExists =
    "each rung costs a full-context model call; a rung the owner switched off in behavior.json that still fires is a bill for a behaviour they removed, and one the shipped brain no longer fires is a quiet failure the rung existed to catch";

  override async run(t: TestRun): Promise<void> {
    for (const c of RUNGS) {
      const on = await this.start({ turns: c.turns });
      const a = await on.engine.runTurn("Do the work.");
      t.assert.deepEqual([...a.errors], [], `${c.rung} (shipped): no error`);
      t.assert.equal(a.notes.filter((n) => n === c.note).length, 1, `${c.rung} (shipped): the rung fires once — ${JSON.stringify(a.notes)}`);
      t.assert.equal(on.engine.provider.requests.length, c.requests[0], `${c.rung} (shipped): model calls`);

      const off = await this.start({ turns: c.turns, behavior: this.compiledBehavior(c.knobs) });
      const b = await off.engine.runTurn("Do the work.");
      t.assert.deepEqual([...b.errors], [], `${c.rung} (off): no error`);
      t.assert.equal(b.notes.includes(c.note), false, `${c.rung} (${JSON.stringify(c.knobs)}): the rung must not fire — ${JSON.stringify(b.notes)}`);
      t.assert.equal(off.engine.provider.requests.length, c.requests[1], `${c.rung} (off): one model call fewer`);
      t.assert.equal(b.stopReason, "end_turn");
    }
  }
}

class ARungCounterAboveOneFiresAgain extends BehaviorEngineTest {
  readonly id = "a-rung-counter-raised-in-brain-fires-the-rung-that-many-times-in-one-turn";
  readonly whyItExists =
    "the once-per-turn fuses became counters so the owner can push harder from brain; a counter read as a boolean would cap every rung at one firing whatever the file says";

  override async run(t: TestRun): Promise<void> {
    const turns = [{ toolCalls: [call("t1", "TaskCreate", { subject: "Write the parser", description: "parser" })] }, say(FINAL), say(FINAL), say(FINAL)];
    const twice = await this.start({ turns, behavior: this.compiledBehavior({ "finishing.incompleteTasks.maxNudges": 2 }) });
    const turn = await twice.engine.runTurn("Plan the work.");
    t.assert.deepEqual([...turn.errors], []);
    t.assert.equal(turn.notes.filter((n) => n === NOTE.tasks).length, 2, "maxNudges 2: two incomplete-task nudges");
    t.assert.equal(twice.engine.provider.requests.length, 4);
  }
}

/* ---- checklist 3 (OVERDRIVE self-verify) and amendment 2 ---------------- */

class OverdriveSelfVerifyOffRunsNoSilentRound extends BehaviorEngineTest {
  readonly id = "overdrive-self-verify-off-in-brain-runs-no-silent-round-and-its-counter-sets-the-rounds";
  readonly whyItExists =
    "the silent self-check is one hidden model call per OVERDRIVE turn; switched off in brain it must cost nothing and announce nothing, and raised it must really run again — otherwise the owner cannot tune the one rung that only autonomous runs pay for";

  override async run(t: TestRun): Promise<void> {
    const setup = (ws: string): void => writeFileSync(join(ws, "a.txt"), "alpha\n");
    const turns = (ws: string): FakeTurn[] => [{ toolCalls: [call("r1", "Read", { file_path: join(ws, "a.txt") })] }, say(FINAL), say("One more look: all fine."), say("DONE")];

    const shipped = await this.start({ turns, setup, overdrive: true });
    const a = await shipped.engine.runTurn("Check a.txt.");
    t.assert.deepEqual([...a.errors], []);
    t.assert.equal(a.notes.filter((n) => n === NOTE.verify).length, 1, "shipped OVERDRIVE: one self-verify round");
    t.assert.equal(shipped.engine.provider.requests.length, 3);
    t.assert.equal(countIn(this.history(shipped.engine), SELF_CHECK), 1);

    const off = await this.start({ turns, setup, overdrive: true, behavior: this.compiledBehavior({ "overdrive.overrides": {} }) });
    const b = await off.engine.runTurn("Check a.txt.");
    t.assert.deepEqual([...b.errors], []);
    t.assert.equal(b.notes.includes(NOTE.verify), false, "no self-verify status line");
    t.assert.equal(off.engine.provider.requests.length, 2, "no silent round: the turn ends on the answer");
    t.assert.equal(countIn(this.history(off.engine), SELF_CHECK), 0);

    const two = await this.start({ turns, setup, overdrive: true, behavior: this.compiledBehavior({ "overdrive.overrides": { finishing: { selfVerify: { maxRounds: 2 } } } }) });
    const c = await two.engine.runTurn("Check a.txt.");
    t.assert.deepEqual([...c.errors], []);
    t.assert.equal(c.notes.filter((n) => n === NOTE.verify).length, 2, "maxRounds 2: a second round after a reply that was not DONE");
    t.assert.equal(two.engine.provider.requests.length, 4);
  }
}

class AChildNeverSelfVerifies extends BehaviorEngineTest {
  readonly id = "with-self-verify-on-in-the-attended-stance-the-root-verifies-and-a-subagent-child-never-does";
  readonly whyItExists =
    "a subagent's reply is its parent's tool result; a child that self-verified would answer DONE into the parent's context or burn a hidden round per spawn, so the counter applies to root sessions only whatever brain says";

  override async run(t: TestRun): Promise<void> {
    const run = await this.start({
      agent: true,
      behavior: this.compiledBehavior({ "finishing.selfVerify.maxRounds": 1 }),
      turns: [
        { toolCalls: [call("a1", "Agent", { description: "look around", prompt: "Run one check and report.", subagent_type: "general-purpose" })] },
        bash("c1", "echo child"), // the child
        say(FINAL), // the child's answer
        say(FINAL), // the root's answer
        say("DONE"), // the root's self-check
      ],
    });
    const turn = await run.engine.runTurn("Delegate one check.");
    t.assert.deepEqual([...turn.errors], []);
    const requests = run.engine.provider.requests;
    t.assert.equal(requests.length, 5, "root call, two child calls, the root's answer and its one self-check");
    const root = requests[0]!.messages as Msg[];
    const child = requests[1]!.messages as Msg[];
    t.assert.notEqual(child, root, "the second call is the child's own session");
    t.assert.equal(countIn(child, SELF_CHECK), 0, "the child is never self-checked");
    t.assert.equal(countIn(root, SELF_CHECK), 1, "the attended root is, with maxRounds 1");
    t.assert.equal(turn.notes.includes(NOTE.verify), false, "the OVERDRIVE status line stays OVERDRIVE's");
  }
}

/* ---- checklist 7 ------------------------------------------------------- */

class AnOverrideAppliesOnlyWhileOverdriveIsOn extends BehaviorEngineTest {
  readonly id = "a-knob-changed-in-overdrive-overrides-applies-only-while-overdrive-is-on";
  readonly whyItExists =
    "overdrive.overrides is how the owner makes autonomous runs push harder or softer than attended ones; leaking into the attended stance it would change every ordinary turn, and ignored in OVERDRIVE it would be a knob that does nothing";

  override async run(t: TestRun): Promise<void> {
    const behavior = this.compiledBehavior({ "overdrive.overrides": { finishing: { nudgeBudget: 1 } } });

    const attended = await this.start({ turns: FAILING_ROUNDS, behavior });
    const a = await attended.engine.runTurn("Run the checks.");
    t.assert.equal(a.notes.filter((n) => n === NOTE.nudge).length, 3, "attended: the base budget of three");
    t.assert.equal(attended.engine.provider.requests.length, 8);

    const od = await this.start({ turns: FAILING_ROUNDS, behavior, overdrive: true });
    const b = await od.engine.runTurn("Run the checks.");
    t.assert.equal(b.notes.filter((n) => n === NOTE.nudge).length, 1, "OVERDRIVE: the override's budget of one");
    t.assert.equal(b.notes.includes(NOTE.verify), false, "and the override object replaced the shipped one whole: no self-verify round");
    t.assert.equal(od.engine.provider.requests.length, 4);
  }
}

/* ---- the stall detector ------------------------------------------------ */

class TheStallDetectorReadsBrain extends BehaviorEngineTest {
  readonly id = "the-stall-detector-takes-its-repeat-threshold-and-pivot-count-from-brain";
  readonly whyItExists =
    "the stall detector is the only brake on an uncapped root turn that repeats itself; its threshold and pivot count read from anywhere but brain would leave the owner unable to make it brake sooner, and a shipped value off by one changes when every looping turn is told to stop";

  override async run(t: TestRun): Promise<void> {
    const turns = [...Array.from({ length: 9 }, (_, i) => bash(`s${i}`, "echo same")), say("done"), say(FINAL)];

    const shipped = await this.start({ turns });
    const a = await shipped.engine.runTurn("Find the bug.");
    t.assert.deepEqual(
      a.notes.filter((n) => n.startsWith("⚡")),
      [NOTE.stallPivot(1, 2), NOTE.stallPivot(2, 2), NOTE.stallAsk, NOTE.stallAsk],
      "shipped: a stall on the third identical round and every second one after, two pivots, then ask",
    );

    const noPivots = await this.start({ turns, behavior: this.compiledBehavior({ "stall.pivots": 0 }) });
    const b = await noPivots.engine.runTurn("Find the bug.");
    t.assert.deepEqual(b.notes.filter((n) => n.startsWith("⚡")), Array(4).fill(NOTE.stallAsk), "pivots 0: ask from the first stall");

    const sooner = await this.start({ turns, behavior: this.compiledBehavior({ "stall.repeatRounds": 2 }) });
    const c = await sooner.engine.runTurn("Find the bug.");
    t.assert.deepEqual(
      c.notes.filter((n) => n.startsWith("⚡")),
      [NOTE.stallPivot(1, 2), NOTE.stallPivot(2, 2), ...Array(6).fill(NOTE.stallAsk)],
      "repeatRounds 2: every repeated round from the second on is a stall",
    );
  }
}

/* ---- the length-cutoff knobs, and checklist 11 -------------------------- */

class TheCutoffKnobsBoundTheResume extends BehaviorEngineTest {
  readonly id = "the-length-cutoff-knobs-bound-the-resume-and-never-stop-the-context-overflow-resume";
  readonly whyItExists =
    "a recovered context overflow resumes through the cutoff rung; a lengthCutoff setting that also governed it would compact the history, tell the user it is resuming, and then end the turn — losing the answer the compaction was for";

  override async run(t: TestRun): Promise<void> {
    const cutoff = { stopReason: "max_tokens" as const };
    const turns = [say("part one", cutoff), say("part two", cutoff), say("part three", cutoff), say("part four", cutoff), say(FINAL)];
    const resumes = (notes: readonly string[]): number => notes.filter((n) => n === NOTE.resume).length;

    const shipped = await this.start({ turns });
    const a = await shipped.engine.runTurn("Write a long essay.");
    t.assert.equal(resumes(a.notes), 3, "shipped: three resumes, the fourth cutoff ends the turn");
    t.assert.equal(shipped.engine.provider.requests.length, 4);

    const one = await this.start({ turns, behavior: this.compiledBehavior({ "finishing.lengthCutoff.maxStreak": 1 }) });
    const b = await one.engine.runTurn("Write a long essay.");
    t.assert.equal(resumes(b.notes), 1, "maxStreak 1: one resume");
    t.assert.equal(one.engine.provider.requests.length, 2);

    const offKnobs = { "finishing.lengthCutoff.enabled": false, "finishing.lengthCutoff.maxStreak": 0 };
    const off = await this.start({ turns, behavior: this.compiledBehavior(offKnobs) });
    const c = await off.engine.runTurn("Write a long essay.");
    t.assert.equal(resumes(c.notes), 0, "enabled false: a cut-off answer is not resumed");
    t.assert.equal(off.engine.provider.requests.length, 1);

    // Checklist 11: the overflow-driven resume holds with the cutoff resume switched off.
    const overflow = await this.start({
      behavior: this.compiledBehavior(offKnobs),
      turns: [say(FINAL), say("partial answer", { stopReason: "context_overflow" }), say("Summary: the first exchange."), say(FINAL)],
    });
    await overflow.engine.runTurn("First question.");
    await overflow.engine.engine.idle(); // turn_finished precedes the busy flag clearing
    const d = await overflow.engine.runTurn("Second question.");
    t.assert.deepEqual([...d.errors], []);
    t.assert.ok(d.notes.includes(NOTE.overflowResume), `the overflow is compacted: ${JSON.stringify(d.notes)}`);
    const requests = overflow.engine.provider.requests;
    t.assert.equal(requests.length, 4, "the answer, the overflowing call, the summarizer, and the resumed call");
    t.assert.equal(requests[2]!.tools.length, 0, "the third call is the summarizer (no tools), so the script is aligned");
    t.assert.equal(countIn(this.history(overflow.engine), promptDefault("reminder.length-continuation")), 1, "the turn was resumed after the compaction");
    t.assert.equal(d.stopReason, "end_turn");
  }
}

/* ---- the remaining knobs, one engine each -------------------------------- */

class TheSmallerKnobsChangeWhatTheyName extends BehaviorEngineTest {
  readonly id = "plan-first-error-batch-clarify-overflow-recoveries-and-output-bytes-follow-brain";
  readonly whyItExists =
    "each of these was a literal in session.ts; a knob that validates and is read but is applied in the wrong place — the error reminder still pushed, a fourth clarify question still asked, the overflow still retried — would pass every structural test";

  override async run(t: TestRun): Promise<void> {
    const planFirst = promptDefault("reminder.plan-first");
    const errorBatch = promptDefault("reminder.error-batch");

    // reminders.planFirst / reminders.errorBatch
    const shipped = await this.start({ turns: [bash("x1", "exit 3"), say(FINAL), say(FINAL)] });
    await shipped.engine.runTurn("Run it.");
    t.assert.ok(countIn(this.history(shipped.engine), planFirst) >= 1, "shipped: the plan-first reminder rides on the first message");
    t.assert.ok(countIn(this.history(shipped.engine), errorBatch) >= 1, "shipped: a failed batch carries the error-batch reminder");
    const quiet = await this.start({
      turns: [bash("x1", "exit 3"), say(FINAL), say(FINAL)],
      behavior: this.compiledBehavior({ "reminders.planFirst.enabled": false, "reminders.errorBatch.enabled": false }),
    });
    await quiet.engine.runTurn("Run it.");
    t.assert.equal(countIn(this.history(quiet.engine), planFirst), 0, "planFirst off: no plan-first reminder");
    t.assert.equal(countIn(this.history(quiet.engine), errorBatch), 0, "errorBatch off: no error-batch reminder");

    // clarify.enabled can only switch clarify OFF; clarify.maxQuestions caps the questions.
    const verdict = JSON.stringify({
      clarify: true,
      questions: ["One", "Two", "Three", "Four"].map((q) => ({ question: `${q}?`, header: q, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] })),
    });
    const noClarify = await this.start({ settings: { clarify: true }, turns: [say(FINAL)], behavior: this.compiledBehavior({ "clarify.enabled": false }) });
    await noClarify.engine.runTurn("Build me a game.");
    t.assert.equal(noClarify.engine.provider.requests.length, 1, "clarify.enabled false: no clarify call even with settings.clarify on");
    t.assert.ok(noClarify.engine.provider.requests[0]!.tools.length > 0, "the one call is the turn's own");

    for (const [max, behavior] of [[4, undefined], [1, this.compiledBehavior({ "clarify.maxQuestions": 1 })]] as const) {
      const run = await this.start({ settings: { clarify: true }, turns: [say(verdict), say(FINAL)], ...(behavior ? { behavior } : {}) });
      run.engine.send({ type: "user_message", text: "Build me a game." });
      const asked = await run.engine.waitFor((e): e is Extract<CoreEvent, { type: "question_request" }> => e.type === "question_request");
      t.assert.equal(asked.questions.length, max, `clarify.maxQuestions ${max}: that many questions put to the user`);
      run.engine.send({ type: "question_response", id: asked.id, answers: Object.fromEntries(asked.questions.map((_, i) => [`q:${i}`, ["A"]])) });
      await run.engine.waitFor((e) => e.type === "turn_finished");
    }

    // context.overflowRecoveries: a thrown overflow is compacted and retried, or not at all.
    const overflowError = (): Error => Object.assign(new Error("prompt is too long: context length exceeded"), { status: 413 });
    const recovers = await this.start({ turns: [say(FINAL), { error: overflowError() }, say("Summary: the first exchange."), say(FINAL)] });
    await recovers.engine.runTurn("First.");
    await recovers.engine.engine.idle();
    const r = await recovers.engine.runTurn("Second.");
    t.assert.deepEqual([...r.errors], [], "shipped: the overflow is recovered");
    t.assert.equal(recovers.engine.provider.requests.length, 4);
    const gives = await this.start({ turns: [say(FINAL), { error: overflowError() }, say(FINAL)], behavior: this.compiledBehavior({ "context.overflowRecoveries": 0 }) });
    await gives.engine.runTurn("First.");
    await gives.engine.engine.idle();
    const g = await gives.engine.runTurn("Second.");
    t.assert.ok(g.errors.length > 0, "overflowRecoveries 0: the first overflow ends the turn with an error");
    t.assert.equal(gives.engine.provider.requests.length, 2, "and nothing is compacted or retried");

    // tools.defaultOutputBytes caps a tool with no limit of its own.
    const big = `node -e "process.stdout.write('x'.repeat(5000))"`;
    const whole = await this.start({ turns: [bash("o1", big), say(FINAL)] });
    await whole.engine.runTurn("Print it.");
    t.assert.ok(toolResultText(this.history(whole.engine), "o1").includes("x".repeat(5000)), "shipped 40000 bytes: the 5000-byte output is whole");
    const capped = await this.start({ turns: [bash("o1", big), say(FINAL)], behavior: this.compiledBehavior({ "tools.defaultOutputBytes": 1000 }) });
    await capped.engine.runTurn("Print it.");
    const cut = toolResultText(this.history(capped.engine), "o1");
    t.assert.equal(cut.includes("x".repeat(1001)), false, "defaultOutputBytes 1000: the output is cut");
    t.assert.ok(cut.includes("x".repeat(100)), "and keeps its head and tail");
  }
}

/* ---- checklist 8 ------------------------------------------------------- */

const REFUSED = {
  deletion: promptDefault("reminder.overdrive-deletion-refused"),
  protectedEdit: promptDefault("reminder.overdrive-protected-edit-refused"),
  outsideEdit: promptDefault("reminder.overdrive-outside-edit-refused"),
};

const ALL_REFUSE = {
  "overdrive.guards.deletions": "refuse",
  "overdrive.guards.protectedDeletions": "refuse",
  "overdrive.guards.protectedEdits": "refuse",
  "overdrive.guards.outsideWorkspaceEdits": "refuse",
} as const;

class EveryGuardRefusesAndNothingAsks extends BehaviorEngineTest {
  readonly id = "with-every-guard-set-to-refuse-overdrive-never-asks-and-never-runs-the-refused-call";
  readonly whyItExists =
    "OVERDRIVE runs with nobody at the screen; a guard tightened to refuse that asks instead stalls the run on a card nobody answers, and one that runs anyway deletes or overwrites exactly what the owner fenced off";

  override async run(t: TestRun): Promise<void> {
    const outside = this.tempDir("magentra-knob-outside-");
    const behavior = this.compiledBehavior(ALL_REFUSE);
    const run = await this.start({
      overdrive: true,
      behavior,
      setup: (ws) => {
        writeFileSync(join(ws, "notes.txt"), "keep me\n");
        mkdirSync(join(ws, ".magentra"), { recursive: true });
      },
      turns: (ws) => [
        bash("d1", "rm notes.txt"),
        bash("d2", "rm -rf .magentra"),
        { toolCalls: [call("p1", "Write", { file_path: join(ws, ".env"), content: "KEY=1\n" })] },
        { toolCalls: [call("p2", "Write", { file_path: join(ws, ".magentra", "notes.md"), content: "state\n" })] },
        { toolCalls: [call("o1", "Write", { file_path: join(outside, "note.txt"), content: "outside\n" })] },
        bash("k1", "pkill -f magentra-knob-no-such-process"),
        say("Done."),
        say("Done."),
        say("DONE"),
      ],
    });
    const turn = await run.engine.runTurn("Do all the risky things.");
    t.assert.deepEqual([...turn.errors], []);
    t.assert.equal(turn.events.some((e) => e.type === "permission_request"), false, "OVERDRIVE never asks, whatever a guard says");

    const ws = run.workspace;
    t.assert.equal(existsSync(join(ws, "notes.txt")), true, "the refused deletion did not run");
    t.assert.equal(existsSync(join(ws, ".magentra")), true, "the refused protected deletion did not run");
    t.assert.equal(existsSync(join(ws, ".env")), false, "the refused protected edit did not run");
    t.assert.equal(existsSync(join(ws, ".magentra", "notes.md")), false);
    t.assert.equal(existsSync(join(outside, "note.txt")), false, "the refused outside edit did not run");

    const history = this.history(run.engine);
    t.assert.ok(fillsTemplate(toolResultText(history, "d1"), REFUSED.deletion), `d1: ${toolResultText(history, "d1")}`);
    t.assert.ok(fillsTemplate(toolResultText(history, "d2"), REFUSED.deletion), `d2: ${toolResultText(history, "d2")}`);
    t.assert.ok(fillsTemplate(toolResultText(history, "p1"), REFUSED.protectedEdit) && toolResultText(history, "p1").includes(".env"), toolResultText(history, "p1"));
    t.assert.ok(fillsTemplate(toolResultText(history, "p2"), REFUSED.protectedEdit), toolResultText(history, "p2"));
    t.assert.ok(fillsTemplate(toolResultText(history, "o1"), REFUSED.outsideEdit) && toolResultText(history, "o1").includes("note.txt"), toolResultText(history, "o1"));
    t.assert.equal(toolResultText(history, "k1"), promptDefault("reminder.permission-kill-overdrive"), "kill by name stays the fixed floor");

    // The guards are OVERDRIVE's: the attended stance still asks.
    const attended = await this.start({
      behavior,
      permissions: "deny",
      setup: (ws2) => writeFileSync(join(ws2, "notes.txt"), "keep me\n"),
      turns: [bash("d1", "rm notes.txt"), say(FINAL), say(FINAL)],
    });
    const a = await attended.engine.runTurn("Clean up.");
    t.assert.equal(a.events.filter((e) => e.type === "permission_request").length, 1, "attended: the deletion guard asks as before");
  }
}

class AnExplicitAllowPassesOnlyANonProtectedRefusal extends BehaviorEngineTest {
  readonly id = "an-explicit-allow-rule-passes-a-non-protected-refusal-and-never-a-protected-one";
  readonly whyItExists =
    "refuse is a fence the owner puts up for unattended runs, and a narrow allow rule is a gate the user cut in it on purpose; ignoring the rule makes the user's own setting useless, and honouring it for .magentra lets one rule delete the session state the fence protects";

  override async run(t: TestRun): Promise<void> {
    const outside = this.tempDir("magentra-knob-outside-");
    const outsideFile = join(outside, "note.txt");
    const run = await this.start({
      overdrive: true,
      behavior: this.compiledBehavior(ALL_REFUSE),
      settings: { permissions: { allow: ["Bash(rm notes.txt)", "Bash(rm -rf .magentra)", `Write(${outsideFile})`], deny: [], allowExact: [] } } as Partial<Settings>,
      setup: (ws) => {
        writeFileSync(join(ws, "notes.txt"), "delete me\n");
        mkdirSync(join(ws, ".magentra"), { recursive: true });
      },
      turns: [
        bash("d1", "rm notes.txt"),
        bash("d2", "rm -rf .magentra"),
        { toolCalls: [call("o1", "Write", { file_path: outsideFile, content: "outside\n" })] },
        say("Done."),
        say("DONE"),
      ],
    });
    const turn = await run.engine.runTurn("Clean up.");
    t.assert.deepEqual([...turn.errors], []);
    t.assert.equal(turn.events.some((e) => e.type === "permission_request"), false);
    t.assert.equal(existsSync(join(run.workspace, "notes.txt")), false, "the explicit rule passed the deletions refusal");
    t.assert.equal(readFileSync(outsideFile, "utf8"), "outside\n", "the explicit rule passed the outside-edit refusal");
    t.assert.equal(existsSync(join(run.workspace, ".magentra")), true, "the protected refusal wins over an explicit rule");
    t.assert.ok(fillsTemplate(toolResultText(this.history(run.engine), "d2"), REFUSED.deletion), toolResultText(this.history(run.engine), "d2"));
  }
}

/* ---- checklist 5, composed through the real engine ----------------------- */

class TheMovedTextsReachTheModelAsComposedTemplates extends BehaviorEngineTest {
  readonly id = "the-moved-tool-permission-image-and-deletion-policy-texts-reach-the-model-composed-exactly-from-their-brain-templates";
  readonly whyItExists =
    "a moved text can render exactly and still be composed wrongly — the Write note glued to the byte count, the image note without its blank line, the decline with a space before its full stop — and the model reads the composed bytes, not the template";

  override async run(t: TestRun): Promise<void> {
    const outside = this.tempDir("magentra-knob-outside-");
    const run = await this.start({
      permissions: "deny",
      settings: { search: { enabled: false }, permissions: { allow: [], deny: ["Bash(curl *)"], allowExact: [] } } as unknown as Partial<Settings>,
      setup: (ws) => {
        writeFileSync(join(ws, "a.txt"), "alpha\n");
        writeFileSync(join(ws, "notes.txt"), "keep\n");
        writeFileSync(join(ws, "shot.png"), PNG);
      },
      turns: (ws) => [
        bash("s1", "sleep 1"),
        { toolCalls: [call("q1", "WebSearch", { query: "magentra brain" })] },
        { toolCalls: [call("r1", "Read", { file_path: join(ws, "a.txt") })] },
        { toolCalls: [call("w1", "Write", { file_path: join(ws, "a.txt"), content: "beta\n" })] },
        { toolCalls: [call("i1", "Read", { file_path: join(ws, "shot.png") })] },
        bash("c1", "curl -s http://127.0.0.1:9/x"),
        { toolCalls: [call("o1", "Write", { file_path: join(outside, "note.txt"), content: "x\n" })] },
        bash("k1", "pkill -f magentra-knob-no-such-process"),
        bash("d1", "rm notes.txt"),
        { toolCalls: [call("p1", "Write", { file_path: join(ws, ".env"), content: "KEY=1\n" })] },
        say("Done."),
        say(FINAL),
        say(FINAL),
        say(FINAL),
      ],
    });
    const turn = await run.engine.runTurn("Try everything.");
    t.assert.deepEqual([...turn.errors], []);
    const h = this.history(run.engine);
    const ws = run.workspace;

    // Each composed text is its brain template with its slots filled by the
    // engine: a decline with no note fills `{{detail}}` with the bare full stop.
    const declined = (id: string): string => renderPrompt(id, { detail: "." });
    t.assert.equal(toolResultText(h, "s1"), promptDefault("bash.foreground-sleep"));
    t.assert.equal(toolResultText(h, "q1"), promptDefault("websearch.disabled"));
    t.assert.equal(toolResultText(h, "w1"), `File written: ${join(ws, "a.txt")} (5 bytes)\n${promptDefault("write.replaced-note")}`);
    const unseen = templateMatch(toolResultText(h, "i1"), promptDefault("read.image-unseen"), { file: "shot.png" });
    t.assert.ok(unseen?.reason, toolResultText(h, "i1"));
    const reason = unseen!.reason!;
    t.assert.equal(toolResultText(h, "c1"), promptDefault("reminder.permission-rule-denied"));
    t.assert.equal(toolResultText(h, "o1"), declined("reminder.permission-declined"));
    t.assert.equal(toolResultText(h, "k1"), declined("reminder.permission-kill-declined"));
    t.assert.equal(toolResultText(h, "d1"), declined("reminder.permission-deletion-declined"));
    const protectedPath = templateMatch(toolResultText(h, "p1"), promptDefault("reminder.permission-protected-declined"), { detail: "." });
    t.assert.ok(protectedPath?.path?.endsWith(".env"), toolResultText(h, "p1"));

    // An attached image with vision off: the note, a blank line, the typed text.
    await run.engine.engine.idle(); // turn_finished precedes the busy flag clearing
    const before = run.engine.provider.requests.length;
    run.engine.send({ type: "user_message", text: "What is in this picture?", images: [{ name: "pic.png", mediaType: "image/png", data: PNG.toString("base64") }] });
    await run.engine.waitFor((e) => e.type === "turn_finished");
    t.assert.equal(run.engine.provider.requests.length, before + 1);
    t.assert.ok(
      userTexts(this.history(run.engine)).includes(`${renderPrompt("vision.attached-unreadable", { count: 1, reason })}\n\nWhat is in this picture?`),
      "the vision-off note, one blank line, then the typed text",
    );

    // "Allow deletions" on: the deletion-policy section, as brain ships it.
    await run.engine.engine.idle();
    run.engine.send({ type: "set_deletion_guard", enabled: false });
    await run.engine.runTurn("And now?");
    const system = run.engine.provider.requests[run.engine.provider.requests.length - 1]!.system;
    t.assert.ok(system.includes(promptDefault("system.deletion-policy").trim()), "the deletion-policy section is brain's text, whole");
  }
}

/* ---- checklists 9 and 10: the system prompt assembled from a temp brain --- */

interface ProtocolModule {
  readonly PRODUCT_NAME: string;
  readonly PRODUCT_REPO_URL: string;
  coreSectionOrder(): readonly string[];
  renderPrompt(id: string, vars: Record<string, string | number>): string;
  promptText(id: string): string;
  promptTextIfEnabled(id: string): string | undefined;
  renderPromptIfEnabled(id: string, vars: Record<string, string | number>): string | undefined;
  isPromptDisabled(id: string): boolean;
  promptCatalog(): { id: string; currentText: string; disabled: boolean }[];
}

interface CorePromptsModule {
  behaviorCore(): string;
  buildSystemPrompt(opts: { env: PromptEnvironment; addons?: { name: string; description: string }[]; extraSections?: string[] }): string;
  environmentBlock(env: PromptEnvironment): string;
}

interface Assembly {
  readonly protocol: ProtocolModule;
  readonly core: CorePromptsModule;
  readonly coreOrder: readonly string[];
}

const DATA_SECTIONS = ["system.environment", "system.addons-block"];

abstract class AssemblyTest extends BehaviorFsTest {
  /**
   * The built engine's prompt assembly on the module the compiler generated
   * from `brain`: engine/protocol/dist with brain.generated.js replaced by
   * that module (types stripped, as tsc would emit it), and
   * engine/core/dist/agent/prompts.js resolving `@magentra/protocol` to it.
   * Every function is the shipped one; only the brain differs.
   */
  protected async assemble(brain: string): Promise<Assembly> {
    const result = compileOk(brain);
    const root = this.tempDir("magentra-assembly-");
    writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
    const protocolDir = join(root, "node_modules", "@magentra", "protocol");
    cpSync(join(repoRoot(), "engine", "protocol", "dist"), join(protocolDir, "dist"), { recursive: true });
    copyFileSync(join(repoRoot(), "engine", "protocol", "package.json"), join(protocolDir, "package.json"));
    writeFileSync(join(protocolDir, "dist", "brain.generated.js"), stripTypeScriptTypes(result.source));
    mkdirSync(join(root, "core"));
    copyFileSync(join(repoRoot(), "engine", "core", "dist", "agent", "prompts.js"), join(root, "core", "prompts.js"));
    const core = (await import(pathToFileURL(join(root, "core", "prompts.js")).href)) as CorePromptsModule;
    const protocol = (await import(pathToFileURL(join(protocolDir, "dist", "index.js")).href)) as ProtocolModule;
    return { protocol, core, coreOrder: result.coreOrder ?? [] };
  }

  /** Each behaviour section of `a` as it is rendered and trimmed, by id. */
  protected sections(a: Assembly): Map<string, string> {
    const vars = { product: a.protocol.PRODUCT_NAME, repo: a.protocol.PRODUCT_REPO_URL };
    return new Map(a.protocol.coreSectionOrder().filter((id) => !DATA_SECTIONS.includes(id)).map((id) => [id, a.protocol.renderPrompt(id, vars).trim()]));
  }

  /** Rewrites one frontmatter line `key: …` of a prompt file in `brain` (adds it when absent). */
  protected setFrontmatter(brain: string, folder: string, id: string, key: string, value: string): void {
    const file = join(brain, "prompts", folder, `${id}.md`);
    const text = readFileSync(file, "utf8");
    const end = text.indexOf("\n---\n", 3);
    const head = text.slice(0, end).split("\n").filter((line) => !line.startsWith(`${key}:`));
    writeFileSync(file, `${[...head, `${key}: ${value}`].join("\n")}${text.slice(end)}`);
  }

  protected isolatePrompts(dir: string): void {
    this.redirectHome();
    this.setEnv("MAGENTRA_PROMPTS_DIR", dir);
  }
}

/** Any environment will do; one fixed value keeps two renders comparable. */
const ENV: PromptEnvironment = { cwd: "/w", isGitRepo: false, platform: "win32", model: "m", date: "2026-01-01" };

const SHIPPED_CORE_ORDER = [
  "system.identity", "system.harness", "system.communication", "system.action-care", "system.git", "system.code-style",
  "system.tasks", "system.working-method", "system.autonomy", "system.environment", "system.addons-block",
];

class TheCoreSectionsFollowBrainsOrder extends AssemblyTest {
  readonly id = "reordering-adding-or-switching-off-a-core-section-file-changes-the-assembled-system-prompt-and-the-shipped-order-is-the-engines-own";
  readonly whyItExists =
    "which sections open the system prompt and in what order is the agent's description of itself; held in a code list, a brain-only edit to that order or a new section file would compile cleanly and change nothing the model reads";

  override async run(t: TestRun): Promise<void> {
    this.isolatePrompts(this.tempDir("magentra-prompts-"));
    const render = (a: Assembly): string => `${a.core.buildSystemPrompt({ env: ENV }).replace(/\r\n/g, "\n").trimEnd()}\n`;

    // The shipped order, through the relinked assembly, is the engine's own prompt.
    const shipped = await this.assemble(this.brainCopy());
    t.assert.deepEqual([...shipped.coreOrder], SHIPPED_CORE_ORDER, "brain's order: today's sequence");
    t.assert.equal(render(shipped), `${buildSystemPrompt({ env: ENV }).replace(/\r\n/g, "\n").trimEnd()}\n`, "the relinked assembly of the shipped brain is the engine's own");
    const texts = this.sections(shipped);
    const joined = (ids: readonly string[]): string => ids.map((id) => texts.get(id) ?? "").filter((s) => s !== "").join("\n\n");
    const behaviourIds = SHIPPED_CORE_ORDER.filter((id) => !DATA_SECTIONS.includes(id));
    t.assert.equal(shipped.core.behaviorCore(), joined(behaviourIds));

    // Reordered: git moves after tasks.
    const reordered = this.brainCopy();
    this.setFrontmatter(reordered, "1-core-system", "system.git", "order", "75");
    const r = await this.assemble(reordered);
    const moved = behaviourIds.filter((id) => id !== "system.git");
    moved.splice(moved.indexOf("system.tasks") + 1, 0, "system.git");
    t.assert.equal(r.core.behaviorCore(), joined(moved), "the git section now follows the tasks section");
    t.assert.notEqual(render(r), render(shipped));

    // The environment block holds its place in the order too.
    const envFirst = this.brainCopy();
    this.setFrontmatter(envFirst, "1-core-system", "system.environment", "order", "5");
    const e = await this.assemble(envFirst);
    t.assert.deepEqual([...e.coreOrder].slice(0, 2), ["system.environment", "system.identity"]);
    t.assert.ok(render(e).startsWith(e.core.environmentBlock(ENV).trim()), "order 5 opens the prompt with the environment block");

    // A section added in brain alone joins the prompt with no code change.
    const added = this.brainCopy();
    const focus = "Focus:\n- Finish the task the user asked for before suggesting another.";
    writeFileSync(
      join(added, "prompts", "1-core-system", "system.focus.md"),
      `---\nid: system.focus\ngroup: 1 · Core system prompt\nlabel: Focus\nchannel: system\nwhere: A test section.\norder: 55\n---\n${focus}\n`,
    );
    const f = await this.assemble(added);
    const withFocus = [...behaviourIds];
    withFocus.splice(withFocus.indexOf("system.git") + 1, 0, "system.focus");
    t.assert.equal(f.core.behaviorCore(), [...withFocus.map((id) => (id === "system.focus" ? focus : texts.get(id)!))].join("\n\n"), "the new section sits at its order, between git (50) and code style (60)");

    // Switched off in brain (enabled: false), the section leaves the prompt.
    const removed = this.brainCopy();
    this.setFrontmatter(removed, "1-core-system", "system.git", "enabled", "false");
    const g = await this.assemble(removed);
    t.assert.equal(g.core.behaviorCore(), joined(behaviourIds.filter((id) => id !== "system.git")), "no git section, and no blank paragraph where it was");
  }
}

class EnabledFalseIsABlankOverride extends AssemblyTest {
  readonly id = "enabled-false-on-a-prompt-behaves-exactly-like-a-blank-override";
  readonly whyItExists =
    "enabled: false is the brain-only way to switch a prompt off; if it differed from a blank override in any reader — a wrapper still sent, a rung's round still run, a blank paragraph left in the system prompt — the owner's switch would half-work in exactly the places nobody looks";

  override async run(t: TestRun): Promise<void> {
    const ids: readonly [folder: string, id: string][] = [
      ["1-core-system", "system.git"],
      ["3-in-turn-reminders", "reminder.plan-first"],
      ["4-end-of-turn-rungs", "finishing.self-verify"],
    ];

    // The compiler: enabled: false allows an empty body; nothing else does.
    const empty = this.brainCopy();
    const file = join(empty, "prompts", "3-in-turn-reminders", "reminder.plan-first.md");
    const text = readFileSync(file, "utf8");
    const headEnd = text.indexOf("\n---\n", 3) + 5;
    writeFileSync(file, `${text.slice(0, headEnd)}\n`);
    t.assert.ok(compiler.compileBrain(empty).problems.some((p) => p.includes("reminder.plan-first.md")), "an empty body without enabled: false is an error");
    this.setFrontmatter(empty, "3-in-turn-reminders", "reminder.plan-first", "enabled", "false");
    t.assert.deepEqual([...compiler.compileBrain(empty).problems], [], "with enabled: false it compiles");
    const yes = this.brainCopy();
    this.setFrontmatter(yes, "3-in-turn-reminders", "reminder.plan-first", "enabled", "true");
    t.assert.ok(compiler.compileBrain(yes).problems.some((p) => p.includes("only `enabled: false` is accepted")), "enabled: true is refused, not ignored");

    // X: the three switched off in brain. Y: the shipped brain with a blank override for each.
    const disabledBrain = this.brainCopy();
    for (const [folder, id] of ids) this.setFrontmatter(disabledBrain, folder, id, "enabled", "false");
    const x = await this.assemble(disabledBrain);
    const y = await this.assemble(this.brainCopy());

    const blankDir = this.tempDir("magentra-prompts-blank-");
    for (const [, id] of ids) writeFileSync(join(blankDir, `${id}.txt`), "");
    const observe = (a: Assembly): unknown => ({
      core: a.core.behaviorCore(),
      system: a.core.buildSystemPrompt({ env: ENV, extraSections: ["Extra."] }),
      prompts: ids.map(([, id]) => ({
        id,
        text: a.protocol.promptText(id),
        ifEnabled: a.protocol.promptTextIfEnabled(id) ?? null,
        rendered: a.protocol.renderPromptIfEnabled(id, { tasks: "x" }) ?? null,
        disabled: a.protocol.isPromptDisabled(id),
        catalog: (({ currentText, disabled }) => ({ currentText, disabled }))(a.protocol.promptCatalog().find((p) => p.id === id)!),
      })),
    });
    // Each module instance reads the override dir in force on its first read, and caches per id.
    this.isolatePrompts(blankDir);
    const viaOverride = observe(y);
    this.setEnv("MAGENTRA_PROMPTS_DIR", this.tempDir("magentra-prompts-empty-"));
    const viaBrain = observe(x);

    t.assert.deepEqual(viaBrain, viaOverride, "every reader sees enabled: false exactly as it sees a blank override");
    for (const p of (viaBrain as { prompts: { id: string; disabled: boolean; ifEnabled: unknown }[] }).prompts) {
      t.assert.equal(p.disabled, true, `${p.id} is switched off`);
      t.assert.equal(p.ifEnabled, null, `${p.id}: promptTextIfEnabled is undefined, so a call site sends nothing`);
    }
  }
}

/* ---- review follow-ups --------------------------------------------------- */

class OnlyResolvedObjectsPassUnchecked extends BehaviorPureTest {
  readonly id = "resolve-behavior-hands-back-its-own-results-unchanged-and-validates-any-look-alike";
  readonly whyItExists =
    "a subagent child runs with its parent's resolved behaviour; a seam that took any complete-looking object as is would let an out-of-range value into a session unchecked — keepTailMessages 0 crashes compaction, a cutoff streak of 1e9 resumes a cut-off answer without end";

  override run(t: TestRun): void {
    const shipped = brainBehavior();
    t.assert.equal(resolveBehavior(), shipped, "no override is the shipped object");
    t.assert.equal(resolveBehavior(shipped), shipped, "the shipped object comes back as is");
    const tweaked = behaviorWith({ finishing: { nudgeBudget: 1 } });
    t.assert.equal(resolveBehavior(tweaked), tweaked, "an object resolveBehavior returned comes back as is");

    const lookAlike = clone(shipped) as unknown as Bag;
    setPath(lookAlike, "context.compaction.keepTailMessages", 0);
    setPath(lookAlike, "finishing.lengthCutoff.maxStreak", 1e9);
    t.assert.throws(
      () => resolveBehavior(lookAlike as BehaviorOverride),
      /invalid behaviour override: .*context\.compaction\.keepTailMessages: 0 is out of range/,
      "a complete object built elsewhere is validated like any override",
    );
    const copy = clone(tweaked);
    const again = resolveBehavior(copy as BehaviorOverride);
    t.assert.notEqual(again, copy, "a copy is merged, validated and frozen anew");
    t.assert.deepEqual(clone(again), clone(tweaked));
  }
}

class TheDeletionPolicyClaimWarns extends BehaviorFsTest {
  readonly id = "the-deletion-policy-section-warns-when-a-deletion-guard-refuses";
  readonly whyItExists =
    "with Allow deletions on, the deletion-policy section tells the model its deletions run unasked; in OVERDRIVE with a deletion guard on refuse that is false, and an owner who rewords only what the build names would still ship the contradiction";

  override run(t: TestRun): void {
    // The claimed prose is written into each temp brain from the compiler's
    // own claim table, so this holds whatever the shipped section says.
    const claim = compiler.CLAIMS.find((c) => c.prompt === "system.deletion-policy");
    t.assert.ok(claim, "the claim table has a claim on the deletion-policy section");
    for (const key of ["overdrive.guards.deletions", "overdrive.guards.protectedDeletions"]) {
      const brain = this.brainCopy();
      const file = this.setPromptText(brain, "system.deletion-policy", `${claim!.phrase}.`);
      this.editBehavior(brain, { [key]: "refuse" });
      const result = compiler.compileBrain(brain, { complete: true });
      t.assert.deepEqual([...result.problems], [], "a claim never fails the build");
      const warnings = result.warnings ?? [];
      t.assert.ok(
        warnings.some((w) => w.includes(file) && w.includes(JSON.stringify(claim!.phrase)) && w.includes(key)),
        `${key} = refuse: the deletion-policy section is named:\n  ${warnings.join("\n  ")}`,
      );
    }
    const edits = this.brainCopy();
    this.setPromptText(edits, "system.deletion-policy", `${claim!.phrase}.`);
    this.editBehavior(edits, { "overdrive.guards.protectedEdits": "refuse" });
    const quiet = compiler.compileBrain(edits, { complete: true }).warnings ?? [];
    t.assert.equal(quiet.some((w) => w.includes("system.deletion-policy.md")), false, "an edit guard says nothing about deletions");
  }
}

/** Each rung of RUNGS whose own text can be switched off, with that prompt's id. */
const RUNG_PROMPTS: readonly [rung: string, id: string][] = [
  ["error recovery", "reminder.recovery-nudge"],
  ["incomplete tasks", "reminder.incomplete-tasks"],
  ["runtime evidence", "finishing.runtime-evidence"],
  ["browser evidence", "finishing.browser-evidence"],
  ["wrap-up", "reminder.wrapup-nudge"],
];

/** The prompt registry re-reads an override file at most every 250 ms. */
const overrideSettles = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

class ARungWhosePromptIsOffDoesNotFire extends BehaviorEngineTest {
  readonly id = "a-finishing-rung-whose-prompt-is-switched-off-does-not-fire-and-sends-no-blank-message";
  readonly whyItExists =
    "enabled: false (or a blank override) is how an owner switches a reminder off; a rung that still fired would spend the model call the owner removed, and send an empty text block that the Anthropic API rejects";

  override async run(t: TestRun): Promise<void> {
    this.isolate();
    const noBlank = (engine: ScriptedEngine, label: string): void => {
      for (const text of userTexts(this.history(engine))) t.assert.notEqual(text.trim(), "", `${label}: no blank user message is sent`);
    };
    const switchOff = async (id: string): Promise<void> => {
      const dir = this.tempDir("magentra-prompts-off-");
      writeFileSync(join(dir, `${id}.txt`), "");
      this.setEnv("MAGENTRA_PROMPTS_DIR", dir);
      await overrideSettles();
    };

    for (const [rung, id] of RUNG_PROMPTS) {
      const c = RUNGS.find((r) => r.rung === rung)!;
      await switchOff(id);
      const off = await this.start({ turns: c.turns });
      const turn = await off.engine.runTurn("Do the work.");
      t.assert.deepEqual([...turn.errors], [], `${rung} (${id} off): no error`);
      t.assert.equal(turn.notes.includes(c.note), false, `${rung} (${id} off): the rung must not fire — ${JSON.stringify(turn.notes)}`);
      t.assert.equal(off.engine.provider.requests.length, c.requests[1], `${rung} (${id} off): no extra model call`);
      t.assert.equal(turn.stopReason, "end_turn");
      noBlank(off.engine, rung);
    }

    // The resume's text off: a cut-off answer is delivered as is.
    await switchOff("reminder.length-continuation");
    const cut = await this.start({ turns: [say("part one", { stopReason: "max_tokens" }), say(FINAL)] });
    const turn = await cut.engine.runTurn("Write a long essay.");
    t.assert.deepEqual([...turn.errors], []);
    t.assert.equal(turn.notes.includes(NOTE.resume), false, `no resume: ${JSON.stringify(turn.notes)}`);
    t.assert.equal(cut.engine.provider.requests.length, 1, "no extra model call");
    noBlank(cut.engine, "length continuation");

    // Back to no overrides before the next test reads these prompts.
    this.setEnv("MAGENTRA_PROMPTS_DIR", this.tempDir("magentra-prompts-"));
    await overrideSettles();
  }
}

class AnExplicitAllowNeverPassesAProtectedEditRefusal extends BehaviorEngineTest {
  readonly id = "an-explicit-allow-rule-never-passes-a-protected-edit-refusal";
  readonly whyItExists =
    "protectedEdits = refuse fences .env and .magentra edits off from an unattended run; if a Write(...) allow rule written for attended work passed it, the fence would hold only for owners who never wrote one";

  override async run(t: TestRun): Promise<void> {
    const outside = this.tempDir("magentra-knob-outside-");
    const envFile = join(outside, ".env");
    const run = await this.start({
      overdrive: true,
      behavior: this.compiledBehavior({ "overdrive.guards.protectedEdits": "refuse" }),
      settings: { permissions: { allow: [`Write(${envFile})`], deny: [], allowExact: [] } } as Partial<Settings>,
      turns: [{ toolCalls: [call("p1", "Write", { file_path: envFile, content: "SECRET=1\n" })] }, say(FINAL), say(FINAL), say("DONE"), say(FINAL)],
    });
    const turn = await run.engine.runTurn("Set the secret.");
    t.assert.deepEqual([...turn.errors], []);
    t.assert.equal(turn.events.some((e) => e.type === "permission_request"), false, "OVERDRIVE never asks");
    t.assert.equal(existsSync(envFile), false, "the explicit rule did not pass the protected refusal");
    t.assert.ok(fillsTemplate(toolResultText(this.history(run.engine), "p1"), REFUSED.protectedEdit), toolResultText(this.history(run.engine), "p1"));
  }
}

registerFeatureTests(
  new EveryKeyIsReadByTheEngine(),
  new NoReplacedConstantSurvives(),
  new TheShippedValuesAreTheOldConstants(),
  new TheGeneratedBehaviourIsAFreshCompile(),
  new TheDetectorListsRebuildTheOldDetectors(),
  new TheRuntimeCheckerIsTheCompilersTwin(),
  new OverridesApplyOnlyInOverdrive(),
  new EveryClaimGuardsRealProse(),
  new TheCompilerRejectsABadValueNamingTheKey(),
  new ALowerNudgeBudgetStopsSooner(),
  new ARungSwitchedOffDoesNotFire(),
  new ARungCounterAboveOneFiresAgain(),
  new OverdriveSelfVerifyOffRunsNoSilentRound(),
  new AChildNeverSelfVerifies(),
  new AnOverrideAppliesOnlyWhileOverdriveIsOn(),
  new TheStallDetectorReadsBrain(),
  new TheCutoffKnobsBoundTheResume(),
  new TheSmallerKnobsChangeWhatTheyName(),
  new EveryGuardRefusesAndNothingAsks(),
  new AnExplicitAllowPassesOnlyANonProtectedRefusal(),
  new TheMovedTextsReachTheModelAsComposedTemplates(),
  new TheCoreSectionsFollowBrainsOrder(),
  new EnabledFalseIsABlankOverride(),
  new OnlyResolvedObjectsPassUnchecked(),
  new TheDeletionPolicyClaimWarns(),
  new ARungWhosePromptIsOffDoesNotFire(),
  new AnExplicitAllowNeverPassesAProtectedEditRefusal(),
);
