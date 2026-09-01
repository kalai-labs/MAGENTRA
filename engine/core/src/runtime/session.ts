import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  STATE_DIR_NAME,
  addUsage,
  definePrompt,
  emptyUsage,
  estimateTokens,
  isPromptDisabled,
  formatTokens,
  inputTokensOf,
  promptText,
  promptTextIfEnabled,
  renderPrompt,
  type CoreEvent,
  type PermissionDecision,
  type TaskItem,
  type Usage,
} from "@magentra/protocol";
import type { ContentBlock, Msg, Provider, StopReason, ToolResultPart, ToolSchema } from "@magentra/providers";
import { friendlyProviderError, isContextOverflowError } from "@magentra/providers";
import { zodToJsonSchema } from "../util/zodToJsonSchema.js";
import {
  AGENT_TYPES,
  SUBAGENT_RESULT_ID,
  agentRoleText,
  agentToolNames,
  resolveAgentType,
} from "../agent/agents.js";
import { projectName, workspaceLooksNonTrivial } from "../knowledge/workspace.js";
import { graphStats, loadOrBuildGraph, pagerank, type GraphData } from "../knowledge/graph.js";
import { loadStandards } from "../knowledge/standards.js";
import { BackgroundManager } from "../scheduling/background.js";
import { FileState } from "./fileState.js";
import type { HookRunner } from "../agent/hooks.js";
import { PermissionEngine, type PermissionRequestPayload, protectedEditPath } from "./permissions.js";
import {
  codeFilesAmong,
  looksLikeTestDouble,
  runtimeEvidenceText,
  selfVerifyText,
} from "./finishing.js";
import { addonsBlock, buildSystemPrompt } from "../agent/prompts.js";
import { SearchLog, evaluateReuseGate, type ReuseGateResult } from "../knowledge/reuseGate.js";
import { buildSymbolIndex, loadOrBuildSymbolIndex, type SymbolIndexData } from "../knowledge/symbols.js";
import { SessionStats, type ContextBreakdown } from "./sessionStats.js";
import type { Settings } from "../config/settings.js";
import { addExactPermission, resolveVisionApiKey } from "../config/settings.js";
import { createProviderForEndpoint, endpointSpecFromSettings } from "../config/providerFactory.js";
import { contextWindowFor } from "../config/pricing.js";
import type { Addon } from "../agent/addons.js";
import { TaskStore } from "../state/taskStore.js";
import { isToolDisabled, toolDescriptionText } from "../agent/tool.js";
import type {
  SessionServices,
  SpawnAgentOptions,
  ToolContext,
  ToolRegistry,
  ToolResult,
} from "../agent/tool.js";
import { Transcript, syntheticToolResults, unansweredToolUseIds } from "../state/transcript.js";

const DEFAULT_OUTPUT_LIMIT = 40_000;

/** Conversation-content tokens (message history, not system/tools) after which a
 * session earns an auto-generated title. Below this the generic default stands —
 * there isn't enough said yet to summarize meaningfully. */
const AUTO_NAME_MIN_TOKENS = 2_000;

const AUTO_NAME_ROLE = definePrompt({
  id: "session.auto-name.role",
  group: "5 · Background inference calls",
  label: "Session auto-name — role",
  channel: "side-call",
  where:
    "System prompt of the small background call that names a chat session in the sidebar. Runs once per session, after ~2000 tokens of conversation. Never seen by the main agent.",
  text: "You name chat sessions for a coding assistant's sidebar.",
});
const AUTO_NAME_INSTRUCTION = definePrompt({
  id: "session.auto-name.instruction",
  group: "5 · Background inference calls",
  label: "Session auto-name — instruction",
  channel: "side-call-user",
  where:
    "User-role instruction of the same session-naming call, sent above the conversation excerpt.",
  text: `You name chat sessions for a coding assistant's sidebar. Read the conversation excerpt below and reply with ONLY a short title (3–6 words) naming what it is about. No quotes, no trailing punctuation, no prefix like 'Title:' — just the title itself.`,
});

/** Normalizes a model-authored title into a clean sidebar label: first line only,
 * quotes/markdown/trailing punctuation stripped, whitespace collapsed, capped to a
 * few words. Returns "" when nothing usable remains (caller then skips renaming). */
function cleanSessionTitle(raw: string): string {
  let s = (raw || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  s = s.replace(/^["'`*_#\s]+/, "").replace(/["'`*_\s]+$/, ""); // surrounding quotes/markdown
  s = s.replace(/^(?:title|session|chat|name)\s*[:\-]\s*/i, ""); // stray "Title:" prefix
  s = s.replace(/[.。!?！？]+$/, "").replace(/\s+/g, " ").trim(); // trailing punctuation + inner runs
  if (!s) return "";
  const words = s.split(" ");
  if (words.length > 8) s = words.slice(0, 8).join(" ");
  return s.slice(0, 60);
}

/** Per-turn cap on auto-recovery / wrap-up nudges (see runTurn). */
const MAX_AUTO_NUDGES = 3;
/**
 * How many output-length cutoffs IN A ROW a turn rides out before it ends
 * visibly. Each cutoff is resumed (text) or reissued (tool call); a model that
 * is cut off this many consecutive times is rewriting the same oversized
 * response — the transcript pattern of "↻ continuing" forever — and no further
 * resume will land it. Any complete response resets the streak.
 */
const MAX_CUTOFF_STREAK = 3;
/**
 * How many times one turn may recover from a context overflow by compacting
 * and retrying. Two: the first compaction can be defeated by a single huge
 * tool result still in the kept tail; a second forced pass squeezes that too.
 * A third overflow means the window cannot hold even the compacted history.
 */
const MAX_OVERFLOW_RECOVERIES = 2;

const ERROR_BATCH_REMINDER = definePrompt({
  id: "reminder.error-batch",
  group: "3 · In-turn reminders",
  label: "Tool batch failed",
  channel: "reminder",
  where:
    "Appended to the tool-result block whenever one or more tool calls in that batch failed, so the agent fixes and continues instead of ending the turn.",
  text: "One or more tool calls above failed. Diagnose the cause and continue working — fix and retry rather than ending the turn. Only stop if the task is complete or genuinely blocked, and if blocked, explain why.",
});

const RECOVERY_NUDGE_TEXT = definePrompt({
  id: "reminder.recovery-nudge",
  group: "3 · In-turn reminders",
  label: "Turn ended on a failed call",
  channel: "reminder",
  where:
    "Injected when the turn is about to end and the LAST tool call failed. Capped at 3 auto-nudges per turn.",
  text: "<system-reminder>The last tool call in this turn failed and the turn is ending. Either fix the failure and re-verify, or state explicitly why this failure does not block success. Do not end with a failing command unaccounted for.</system-reminder>",
});

const WRAPUP_NUDGE_TEXT = definePrompt({
  id: "reminder.wrapup-nudge",
  group: "3 · In-turn reminders",
  label: "Missing wrap-up",
  channel: "reminder",
  where:
    "Injected when the agent stops working without writing a summary. Costs one extra round trip each time it fires.",
  text: "<system-reminder>You finished working but did not summarize. Give the user a short wrap-up: what was built/changed, how to use it, what you verified and the outcome, and any open issues.</system-reminder>",
});

const LENGTH_CONTINUATION_TEXT = definePrompt({
  id: "reminder.length-continuation",
  group: "3 · In-turn reminders",
  label: "Output cut off mid-text",
  channel: "reminder",
  where:
    "Injected when the provider stopped the response at the max-output-token wall. Asks for a seamless continuation rather than a restart.",
  text: "<system-reminder>Your previous response was cut off mid-output by the token limit. Resume from the exact character where it stopped. Do not repeat or rephrase anything already written. Do not restart, re-introduce, or summarize. No preamble — output only the continuation, as if the text had never been interrupted.</system-reminder>",
});

// The tool-call analogue of LENGTH_CONTINUATION_TEXT: a cutoff that lands
// mid-tool-call leaves the tool's JSON truncated. Sent as that call's result so
// the model knows it was cut off (not that it sent bad input) and reissues the
// call in full — never assuming the truncated call ran.
const TOOL_CUTOFF_TEXT = definePrompt({
  id: "reminder.tool-cutoff",
  group: "3 · In-turn reminders",
  label: "Output cut off mid tool call",
  channel: "reminder",
  where:
    "Returned as the RESULT of a tool call whose JSON arguments were truncated by the output-token wall, so the agent reissues it instead of assuming it ran.",
  text: "This tool call was cut off by the output-token limit before it finished, so it was NOT executed. Reissue the complete call — do not assume it ran or had any effect.",
});

// Stall handling: with the interactive numeric caps lifted, the brake is
// noticing that rounds have stopped producing anything new. Three consecutive
// identical rounds (same tool calls, same results) = a stall; the first two
// stalls force a strategy pivot, the third forces one concrete question to the
// user — never a silent surrender, never an infinite burn.
const STALL_PIVOT_TEXT = definePrompt({
  id: "reminder.stall-pivot",
  group: "3 · In-turn reminders",
  label: "Stall — force a pivot",
  channel: "reminder",
  where:
    "Injected after three consecutive identical rounds (same calls, same results). Fires for the first two stalls of a turn.",
  text: "<system-reminder>Stall: your last rounds repeated the same actions with the same results. This approach is not working — abandon it entirely and try a genuinely different strategy (different tool, different angle, different decomposition). Do not re-issue the failing action.</system-reminder>",
});

const STALL_ASK_TEXT = definePrompt({
  id: "reminder.stall-ask",
  group: "3 · In-turn reminders",
  label: "Stall — force a question",
  channel: "reminder",
  where:
    "Injected on the third stall of a turn: stop attempting and ask the user one concrete question with AskUserQuestion.",
  text: "<system-reminder>Stall: strategy pivots have not produced progress either. Stop attempting now. Ask the user ONE concrete question with AskUserQuestion: state what you are trying to achieve, what keeps failing and why you think so, and offer the options you see (with your recommendation). If asking is unavailable (you are a subagent), end the turn instead with a clear report of the blocker.</system-reminder>",
});

// The OVERDRIVE system-prompt section. The autonomy contract: plan first,
// think in consequences, evidence stays query-shaped, ask only rubric-worthy
// questions, clean up after yourself, do not stop until the query is handled.
const OVERDRIVE_PROMPT_SECTION = definePrompt({
  id: "system.overdrive",
  group: "2 · Conditional system sections",
  label: "OVERDRIVE mode section",
  channel: "system-conditional",
  where:
    "Appended to the system prompt only while OVERDRIVE is on. Removes every confirmation step and tells the agent not to stop until the whole query is handled.",
  text: `# OVERDRIVE — fully-autonomous mode
You are operating autonomously.

- The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to…?' or 'Shall I…?' will block the work.
- For reversible actions that follow from the original request, proceed without asking. 
- NOTHING asks. Every call runs the moment you make it: deletions at any path, edits to \`.magentra\` state and \`.env\` files, writes outside the workspace. There is no confirmation step and no safety net but your own judgement — read a file before you overwrite it, look before you delete, and prefer the reversible move. The only thing that can still stop a call is a deny rule the user wrote themselves.`,
});

/**
 * Whether a self-verify round answered with the "nothing left to do" sentinel.
 *
 * The instruction asks for a bare DONE, but models — reasoning models especially
 * — decorate or repeat it: `**DONE**`, `DONE.`, `DONE DONE DONE`, `DONE!\nDONE`.
 * A strictly-anchored match let all of those fall through to the reveal path,
 * spamming the chat with the raw verify buffer. Treat the round as complete when
 * nothing but DONE survives stripping markdown emphasis and punctuation — but
 * never when real prose rides along, since that prose is genuine continued work
 * that must reach the user.
 *
 * Literal DONE only. A lone word in any other language used to count too, as a
 * safety net for models that localize the sentinel — but the round's own prompt
 * demands "exactly this literal ASCII word … never translated or localized",
 * and that tolerance swallowed the one answer that must never end a turn: a
 * model replying `No` to a yes/no self-check was read as "nothing left to do"
 * and its reply was never rendered. A localizing model now costs one extra
 * round and shows its word — wasted work, never a false completion.
 */
export function isSelfVerifyDone(text: string): boolean {
  const tokens = text
    .replace(/[*_`~#>]/g, " ") // markdown emphasis / heading / quote marks
    .replace(/[.!…,:;\-–—]/g, " ") // trailing punctuation and separators
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => /^done$/i.test(t)); // literal DONE, decorated or repeated
}

// ── Clarify pre-layer ───────────────────────────────────────────────────────
// Before acting on an open-ended request ("build a game", "improve this
// app"), the same main model first judges whether guessing the unstated
// choices wrong would force a redo — and only then asks the user up to three
// concrete multiple-choice questions. Strictly fail-open: any inference
// error, malformed verdict, or interrupt proceeds without clarifying.
const CLARIFY_SYSTEM = definePrompt({
  id: "clarify.system",
  group: "5 · Background inference calls",
  label: "Clarify pre-layer",
  channel: "side-call",
  where:
    "System prompt of the background call that runs BEFORE an open-ended request and decides whether to ask the user clarifying questions. Adds one inference round at the start of a turn; fails open on any error.",
  text: `You are the clarify pre-layer of an autonomous coding agent. You see ONE incoming user request (plus a snippet of the previous exchange for context) and decide: should the agent ask clarifying questions BEFORE starting, or just start?

You may also be given a "Codebase overview" — a quick, cursory read of the workspace (an import-graph skeleton, or a short peek at README/manifests). It is CONTEXT, not something to confirm with the user. Use it to SHARPEN questions, NOT to silence them:
- Ground your questions in the project's actual stack, structure, and conventions, so you ask about real, specific choices instead of generic ones — name the concrete options THIS codebase invites.
- Skip only what the overview answers as FACT — what the app is, its stack, which existing pattern to follow. Never ask the user to restate what the code plainly shows.
- But the code shows what EXISTS, not what the user now WANTS. For an open-ended change to an existing project ("improve the game", "make it better", "extend this"), the DIRECTION and SCOPE are still the user's to choose — the overview does NOT settle them. Ask that (made specific by the overview), rather than silently picking a direction. Knowing the codebase is a reason to ask a sharper question, not a reason to skip asking.

Reply with STRICT JSON only — no markdown fences, no prose:
  {"clarify": false}
or
  {"clarify": true, "questions": [{"question": "...?", "header": "max 12 chars", "options": [{"label": "...", "description": "..."}, ...], "multiSelect": false}]}

Set clarify=true ONLY when BOTH hold:
1. The request is genuinely open-ended — EITHER the deliverable's core shape is unstated (kind/genre/technology/scope/audience), e.g. "build a game", "draw me something"; OR it asks for an open-ended change whose DIRECTION is the user's to choose, e.g. "improve this app", "make the game better". A codebase overview may tell you what already EXISTS, but that does not settle which direction the user wants — so it does not, on its own, make an open-ended request concrete.
2. Guessing wrong would waste real work — the user would likely ask for a redo.

Set clarify=false for everything else: concrete tasks naming a target, questions or explanations, conversational messages, follow-ups whose context already fixes the shape, and anything where a sensible default exists and adjusting later is cheap. When unsure, prefer false — asking needlessly is friction.

Questions: at most 5, each one decision-changing (never a detail that could be adjusted later), 2-4 mutually distinct options with a one-line description each; put your recommended option first with " (Recommended)" appended to its label. multiSelect true only when choices genuinely combine. NOTE THAT: Questions in one set are answered together, so they must be independent -- never include a question whose sensible options depend on another question's answer in the same set, ask only the upstream shape-defining question and leave the dependent one for the agent to ask afterwards, with options tailored to the answer.`,
});

// Caps that keep the clarify skim a cursory glance, not a context dump: the
// whole overview injected into the clarify prompt, and the per-fallback read of
// the working directory's overview files.
const CLARIFY_SKIM_MAX_CHARS = 6000;
const CLARIFY_PEEK_MAX_CHARS = 4000;
// The obvious "what is this project" files, richest first — read only until the
// peek budget runs out.
const CLARIFY_PEEK_FILES = [
  "README.md",
  "README",
  "readme.md",
  "README.txt",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
];

/**
 * A compact one-glance skeleton of the import graph for the clarify skim: the
 * project's scale plus its most central files (by import centrality), which is
 * enough to convey what the codebase IS. Returns undefined when the graph parsed
 * no files (e.g. a language it does not index) so the caller can fall back.
 */
function graphSkeleton(g: GraphData, project: string): string | undefined {
  const stats = graphStats(g);
  if (stats.fileCount === 0) return undefined;
  const top = [...pagerank(g).entries()]
    .filter(([id]) => !id.startsWith("pkg:") && g.files[id])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => id);
  return [
    `${project}: ${stats.fileCount} source files, ${stats.edgeCount} internal imports.`,
    "Most central files (by import centrality):",
    ...top.map((id) => `  ${id}`),
  ].join("\n");
}

const PLAN_FIRST_REMINDER = definePrompt({
  id: "reminder.plan-first",
  group: "3 · In-turn reminders",
  label: "Nothing on the task board",
  channel: "reminder",
  where:
    "Injected at turn start when the task list is empty, nudging the agent to decompose multi-move work with TaskCreate first.",
  text: "Nothing is on the task board yet. When a request will take several moves to finish, lay it out first with TaskCreate — one entry per move, closing with a check task that names the end state you'll confirm — before you touch any files. A quick one-off needs no board; just handle it.",
});

/**
 * The installed addon a message names with a leading slash, if any.
 *
 * Matched on a word boundary, so `/grill-me` is found in "bana /grill-me yap"
 * while a path (`src/grill-me`) is not. Longest name wins, so `/review` cannot
 * shadow `/review-sql`. Pure and exported so it is tested directly rather than
 * having its regex copied into a check that can drift from it.
 */
export function addonNamedIn(text: string, addons: readonly { name: string }[]): string | undefined {
  let hit: string | undefined;
  for (const addon of addons) {
    const escaped = addon.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|\\s)/${escaped}(?=$|[\\s.,!?;:])`).test(text)) {
      if (hit === undefined || addon.name.length > hit.length) hit = addon.name;
    }
  }
  return hit;
}

const ADDON_NAMED_REMINDER = definePrompt({
  id: "reminder.addon-named",
  group: "3 · In-turn reminders",
  label: "The user named an addon",
  channel: "reminder",
  where:
    "Injected at turn start when the user's message names an installed addon with a leading slash (anywhere in the message, not only at the start). `{{name}}` is the addon. Also suppresses the clarify pre-layer for that turn.",
  placeholders: ["name"],
  text: 'The user named the "{{name}}" addon in their message. Load it with the Addon tool now and follow it — the rest of their message is the task to apply it to, so pass it along as the addon\'s arguments where that fits. Its procedure is the answer to what to do here; do not ask them to define it.',
});

const STANDARDS_SECTION_HEADER = definePrompt({
  id: "system.standards-header",
  group: "2 · Conditional system sections",
  label: "Coding standards header",
  channel: "system-conditional",
  where:
    "Prefixes the contents of the workspace STANDARDS.md when one exists, declaring it binding over the default code-style guidance.",
  text: `# Coding standards (user-provided — binding)
The user supplied these standards. They are RULES, not suggestions: where they conflict with any default guidance about code style, the standards win. A change that violates them is a failed change regardless of whether it works.`,
});

const COMPACTION_SYSTEM = definePrompt({
  id: "compaction.system",
  group: "5 · Background inference calls",
  label: "History compaction summarizer",
  channel: "side-call",
  where:
    "System prompt of the background call that summarizes older history when the context fills up (auto-compaction or /compact). Runs on settings.smallModel when set. Its output becomes the agent's only memory of the compacted span.",
  text: "Summarize this coding-agent conversation so work can continue seamlessly in a fresh context. Structure the summary as: 1) task state and goal, 2) decisions made and why, 3) files read or modified (with paths), 4) open items and next steps. Be specific; keep every detail a continuation would need.",
});

const COMPACTION_WRAPPER = definePrompt({
  id: "compaction.wrapper",
  group: "3 · In-turn reminders",
  label: "Compaction summary wrapper",
  channel: "reminder",
  where:
    "Replaces the compacted messages in the conversation. `{{summary}}` is the summarizer's output; the wrapper text around it is what stops the agent treating compaction as a signal to wrap up.",
  placeholders: ["summary"],
  text: `<system-reminder>Earlier conversation was compacted. Summary of the compacted span:

{{summary}}

Continue the work; do not wrap up early on account of the compaction.</system-reminder>`,
});

/** Output ceiling for one image description. Generous on purpose: a screenshot
 *  of a stack trace or a settings panel is mostly transcription, and a truncated
 *  description silently loses the line the user cared about. */
const VISION_DESCRIBE_MAX_TOKENS = 4_000;

const VISION_DESCRIBE_SYSTEM = definePrompt({
  id: "vision.describe",
  group: "5 · Background inference calls",
  label: "Image describer",
  channel: "side-call",
  where:
    "System prompt of the call that looks at an image on settings.visionConnection — the attached-image path and the Read tool both use it. Its output is the ONLY thing the main model ever learns about the picture, so it is written to transcribe rather than to interpret.",
  text: `You are describing an image for another model that cannot see it. Your description is the only account it will ever have, so it must be complete enough to work from and free of anything you did not actually see.

- Transcribe every piece of text verbatim — code, error messages, labels, menu items, URLs, numbers. Keep the original line breaks and spelling, including mistakes.
- Describe the layout and what kind of thing this is (screenshot, photo, diagram, chart, UI mockup), then its parts in reading order.
- For a UI: name the visible components, their state (focused, disabled, checked, highlighted), and anything that reads as an error or a warning.
- For a diagram or chart: state the axes, labels, series, and the values you can read off it.
- Report what is visible, not what it means. Do not guess at intent, do not offer fixes, do not add anything the picture does not show.
- If part of the image is unreadable — too small, blurred, cut off — say so plainly for that part instead of filling it in.

Answer with the description alone. No preamble, no closing remark.`,
});

const VISION_DESCRIPTION_WRAPPER = definePrompt({
  id: "vision.description-wrapper",
  group: "3 · In-turn reminders",
  label: "Image description wrapper",
  channel: "reminder",
  where:
    "Wraps a vision model's description before it enters the conversation. `{{label}}` names the image, `{{description}}` is what the vision model returned. The wrapper is what stops the main model from claiming it looked at the picture itself.",
  placeholders: ["label", "description"],
  text: `<image-description source="{{label}}">
A separate vision model looked at this image and wrote the description below. You did NOT see the image and cannot see it — this text is all you have. Work from it, quote it if you need to, and never claim to have viewed the image yourself. If the description is missing something you need, say so and ask.

{{description}}
</image-description>`,
});

export interface SessionOptions {
  cwd: string;
  settings: Settings;
  provider: Provider;
  registry: ToolRegistry;
  emit: (event: CoreEvent) => void;
  requestApproval: (
    req: PermissionRequestPayload & { id: string },
  ) => Promise<{ decision: PermissionDecision; message?: string }>;
  askUser: (id: string, questions: unknown) => Promise<Record<string, string[]>>;
  sessionId?: string;
  initialMessages?: Msg[];
  /** Overrides the assembled system prompt (used by subagents). */
  systemPromptOverride?: string;
  addons?: Addon[];
  /** Extra prompt sections appended to the system prompt. */
  extraPromptSections?: string[];
  /**
   * Share an existing PermissionEngine instead of building one (subagents get
   * their parent's): session-allows granted during one subagent run hold for
   * the next, and mode/deletion-guard changes reach the whole tree.
   */
  permissionEngine?: PermissionEngine;
  /**
   * Share the parent's SessionStats (subagents do): their token
   * spend, API time and code changes belong to the same /session report as the
   * orchestrator's. Also set on /resume with the ledger rebuilt from the
   * transcript's meta snapshot. Omitted for a fresh root session.
   */
  stats?: SessionStats;
  /**
   * Subagent child session: its transcript lives in sessions/subagents/
   * (off the resumable listing) and stats snapshots are the root's job.
   */
  child?: boolean;
  /** Runs lifecycle hooks; omitted for subagent sessions. */
  hookRunner?: HookRunner;
}

interface PendingToolCall {
  id: string;
  name: string;
  json: string;
}

export class Session {
  readonly id: string;
  cwd: string;
  readonly stateDir: string;
  readonly settings: Settings;
  readonly permissions: PermissionEngine;
  readonly tasks: TaskStore;
  readonly fileState = new FileState();
  readonly background: BackgroundManager;
  readonly transcript: Transcript;
  readonly services: SessionServices;

  messages: Msg[];
  extraPromptSections: string[];
  /** Not readonly: a live connection swap (set_connection) replaces it without
   *  ending the session — see {@link setProvider}. */
  private provider: Provider;
  private readonly registry: ToolRegistry;
  private readonly emit: (event: CoreEvent) => void;
  private readonly reminders: string[] = [];
  private readonly dynamicSections = new Map<string, string>();
  private abortController: AbortController | undefined;
  private turnCounter = 0;
  /**
   * Whole-session accounting (cost, API time, code changes, and the CURRENT
   * context size). Shared by reference with every subagent child, so one
   * /session report covers the whole tree. See SessionStats for why context and
   * usage must not be conflated.
   */
  readonly stats: SessionStats;
  private busy = false;
  /**
   * OVERDRIVE: the fully-autonomous turn-loop policy. When on, the per-turn
   * iteration/token caps and the auto-nudge ceiling are lifted, the reuse gate
   * only reminds, and a turn may not end until it passes the self-verify rung.
   * Session-scoped, persisted in the meta snapshot so /resume restores it.
   */
  private overdrive = false;
  /** The UI's optional auto-compact cap (set_compact_limit frame): undefined
   *  until a frontend sends one (TUI, headless), 0 = the user switched
   *  auto-compaction off, >0 = compact no later than this many context tokens.
   *  The limit that actually fires is {@link effectiveCompactLimit}: this cap
   *  can only LOWER the window-derived limit, never raise it past the model. */
  private autoCompactLimit: number | undefined = undefined;
  private suppressAssistantText = false;
  /** Usage totals of the most recently completed turn (undefined before the first turn ends). */
  lastTurnUsage: Usage | undefined;
  /** User-assigned OR auto-generated session name; persisted in the meta snapshot.
   *  A manual rename sets this too, which blocks auto-naming from overriding it. */
  label: string | undefined;
  /** True once auto-naming has run (or been superseded by a manual name) — it
   *  fires at most once per session so the sidebar title doesn't churn. */
  private autoNameDone = false;
  /** True once the empty-task-list plan-first reminder has fired and the list has stayed empty since. */
  private planReminderFired = false;
  private readonly hooks: HookRunner | undefined;
  /** Reuse check: tokenized record of related searches/queries made this session. */
  private readonly searchLog = new SearchLog();
  /** Reuse check: the workspace symbol index, loaded once then refreshed incrementally. */
  private symbolIndexCache: SymbolIndexData | undefined;
  /**
   * Finishing rungs: what this turn actually did, as observed rather than as
   * claimed. Workspace-relative paths of every file a successful Write/Edit
   * touched, and whether any command was executed at all. Both reset at turn
   * start — the question the rungs ask is about THIS turn's work.
   *
   * Only successful calls count. A refused Write or a Bash that never ran left
   * nothing behind to verify, and crediting it would let a turn buy its way past
   * the evidence rung with calls that did nothing.
   */
  private readonly filesChangedThisTurn = new Set<string>();
  private ranCommandThisTurn = false;
  /**
   * The subset of those files whose written text stands something in for a real
   * dependency — a mock, fake, stub or patch. Tracked separately because a check
   * that leans on one of these is not evidence about the dependency it replaced:
   * the double was authored by the same understanding as the code, so the two
   * agree by construction and a green result proves only self-consistency.
   */
  private readonly doubleFilesThisTurn = new Set<string>();
  /** Finishing rungs fire at most once per turn each (reset at turn start). */
  private evidenceNudgeFired = false;
  private incompleteTasksNudgeFired = false;
  private activeChildren = 0;
  /** Foreground child sessions currently running, so interrupt() can propagate.
   *  Background children are deliberately excluded — they detach from the turn
   *  and are stopped through the BackgroundManager instead. */
  private liveChildren = new Set<Session>();
  private static readonly MAX_CHILDREN = 8;
  private static agentCounter = 0;

  constructor(private readonly opts: SessionOptions) {
    this.id = opts.sessionId ?? `s_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    this.cwd = opts.cwd;
    this.stateDir = join(opts.cwd, STATE_DIR_NAME);
    this.settings = opts.settings;
    // Children share the parent's ledger; a root session opens a fresh one.
    this.stats = opts.stats ?? new SessionStats();
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.emit = opts.emit;
    this.messages = opts.initialMessages ?? [];
    this.hooks = opts.hookRunner;
    this.extraPromptSections = [...(opts.extraPromptSections ?? [])];
    this.transcript = new Transcript(this.stateDir, this.id, { child: opts.child ?? false });
    this.tasks = new TaskStore(this.stateDir, this.id, this.emit);
    this.background = new BackgroundManager(this.stateDir, this.emit, (t) => this.remind(t));
    this.permissions =
      opts.permissionEngine ??
      new PermissionEngine(
        opts.settings.permissions,
        async (req, approvalSource) => {
        const id = `perm_${randomBytes(4).toString("hex")}`;
        const res = await opts.requestApproval({ ...req, id });
        this.transcript.append({
          kind: "permission",
          tool: req.tool,
          ...(subjectOf(req) !== undefined ? { subject: subjectOf(req) } : {}),
          decision: res.decision,
          source: approvalSource === "deletion-guard" ? "deletion-guard" : "user",
        });
        return res;
      },
        // "Always allow" writes the grant into this workspace's settings, so
        // the same command (or command shape, for prefix grants) stops asking
        // in later sessions too.
        (tool, subject, prefix = false) => {
          // The in-memory settings object outlives this session — /clear builds
          // the next one from it. Without this, a grant would be forgotten
          // until the app restarted and re-read the file it just wrote.
          const exact = opts.settings.permissions.allowExact;
          if (!exact.some((g) => g.tool === tool && g.subject === subject && (g.prefix === true) === prefix)) {
            exact.push({ tool, subject, ...(prefix ? { prefix: true } : {}) });
          }
          addExactPermission(this.cwd, tool, subject, prefix);
        },
    );
    this.services = {
      // The tools' emit seam — and the single place a file_edited diff is
      // counted. A child's Write/Edit calls ITS OWN services.emit (writing to
      // the shared stats object), so counting here tallies the whole tree
      // exactly once; hooking the internal emit instead would double-count,
      // because emitFromChild forwards a child's events back through it.
      emit: (event) => {
        if (event.type === "file_edited") this.stats.recordDiff(event.diff);
        this.emit(event);
      },
      fileState: this.fileState,
      tasks: this.tasks,
      background: this.background,
      remind: (t) => this.remind(t),
      askUser: (questions) => opts.askUser(`q_${randomBytes(4).toString("hex")}`, questions),
      spawnAgent: (o) => this.spawnAgent(o),
      runInference: (o) => this.runInference(o),
      describeImageForContext: (image) => this.describeImageForContext(image),
      visionUnavailableReason: () => this.visionUnavailableReason(),
      setPromptSection: (k, t) => this.setPromptSection(k, t),
      addSessionAllow: (tool, subject) => this.permissions.addSessionAllow(tool, subject),
      settings: this.settings,
      usedOutputTokens: () => this.stats.totalUsage().outputTokens,
      stateDir: this.stateDir,
      setCwd: (dir: string) => {
        this.cwd = dir;
        // The UI must show when the session operates inside a worktree —
        // edits landing in an unexpected tree read as data loss.
        this.emit({ type: "cwd_changed", cwd: dir, worktree: dir !== this.opts.cwd });
      },
      worktreeBaseRef: opts.settings.worktree.baseRef,
      ...(opts.addons !== undefined ? { addons: opts.addons } : {}),
    };
  }

  remind(text: string): void {
    // A prompt switched off in the registry resolves to "". Pushing it would
    // inject an empty <system-reminder> and, for the rungs that `continue`
    // afterwards, still cost the round trip the operator meant to remove.
    if (text.trim() === "") return;
    this.reminders.push(text);
  }

  /** Records out-of-band context (e.g. `!` command output) without a model turn. */
  addContextMessage(text: string): void {
    const msg: Msg = { role: "user", content: [{ type: "text", text }] };
    this.messages.push(msg);
    this.transcript.append({ kind: "message", message: msg });
  }


  setPromptSection(key: string, text: string | undefined): void {
    if (text === undefined) this.dynamicSections.delete(key);
    else this.dynamicSections.set(key, text);
  }

  /** The app's "Allow deletions" safety toggle. Turning it on both disables the
   *  always-ask deletion guard and tells the model (via a prompt section) that
   *  destructive local operations carry a durable user authorization — the
   *  prompt otherwise instructs it to seek confirmation for them. */
  setDeletionPolicy(allowDeletions: boolean): void {
    this.permissions.setDeletionGuard(!allowDeletions);
    this.setPromptSection(
      "deletion-policy",
      allowDeletions
        ? `Deletion policy:
- The user has enabled "Allow deletions" in the app settings — a durable authorization for destructive local operations (deleting files or folders, forced git history rewrites, and similar). They run without an extra confirmation prompt.
- This is a license, not a directive: delete only what the task genuinely requires, keep the smallest possible blast radius, and still call out anything surprising you are about to remove.`
        : undefined,
    );
  }

  /** OVERDRIVE toggle. It now means exactly what it says: NOTHING asks —
   *  deletions at any scope, edits to `.magentra` state and `.env` files, and
   *  writes outside the workspace all run. Only a user-authored deny rule
   *  still refuses. In exchange the turn self-verifies against the original
   *  query before it may end, which is the rung an attended turn does not run.
   *  Turn budgets are unaffected (`capped` keys off child, not this). Emits the state change so every frontend can sync its indicator. */
  setOverdrive(enabled: boolean): void {
    if (this.overdrive === enabled) return;
    this.overdrive = enabled;
    this.permissions.setOverdrive(enabled);
    this.setPromptSection("overdrive", enabled ? promptText(OVERDRIVE_PROMPT_SECTION) : undefined);
    this.emit({ type: "overdrive_changed", enabled });
  }

  /**
   * Point this session at a different inference endpoint mid-conversation (the
   * set_connection frame). Every provider call reads `this.provider` at call
   * time, so the swap lands on the next request — the messages, the session id,
   * the task list, and the stance all stay exactly as they were.
   *
   * Child sessions already running keep the provider they were spawned with:
   * their turn is in flight, and swapping under it would change the model
   * halfway through one exchange. They are short-lived; the next spawn inherits
   * the new one.
   */
  setProvider(provider: Provider): void {
    this.provider = provider;
  }

  /** Mid-run steering: queue user text for injection at the running turn's
   *  next message boundary. Steering re-arms the self-verify rung and resets
   *  spent strategy pivots — new guidance is new information. */
  private readonly pendingSteering: string[] = [];

  steer(text: string): void {
    this.pendingSteering.push(text);
    this.emit({ type: "command_output", text: "⚡ steering — your message joins the running turn at its next step" });
  }

  isOverdrive(): boolean {
    return this.overdrive;
  }

  /** The last pre-turn OVERDRIVE snapshot: a dangling stash commit ref, or
   *  undefined when the tree was clean (HEAD is the snapshot) or not a repo. */
  private overdriveSnapshotRef: string | undefined;

  private async snapshotForOverdrive(): Promise<void> {
    this.overdriveSnapshotRef = undefined;
    if (!existsSync(join(this.cwd, ".git"))) return;
    try {
      const ref = await new Promise<string>((res, rej) => {
        execFile(
          "git",
          ["stash", "create", "overdrive pre-turn snapshot"],
          { cwd: this.cwd, timeout: 10_000 },
          (err, stdout) => (err ? rej(err) : res(stdout.trim())),
        );
      });
      // Empty output = clean working tree; git gc keeps the dangling commit
      // reachable long enough for session-scale recovery. Tracked files only —
      // `git stash create` cannot see untracked ones.
      this.overdriveSnapshotRef = ref || undefined;
    } catch {
      // The net is best-effort; a failed snapshot must never block the turn.
    }
  }

  /** One-shot completion with no tools; returns concatenated text. Runs on the
   *  small model unless `model` overrides it (the clarify pre-layer runs on
   *  the main model by design).
   *
   *  This is a real model invocation, so it is banked like any other: its tokens
   *  join the session ledger and the open turn's deliberation total. It is NOT
   *  conversational — its private prompt never enters the conversation's window,
   *  so it must not be mistaken for the context size. */
  async runInference(opts: {
    system: string;
    user: string;
    maxTokens: number;
    model?: string;
    provider?: Provider;
    /**
     * Images to send alongside `user`, in the same message. Only the vision
     * side-call uses this, and only against the endpoint configured to see
     * them — the conversation itself never carries an image (see
     * {@link describeImage}).
     */
    images?: { data: string; mediaType: string }[];
    /**
     * Why the reply ended. Optional because most callers do not care — but a
     * caller that parses the reply as JSON does: `max_tokens` means the text is
     * TRUNCATED, not malformed, and the two need different handling. Without
     * this the layer has to guess from a failed parse, and guessing wrong reads
     * a correct-but-cut-off answer as no answer at all.
     */
    onEnd?: (stopReason: StopReason) => void;
  }): Promise<string> {
    let text = "";
    const model = opts.model ?? this.settings.smallModel ?? this.settings.model;
    const startedAt = Date.now();
    let usage = emptyUsage();
    const stream = (opts.provider ?? this.provider).stream({
      model,
      system: opts.system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: opts.user },
            ...(opts.images ?? []).map((img) => ({
              type: "image" as const,
              data: img.data,
              mediaType: img.mediaType,
            })),
          ],
        },
      ],
      tools: [],
      maxTokens: opts.maxTokens,
      signal: new AbortController().signal,
    });
    try {
      for await (const event of stream) {
        if (event.type === "text_delta") text += event.text;
        else if (event.type === "message_end") {
          usage = event.usage;
          opts.onEnd?.(event.stopReason);
        }
      }
    } finally {
      // Banked even when the call throws part-way: the tokens it did consume
      // were still spent, and a silent hole in the ledger is worse than a
      // partial figure.
      this.stats.recordResponse(model, usage, Date.now() - startedAt, false);
    }
    return text;
  }

  /**
   * The vision endpoint's Provider, rebuilt whenever the configured connection
   * changes. Keyed by the connection itself rather than invalidated by hand:
   * a set_connection swap or a /settings edit changes the key, so the next call
   * builds a fresh client without anything having to remember to clear a cache.
   */
  private visionProviderCache: { key: string; provider: Provider } | undefined;

  /** Why an image cannot be looked at right now, or undefined when it can.
   *  The one answer to "is vision usable" — the flag alone never is, because a
   *  switched-on flag with no endpoint behind it can look at nothing. */
  visionUnavailableReason(): string | undefined {
    if (!this.settings.visionConnection) {
      return "this workspace's connection names no vision model — add one to its profile in the connection wizard";
    }
    if (!this.settings.vision) {
      return "vision is switched off for this workspace — turn it on from the workspace menu";
    }
    return undefined;
  }

  /**
   * Look at an image and return what a vision model saw in it, as text.
   *
   * The image goes to `settings.visionConnection` — never to the session's own
   * model, which is treated as unable to see one whatever it claims to support.
   * The description is what enters the conversation, so every later claim about
   * the picture rests on text that is in the transcript and can be checked.
   *
   * The call is banked like any other inference (runInference records it), so a
   * described image shows up in the session's token ledger.
   *
   * Throws when vision is off or unconfigured, or when the vision endpoint
   * fails — callers turn that into something the user or the agent can act on.
   *
   * Private: everything outside goes through {@link describeImageForContext},
   * so no caller can put a bare description into the conversation without the
   * framing that says the main model did not see the picture.
   */
  private async describeImage(image: { data: string; mediaType: string; label?: string }): Promise<string> {
    const unavailable = this.visionUnavailableReason();
    if (unavailable) throw new Error(unavailable);
    const connection = this.settings.visionConnection!;

    // The key is part of the cache key because it is BAKED INTO the provider
    // instance: rotating the credential on an otherwise unchanged endpoint
    // would otherwise keep sending the old one until the engine restarted, and
    // present as an endpoint that suddenly rejects a key the user just fixed.
    // (The model is not — it travels per call.)
    const apiKey = resolveVisionApiKey(this.settings);
    const key = JSON.stringify([connection.provider, connection.baseUrl, connection.contextWindow, apiKey]);
    if (this.visionProviderCache?.key !== key) {
      this.visionProviderCache = {
        key,
        provider: createProviderForEndpoint(endpointSpecFromSettings(connection, apiKey)),
      };
    }

    const label = image.label ?? "attached image";
    const description = await this.runInference({
      system: promptText(VISION_DESCRIBE_SYSTEM),
      user: `Describe this image (${label}).`,
      maxTokens: VISION_DESCRIBE_MAX_TOKENS,
      model: connection.model,
      provider: this.visionProviderCache.provider,
      images: [{ data: image.data, mediaType: image.mediaType }],
    });
    if (description.trim() === "") {
      throw new Error(`the vision model (${connection.model}) returned an empty description`);
    }
    return description.trim();
  }

  /**
   * A described image as it enters the conversation: the description wrapped in
   * the text that keeps the main model honest about what it did and did not
   * see. Shared by the attached-image path and the Read tool, so the framing
   * cannot drift between them.
   */
  async describeImageForContext(image: { data: string; mediaType: string; label?: string }): Promise<string> {
    const description = await this.describeImage(image);
    return renderPrompt(VISION_DESCRIPTION_WRAPPER, {
      label: image.label ?? "attached image",
      description,
    });
  }

  /**
   * Filters events from a child (subagent) session before they reach this
   * session's own emit. Child turn/text events must not leak into the
   * top-level stream (a frontend waiting for the outer turn_finished would
   * otherwise stop on the child's t_1); tool call events pass through so
   * subagent activity is still visible, tagged so frontends can render them
   * distinctly. Everything else (permissions, questions, tasks, background
   * notifications) passes through unchanged.
   */
  private emitFromChild(event: CoreEvent, agentId: string, agentDesc: string): void {
    switch (event.type) {
      case "turn_started":
      case "turn_finished":
      case "text_delta":
      case "thinking_delta":
        return;
      case "tool_call_started":
      case "tool_call_finished":
        // A grandchild's own emitFromChild layer stamps its tags first, so an
        // outer layer must not overwrite an already-present agentId/agentDesc.
        this.emit({
          ...event,
          subagent: true,
          agentId: event.agentId ?? agentId,
          agentDesc: event.agentDesc ?? agentDesc,
        });
        return;
      default:
        this.emit(event);
    }
  }

  /**
   * Spawns a child Session with a restricted registry and an agent-type role.
   * The child shares this session's provider (so scripted/live turns are drawn
   * from the same stream, parent-then-child-then-parent), emit, and approval
   * channel. Foreground: resolves with the child's final assistant text.
   * Background: resolves with a task id; the final text lands in the task
   * output file when the child finishes.
   */
  async spawnAgent(opts: SpawnAgentOptions): Promise<string> {
    const def = resolveAgentType(opts.agentType);
    if (!def) {
      throw new Error(
        `Unknown subagent_type "${opts.agentType}". Available: ${Object.keys(AGENT_TYPES).join(", ")}.`,
      );
    }
    if (this.activeChildren >= Session.MAX_CHILDREN) {
      throw new Error(
        `Too many concurrent subagents (max ${Session.MAX_CHILDREN}). Wait for running subagents to finish before spawning more.`,
      );
    }

    const agentId = `ag_${++Session.agentCounter}`;
    const agentDesc = opts.description;
    // Children inherit the lifted budgets — a capped child inside an uncapped
    // run is a hidden stop.
    const childSettings = { ...this.settings, maxIterationsPerTurn: Number.MAX_SAFE_INTEGER, maxTokensPerTurn: Number.MAX_SAFE_INTEGER };

    const allNames = this.registry.list().map((t) => t.name);
    const childRegistry = this.registry.subset(agentToolNames(def, allNames));
    const system = buildSystemPrompt({
      env: {
        cwd: this.cwd,
        isGitRepo: existsSync(join(this.cwd, ".git")),
        platform: process.platform,
        model: childSettings.model,
        date: new Date().toISOString().slice(0, 10),
      },
      addons: [],
      extraSections: [agentRoleText(def), promptText(SUBAGENT_RESULT_ID)],
    });
    const child = new Session({
      cwd: this.cwd,
      settings: childSettings,
      provider: this.provider,
      registry: childRegistry,
      emit: (event) => this.emitFromChild(event, agentId, agentDesc),
      requestApproval: this.opts.requestApproval,
      askUser: async () => {
        throw new Error("subagents cannot ask the user — decide or report back");
      },
      systemPromptOverride: system,
      // The child shares this session's PermissionEngine: an "always allow
      // this session" granted during one subagent's run holds for the next.
      permissionEngine: this.permissions,
      // ...and its stats ledger: a subagent's spend belongs in the same
      // /session report as the orchestrator's.
      stats: this.stats,
      child: true,
    });

    // Announce the dispatch before the child's first model turn: without this
    // the frontend hears nothing until the child's first tool call, so a
    // parallel fan-out looks stalled for a full LLM turn.
    const spawnedEvent = {
      type: "agent_spawned" as const,
      agentId,
      agentDesc,
    };

    if (opts.runInBackground) {
      const info = this.background.launch({
        kind: "agent",
        description: opts.description,
        start: (outputFile, onExit) => {
          this.activeChildren++;
          this.emit({ ...spawnedEvent, background: true });
          void (async () => {
            try {
              await child.runTurn(opts.prompt);
              writeFileSync(outputFile, finalAssistantText(child));
              this.emit({ type: "agent_finished", agentId });
              onExit(0);
            } catch (err) {
              writeFileSync(outputFile, `Subagent failed: ${(err as Error).message}`);
              this.emit({ type: "agent_finished", agentId, isError: true });
              onExit(1);
            } finally {
              this.activeChildren--;
            }
          })();
          return { stop: () => child.interrupt() };
        },
      });
      return info.id;
    }

    this.activeChildren++;
    this.liveChildren.add(child);
    this.emit(spawnedEvent);
    let failed = false;
    try {
      await child.runTurn(opts.prompt);
      return finalAssistantText(child);
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      this.activeChildren--;
      this.liveChildren.delete(child);
      this.emit({ type: "agent_finished", agentId, ...(failed ? { isError: true } : {}) });
    }
  }


  /**
   * HARD STOP — everything this session started, stopped now.
   *
   * "Stop" only means something if it reaches all the way. Two kinds of work
   * outlive a naive abort, and each is cut here:
   *
   *   1. the current turn, and every subagent under it (they run their own
   *      controllers, so aborting only this session would leave them burning
   *      tokens while the parent waits on their results);
   *   2. background jobs (bash, monitors) — detached from any turn, so nothing
   *      else would ever kill them.
   *
   * Idempotent and safe when idle.
   */
  interrupt(): void {
    this.abortController?.abort(new Error("interrupted by user"));
    for (const child of this.liveChildren) child.interrupt();
    this.stopBackgroundTasks();
  }

  /** Kills every still-running background job this session launched. Returns how many died. */
  private stopBackgroundTasks(): number {
    let stopped = 0;
    for (const task of this.background.list()) {
      if (task.status === "running" && this.background.stop(task.id)) stopped++;
    }
    return stopped;
  }

  isBusy(): boolean {
    return this.busy;
  }

  toolSchemas(): ToolSchema[] {
    return this.registry.enabled().map((t) => ({
      name: t.name,
      description: toolDescriptionText(t.name, t.description, t.descriptionVars),
      inputSchema: t.rawInputSchema ?? zodToJsonSchema(t.inputSchema),
    }));
  }

  buildSystemPrompt(): string {
    if (this.opts.systemPromptOverride) return this.opts.systemPromptOverride;
    const standards = loadStandards(this.cwd);
    return buildSystemPrompt({
      env: {
        cwd: this.cwd,
        isGitRepo: existsSync(join(this.cwd, ".git")),
        platform: process.platform,
        model: this.settings.model,
        date: new Date().toISOString().slice(0, 10),
      },
      addons: this.opts.addons ?? [],
      extraSections: [
        ...this.extraPromptSections,
        ...this.dynamicSections.values(),
        // A disabled header drops the whole section, body and all. Injecting the
        // file's contents with no header would hand the model an unlabelled wall
        // of text — worse than not sending it, and not what emptying a section
        // means anywhere else in the registry.
        ...(standards ? Session.section(STANDARDS_SECTION_HEADER, standards) : []),
      ],
    });
  }

  /**
   * A file-backed system section — its header plus the file's contents — or
   * nothing at all when the header prompt is switched off.
   */
  private static section(headerId: string, body: string): string[] {
    const header = promptTextIfEnabled(headerId);
    return header === undefined ? [] : [`${header}\n\n${body}`];
  }

  /**
   * A compact snippet of the last exchange, so a follow-up ("improve it") is
   * judged with what came before in view instead of looking open-ended on its
   * own. Shared by every pre-layer that has to reason about the request.
   *
   * Harness scaffolding is stripped before sampling: a turn that was
   * interrupted (or resumed) leaves messages whose entire text is a
   * <system-reminder> block, and sampling those as "the exchange" hands the
   * clarify judge a context that says nothing about the work. That is exactly
   * how "continue your work" after a resume got answered with "I don't have
   * context from a previous task" — the judge's snippet was two interrupt
   * markers. The window is wider than the two lines kept, for the same reason:
   * an interrupt-heavy tail must not push the real exchange out of reach.
   */
  private recentExchange(): string {
    const recent = this.messages
      .slice(-10)
      .map((m) => ({
        role: m.role,
        text: assistantText(m).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim(),
      }))
      .filter((m) => m.text.length > 0)
      .slice(-2)
      .map((m) => `${m.role}: ${m.text.length > 400 ? `${m.text.slice(0, 400)}…` : m.text}`)
      .join("\n");
    return recent ? `Previous exchange:\n${recent}\n\n` : "";
  }

  /**
   * Clarify pre-layer: judges the incoming request with the MAIN model and,
   * when it is genuinely open-ended, asks the user up to three shape-defining
   * multiple-choice questions before any work starts. Returns the answers as
   * a text block to ride with the user message, or undefined to just start.
   * Strictly fail-open — a broken verdict must never cost the user the turn.
   */
  private async maybeClarify(userText: string): Promise<string | undefined> {
    // Emptying the prompt switches the whole pre-layer off. It has to be checked
    // HERE and not just at the call site's `settings.clarify`: this layer is a
    // full main-model round trip before any work starts, and running it with no
    // system prompt would charge the user that latency to ask nothing.
    const system = promptTextIfEnabled(CLARIFY_SYSTEM);
    if (system === undefined) return undefined;
    // Ground the verdict in a cursory look at the code, so the questions are
    // about real, specific choices — and so nothing the code already answers
    // gets asked. Deterministic (file/graph reads, no model call): it rides
    // inside this one inference, adding no round-trip. Fail-open by design.
    const skim = this.buildClarifySkim();
    let raw: string;
    try {
      raw = await this.runInference({
        system,
        user: `${this.recentExchange()}${skim ? `Codebase overview:\n${skim}\n\n` : ""}Incoming request:\n${userText}`,
        // Three questions with four described options each does not fit in 600
        // either — the same undersized budget, and the same
        // silent outcome, because a truncated reply has no `"clarify": true` to
        // find. This layer is older and quieter, so it was never reported; that
        // makes it more worth fixing, not less.
        maxTokens: 2000,
        model: this.settings.model,
      });
    } catch {
      return undefined;
    }
    const questions = parseClarifyVerdict(raw);
    if (questions === undefined) return undefined;
    this.emit({ type: "command_output", text: "🧭 open-ended request — clarifying before starting" });
    return this.askQuestionRound(
      questions,
      "Clarify pre-layer: before starting, the user answered these questions — honor the answers as requirements. Unanswered questions are yours to decide sensibly:",
    );
  }

  /**
   * Puts a round of shape-defining questions to the user and records their
   * answers as a reminder block for the model.
   *
   * Used by the clarify pre-layer:
   * ask at most three questions that only the user can settle, and both must
   * treat the answers as requirements, so the two must not drift apart in how
   * they record them. Returns undefined when the frontend cannot answer — a
   * question round that fails must never cost the turn.
   */
  private async askQuestionRound(questions: ShapeQuestion[], preamble: string): Promise<string | undefined> {
    let answers: Record<string, string[]>;
    try {
      answers = await this.opts.askUser(`q_${randomBytes(4).toString("hex")}`, questions);
    } catch {
      return undefined;
    }
    const lines = questions.map((q, idx) => {
      const selected = answers[`q:${idx}`] ?? answers[q.question] ?? [];
      return `${q.question}\n-> ${selected.length > 0 ? selected.join(", ") : "(no answer)"}`;
    });
    return `<system-reminder>${preamble}\n\n${lines.join("\n\n")}</system-reminder>`;
  }

  /**
   * A quick, cursory read of the workspace for the clarify pre-layer, so its
   * questions are grounded in what the code actually is. Layered by cost, richest
   * first, and fail-open — any error yields no skim and the clarify proceeds as
   * before. Both sources are deterministic reads (no model call):
   *   1. an import-graph skeleton (top files + scale) — cheap on a warm cache,
   *      a one-time build if cold;
   *   2. else a bounded peek at the working dir (README/manifests + layout), so
   *      even a project the graph cannot parse still gets an overview.
   * The result is capped so it stays a cursory glance, never a context dump.
   */
  private buildClarifySkim(): string | undefined {
    let digest: string | undefined;
    try {
      // workspaceLooksNonTrivial is a depth-1 check — cheap enough to gate the
      // graph load, which the user opted to allow to build once when cold.
      const skeleton = workspaceLooksNonTrivial(this.cwd)
        ? graphSkeleton(loadOrBuildGraph(this.cwd), projectName(this.cwd))
        : undefined;
      digest = skeleton ?? this.peekWorkspaceOverview();
    } catch {
      return undefined; // fail-open — the question must never wait on the skim
    }
    if (!digest) return undefined;
    return digest.length > CLARIFY_SKIM_MAX_CHARS
      ? `${digest.slice(0, CLARIFY_SKIM_MAX_CHARS)}\n[overview truncated]`
      : digest;
  }

  /**
   * The unmapped-project fallback: the top-level layout plus a bounded read of
   * the obvious overview files (README, package manifests). Byte-capped so a
   * giant README can never turn a cursory glance into a slow one.
   */
  private peekWorkspaceOverview(): string | undefined {
    const parts: string[] = [];
    try {
      const entries = readdirSync(this.cwd, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
      const names = [
        ...entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`),
        ...entries.filter((e) => e.isFile()).map((e) => e.name),
      ].slice(0, 30);
      if (names.length > 0) parts.push(`Top level: ${names.join(", ")}`);
    } catch {
      // no listing — the overview files below may still exist
    }
    let budget = CLARIFY_PEEK_MAX_CHARS;
    for (const name of CLARIFY_PEEK_FILES) {
      if (budget <= 0) break;
      let content: string;
      try {
        content = readFileSync(join(this.cwd, name), "utf8");
      } catch {
        continue; // absent/unreadable — try the next candidate
      }
      if (!content.trim()) continue;
      const snippet = content.length > budget ? `${content.slice(0, budget)}\n[…]` : content;
      budget -= snippet.length;
      parts.push(`--- ${name} ---\n${snippet.trim()}`);
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  /** Runs one full user turn: model call -> tool calls -> ... -> final text. */
  async runTurn(userText: string): Promise<void> {
    if (this.busy) throw new Error("session is already processing a turn");
    this.busy = true;

    if (this.hooks?.has("UserPromptSubmit")) {
      const summary = this.hooks.summarize(
        await this.hooks.run("UserPromptSubmit", {
          hook_event_name: "UserPromptSubmit",
          session_id: this.id,
          cwd: this.cwd,
          prompt: userText,
        }),
      );
      if (summary.blocked) {
        this.busy = false;
        this.emit({
          type: "error",
          message: `UserPromptSubmit hook blocked this prompt: ${summary.blockReason}`,
          fatal: false,
        });
        return;
      }
      if (summary.contextText) this.remind(summary.contextText);
    }

    if (this.tasks.list().length === 0) {
      if (!this.planReminderFired) {
        this.remind(promptText(PLAN_FIRST_REMINDER));
        this.planReminderFired = true;
      }
    } else {
      this.planReminderFired = false;
    }

    // Finishing rungs: both the evidence they judge and their once-per-turn
    // fuses are about THIS turn's work, so they all reset together.
    this.filesChangedThisTurn.clear();
    this.doubleFilesThisTurn.clear();
    this.ranCommandThisTurn = false;
    this.evidenceNudgeFired = false;
    this.incompleteTasksNudgeFired = false;

    const turnId = `t_${++this.turnCounter}`;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    /** This session's OWN main-loop spend, which is what the per-turn budget is
     *  about. The tree-wide total (this plus the auxiliary prompts and every
     *  subagent) is the stats phase, opened just below. */
    const turnUsage: Usage = emptyUsage();
    // Open the deliberation phase: from here every invocation anywhere in the
    // tree counts toward this turn's D(t) and T_turn. Only the root opens one —
    // children share this ledger, so a subagent must add to the phase in flight
    // rather than restart it and zero the meter the user is watching.
    if (!this.opts.child) this.stats.beginPhase();

    this.emit({ type: "turn_started", turnId });

    // The pre-layers that put questions to the user, in the order they matter.
    //
    // A message that NAMES an installed addon carries its own shape — the
    // procedure is on disk and its description is already in the system prompt.
    // Point at it, and skip the clarify round entirely: "bana /grill-me yap" was
    // answered with a menu asking what /grill-me ought to be, which is the one
    // question the addon itself already answers.
    //
    // Outside the clarify branch so it fires with `clarify` off too — naming an
    // addon should reach the addon either way.
    const namedAddon = addonNamedIn(userText, this.opts.addons ?? []);
    if (namedAddon !== undefined) this.remind(renderPrompt(ADDON_NAMED_REMINDER, { name: namedAddon }));

    let clarification: string | undefined;
    if (this.settings.clarify && !this.opts.child && namedAddon === undefined) {
      clarification = await this.maybeClarify(userText);
    }

    // OVERDRIVE safety net: before an uncapped autonomous turn starts, park a
    // dangling stash commit of the working tree so anything an in-workspace
    // deletion later removes stays recoverable. Root sessions only — children
    // share the same tree.
    if (this.overdrive && !this.opts.child) await this.snapshotForOverdrive();

    this.pushMessage({
      role: "user",
      content: this.withReminders([
        { type: "text", text: userText },
        ...(clarification !== undefined ? [{ type: "text" as const, text: clarification }] : []),
      ]),
    });

    let stopReason: string = "end_turn";
    let stopHookFired = false;
    let lastBatchHadError = false;
    let nudgeCount = 0;
    // Consecutive output-length cutoffs (see MAX_CUTOFF_STREAK) and context
    // overflows recovered by compaction (see MAX_OVERFLOW_RECOVERIES).
    let cutoffStreak = 0;
    let overflowRecoveries = 0;
    // The interactive root turn runs uncapped — the stall detector is the
    // brake. Only children keep the numeric budgets, so an explicit
    // spawn-time child cap is still enforced.
    const capped = this.opts.child ?? false;
    // Once per turn (re-armed when mid-run steering arrives): the end check
    // that gates a clean break on "is the query truly handled".
    let selfVerifyFired = false;
    // True for exactly the one streamed response that answers the self-verify
    // injection — that response is buffered (not shown live) so a clean DONE
    // stays invisible and only genuine follow-up work reaches the user.
    let verifyBuffered = false;
    // Stall detector state: the previous round's signature (tool
    // calls + results), how many consecutive rounds matched it, and how many
    // strategy pivots have been spent (2 pivots, then ask the user).
    let lastRoundSig = "";
    let identicalRounds = 0;
    let pivotCount = 0;
    let totalToolCallsThisTurn = 0;
    // Mid-run steering drain: injects queued user guidance at a message
    // boundary. New guidance re-arms the self-verify rung and refunds spent
    // pivots — the user changed the game, so the old stall evidence is void.
    const drainSteering = (): boolean => {
      if (this.pendingSteering.length === 0) return false;
      const texts = this.pendingSteering.splice(0);
      selfVerifyFired = false;
      pivotCount = 0;
      identicalRounds = 0;
      lastRoundSig = "";
      this.pushMessage({
        role: "user",
        content: texts.map((t) => ({
          type: "text" as const,
          text: `<system-reminder>The user adds, mid-run — steer the ongoing work accordingly:</system-reminder>\n${t}`,
        })),
      });
      return true;
    };
    try {
      for (let iteration = 0; ; iteration++) {
        // Interactive root turns run uncapped: the turn runs until the query
        // is handled (self-verify rung) or the user interrupts.
        if (capped && iteration >= this.settings.maxIterationsPerTurn) {
          this.emit({
            type: "command_output",
            text: `⏸ Iteration cap reached (${iteration} tool rounds) — send any message to continue.`,
          });
          stopReason = "max_iterations";
          break;
        }
        if (capped && turnUsage.outputTokens > this.settings.maxTokensPerTurn) {
          this.emit({
            type: "command_output",
            text: `⏸ Turn token budget reached (${turnUsage.outputTokens} output tokens) — send any message to continue.`,
          });
          break;
        }

        // Steering that arrived while tools ran lands before the next model
        // call — the earliest boundary the protocol has.
        drainSteering();

        let streamed: Awaited<ReturnType<Session["streamAssistantTurn"]>>;
        try {
          streamed = await this.streamAssistantTurn(signal);
        } catch (err) {
          // The request itself outgrew the model's window (HTTP 400/413, or an
          // in-band error chunk). The auto-compaction threshold is meant to
          // fire first, but a huge tool result or a stale estimate can leap
          // past it — so recover the way /compact would, then retry the same
          // call. Nothing was streamed: an overflow is refused before output.
          if (!signal.aborted && isContextOverflowError(err) && overflowRecoveries < MAX_OVERFLOW_RECOVERIES) {
            overflowRecoveries++;
            this.emit({
              type: "command_output",
              text: `↻ the request exceeded the model's context window — compacting older history and retrying (${overflowRecoveries}/${MAX_OVERFLOW_RECOVERIES})`,
            });
            if (await this.maybeCompact(true)) continue;
          }
          throw err;
        }
        const { assistant, toolCalls, end } = streamed;
        // turnUsage ACCUMULATES (it is billed cost for this turn). The context
        // size does NOT — streamAssistantTurn already set stats.contextTokens
        // from this one response's own input. Never sum the two concepts.
        addUsage(turnUsage, end.usage);

        // Self-verify result: this one response was streamed silently.
        // A bare DONE means the query was already handled — end the turn with
        // no second message. Anything else is genuine follow-up work or a
        // revised answer, so reveal the buffered text now and let it flow.
        if (verifyBuffered) {
          verifyBuffered = false;
          this.suppressAssistantText = false;
          const verifyText = assistantText(assistant).trim();
          if (toolCalls.length === 0 && isSelfVerifyDone(verifyText)) {
            // Record the sentinel so history stays well-formed; it is never
            // rendered. The user's single original answer stands as the reply.
            if (assistant.content.length > 0) this.pushMessage(assistant);
            // The status chatter is OVERDRIVE identity flavor; the plain
            // stance verifies just as silently as it works.
            if (this.overdrive) {
              this.emit({ type: "command_output", text: "✓ overdrive: verified — nothing left to do" });
            }
            stopReason = "end_turn";
            break;
          }
          if (verifyText) this.emit({ type: "text_delta", text: verifyText });
        }

        if (assistant.content.length > 0) this.pushMessage(assistant);
        stopReason = end.stopReason;

        // Input plus output filled the window mid-response. The response is
        // truncated exactly as at max_tokens, but "continue" alone would
        // overflow again on a bigger history — compact first, then let the
        // cutoff rungs below resume it. Beyond the recovery budget, end the
        // turn with a visible reason instead of a silent break.
        if (stopReason === "context_overflow") {
          if (overflowRecoveries >= MAX_OVERFLOW_RECOVERIES || !(await this.maybeCompact(true))) {
            this.emit({
              type: "error",
              message:
                "The model's context window is full and the conversation cannot be compacted further. Start a fresh session with /clear, or set this connection's Context size to the model's real window.",
              fatal: false,
            });
            if (toolCalls.length > 0) this.pushMessage({ role: "user", content: this.withReminders(syntheticToolResults(unansweredToolUseIds(assistant))) });
            break;
          }
          overflowRecoveries++;
          this.emit({
            type: "command_output",
            text: `↻ the response hit the model's context window — compacted older history (${overflowRecoveries}/${MAX_OVERFLOW_RECOVERIES}), resuming`,
          });
          stopReason = "max_tokens";
        }
        cutoffStreak = stopReason === "max_tokens" ? cutoffStreak + 1 : 0;

        if (toolCalls.length === 0) {
          // Pending steering outranks every end-of-turn decision: the user's
          // mid-run guidance must be acted on, not dropped by a clean break.
          if (drainSteering()) continue;

          if (stopReason === "end_turn" && !stopHookFired && this.hooks?.has("Stop")) {
            stopHookFired = true;
            const summary = this.hooks.summarize(
              await this.hooks.run("Stop", {
                hook_event_name: "Stop",
                session_id: this.id,
                cwd: this.cwd,
              }),
            );
            if (summary.blocked) {
              this.pushMessage({
                role: "user",
                content: [
                  { type: "text", text: `<system-reminder>Stop hook: ${summary.blockReason}</system-reminder>` },
                ],
              });
              continue;
            }
          }

          // LAYER 3: the provider cut the response off at the output-token
          // limit with no tool calls pending — resume rather than ending the
          // turn on a truncated answer. Bounded by MAX_CUTOFF_STREAK, its own
          // counter: a model that answers "length" every time would otherwise
          // resume forever (the root turn has no iteration cap to catch it),
          // and sharing the nudge budget meant an error-recovery nudge spent
          // earlier could silently end a turn that only needed resuming.
          if (stopReason === "max_tokens") {
            if (cutoffStreak <= MAX_CUTOFF_STREAK) {
              this.emit({ type: "command_output", text: "↻ continuing after output-length cutoff" });
              this.pushMessage({ role: "user", content: [{ type: "text", text: promptText(LENGTH_CONTINUATION_TEXT) }] });
              continue;
            }
            this.emit({
              type: "command_output",
              text: `⏸ the response was cut off ${cutoffStreak} times in a row — ending the turn. Ask for the work in smaller pieces, or raise maxTokensPerResponse.`,
            });
            break;
          }

          // LAYER 2: the previous tool-result batch had a failure and the
          // turn is ending regardless of what the final text says — weak
          // models sometimes bury a failure under a long non-answer. Nudge
          // it to keep going; the stall detector terminates a model that
          // keeps failing identically.
          //
          // The flag is spent on the nudge, and the whole rung is bounded by
          // MAX_AUTO_NUDGES. Both matter: lastBatchHadError is only ever
          // assigned after a tool batch, so on a no-tool-call answer it stays
          // true forever — this rung used to re-fire every iteration of an
          // uncapped turn, and because it sits above the self-verify rung, a
          // turn whose last batch failed never self-verified at all. A later
          // failing batch sets it again, so real recovery still gets nudged.
          if (stopReason === "end_turn" && lastBatchHadError && nudgeCount < MAX_AUTO_NUDGES) {
            nudgeCount++;
            lastBatchHadError = false;
            this.emit({
              type: "command_output",
              text: "↻ auto-recovery: nudging the agent to continue after a failed tool call",
            });
            this.pushMessage({ role: "user", content: [{ type: "text", text: promptText(RECOVERY_NUDGE_TEXT) }] });
            continue;
          }

          // LAYER 1.5: the turn is ending cleanly but the task list still has
          // pending or in-progress work — nudge the model to finish or
          // explicitly justify leaving it open. Checked after error-recovery
          // (a failure takes priority) and before the wrap-up nudge.
          //
          // Fires ONCE per turn, like every other rung on this ladder. Without
          // the fuse it re-fired on each attempt to end the turn for as long as
          // anything stayed open, and each firing is a full-context round trip.
          // A plan of six tasks could therefore charge six extra model calls for
          // one turn's work, which made planning itself expensive and turned the
          // task list into a latency multiplier. Saying it twice does not tell
          // the model anything the first reminder did not; if it ends the turn
          // again with work still open, that is an answer, and the wrap-up rung
          // below is where the user hears about it.
          //
          // It also no longer touches nudgeCount. That counter is the wrap-up
          // rung's budget and nothing else reads it, so incrementing here only
          // starved the summary this rung's own reminder asks for.
          if (stopReason === "end_turn" && !lastBatchHadError && !this.incompleteTasksNudgeFired) {
            const incomplete = this.tasks.list().filter((t) => t.status === "pending" || t.status === "in_progress");
            if (incomplete.length > 0) {
              this.incompleteTasksNudgeFired = true;
              this.emit({ type: "command_output", text: "↻ tasks incomplete — continuing" });
              this.pushMessage({ role: "user", content: [{ type: "text", text: incompleteTasksNudgeText(incomplete) }] });
              continue;
            }
          }

          // RUNTIME EVIDENCE FLOOR: the turn rewrote source files and never ran
          // a single command, so every claim it is about to make about that code
          // is an inference. Deterministic, fires once, and only reminds — the
          // It catches a quiet failure: a turn that looks finished and is not.
          //
          // Placed ahead of the self-verify rung deliberately. A self-verify
          // that answers DONE breaks the loop where it stands, so anything
          // ranked below it on a clean turn would never run at all.
          //
          // The floor has two shapes, and they ask the same question of two
          // different turns: is the evidence about the REAL thing?
          //
          //   nothing ran        — the change was reasoned about, never observed
          //   only doubles ran   — something was observed, but it was a stand-in
          //                        this turn wrote, which agrees with whatever
          //                        the author believed and so cannot disprove it
          //
          // The second shape exists because the first one, alone, pushes toward
          // the very failure it is meant to catch: told "you ran nothing" about
          // a dependency this machine cannot execute, the cheapest way to go
          // quiet is to mock it and watch the mock pass. Both texts therefore
          // name an honest "I could not run this" as a complete answer.
          //
          // ONE rung, two shapes. They used to be two prompts firing on opposite
          // halves of `ranCommandThisTurn`, which meant disabling either one
          // silently uncovered its half — a turn that ran only its own mocks got
          // no reminder at all, because a command HAD run. Folding the stand-in
          // argument into the same text as a conditional clause keeps both cases
          // covered by a single fuse and a single prompt an operator can find.
          if (stopReason === "end_turn" && !this.evidenceNudgeFired) {
            const changedCode = codeFilesAmong(this.filesChangedThisTurn);
            const doubles = [...this.doubleFilesThisTurn];
            const nothingRan = !this.ranCommandThisTurn;
            const onlyDoubles = this.ranCommandThisTurn && doubles.length > 0;
            if (changedCode.length > 0 && (nothingRan || onlyDoubles)) {
              this.evidenceNudgeFired = true;
              this.emit({
                type: "command_output",
                text: nothingRan
                  ? "↻ nothing was run — verifying the change for real"
                  : "↻ checked against your own stand-in — confirm the real contract",
              });
              this.pushMessage({
                role: "user",
                // "Vision is on" for the agent means an image can actually be
                // looked at — the flag alone is not enough without an endpoint
                // to send it to.
                content: [
                  {
                    type: "text",
                    text: runtimeEvidenceText(changedCode, this.visionUnavailableReason() === undefined, doubles),
                  },
                ],
              });
              continue;
            }
          }

          // Self-verify rung: the first time the turn tries to end cleanly,
          // make the model check the outcome against the original query
          // (completeness + economy) before the break is allowed. Runs after
          // the signal rungs above — a real failure or open task list always
          // outranks a politeness check — and before the wrap-up rung, which
          // it subsumes. A purely conversational turn (no tools all turn, so
          // nothing was built and nothing can be left behind) has nothing to
          // verify: skip the rung so a greeting ends instantly, with no extra
          // round-trip and no risk of a leaked sentinel.
          //
          // OVERDRIVE only (2026-07-26). Autonomous runs are exactly where an
          // unverified "I think I'm done" is expensive: nothing asked, so the
          // user saw no checkpoint along the way. An attended turn already has
          // one — the user reads the reply — and does not need to pay a round
          // trip per turn for a second opinion.
          // undefined means the rung is switched off in the prompt registry. Skip
          // the round entirely then — pushing a blank message would still spend
          // the inference round the operator emptied the prompt to avoid.
          const verify =
            stopReason === "end_turn" && !selfVerifyFired && totalToolCallsThisTurn > 0 && this.overdrive
              ? selfVerifyText(codeFilesAmong(this.filesChangedThisTurn))
              : undefined;
          if (verify !== undefined) {
            selfVerifyFired = true;
            verifyBuffered = true;
            this.suppressAssistantText = true; // the verify answer streams silently
            this.emit({ type: "command_output", text: "⚡ overdrive: self-verifying against the original query" });
            this.pushMessage({ role: "user", content: [{ type: "text", text: verify }] });
            continue;
          }

          // LAYER 1: the turn did substantial tool-driven work but ended on a
          // bare reply with no wrap-up for the user — nudge once for a summary
          // rather than letting the turn end in silence. Checked after LAYER 2
          // so error-recovery still takes priority over the wrap-up nudge.
          if (
            stopReason === "end_turn" &&
            !lastBatchHadError &&
            totalToolCallsThisTurn >= 5 &&
            assistantTextLength(assistant) < 150 &&
            nudgeCount < MAX_AUTO_NUDGES
          ) {
            nudgeCount++;
            this.emit({ type: "command_output", text: "↻ requesting a work summary" });
            // Whether anything was actually written, from the same observation
            // the finishing rungs use: a Write that was refused or that failed
            // its freshness check changed no module, so it must not pull in the
            // standards reminder.
            const wroteOrEdited = this.filesChangedThisTurn.size > 0;
            const mentionStandards = wroteOrEdited && loadStandards(this.cwd) !== undefined;
            this.pushMessage({
              role: "user",
              content: [{ type: "text", text: wrapupNudgeText(mentionStandards) }],
            });
            continue;
          }

          break;
        }

        // A max_tokens stop with tool calls pending means the response was cut
        // off mid-tool-call. Surface the same continuation marker the text path
        // shows (Layer 3); the truncated call is rejected with TOOL_CUTOFF_TEXT
        // inside executeToolCalls, and complete calls in the batch still run.
        // The streak check lives after the results are pushed (below), so the
        // history never ends on a tool_use without its results.
        if (stopReason === "max_tokens") {
          this.emit({ type: "command_output", text: "↻ continuing after output-length cutoff" });
        }
        totalToolCallsThisTurn += toolCalls.length;
        const results = await this.executeToolCalls(toolCalls, signal);
        lastBatchHadError = results.some((r) => r.type === "tool_result" && r.isError === true);
        if (lastBatchHadError) {
          this.remind(promptText(ERROR_BATCH_REMINDER));
        }
        // Stall detector: a round that exactly repeats the previous one (same
        // calls, same results) produced nothing new. Three in a row is a
        // stall — force a strategy pivot; after two spent pivots, force one
        // concrete question to the user instead of burning forever.
        {
          // The fingerprint must describe WORK, not identity. tool_result blocks
          // carry toolUseId — the provider's per-call random id (`call_…`,
          // `toolu_…`) — so serializing them whole made every round unique,
          // pinned identicalRounds at 0, and meant this detector had never once
          // fired in production. The tool-call half already omitted `c.id` for
          // exactly this reason; the result half was the oversight.
          //
          // Two defeaters remain, deliberately unfixed here: results that mint
          // their own fresh id (a background/monitor launch reports "task id:
          // bash_<random>", scheduling/background.ts) and image results, which
          // describeToolImages replaces with non-deterministic vision prose.
          // Loops built out of those still will not be detected.
          const sig = JSON.stringify([
            toolCalls.map((c) => c.name + c.json),
            results.map((r) => (r.type === "tool_result" ? [r.isError === true, r.content] : r.type)),
          ]);
          identicalRounds = sig === lastRoundSig ? identicalRounds + 1 : 0;
          lastRoundSig = sig;
          if (identicalRounds >= 2) {
            identicalRounds = 0;
            if (pivotCount < 2) {
              pivotCount++;
              this.emit({ type: "command_output", text: `⚡ stall detected — forcing strategy pivot ${pivotCount}/2` });
              this.remind(promptText(STALL_PIVOT_TEXT));
            } else {
              this.emit({ type: "command_output", text: "⚡ still stalled after pivots — asking the user" });
              this.remind(promptText(STALL_ASK_TEXT));
            }
          }
        }
        // These results are read in round iteration+1; the last round that
        // streams before the cap breaks the loop is cap-1. Warn the model ON
        // that final round (teaching, not enforcement): a weak model that
        // over-explores otherwise ends the turn cut off mid-exploration with
        // no final answer.
        if (capped && iteration === this.settings.maxIterationsPerTurn - 2) {
          this.remind(
            "Final tool round: the per-turn iteration cap is reached after this response. Give your complete final answer now — further tool calls will be cut off.",
          );
        }
        this.pushMessage({ role: "user", content: this.withReminders(results) });
        // The tool-call twin of LAYER 3's bound: a model that is cut off
        // mid-call this many times running is reissuing the same oversized
        // call (a whole file in one Write) and will be cut off again. This
        // path used to be unbounded — the endless "↻ continuing" transcript.
        if (stopReason === "max_tokens" && cutoffStreak > MAX_CUTOFF_STREAK) {
          this.emit({
            type: "command_output",
            text: `⏸ the response was cut off mid tool call ${cutoffStreak} times in a row — ending the turn. Ask for the work in smaller pieces (e.g. write the file in parts), or raise maxTokensPerResponse.`,
          });
          break;
        }
        // Mid-turn compaction: a long tool loop must squeeze the window when it
        // fills instead of dying on a provider context error at the next call.
        // (maybeCompact self-gates on the threshold, so this is cheap.)
        await this.maybeCompact();
      }
    } catch (err) {
      // If the turn died between an assistant tool_use and its results, the
      // history is malformed until each dangling call gets a tool_result —
      // providers reject the next request otherwise (and /resume replays the
      // same wound). Synthesize the missing results before recording anything.
      const repairs = syntheticToolResults(
        unansweredToolUseIds(this.messages[this.messages.length - 1]),
      );
      if (signal.aborted) {
        stopReason = "aborted";
        this.pushMessage({
          role: "user",
          content: [
            ...repairs,
            { type: "text", text: "<system-reminder>The user interrupted this turn before it finished.</system-reminder>" },
          ],
        });
      } else {
        stopReason = "error";
        // Provider failures reach the user here: a raw "provider returned 401:
        // {json}" means nothing, so classify to a plain-English cause. The
        // original text is preserved in the engine log by the desktop layer.
        const host = providerHost(this.settings);
        this.emit({ type: "error", message: friendlyProviderError(err, host), fatal: false });
        if (repairs.length > 0) {
          this.pushMessage({
            role: "user",
            content: [
              ...repairs,
              { type: "text", text: "<system-reminder>This turn ended with an error before its tool calls completed.</system-reminder>" },
            ],
          });
        }
      }
    } finally {
      this.busy = false;
      // A turn that died mid-self-verify must not leave the next turn muted.
      this.suppressAssistantText = false;
      this.abortController = undefined;
      this.lastTurnUsage = turnUsage;
      // Close the phase. Its total is T_turn — every invocation the turn made,
      // this session's plus its auxiliary prompts plus every subagent's — and
      // its output component is the authoritative D_final that supersedes the
      // estimates streamed while the turn ran. A child never closes the phase:
      // the root's turn is still open around it, so it reports only its own
      // spend and leaves the tree-wide total to the root.
      const reportedUsage = this.opts.child ? turnUsage : this.stats.endPhase();
      this.emit({
        type: "turn_finished",
        turnId,
        stopReason,
        usage: reportedUsage,
        contextTokens: this.stats.contextTokens,
        // Cost is intentionally not surfaced: our token counting and a
        // provider's billing can diverge, so any figure risks misinforming.
        ...(this.contextOverWarnThreshold() ? { contextWarn: true } : {}),
        ...(this.overdrive && this.overdriveSnapshotRef !== undefined
          ? { overdriveSnapshot: this.overdriveSnapshotRef }
          : {}),
      });
      // Snapshot the tree-wide ledger so /resume restores real accounting
      // instead of a $0.00 session. Children share the root's ledger, so only
      // the root writes it.
      if (!this.opts.child) {
        this.transcript.append({
          kind: "meta",
          data: {
            stats: this.stats.snapshot(),
            model: this.settings.model,
            overdrive: this.overdrive,
            ...(this.label !== undefined ? { label: this.label } : {}),
          },
        });
      }
    }

    await this.maybeCompact();
  }

  private async streamAssistantTurn(signal: AbortSignal): Promise<{
    assistant: Msg;
    toolCalls: PendingToolCall[];
    end: { stopReason: StopReason; usage: Usage };
  }> {
    const blocks: ContentBlock[] = [];
    const toolCalls: PendingToolCall[] = [];
    let text = "";
    let thinking = "";
    let end: { stopReason: StopReason; usage: Usage } = {
      stopReason: "end_turn",
      usage: emptyUsage(),
    };

    const model = this.settings.model;
    const apiStartedAt = Date.now();

    // The live token meters. Without them a frontend only learns either figure
    // once per turn (at turn_finished), so a long reply looks frozen.
    //
    // B(t) — the INPUT of the call now in flight. FIXED for the whole call:
    // generated output does not enter the input context, so this is seeded with
    // an estimate of the prompt about to go out and then replaced by the exact
    // figure the moment the provider reports one (at message_start on APIs that
    // send it, otherwise at message_end). Only a root session measures a window:
    // a subagent's conversation is a different one, so a child reports the
    // root's last measurement unchanged rather than its own, much smaller, size.
    //
    // D(t) — output tokens generated by this TURN, and it only grows: every
    // completed call in the phase (this session's, its auxiliary prompts, and
    // every subagent's) is already banked exactly on the shared ledger, and this
    // call's still-streaming tail is estimated from characters until its usage
    // lands.
    //
    // The seed is computed for a root only: building the system prompt and
    // serializing the tool schemas is not free, and a child replaces this with
    // the root's measurement at emit time anyway.
    let liveContext = this.opts.child ? 0 : this.estimateContextNow();
    let emittedContext = -1;
    let emittedOutput = -1;
    const emitLiveTokens = (): void => {
      // A child reads the root's figure fresh each time rather than seeding its
      // own: the window it should report is the one the frontend is showing.
      if (this.opts.child) liveContext = this.stats.contextTokens;
      // Nothing has measured a window yet — say nothing rather than push a 0 a
      // frontend would adopt as "the context is empty".
      if (liveContext <= 0) return;
      const output = this.stats.liveDeliberationTokens(estimateTokens(text.length + thinking.length));
      // Step-gate so a fast stream emits a handful of updates, not hundreds —
      // but never swallow a context change, which moves at most once per call.
      if (liveContext === emittedContext && output - emittedOutput < 200) return;
      emittedContext = liveContext;
      emittedOutput = output;
      this.emit({
        type: "context_update",
        contextTokens: liveContext,
        outputTokens: output,
        ...(this.effectiveCompactLimit() > 0 && liveContext >= Math.floor(this.effectiveCompactLimit() * 0.9)
          ? { contextWarn: true }
          : {}),
      });
    };

    const stream = this.provider.stream({
      model,
      system: this.buildSystemPrompt(),
      messages: this.messages,
      tools: this.toolSchemas(),
      maxTokens: this.settings.maxTokensPerResponse,
      signal,
      // A silent backoff looks like a frozen spinner — narrate every retry.
      onRetry: (info) =>
        this.emit({ type: "retry_status", attempt: info.attempt, delayMs: info.delayMs, reason: info.reason }),
    });

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          // The exact input context of this call, known before a single output
          // token exists — adopt it so the meter stops estimating immediately.
          if (!this.opts.child) {
            this.stats.observeContext(event.usage);
            liveContext = this.stats.contextTokens;
          }
          emitLiveTokens();
          break;
        case "text_delta":
          text += event.text;
          if (!this.suppressAssistantText) this.emit({ type: "text_delta", text: event.text });
          emitLiveTokens();
          break;
        case "thinking_delta":
          thinking += event.text;
          if (!this.suppressAssistantText) this.emit({ type: "thinking_delta", text: event.text });
          emitLiveTokens();
          break;
        case "tool_use_start":
          toolCalls.push({ id: event.id, name: event.name, json: "" });
          break;
        case "tool_use_delta": {
          const call = toolCalls.find((c) => c.id === event.id);
          if (call) call.json += event.partialJson;
          break;
        }
        case "tool_use_end":
          break;
        case "message_end":
          end = { stopReason: event.stopReason, usage: event.usage };
          break;
      }
    }

    // Bank this response against the whole-session ledger: its billed tokens
    // (per model — a subagent may run on a different one), the API time it
    // took, and, for a root session, the window occupancy its input reveals.
    // The ledger is shared with the parent, so a subagent's spend lands in
    // the same /session report — but its window is its own conversation's, so a
    // child never writes the root's context figure.
    this.stats.recordResponse(model, end.usage, Date.now() - apiStartedAt, !this.opts.child);
    // Provider omitted usage entirely (some do on very large prompts): the
    // recorded size stayed put, but this turn's history may have grown. Fall
    // back to a conservative estimate from the real messages so the compaction
    // safety still sees roughly the true size instead of a stale, too-small one.
    if (!this.opts.child && inputTokensOf(end.usage) === 0) {
      this.stats.contextTokens = Math.max(this.stats.contextTokens, this.estimateContextTokens());
    }

    if (thinking) blocks.push({ type: "thinking", thinking });
    if (text) blocks.push({ type: "text", text });
    for (const call of toolCalls) {
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: safeParse(call.json) });
    }
    return { assistant: { role: "assistant", content: blocks }, toolCalls, end };
  }

  private async executeToolCalls(calls: PendingToolCall[], signal: AbortSignal): Promise<ContentBlock[]> {
    interface Planned {
      call: PendingToolCall;
      run: () => Promise<ToolResult>;
      parallel: boolean;
    }

    const planned: Planned[] = [];
    for (const call of calls) {
      // A tool whose description was emptied is withheld from the schema list,
      // but the model can still name one it saw earlier in the transcript. Refuse
      // it here too, or "switched off" would only hold until it was mentioned.
      if (isToolDisabled(call.name)) {
        planned.push({
          call,
          parallel: true,
          run: async () => ({
            content: `The ${call.name} tool is switched off in this workspace and cannot be called. Reach the goal another way, and do not retry it this turn.`,
            isError: true,
          }),
        });
        continue;
      }

      const tool = this.registry.get(call.name);
      if (!tool) {
        planned.push({
          call,
          parallel: true,
          run: async () => ({
            content: `Unknown tool "${call.name}". Available tools: ${this.registry.enabled().map((t) => t.name).join(", ")}`,
            isError: true,
          }),
        });
        continue;
      }

      const rawInput = safeParse(call.json);
      // Truncated tool JSON = the response was cut off mid-call. Do not run it;
      // tell the model it was cut off so it reissues (a generic schema error
      // would read as "you sent bad input" and send it debugging a phantom).
      if (isUnparseable(rawInput)) {
        planned.push({
          call,
          parallel: true,
          run: async () => ({ content: promptText(TOOL_CUTOFF_TEXT), isError: true }),
        });
        continue;
      }
      let parsed = tool.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        // One bounded repair pass before rejecting the call: models on
        // OpenAI-compatible endpoints routinely JSON-encode scalars, and the
        // call itself is otherwise well-formed. See repairPrimitiveTypes.
        const repaired = repairPrimitiveTypes(rawInput, parsed.error.issues);
        if (repaired !== undefined) parsed = tool.inputSchema.safeParse(repaired);
      }
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        planned.push({
          call,
          parallel: true,
          run: async () => ({ content: `Invalid input for ${call.name}: ${issues}`, isError: true }),
        });
        continue;
      }

      const input = parsed.data as never;
      let subject = tool.permissionSubject?.(input);
      const description = tool.describeInput?.(input);
      // A file edit that escapes the workspace must ask (it auto-runs inside).
      // Surface the absolute path as the subject so the prompt names it and an
      // "always allow" can grant that exact path.
      const editOutsidePath = tool.isFileEdit ? this.fileEditOutsideWorkspace(input) : undefined;
      if (editOutsidePath && subject === undefined) subject = editOutsidePath;
      // A file edit into .magentra/ or a .env file always confirms. Computed
      // here (not in the tool) so it holds for every current and future
      // isFileEdit tool without each one reimplementing the check.
      const editProtectedPath = tool.isFileEdit ? this.fileEditProtectedPath(input) : undefined;
      if (editProtectedPath && subject === undefined) subject = editProtectedPath;
      planned.push({
        call,
        parallel: tool.permissionClass === "read" || tool.parallelSafe === true,
        run: async () => {
          // Reuse gate: record any search/query evidence this call carries, then
          // (for a Write) decide whether a reuse reminder should ride along.
          if (tool.searchTerms) {
            try {
              this.searchLog.record(tool.searchTerms(input));
            } catch {
              // evidence logging must never break the call it observes
            }
          }
          if (tool.name === "Write") {
            const gate = this.evaluateWriteReuseGate(input);
            // The reuse check never blocks the flow — the reminder rides
            // along with the allowed Write (silent refusals were the root of
            // "it suddenly stops").
            if (gate.kind === "remind") this.remind(gate.text);
          }
          if (this.hooks?.has("PreToolUse")) {
            const summary = this.hooks.summarize(
              await this.hooks.run("PreToolUse", {
                hook_event_name: "PreToolUse",
                session_id: this.id,
                cwd: this.cwd,
                tool_name: tool.name,
                tool_input: input,
              }),
            );
            if (summary.blocked) {
              return { content: "PreToolUse hook blocked this call: " + summary.blockReason, isError: true };
            }
          }
          const outcome = await this.permissions.check(
            tool,
            input,
            subject,
            description,
            // Computed in every mode: the "protected" verdict (.magentra state
            // dirs) must hold even outside OVERDRIVE. The tool sees its own
            // effective cwd via the context.
            tool.deletionScope?.(input, { ...this.toolContext(), callId: call.id }),
            // A file edit landing outside the workspace is not auto-safe.
            editOutsidePath !== undefined,
            editProtectedPath,
          );
          if (outcome.source !== "user") {
            this.transcript.append({
              kind: "permission",
              tool: tool.name,
              ...(subject !== undefined ? { subject } : {}),
              decision: outcome.allowed ? "allow" : "deny",
              source: outcome.source,
            });
          }
          if (!outcome.allowed) {
            return { content: outcome.message ?? "Permission denied.", isError: true };
          }
          // A note attached to an APPROVAL rides along with this round's
          // results — the user let the call run but wants it steered.
          if (outcome.note !== undefined && outcome.note.trim() !== "") {
            this.remind(
              `The user approved this ${tool.name} call but attached a note — read it and adjust your approach accordingly:\n${outcome.note.trim()}`,
            );
          }
          this.emit({
            type: "tool_call_started",
            id: call.id,
            tool: tool.name,
            input,
            ...(description !== undefined ? { description } : {}),
          });
          try {
            const result = await tool.execute(input, { ...this.toolContext(), callId: call.id }, signal);
            this.observeTurnWork(tool.name, input, result.isError === true);
            const truncated = truncateResult(result, tool.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT);
            if (this.hooks?.has("PostToolUse")) {
              const summary = this.hooks.summarize(
                await this.hooks.run("PostToolUse", {
                  hook_event_name: "PostToolUse",
                  session_id: this.id,
                  cwd: this.cwd,
                  tool_name: tool.name,
                  tool_input: input,
                  tool_response: preview(truncated),
                }),
              );
              if (summary.blocked && typeof truncated.content === "string") {
                return {
                  ...truncated,
                  content: `${truncated.content}\n<system-reminder>PostToolUse hook: ${summary.blockReason}</system-reminder>`,
                };
              }
            }
            return truncated;
          } catch (err) {
            if (signal.aborted) throw err;
            return { content: `Tool failed: ${(err as Error).message}`, isError: true };
          }
        },
      });
    }

    const results = new Map<string, ToolResult>();
    const parallelBatch = planned.filter((p) => p.parallel);
    const sequential = planned.filter((p) => !p.parallel);

    // Permission prompts must not race; sequential (mutating) calls run first-to-last
    // while read-only calls execute concurrently.
    const parallelPromise = Promise.all(
      parallelBatch.map(async (p) => results.set(p.call.id, await p.run())),
    );
    for (const p of sequential) {
      signal.throwIfAborted();
      results.set(p.call.id, await p.run());
    }
    await parallelPromise;

    return Promise.all(
      calls.map(async (call) => {
        const result = results.get(call.id) ?? { content: "Tool did not run.", isError: true };
        this.emit({
          type: "tool_call_finished",
          id: call.id,
          tool: call.name,
          resultPreview: preview(result),
          isError: result.isError ?? false,
        });
        return {
          type: "tool_result" as const,
          toolUseId: call.id,
          content: await this.describeToolImages(result.content),
          ...(result.isError ? { isError: true } : {}),
        };
      }),
    );
  }

  /**
   * Tool-result content with every image turned into words.
   *
   * This is the catch-all for tools the engine does not own — an MCP server is
   * free to answer with a screenshot. The rule is the same one the Read tool and
   * the attached-image path follow, applied at the single point where a result
   * becomes a message: the session's model is never handed an image, so either
   * the vision endpoint describes it or the agent is told plainly that
   * something was returned it cannot see.
   *
   * (It also settles a wire-format problem. An OpenAI-compatible tool result is
   * a `role: "tool"` message, which cannot carry an image at all — that path
   * silently replaced it with "[image omitted]". A description is text, so it
   * survives both dialects intact.)
   */
  private async describeToolImages(content: string | ToolResultPart[]): Promise<string | ToolResultPart[]> {
    if (typeof content === "string" || !content.some((part) => part.type === "image")) return content;
    const out: ToolResultPart[] = [];
    for (const part of content) {
      if (part.type !== "image") {
        out.push(part);
        continue;
      }
      const unavailable = this.visionUnavailableReason();
      if (unavailable) {
        out.push({
          type: "text",
          text: `[This tool returned an image. You have NOT seen it — ${unavailable}. Do not describe it or draw conclusions from it.]`,
        });
        continue;
      }
      try {
        out.push({
          type: "text",
          text: await this.describeImageForContext({
            data: part.data ?? "",
            mediaType: part.mediaType ?? "image/png",
            label: "an image returned by a tool",
          }),
        });
      } catch (err) {
        out.push({
          type: "text",
          text: `[This tool returned an image, but the vision model could not look at it: ${(err as Error).message}. You have NOT seen it.]`,
        });
      }
    }
    return out;
  }

  private toolContext(): ToolContext {
    return { cwd: this.cwd, session: this.services };
  }

  /**
   * Finishing rungs: what this turn did, watched at the one place a tool has
   * actually finished running. A Write or an Edit records the file it changed;
   * any Bash call records that something was executed at all.
   *
   * Only executed calls reach here — a refused or hook-blocked call returns
   * before this point — so a Bash call counts whatever it exited with. The rung
   * asks whether anything was OBSERVED, and a nonzero exit is an observation;
   * whether the result was good belongs to the error-recovery and self-verify
   * rungs, not to this one. A failed Write/Edit is different: it changed no
   * bytes, so there is nothing there to verify.
   */
  private observeTurnWork(toolName: string, input: unknown, isError: boolean): void {
    if (toolName === "Bash") {
      this.ranCommandThisTurn = true;
      return;
    }
    if (isError) return;
    if (toolName !== "Write" && toolName !== "Edit") return;
    if (typeof input !== "object" || input === null) return;
    const filePath = (input as Record<string, unknown>).file_path;
    if (typeof filePath !== "string" || filePath === "") return;
    const absolute = resolve(this.cwd, filePath);
    const rel = relative(this.cwd, absolute);
    // A path outside the workspace has no useful relative form ("../../etc/..."),
    // so it is named in full — the rung reads better with a path the user can
    // recognize than with a walk back up the tree.
    const named = rel === "" || rel.startsWith("..") ? absolute : rel;
    this.filesChangedThisTurn.add(named);
    // Only the text this turn actually wrote is judged, never the file on disk:
    // the question is what THIS turn stood in for, and a file that already
    // contained mocks before the turn started is not this turn's assumption.
    const written = (input as Record<string, unknown>)[toolName === "Write" ? "content" : "new_string"];
    if (typeof written === "string" && looksLikeTestDouble(written)) this.doubleFilesThisTurn.add(named);
  }

  /**
   * The absolute target of a file-edit call when it lands OUTSIDE the workspace,
   * else undefined. File edits auto-run inside the workspace (the frictionless
   * default), but an edit that escapes the tree — a shell profile, an SSH key,
   * a system file — is exactly what a prompt-injection would attempt, so it must
   * ask first. Reads the path field structurally (no dependency on @magentra/tools).
   */
  private fileEditOutsideWorkspace(input: unknown): string | undefined {
    if (typeof input !== "object" || input === null) return undefined;
    const rec = input as Record<string, unknown>;
    const raw =
      typeof rec.file_path === "string" ? rec.file_path
      : typeof rec.path === "string" ? rec.path
      : typeof rec.notebook_path === "string" ? rec.notebook_path
      : undefined;
    if (!raw) return undefined;
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(this.cwd, raw);
    const root = resolve(this.cwd);
    return abs !== root && !abs.startsWith(root + sep) ? abs : undefined;
  }

  /**
   * The absolute target of a file-edit call when it lands on a PROTECTED path
   * (`.magentra/**` or a `.env*` file), else undefined. Every other edit runs
   * without asking; these two always confirm. Same structural path read as
   * fileEditOutsideWorkspace — and note this covers the Write/Edit tools only.
   * A shell redirect (`echo x > .env`) goes through Bash and is NOT seen here.
   */
  private fileEditProtectedPath(input: unknown): string | undefined {
    if (typeof input !== "object" || input === null) return undefined;
    const rec = input as Record<string, unknown>;
    const raw =
      typeof rec.file_path === "string" ? rec.file_path
      : typeof rec.path === "string" ? rec.path
      : typeof rec.notebook_path === "string" ? rec.notebook_path
      : undefined;
    if (!raw) return undefined;
    return protectedEditPath(isAbsolute(raw) ? resolve(raw) : resolve(this.cwd, raw));
  }

  /**
   * Reuse gate for a Write call. Reads `file_path`/`content` structurally (this
   * module must not depend on @magentra/tools) and delegates to the pure
   * evaluator. Fails open on any throw — the gate must never break a Write.
   */
  private evaluateWriteReuseGate(input: unknown): ReuseGateResult {
    if (typeof input !== "object" || input === null) return { kind: "pass" };
    const rec = input as Record<string, unknown>;
    const filePath = rec.file_path;
    const content = rec.content;
    if (typeof filePath !== "string" || typeof content !== "string") return { kind: "pass" };
    try {
      return evaluateReuseGate(
        this.cwd,
        filePath,
        content,
        this.settings.reuseCheck,
        this.searchLog,
        (p) => this.fileState.wasRead(p),
        () => this.loadSymbolIndex(),
      );
    } catch {
      return { kind: "pass" };
    }
  }

  /** The workspace symbol index: built (and persisted) once, then refreshed incrementally per gate check. */
  private loadSymbolIndex(): SymbolIndexData {
    this.symbolIndexCache = this.symbolIndexCache
      ? buildSymbolIndex(this.cwd, this.symbolIndexCache)
      : loadOrBuildSymbolIndex(this.cwd);
    return this.symbolIndexCache;
  }

  private withReminders(blocks: ContentBlock[]): ContentBlock[] {
    if (this.reminders.length === 0) return blocks;
    const text = this.reminders.splice(0).map(wrapReminder).join("\n");
    return [...blocks, { type: "text", text }];
  }

  private pushMessage(msg: Msg): void {
    this.messages.push(msg);
    this.transcript.append({ kind: "message", message: msg });
  }

  /**
   * A conservative token estimate of the current message history, used only when
   * the provider gave no usage to measure from — better to compact a little
   * early than to under-count and overflow the provider.
   */
  private estimateContextTokens(): number {
    let chars = 0;
    for (const m of this.messages) chars += JSON.stringify(m.content).length;
    return estimateTokens(chars);
  }

  /** Estimated token weight of the CONVERSATION alone (message history), excluding
   * the fixed system prompt + tool schemas. Auto-naming keys off this so the
   * ~12k baseline of an empty chat doesn't count as "enough to summarize". */
  conversationTokens(): number {
    return this.estimateContextTokens();
  }

  /** A compact plain-text digest of the conversation for summarization: user and
   * assistant prose only (tool calls/results skipped as noise), oldest first,
   * truncated to maxChars — the topic is usually set early. */
  private conversationDigest(maxChars: number): string {
    const parts: string[] = [];
    for (const m of this.messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (!text) continue;
      parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${text}`);
      if (parts.join("\n").length >= maxChars) break;
    }
    return parts.join("\n").slice(0, maxChars);
  }

  /**
   * Once the conversation is substantial enough to summarize, generate a short
   * title for it — a cheap smallModel call — so the sidebar stops showing the
   * generic default name. Returns the new label (for the engine to persist +
   * broadcast), or undefined when it isn't due: too early, already named
   * (manually or auto), or generation produced nothing usable. Fires at most once
   * per session. The engine calls this only after a turn settles (model is free);
   * `runInference` is stateless so it never disturbs the live conversation.
   */
  async maybeAutoName(): Promise<string | undefined> {
    if (this.autoNameDone || this.label) return undefined;
    if (this.conversationTokens() < AUTO_NAME_MIN_TOKENS) return undefined;
    // The instruction is what actually names the session, so emptying it
    // switches the feature off. The role is not guarded: it only adds framing
    // the instruction already carries, and both providers drop an empty system
    // block rather than sending one. Claim `autoNameDone` before returning, or
    // the catch below — which exists to retry a TRANSIENT failure — would make
    // a switched-off feature re-check on every settling turn.
    const instruction = promptTextIfEnabled(AUTO_NAME_INSTRUCTION);
    if (instruction === undefined) {
      this.autoNameDone = true;
      return undefined;
    }
    this.autoNameDone = true; // claim before the await so two settling turns can't both fire
    try {
      const raw = await this.runInference({
        system: promptText(AUTO_NAME_ROLE),
        user: `${instruction}\n\n---\n${this.conversationDigest(4000)}\n---`,
        maxTokens: 24,
      });
      const label = cleanSessionTitle(raw);
      if (!label) {
        this.autoNameDone = false; // nothing usable — let a later turn try again
        return undefined;
      }
      this.label = label;
      return label;
    } catch {
      this.autoNameDone = false; // transient failure — retry on a later turn
      return undefined;
    }
  }

  /**
   * The category-sum estimate of what currently fills the context, for the
   * /session report: the input context broken into its disjoint parts. Each part
   * is an ESTIMATE of its own size — the measured total (`stats.contextTokens`,
   * from provider usage) is the source of truth and will not sum to these
   * exactly. Addon names/descriptions physically live inside the system string; they
   * are broken out (and subtracted from it) so their weight is visible on its own
   * without being counted twice. `limit` is the user's auto-compact limit (0 = none
   * set), used to show free space; without a limit there is no window to compute
   * free space against.
   */
  contextBreakdown(): ContextBreakdown {
    const addonsText = addonsBlock(this.opts.addons ?? []) ?? "";
    const addons = estimateTokens(addonsText);
    // System prompt without the addons block, so the two don't double-count.
    const systemPrompt = Math.max(0, estimateTokens(this.buildSystemPrompt()) - addons);
    const tools = estimateTokens(JSON.stringify(this.toolSchemas()));
    const messages = this.estimateContextTokens();
    return { systemPrompt, tools, addons, messages, limit: this.effectiveCompactLimit() };
  }

  /** An estimate of the whole context right now — system prompt + tool schemas +
   * addons + surviving message history — used to seed `contextTokens` after a
   * compaction (before the next response measures it exactly) so the meter never
   * reads a misleading ~0 for a window that still holds the system prompt and
   * the summary. */
  private estimateContextNow(): number {
    const b = this.contextBreakdown();
    return b.systemPrompt + b.tools + b.addons + b.messages;
  }

  /** The UI's auto-compact cap (set_compact_limit frame). 0 (or invalid) switches
   * auto-compaction off; a positive value compacts no later than that. It is a
   * cap on {@link effectiveCompactLimit}, not the limit itself. */
  setAutoCompactLimit(limit: number): void {
    this.autoCompactLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  }

  /** compactionThreshold × the context window the user set for this connection
   * (`settings.contextWindow`, via contextWindowFor — 128k when unset, and the
   * engine warns at start about that assumption). */
  private derivedCompactLimit(): number {
    return Math.floor(contextWindowFor(this.settings.model, this.settings) * this.settings.compactionThreshold);
  }

  /**
   * The context size at which auto-compaction fires: the window-derived limit
   * (see {@link derivedCompactLimit}), lowered by the UI cap when one is set.
   * 0 = off, only when the user explicitly set the cap to 0. Derived from the
   * connection so the TUI, headless runs and subagents — none of which send
   * set_compact_limit — compact too, instead of dying at the model's wall.
   */
  effectiveCompactLimit(): number {
    const derived = this.derivedCompactLimit();
    if (this.autoCompactLimit === undefined) return derived;
    if (this.autoCompactLimit <= 0) return 0;
    return Math.min(this.autoCompactLimit, derived);
  }

  /** True when the context is within 10% of the effective auto-compact limit —
   * the UI tints its counter as it approaches. False when auto-compaction is off. */
  contextOverWarnThreshold(): boolean {
    const limit = this.effectiveCompactLimit();
    return limit > 0 && this.stats.contextTokens >= Math.floor(limit * 0.9);
  }

  /**
   * Compaction is either MANUAL (`/compact`, force) or fires when the context
   * reaches {@link effectiveCompactLimit} — a fraction of the window the user
   * entered for this connection, so the engine never guesses the model's size.
   * Between tool rounds the measured size (last call's input) lags the real
   * one by the response and the results just appended, so the gate takes the
   * larger of the measurement and a fresh estimate. Returns whether it compacted.
   */
  async maybeCompact(force = false): Promise<boolean> {
    if (!force) {
      const limit = this.effectiveCompactLimit();
      if (limit <= 0) return false;
      // A child shares the root's ledger, so stats.contextTokens is the ROOT's
      // window — a child gates on its own estimate alone.
      const measured = this.opts.child ? 0 : this.stats.contextTokens;
      if (Math.max(measured, this.estimateContextNow()) < limit) return false;
    }

    // Compaction REPLACES history with the summary, so this is the one place
    // where running the call is worse than not running it: with no system prompt
    // the real conversation would be swapped for whatever a model returns when
    // asked nothing. Decline and keep the history intact.
    if (isPromptDisabled(COMPACTION_SYSTEM)) {
      this.emit({
        type: "command_output",
        text: "⚠ compaction is switched off (compaction.system is empty) — history kept as is.",
      });
      return false;
    }

    // Keep the most recent messages (a shorter tail under /compact force, so a
    // small history can still be squeezed), but never split a tool_use from
    // its tool_result: a tail that opens with tool_results whose tool_use was
    // summarized away is a history every provider rejects, bricking the
    // session. Tool pairs are adjacent, so walking the boundary back to a
    // message with no tool_result blocks guarantees each pair lands whole.
    let splitIdx = this.messages.length - (force ? 2 : 6);
    while (splitIdx > 0 && this.messages[splitIdx]!.content.some((b) => b.type === "tool_result")) {
      splitIdx--;
    }
    if (splitIdx <= 0) return false;
    const head = this.messages.slice(0, splitIdx);
    const tail = this.messages.slice(splitIdx);

    const before = this.stats.contextTokens;
    const summaryText = await this.summarizeForCompaction(head);

    const summaryMessage = renderPrompt(COMPACTION_WRAPPER, { summary: summaryText });
    this.messages = [{ role: "user", content: [{ type: "text", text: summaryMessage }] }, ...tail];
    this.transcript.append({ kind: "compaction", replacedCount: head.length, summary: summaryMessage });
    // Reset the measured size to a fresh ESTIMATE of the compacted window
    // (system prompt + tools + addons + summary + surviving tail) — NOT zero.
    // The window is far from empty, and a ~0 reading would both misinform the
    // context meter and disarm the compaction safety until the next response
    // re-measures. (Cost/usage totals stay — compaction does not un-bill spend.)
    // Root only: the shared figure describes the root's window, and a child
    // compacting its own history says nothing about how full that one is.
    if (!this.opts.child) this.stats.contextTokens = this.estimateContextNow();
    // A manual /compact runs outside any turn, so no turn_finished will carry
    // the new size — push it now so the frontend's context meter updates.
    this.emit({
      type: "context_update",
      contextTokens: this.stats.contextTokens,
      ...(this.contextOverWarnThreshold() ? { contextWarn: true } : {}),
    });
    // An auto-compaction (non-forced) must not be silent — mid-turn it would
    // otherwise look like the agent quietly forgot the conversation. The note
    // names WHY it happened (the user's limit) and where to change it, so it is
    // never a mystery. Forced /compact prints its own confirmation elsewhere.
    if (!force) {
      const limit = this.effectiveCompactLimit();
      const cappedByUi = this.autoCompactLimit !== undefined && this.autoCompactLimit > 0 && this.autoCompactLimit < this.derivedCompactLimit();
      const why = cappedByUi
        ? `your auto-compact limit of ${formatTokens(limit)} tokens (Settings → Context)`
        : `${Math.round(this.settings.compactionThreshold * 100)}% of the ${formatTokens(contextWindowFor(this.settings.model, this.settings))}-token context window set for this connection`;
      this.emit({
        type: "command_output",
        text: `Auto-compacted (~${formatTokens(before)} tokens summarized): the context reached ${why}.`,
      });
    }
    return true;
  }

  /**
   * Summarizes the compacted head, chunking the input so the summary call can
   * never itself overflow the summarizer's window: each chunk is folded into a
   * rolling summary that carries forward what earlier chunks established.
   */
  private async summarizeForCompaction(head: Msg[]): Promise<string> {
    // A character budget, not a token count: at the shared chars-per-token
    // estimate this keeps each summarizer prompt (~57k tokens) well inside even
    // a small 128k window, leaving room for the rolling summary + reply.
    const MAX_CHUNK_CHARS = 200_000;
    const serialized = head.map((m) => serializeForSummary([m]));
    const chunks: string[] = [];
    let current = "";
    for (const piece of serialized) {
      // A single oversized message still becomes its own (hard-sliced) chunk.
      if (current && current.length + piece.length > MAX_CHUNK_CHARS) {
        chunks.push(current);
        current = "";
      }
      current += (current ? "\n" : "") + piece;
      while (current.length > MAX_CHUNK_CHARS) {
        chunks.push(current.slice(0, MAX_CHUNK_CHARS));
        current = current.slice(MAX_CHUNK_CHARS);
      }
    }
    if (current) chunks.push(current);

    let summary = "";
    for (const chunk of chunks) {
      const input = summary
        ? `Summary of the conversation so far:\n${summary}\n\nNext span of the conversation:\n${chunk}`
        : chunk;
      summary = await this.runSummarizer(input);
    }
    return summary;
  }

  private async runSummarizer(text: string): Promise<string> {
    const summarySignal = new AbortController().signal;
    let summaryText = "";
    const stream = this.provider.stream({
      model: this.settings.smallModel ?? this.settings.model,
      system: promptText(COMPACTION_SYSTEM), // guarded by maybeCompact
      messages: [{ role: "user", content: [{ type: "text", text }] }],
      tools: [],
      maxTokens: 2000,
      signal: summarySignal,
    });
    for await (const event of stream) {
      if (event.type === "text_delta") summaryText += event.text;
    }
    return summaryText;
  }
}

/** Sentinel returned when a subagent finished without any assistant text (e.g. it errored out). */
const NO_SUBAGENT_TEXT = "(the subagent produced no text output)";

/** Concatenated text blocks of the session's last assistant message with text. */
function finalAssistantText(session: Session): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]!;
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.trim()) return text;
  }
  return NO_SUBAGENT_TEXT;
}

/** How many questions the clarify pre-layer may ask — deliberately light. */
const CLARIFY_MAX_QUESTIONS = 3;

/** A question a pre-layer puts to the user: protocol-shaped, ready for askUser. */
interface ShapeQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/**
 * One JSON object out of a model reply — fenced, bare, or wrapped in prose.
 * Both pre-layers demand strict JSON and both sometimes get it decorated
 * anyway, so tolerance lives here once rather than in each caller.
 */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (const candidate of [stripped, /\{[\s\S]*\}/.exec(stripped)?.[0]]) {
    if (candidate === undefined || candidate === "") continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not this shape — try the next
    }
  }
  return undefined;
}

/** Salvaged objects kept, and the longest span worth attempting to parse. */
const SALVAGE_MAX_OBJECTS = 16;
const SALVAGE_MAX_SPAN = 8000;

/**
 * The complete question objects in a reply that is not valid JSON, in the order
 * they appear.
 *
 * The way this layer fails is not "malformed" — it is TRUNCATED. Several
 * questions with described options make a long reply, and one cut off at the
 * token limit ends mid-string with no closing brace. Strict parsing then reads
 * an over-long, entirely correct answer as "ask the user nothing", silently.
 * Whatever question objects completed before the cutoff are still good, and
 * asking three of five questions beats asking none.
 *
 * Scans for balanced braces at any depth while respecting strings and escapes,
 * so a `}` inside a question's own text does not close it early. Keeps only
 * spans that parse AND carry a `question` key — which excludes both the outer
 * `{"questions": …}` wrapper and the `{"label": …}` option objects nested
 * inside. The unterminated tail the cutoff landed in is simply never emitted.
 * Bounded, and never throws: anything it cannot make sense of comes back as an
 * empty list, which every caller reads as "ask nothing".
 */
function salvageQuestionObjects(raw: string): unknown[] {
  const out: unknown[] = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length && out.length < SALVAGE_MAX_OBJECTS; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") starts.push(i);
    else if (ch === "}") {
      const start = starts.pop();
      if (start === undefined) continue; // a stray brace in prose before the JSON
      if (i + 1 - start > SALVAGE_MAX_SPAN) continue;
      try {
        const parsed: unknown = JSON.parse(raw.slice(start, i + 1));
        if (typeof parsed === "object" && parsed !== null && "question" in parsed) out.push(parsed);
      } catch {
        // not JSON after all — a later balanced span may still be
      }
    }
  }
  return out;
}

/**
 * Validates a model-authored `questions` array into protocol-shaped questions,
 * dropping anything malformed. Returns undefined when nothing usable survives —
 * every caller reads that as "ask nothing", the fail-open direction.
 */
function parseQuestionArray(
  value: unknown,
  fallbackHeader: string,
  maxQuestions: number,
): ShapeQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions = value.slice(0, maxQuestions).flatMap<ShapeQuestion>((q) => {
    if (typeof q !== "object" || q === null) return [];
    const qr = q as Record<string, unknown>;
    if (typeof qr.question !== "string" || qr.question.trim() === "" || !Array.isArray(qr.options)) return [];
    const options = qr.options.slice(0, 4).flatMap((o) => {
      if (typeof o !== "object" || o === null) return [];
      const or = o as Record<string, unknown>;
      if (typeof or.label !== "string" || or.label.trim() === "") return [];
      return [{ label: or.label, description: typeof or.description === "string" ? or.description : "" }];
    });
    if (options.length < 2) return [];
    return [
      {
        question: qr.question,
        header: typeof qr.header === "string" && qr.header.trim() !== "" ? qr.header.slice(0, 12) : fallbackHeader,
        options,
        multiSelect: qr.multiSelect === true,
      },
    ];
  });
  return questions.length > 0 ? questions : undefined;
}

/**
 * Parses the clarify pre-layer's verdict into protocol-shaped questions.
 * Returns undefined for clarify:false, malformed JSON, or nothing usable —
 * every failure path means "just start" (fail-open by design).
 *
 * Salvages a truncated reply: a cut-off reply has no closing brace, so
 * `clarify` cannot be read at all — but a reply containing question objects is
 * one where the model had already decided to ask, so recovering them is sound.
 * Without this, a layer that ran too long asks nothing and says nothing.
 */
function parseClarifyVerdict(raw: string): ShapeQuestion[] | undefined {
  const rec = parseJsonObject(raw);
  if (rec !== undefined) {
    if (rec.clarify !== true) return undefined;
    return parseQuestionArray(rec.questions, "Clarify", CLARIFY_MAX_QUESTIONS);
  }
  return parseQuestionArray(salvageQuestionObjects(raw), "Clarify", CLARIFY_MAX_QUESTIONS);
}


/** Total length of the text blocks in an assistant message (used to detect a bare give-up). */
function assistantText(msg: Msg): string {
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function assistantTextLength(msg: Msg): number {
  return assistantText(msg).length;
}

/** Builds the incomplete-task nudge text listing each pending/in-progress task. */
const INCOMPLETE_TASKS_NUDGE = definePrompt({
  id: "reminder.incomplete-tasks",
  group: "3 · In-turn reminders",
  label: "Tasks still open",
  channel: "reminder",
  where:
    "Fires at the end of a clean turn while ANY task is still pending or in_progress, and at most once per turn. Costs one full round trip when it fires, so the real lever on its cost is how many tasks get opened in the first place — see tool.TaskCreate.",
  placeholders: ["tasks"],
  text: `<system-reminder>The turn is ending but these tasks are not completed:
{{tasks}}
Finish them (marking each completed via TaskUpdate only when actually done), or explicitly state why they cannot be completed.</system-reminder>`,
});

function incompleteTasksNudgeText(tasks: TaskItem[]): string {
  return renderPrompt(INCOMPLETE_TASKS_NUDGE, {
    tasks: tasks.map((t) => `- #${t.id} ${t.subject} (${t.status})`).join("\n"),
  });
}

/** Folds the standards nudge into the wrap-up nudge. */
function wrapupNudgeText(mentionStandards = false): string {
  let text = promptText(WRAPUP_NUDGE_TEXT);
  if (mentionStandards) {
    text = text.replace(
      "</system-reminder>",
      `\nConfirm the diff complies with STANDARDS.md — name any deviation and why.</system-reminder>`,
    );
  }
  return text;
}

function wrapReminder(text: string): string {
  return text.trimStart().startsWith("<system-reminder>")
    ? text
    : `<system-reminder>${text}</system-reminder>`;
}

/** A short host label for provider-error messages: the endpoint's hostname,
 * or "anthropic" for the Anthropic provider. Best-effort — never throws. */
function providerHost(settings: Settings): string | undefined {
  if (settings.provider === "anthropic") return "anthropic";
  if (!settings.baseUrl) return undefined;
  try {
    return new URL(settings.baseUrl).host;
  } catch {
    return undefined;
  }
}

const UNPARSEABLE_KEY = "__unparseable_input";

function safeParse(json: string): unknown {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return { [UNPARSEABLE_KEY]: json };
  }
}

/** True when safeParse could not parse the tool JSON — i.e. it was truncated,
 * which for a streamed tool call means the response was cut off mid-call. */
function isUnparseable(input: unknown): boolean {
  return typeof input === "object" && input !== null && UNPARSEABLE_KEY in input;
}

/** The shape of a zod issue this repair pass reads — structural on purpose, so
 * it does not depend on zod's issue union staying stable across versions. */
type PrimitiveTypeIssue = {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly expected?: string | undefined;
};

/**
 * One bounded repair of tool arguments a model got *nearly* right.
 *
 * Models on OpenAI-compatible endpoints routinely JSON-encode scalars —
 * `"replace_all": "true"`, `"limit": "5"` — and a strict schema rejected the
 * whole call for it. That is a harness defect, not a model mistake: 7 of the 18
 * Edit failures in one 89-task benchmark run were this and nothing else.
 *
 * Repair only what zod itself flagged as the wrong primitive, and only when the
 * string is unambiguous. `"yes"`, `"abc"`, a missing required field and anything
 * structurally wrong all stay errors — the point is to stop losing calls that
 * were already correct, never to guess at what the model meant.
 *
 * Deliberately NOT `z.coerce.*`: `z.coerce.boolean().parse("false")` returns
 * `true` (it is `Boolean(input)`), which would turn a declined `replace_all`
 * into a destructive one. Same conservative reading as `coerceSettingValue`
 * in config/settings.ts.
 *
 * Returns a repaired clone, or undefined when there was nothing safe to fix —
 * so the caller can tell "try again" from "reject with the original error".
 */
function repairPrimitiveTypes(input: unknown, issues: readonly PrimitiveTypeIssue[]): unknown {
  const targets = issues.filter(
    (i) =>
      i.code === "invalid_type" &&
      (i.expected === "boolean" || i.expected === "number") &&
      i.path.length > 0,
  );
  if (targets.length === 0) return undefined;

  const clone: unknown = structuredClone(input);
  let touched = false;
  for (const issue of targets) {
    // The issue's own path is followed, so a field nested inside an object or
    // array (AskUserQuestion's questions[].multiSelect) is reached too.
    const parent = resolveContainer(clone, issue.path.slice(0, -1));
    if (parent === undefined) continue;
    const key = issue.path[issue.path.length - 1];
    if (key === undefined) continue;
    const current = parent[key];
    if (typeof current !== "string") continue;
    const fixed = issue.expected === "boolean" ? asBoolean(current) : asNumber(current);
    if (fixed === undefined) continue;
    parent[key] = fixed;
    touched = true;
  }
  return touched ? clone : undefined;
}

/** Walks a zod issue path to the container holding the offending field. */
function resolveContainer(
  root: unknown,
  path: readonly PropertyKey[],
): Record<PropertyKey, unknown> | undefined {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  if (node === null || typeof node !== "object") return undefined;
  return node as Record<PropertyKey, unknown>;
}

function asBoolean(raw: string): boolean | undefined {
  const t = raw.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  return undefined;
}

function asNumber(raw: string): number | undefined {
  const t = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function truncateResult(result: ToolResult, limit: number): ToolResult {
  if (typeof result.content !== "string") return result;
  const bytes = Buffer.byteLength(result.content, "utf8");
  if (bytes <= limit) return result;
  const buf = Buffer.from(result.content, "utf8");
  const half = Math.floor(limit / 2);
  const contentStr =
    buf.subarray(0, half).toString("utf8") +
    `\n\n[truncated: output was ${bytes} bytes, showing first and last ${half}]\n\n` +
    buf.subarray(bytes - half).toString("utf8");
  return { content: contentStr, ...(result.isError !== undefined ? { isError: result.isError } : {}) };
}

function preview(result: ToolResult): string {
  const text =
    typeof result.content === "string"
      ? result.content
      : result.content.map((p) => (p.type === "text" ? (p.text ?? "") : "[image]")).join(" ");
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}

function serializeForSummary(messages: Msg[]): string {
  return messages
    .map((m) => {
      const parts = m.content.map((b) => {
        switch (b.type) {
          case "text":
            return b.text;
          case "image":
            // Only a vision side-call carries one, and those are not part of the
            // conversation being summarized — named rather than dropped so a
            // future path that does put one here is visible in the summary.
            return "[image]";
          case "thinking":
            return "";
          case "tool_use":
            return `[tool call ${b.name}: ${JSON.stringify(b.input).slice(0, 300)}]`;
          case "tool_result": {
            const c = typeof b.content === "string" ? b.content : "[non-text result]";
            return `[tool result: ${c.slice(0, 500)}]`;
          }
        }
      });
      return `${m.role.toUpperCase()}: ${parts.filter(Boolean).join("\n")}`;
    })
    .join("\n\n");
}

function subjectOf(req: PermissionRequestPayload): string | undefined {
  return typeof req.input === "object" && req.input !== null && "command" in req.input
    ? String((req.input as { command: unknown }).command)
    : undefined;
}
