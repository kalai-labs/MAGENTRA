import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadBackpackIndex } from "../knowledge/backpack/index.js";
import {
  STATE_DIR_NAME,
  addUsage,
  definePrompt,
  emptyUsage,
  estimateTokens,
  formatTokens,
  inputTokensOf,
  promptText,
  renderPrompt,
  type CoreEvent,
  type PermissionDecision,
  type TaskItem,
  type Usage,
} from "@magentra/protocol";
import type { ContentBlock, Msg, Provider, StopReason, ToolSchema } from "@magentra/providers";
import { friendlyProviderError } from "@magentra/providers";
import { zodToJsonSchema } from "../util/zodToJsonSchema.js";
import {
  AGENT_TYPES,
  SUBAGENT_RESULT_ID,
  agentRoleText,
  agentToolNames,
  resolveAgentType,
} from "../agent/agents.js";
import {
  ATLAS_AREA_MAX_ITERATIONS,
  ATLAS_AREA_ROLE,
  ATLAS_FANOUT_CONCURRENCY,
  ATLAS_OVERVIEW_SYSTEM,
  assembleAtlas,
  atlasAreaPrompt,
  atlasOverviewPrompt,
  normalizeAtlasSection,
  type AtlasArea,
  atlasIsStale,
  atlasWasHandEdited,
  gitCommitsSince,
  gitHead,
  loadAtlas,
  looksLikeAtlas,
  readAtlasRaw,
  workspaceLooksNonTrivial,
  writeAtlas,
} from "../knowledge/atlas.js";
import { areaFacts, graphSummary, planAtlasAreas, projectName } from "../knowledge/atlasPlan.js";
import { graphStats, loadOrBuildGraph, pagerank, type GraphData } from "../knowledge/graph.js";
import { renderRetrieval, retrieveContext } from "../knowledge/retrieval.js";
import { loadStandards } from "../knowledge/standards.js";
import { BackgroundManager } from "../scheduling/background.js";
import { FileState } from "./fileState.js";
import type { HookRunner } from "../agent/hooks.js";
import type { ModeEngine } from "../ma/modes.js";
import { PermissionEngine, type PermissionRequestPayload, protectedEditPath } from "./permissions.js";
import {
  CAREFUL_CANCELLED_TEXT,
  CAREFUL_MODE_ENABLED,
  CAREFUL_PREDICTOR_SYSTEM,
  CAREFUL_SCOUT_WARN_AFTER_ROUNDS,
  CAREFUL_SCOUT_WARN_TEXT,
  carefulApprovalQuestion,
  carefulApprovedText,
  carefulGroundingText,
  carefulProposalText,
  carefulQuestionsSystem,
  CAREFUL_QUESTIONS_RETRY,
  carefulRevisionText,
  carefulScoutMapText,
  carefulScoutSection,
  carefulUnknownPathsText,
  classifyCarefulAnswer,
  extractCandidatePaths,
  looksLikeProposal,
  parseCarefulVerdict,
  salvageQuestionObjects,
} from "./careful.js";
import {
  codeFilesAmong,
  looksLikeTestDouble,
  runtimeEvidenceText,
  selfVerifyText,
} from "./finishing.js";
import { buildSystemPrompt, skillsBlock } from "../agent/prompts.js";
import { DEBUG_DIR, commandRunsRepro, reproScriptRelPath } from "../ma/debug.js";
import { SearchLog, evaluateReuseGate, type ReuseGateResult } from "../knowledge/reuseGate.js";
import { buildSymbolIndex, loadOrBuildSymbolIndex, type SymbolIndexData } from "../knowledge/symbols.js";
import { SessionStats, type ContextBreakdown } from "./sessionStats.js";
import type { Settings } from "../config/settings.js";
import { addExactPermission } from "../config/settings.js";
import { type CrewAgent, CREW_ALWAYS_ALLOWED, crewSection } from "../crew/team.js";
import { CrewExperience } from "../crew/experience.js";
import { recordCrewRun } from "../crew/ledger.js";
import type { Skill } from "../agent/skills.js";
import { TaskStore } from "../state/taskStore.js";
import { toolDescriptionText } from "../agent/tool.js";
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
  text: `Read the conversation excerpt below and reply with ONLY a short title (3–6 words) naming what it is about. No quotes, no trailing punctuation, no prefix like 'Title:' — just the title itself.`,
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

/** Per-turn cap on auto-recovery / length-continuation nudges (see runTurn). */
const MAX_AUTO_NUDGES = 3;

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
You own this query end to end: plan, act, verify, deliver — without stopping for routine approval.
- Plan first: for any multi-step request, lay out the task plan with TaskCreate — one task per step, the last a verification task stating the expected end state — before making changes. Trivial requests: just do them.
- Think ahead: before each consequential action, weigh its consequences. Prefer the smallest change that truly serves the query; optimize your path and skip ceremony the query does not need.
- Evidence is query-shaped: verify in whatever way the query itself calls for, and no further. A question is answered; a code change is SEEN WORKING — run the path you changed rather than re-reading it. What the query does not need (a full suite, a lint sweep, a benchmark) is ceremony, and you skip it.
- Ask the user ONLY when the answer changes the design, is irreversible, or reaches outside the workspace — the test: would a reasonable user be upset if you guessed wrong? Everything else you decide yourself and note in your wrap-up.
- NOTHING asks. Every call runs the moment you make it: deletions at any path, edits to \`.magentra\` state and \`.env\` files, writes outside the workspace. There is no confirmation step and no safety net but your own judgement — read a file before you overwrite it, look before you delete, and prefer the reversible move. The only thing that can still stop a call is a deny rule the user wrote themselves.
- Do not stop early: the turn ends only when every part of the query is handled and your self-check passes.`,
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
 * Safety net for weaker models that localize the sentinel despite the instruction
 * (`Tamamlandı.`, `Terminé.`, `完了`, …): a reply that reduces to one short word is
 * a translated "done", never genuine continued work. The caller only reaches here
 * with zero tool calls, and real continued work is always tool calls or a real
 * sentence — so a lone word can be safely swallowed in any language.
 */
export function isSelfVerifyDone(text: string): boolean {
  const tokens = text
    .replace(/[*_`~#>]/g, " ") // markdown emphasis / heading / quote marks
    .replace(/[.!…,:;\-–—]/g, " ") // trailing punctuation and separators
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.every((t) => /^done$/i.test(t))) return true; // literal DONE, decorated or repeated
  const [only] = tokens;
  return tokens.length === 1 && only !== undefined && /^[\p{L}\p{M}]{1,24}$/u.test(only); // a lone word = localized "done"
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

You may also be given a "Codebase overview" — a quick, cursory read of the workspace (its design atlas, an import-graph skeleton, or a short peek at README/manifests). It is CONTEXT, not something to confirm with the user. Use it to SHARPEN questions, NOT to silence them:
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

Questions: at most 3, each one decision-changing (never a detail that could be adjusted later), 2-4 mutually distinct options with a one-line description each; put your recommended option first with " (Recommended)" appended to its label. multiSelect true only when choices genuinely combine.`,
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

const NO_ATLAS_REMINDER = definePrompt({
  id: "reminder.no-atlas",
  group: "3 · In-turn reminders",
  label: "No design atlas",
  channel: "reminder",
  where:
    "Injected when the workspace has no .magentra/ATLAS.md, suggesting /atlas or writing one inline. Empty this prompt to switch the reminder off.",
  text: `No design atlas exists for this workspace. Suggest the user run /atlas to generate one — a mapped atlas speeds up every future session. For non-trivial multi-module work you may instead create .magentra/ATLAS.md yourself: each module, one-line purpose, public interface, key dependencies — modules and boundaries, not a file listing, compact (fits in 12KB).`,
});

const ATLAS_SECTION_HEADER = definePrompt({
  id: "system.atlas-header",
  group: "2 · Conditional system sections",
  label: "Atlas section header",
  channel: "system-conditional",
  where:
    "Prefixes the contents of .magentra/ATLAS.md when it is injected into the system prompt. Only the header is editable; the atlas file follows it verbatim.",
  text: `# Codebase atlas (.magentra/ATLAS.md)
The whole-design map of this workspace. Consult it before planning or editing; it is the big picture.`,
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
  skills?: Skill[];
  /** Extra prompt sections appended to the system prompt. */
  extraPromptSections?: string[];
  /**
   * Share an existing PermissionEngine instead of building one (subagents get
   * their parent's): session-allows granted during one specialist run hold for
   * the next, and mode/deletion-guard changes reach the whole tree.
   */
  permissionEngine?: PermissionEngine;
  /**
   * Share the parent's SessionStats (subagents/crew children do): their token
   * spend, API time and code changes belong to the same /session report as the
   * orchestrator's. Also set on /resume with the ledger rebuilt from the
   * transcript's meta snapshot. Omitted for a fresh root session.
   */
  stats?: SessionStats;
  /**
   * Subagent/crew child session: its transcript lives in sessions/subagents/
   * (off the resumable listing) and stats snapshots are the root's job.
   */
  child?: boolean;
  /** Runs lifecycle hooks; omitted for subagent sessions. */
  hookRunner?: HookRunner;
  /** The .ma style engine; omitted for subagent sessions (children inherit no modes). */
  modeEngine?: ModeEngine;
  /** CREW Phase A: the loaded team roster (main session only; children never inherit it). */
  team?: CrewAgent[];
  /** CREW Phase B: this session's own crew agent id (set for specialist children so BackpackSearch self-scopes). */
  crewSelf?: string;
  /**
   * Resolves a dedicated Provider for a crew member whose team file declares an
   * endpoint (provider/baseurl/apikeyenv frontmatter). undefined → the member
   * shares the session provider. A warning → the endpoint could not be resolved
   * (e.g. missing env key): the spawn falls back to the session provider AND the
   * default model, and the warning is surfaced as a non-fatal error event.
   */
  crewProviderResolver?: (agent: CrewAgent) => { provider: Provider } | { warning: string } | undefined;
  /** A2: called at turn start when the .magentra/team/*.md files changed on disk since the last turn. */
  onTeamFilesChanged?: () => void;
}

interface PendingToolCall {
  id: string;
  name: string;
  json: string;
}

/** The deterministic starting position a CAREFUL scout is handed. */
interface CarefulScoutMap {
  /** The rendered map, as the scout reads it. */
  text: string;
  /** True when the request's own words had little purchase on this codebase. */
  weak: boolean;
  /** Top-ranked SOURCE files (never documentation), for the grounding floor. */
  ranked: string[];
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
  /** Skill turn-start texts already injected into this conversation (cleared on compaction). */
  private readonly injectedSkillReminders = new Set<string>();
  private readonly dynamicSections = new Map<string, string>();
  private abortController: AbortController | undefined;
  private turnCounter = 0;
  /**
   * Whole-session accounting (cost, API time, code changes, and the CURRENT
   * context size). Shared by reference with every subagent/crew child, so one
   * /session report covers the whole tree. See SessionStats for why context and
   * usage must not be conflated.
   */
  readonly stats: SessionStats;
  private busy = false;
  /**
   * Unattended run (a scheduled/continuous mission fired with nobody at the
   * keyboard): permission asks auto-deny instead of blocking forever, and
   * AskUserQuestion fails with a teaching error. Set by the engine around the
   * run; propagated to every child this session spawns.
   */
  private unattended = false;
  /**
   * OVERDRIVE: the fully-autonomous turn-loop policy. When on, the per-turn
   * iteration/token caps and the auto-nudge ceiling are lifted, the reuse gate
   * only reminds, and a turn may not end until it passes the self-verify rung.
   * Session-scoped, persisted in the meta snapshot so /resume restores it.
   */
  private overdrive = false;
  /**
   * CAREFUL MODE: armed by the user, but only effective while OVERDRIVE is on
   * (see isCarefulActive). Stored independently of `overdrive` so disengaging
   * and re-engaging OVERDRIVE restores the user's choice rather than silently
   * dropping it. Persisted in the meta snapshot so /resume restores it.
   */
  private careful = false;
  /** Auto-compact at this many context tokens; 0 = off (nothing auto-compacts).
   *  Its ONLY source is the UI's set_compact_limit frame — no settings key, no
   *  /settings path — so the value can never disagree with what the UI shows. */
  private autoCompactLimit = 0;
  /** While true, streamAssistantTurn accumulates text/thinking but does not
   *  emit it — used to run the OVERDRIVE self-verify round silently so a clean
   *  "DONE" never reaches the UI as a second message. */
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
  /** True once the missing-atlas reminder has fired for this session. */
  private atlasReminderFired = false;
  /** True once the first-turn `/atlas` hint has fired (once per session, never for subagents). */
  private atlasHintFired = false;
  private readonly hooks: HookRunner | undefined;
  /** Reuse check: tokenized record of related searches/queries made this session. */
  private readonly searchLog = new SearchLog();
  /** Reuse check: the workspace symbol index, loaded once then refreshed incrementally. */
  private symbolIndexCache: SymbolIndexData | undefined;
  /** debug.ma repro oracle: the designated repro script has been observed exiting nonzero (bug reproduced) — unlocks the repro-failed gate. */
  private reproFailedObserved = false;
  /** debug.ma repro oracle: the repro script has been observed exiting zero AFTER a failure (fix verified). */
  private reproPassedObserved = false;
  /** debug.ma: true once this turn's "rerun the repro" verify nudge has fired (reset at each turn start, so one nudge per turn). */
  private debugVerifyNudgeFired = false;
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
  /** A2: mutable crew roster (hot-reloadable); consumed by buildSystemPrompt and services.team. */
  private teamAgents: CrewAgent[];
  /** Hirable crew: the experience manager (lessons + service record). Main session with a team only. */
  private experience: CrewExperience | undefined;
  /** A2: last observed team-directory signature, for hot-reload detection. */
  private lastTeamSig: string | undefined;
  /** Set by interrupt(); the background atlas loop checks it and stops taking work. */
  private atlasCancelled = false;
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
    this.teamAgents = opts.team ?? [];
    this.hooks = opts.hookRunner;
    this.extraPromptSections = [...(opts.extraPromptSections ?? [])];
    this.transcript = new Transcript(this.stateDir, this.id, { child: opts.child ?? false });
    this.tasks = new TaskStore(this.stateDir, this.id, this.emit);
    // Hirable crew: when a crew-owned task is verified completed, confirm the
    // lessons that rode on the run and capture new candidates from the report.
    if (this.teamAgents.length > 0) this.experience = new CrewExperience(this.cwd);
    this.tasks.onStatusChange = (task, prev) => {
      if (task.status !== "completed" || prev === "completed") return;
      const owner = task.owner;
      if (!owner || owner === "orchestrator" || !this.experience) return;
      if (!this.teamAgents.some((a) => a.id === owner)) return;
      void this.experience.onTaskCompleted(task, (o) => this.runInference(o));
    };
    this.background = new BackgroundManager(this.stateDir, this.emit, (t) => this.remind(t));
    this.permissions =
      opts.permissionEngine ??
      new PermissionEngine(
        opts.settings.permissions,
        async (req, approvalSource) => {
        // Unattended runs never block on a human: deny with a reason instead.
        // The stance allows everything, so the only calls that reach here are
        // the two target-shaped guards — deletions and edits to protected
        // paths (.magentra state, .env). Refusing both is exactly right for a
        // run with nobody watching.
        if (this.unattended) {
          this.transcript.append({
            kind: "permission",
            tool: req.tool,
            ...(subjectOf(req) !== undefined ? { subject: subjectOf(req) } : {}),
            decision: "deny",
            source:
              approvalSource === "deletion-guard" ? "deletion-guard"
              : approvalSource === "protected-path" ? "protected-path"
              : "user",
          });
          return {
            decision: "deny",
            message:
              "unattended mission run — nobody is available to approve this call. It was denied automatically; find a non-destructive way, or leave it for an attended session.",
          };
        }
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
      askUser: (questions) => {
        if (this.unattended) {
          return Promise.reject(
            new Error("unattended mission run — the user cannot be asked. Decide autonomously and note the decision in your report."),
          );
        }
        return opts.askUser(`q_${randomBytes(4).toString("hex")}`, questions);
      },
      spawnAgent: (o) => this.spawnAgent(o),
      runInference: (o) => this.runInference(o),
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
      ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
      ...(this.teamAgents.length > 0 ? { team: this.teamAgents } : {}),
      ...(opts.crewSelf !== undefined ? { crewSelf: opts.crewSelf } : {}),
      ...(this.experience !== undefined ? { experience: this.experience } : {}),
    };
  }

  /** Marks this session (and every child it spawns from now on) as unattended. */
  setUnattended(value: boolean): void {
    this.unattended = value;
  }

  /** A2: replace the crew roster live (used by the engine on team-file hot-reload). */
  setTeam(agents: CrewAgent[]): void {
    this.teamAgents = agents;
    this.services.team = agents.length > 0 ? agents : undefined;
    if (agents.length > 0 && !this.experience) {
      this.experience = new CrewExperience(this.cwd);
      this.services.experience = this.experience;
    }
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
   *  Turn budgets are unaffected (`capped` keys off unattended/child, not
   *  this). Emits the state change so every frontend can sync its indicator. */
  setOverdrive(enabled: boolean): void {
    if (this.overdrive === enabled) return;
    this.overdrive = enabled;
    this.permissions.setOverdrive(enabled);
    this.setPromptSection("overdrive", enabled ? promptText(OVERDRIVE_PROMPT_SECTION) : undefined);
    this.emit({ type: "overdrive_changed", enabled, careful: this.careful });
  }

  /** CAREFUL MODE toggle. Arms the modifier; it does nothing until OVERDRIVE is
   *  also on. Reported on the overdrive_changed frame rather than one of its
   *  own, so a frontend can never hold the two states out of step. */
  setCareful(enabled: boolean): void {
    if (this.careful === enabled) return;
    this.careful = enabled;
    this.emit({ type: "overdrive_changed", enabled: this.overdrive, careful: enabled });
  }

  isCareful(): boolean {
    return this.careful;
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

  /** True when a careful turn is actually possible: the mode is shipped, the
   *  modifier is armed, the stance it modifies is engaged, and there is a human
   *  at the other end. A subagent reports to its parent and an unattended
   *  mission has nobody to approve anything, so neither ever briefs.
   *
   *  CAREFUL_MODE_ENABLED is false while the mode is a withdrawn beta. Engine
   *  already refuses to arm it; this is the behavioural backstop, so a Session
   *  driven directly (tests, embedders) cannot start a careful turn either. */
  private isCarefulActive(): boolean {
    return (
      CAREFUL_MODE_ENABLED && this.careful && this.overdrive && !this.opts.child && !this.unattended
    );
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
      messages: [{ role: "user", content: [{ type: "text", text: opts.user }] }],
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
   * Filters events from a child (subagent) session before they reach this
   * session's own emit. Child turn/text events must not leak into the
   * top-level stream (a frontend waiting for the outer turn_finished would
   * otherwise stop on the child's t_1); tool call events pass through so
   * subagent activity is still visible, tagged so frontends can render them
   * distinctly. Everything else (permissions, questions, tasks, background
   * notifications) passes through unchanged.
   */
  private emitFromChild(
    event: CoreEvent,
    agentId: string,
    agentDesc: string,
    stamp?: { agentColor?: string; agentEmoji?: string },
  ): void {
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
          ...(stamp?.agentColor !== undefined && event.agentColor === undefined
            ? { agentColor: stamp.agentColor }
            : {}),
          ...(stamp?.agentEmoji !== undefined && event.agentEmoji === undefined
            ? { agentEmoji: stamp.agentEmoji }
            : {}),
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
   * channel — except a crew member with a resolvable dedicated endpoint, which
   * runs on its own Provider (see SessionOptions.crewProviderResolver). Foreground: resolves with the child's final assistant text.
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
    const crew = opts.crew?.agent;
    const agentDesc = crew ? `${crew.emoji ?? ""} ${crew.name}`.trim() : opts.description;
    // A crew member with a dedicated endpoint runs on its own Provider; an
    // unresolvable endpoint falls back to the session provider AND default
    // model (its declared model most likely doesn't exist on the fallback host).
    let crewProvider: Provider | undefined;
    let crewModel = crew?.model;
    if (crew) {
      const resolved = this.opts.crewProviderResolver?.(crew);
      if (resolved !== undefined) {
        if ("provider" in resolved) {
          crewProvider = resolved.provider;
        } else {
          this.emit({ type: "error", message: resolved.warning, fatal: false });
          crewModel = undefined;
        }
      }
    }
    const baseSettings = crew ? { ...this.settings, model: crewModel ?? this.settings.model } : this.settings;
    // Interactive children inherit the lifted budgets — a capped child inside
    // an uncapped run is a hidden stop. An explicit spawn-time iteration cap
    // (e.g. the atlas pipeline's) still wins, and unattended (mission) runs
    // keep their configured budgets so a scheduled run stays bounded.
    const liftedSettings = this.unattended
      ? baseSettings
      : { ...baseSettings, maxIterationsPerTurn: Number.MAX_SAFE_INTEGER, maxTokensPerTurn: Number.MAX_SAFE_INTEGER };
    const childSettings =
      opts.maxIterations !== undefined
        ? { ...liftedSettings, maxIterationsPerTurn: opts.maxIterations }
        : liftedSettings;
    const stamp = crew
      ? {
          ...(crew.color !== undefined ? { agentColor: crew.color } : {}),
          ...(crew.emoji !== undefined ? { agentEmoji: crew.emoji } : {}),
        }
      : undefined;

    const allNames = this.registry.list().map((t) => t.name);
    // A crew specialist never spawns further agents or workflows in Phase A.
    const childRegistry = crew
      ? this.registry.subset(
          (crew.tools && crew.tools.length > 0
            ? [...new Set([...crew.tools, ...CREW_ALWAYS_ALLOWED])]
            : allNames
          ).filter((n) => n !== "Agent" && n !== "Workflow"),
        )
      : this.registry.subset(agentToolNames(def, allNames));
    const backpackSection = crew ? this.backpackPromptSection(crew.id, opts.crew?.backpackBrief) : undefined;
    const system = buildSystemPrompt({
      env: {
        cwd: this.cwd,
        isGitRepo: existsSync(join(this.cwd, ".git")),
        platform: process.platform,
        model: childSettings.model,
        date: new Date().toISOString().slice(0, 10),
      },
      skills: [],
      extraSections: crew
        ? [
            `You are ${crew.name}, the crew's ${crew.role}.`,
            crew.rolePrompt,
            ...(backpackSection ? [backpackSection] : []),
            ...(opts.crew?.lessons ? [opts.crew.lessons] : []),
            promptText(SUBAGENT_RESULT_ID),
          ]
        : [opts.roleOverride ?? agentRoleText(def), promptText(SUBAGENT_RESULT_ID)],
    });
    const child = new Session({
      cwd: this.cwd,
      settings: childSettings,
      provider: crewProvider ?? this.provider,
      registry: childRegistry,
      emit: (event) => this.emitFromChild(event, agentId, agentDesc, stamp),
      requestApproval: this.opts.requestApproval,
      askUser: async () => {
        throw new Error("subagents cannot ask the user — decide or report back");
      },
      systemPromptOverride: system,
      // The child shares this session's PermissionEngine: an "always allow
      // this session" granted during one specialist's run holds for the next.
      permissionEngine: this.permissions,
      // ...and its stats ledger: a crew member's spend (possibly on its own
      // model) belongs in the same /session report as the orchestrator's.
      stats: this.stats,
      child: true,
      ...(crew ? { crewSelf: crew.id } : {}),
    });
    child.setUnattended(this.unattended);

    // Announce the dispatch before the child's first model turn: without this
    // the frontend hears nothing until the child's first tool call, so a
    // parallel fan-out looks stalled for a full LLM turn.
    const spawnedEvent = {
      type: "agent_spawned" as const,
      agentId,
      agentDesc,
      ...(stamp ?? {}),
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
              this.recordCrewUsage(crew?.id, child);
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
      this.recordCrewUsage(crew?.id, child);
      this.emit({ type: "agent_finished", agentId, ...(failed ? { isError: true } : {}) });
    }
  }

  /** Cost ledger: bank a crew child's run usage against its member id (best-effort). */
  private recordCrewUsage(crewId: string | undefined, child: Session): void {
    if (!crewId || !child.lastTurnUsage) return;
    try {
      recordCrewRun(this.cwd, crewId, child.lastTurnUsage);
    } catch {
      // accounting must never fail a run
    }
  }

  /**
   * HARD STOP — everything this session started, stopped now.
   *
   * "Stop" only means something if it reaches all the way. Three kinds of work
   * outlive a naive abort, and each is cut here:
   *
   *   1. the current turn, and every subagent under it (they run their own
   *      controllers, so aborting only this session would leave them burning
   *      tokens while the parent waits on their results);
   *   2. a background atlas build, whose loop would otherwise catch the abort of
   *      one area agent, wait, and cheerfully spawn the next one;
   *   3. background jobs (bash, monitors) — detached from any turn, so nothing
   *      else would ever kill them.
   *
   * Idempotent and safe when idle.
   */
  interrupt(): void {
    this.atlasCancelled = true;
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
    return this.registry.list().map((t) => ({
      name: t.name,
      description: toolDescriptionText(t.name, t.description, t.descriptionVars),
      inputSchema: t.rawInputSchema ?? zodToJsonSchema(t.inputSchema),
    }));
  }

  buildSystemPrompt(): string {
    if (this.opts.systemPromptOverride) return this.opts.systemPromptOverride;
    const atlas = loadAtlas(this.cwd);
    const standards = loadStandards(this.cwd);
    return buildSystemPrompt({
      env: {
        cwd: this.cwd,
        isGitRepo: existsSync(join(this.cwd, ".git")),
        platform: process.platform,
        model: this.settings.model,
        date: new Date().toISOString().slice(0, 10),
      },
      skills: this.opts.skills ?? [],
      extraSections: [
        ...this.extraPromptSections,
        ...this.dynamicSections.values(),
        ...(this.opts.modeEngine?.promptSections() ?? []),
        ...(this.teamAgents.length > 0 ? [crewSection(this.teamAgents)] : []),
        ...(atlas ? [`${promptText(ATLAS_SECTION_HEADER)}\n\n${atlas}`] : []),
        ...(standards ? [`${promptText(STANDARDS_SECTION_HEADER)}\n\n${standards}`] : []),
      ],
    });
  }

  /** CREW Phase B: the knowledge-brief prompt section for a specialist, or undefined. */
  private backpackPromptSection(agentId: string, briefOverride?: string): string | undefined {
    const index = loadBackpackIndex(this.cwd, agentId);
    const brief = briefOverride ?? index?.brief;
    if (brief) return `# Your knowledge brief\n${brief}\n(Use BackpackSearch for exact passages.)`;
    if (index && index.chunks.length > 0) {
      return "(backpack still indexing — BackpackSearch over raw text is available)";
    }
    return undefined;
  }

  /** A2: a cheap signature of the team dir (names + mtime + size) for hot-reload detection. */
  private teamDirSignature(): string {
    const dir = join(this.cwd, ".magentra", "team");
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      return "";
    }
    return names
      .map((n) => {
        try {
          const st = statSync(join(dir, n));
          return `${n}:${st.mtimeMs}:${st.size}`;
        } catch {
          return n;
        }
      })
      .join("|");
  }

  /**
   * The `/atlas` build, as an orchestrator over three stages: derive the facts
   * (no model), map every area in parallel (one agent each), then synthesize the
   * overview and assemble the document. See the ATLAS BUILD note in atlas.ts for
   * why it is shaped this way.
   *
   * Best-effort throughout: a failure emits a notice, leaves any existing atlas
   * alone, and the missing-atlas nudge still fires. A hand-edited atlas is never
   * clobbered without `force`. Subagents opt out entirely.
   */
  async buildAtlas(force = false): Promise<void> {
    // Subagents (which always run with an overridden system prompt) never
    // auto-explore: it would recurse via spawnAgent, and a child cannot own the
    // workspace atlas anyway.
    if (this.opts.systemPromptOverride !== undefined) return;

    // A stop from a previous build must not kill this one before it starts.
    this.atlasCancelled = false;

    // If a human edited the atlas since the engine wrote it (its body hash no
    // longer matches the stamp), never clobber that work unless forced.
    const raw = readAtlasRaw(this.cwd);
    if (raw !== undefined && atlasWasHandEdited(raw) && !force) {
      this.emit({
        type: "command_output",
        text: "🗺 atlas was hand-edited — keeping your version (run /atlas force to overwrite)",
      });
      return;
    }

    try {
      // ── 1. Facts. Costs nothing, and spares every agent the grepping. ──────
      const graph = loadOrBuildGraph(this.cwd);
      const symbols = loadOrBuildSymbolIndex(this.cwd);
      const areas = planAtlasAreas(graph, undefined, this.cwd);
      if (areas.length === 0) throw new Error("no source files to map");

      const project = projectName(this.cwd);
      this.emit({
        type: "command_output",
        text: `🗺 mapping ${project}: ${graphSummary(graph, areas)} — ${areas.length} agent${areas.length === 1 ? "" : "s"} in parallel…`,
      });

      // ── 2. Fan out. Each agent maps one area and returns one compact section. ─
      const sections = await this.mapAreasInParallel(areas, graph, symbols);
      // A stopped build writes nothing: half a map, silently saved, is worse
      // than no map — the next session would trust it.
      if (this.atlasCancelled) {
        this.emit({ type: "command_output", text: "🗺 atlas build stopped — nothing written." });
        return;
      }
      if (sections.length === 0) throw new Error("no area could be mapped");

      // ── 3. Synthesize. One cheap, tool-free call opens the document. ────────
      const overview = await this.runInference({
        system: promptText(ATLAS_OVERVIEW_SYSTEM),
        user: atlasOverviewPrompt(project, sections, graphSummary(graph, areas)),
        maxTokens: 400,
      });

      const atlas = assembleAtlas(project, overview, sections);
      if (!looksLikeAtlas(atlas)) throw new Error("assembled atlas failed its shape check");

      writeAtlas(this.cwd, atlas, gitHead(this.cwd));
      this.emit({
        type: "command_output",
        text: `🗺 design atlas ready — .magentra/ATLAS.md (${sections.length}/${areas.length} areas mapped)`,
      });
    } catch (err) {
      this.emit({
        type: "command_output",
        text: `🗺 atlas build failed (${(err as Error).message}) — continuing without it`,
      });
    }
  }

  /**
   * Runs one agent per area, ATLAS_FANOUT_CONCURRENCY at a time. A failed or
   * empty area is dropped rather than failing the build — a partial atlas beats
   * none. Sections come back in area order regardless of completion order, so
   * the document is stable across runs.
   */
  private async mapAreasInParallel(
    areas: AtlasArea[],
    graph: GraphData,
    symbols: SymbolIndexData,
  ): Promise<string[]> {
    const results: (string | undefined)[] = new Array(areas.length).fill(undefined);
    let next = 0;

    const mapOne = async (area: AtlasArea): Promise<string | undefined> => {
      const section = await this.spawnAgent({
        agentType: "explore",
        description: `map ${area.name}`,
        prompt: atlasAreaPrompt(area, areaFacts(area, areas, graph, symbols)),
        // The explore role ("return concise conclusions — file paths with line
        // numbers") is the wrong persona for authoring a section.
        roleOverride: promptText(ATLAS_AREA_ROLE),
        maxIterations: ATLAS_AREA_MAX_ITERATIONS,
      });
      const text = section.trim();
      if (!text || text === NO_SUBAGENT_TEXT) return undefined;
      return normalizeAtlasSection(text, area.name);
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        // A hard stop must actually stop: check before taking new work, and
        // again before retrying, or the loop would happily out-live the abort it
        // just caught.
        if (this.atlasCancelled) return;
        const index = next++;
        const area = areas[index];
        if (!area) return;
        try {
          results[index] = await mapOne(area);
        } catch {
          if (this.atlasCancelled) return;
          // The build runs in the background, so the user's own turn may be
          // spawning agents at the same time and briefly exhaust the subagent
          // slots. That is transient — back off once and retry, rather than
          // silently shipping an atlas with a hole in it.
          await new Promise((r) => setTimeout(r, 2_000));
          if (this.atlasCancelled) return;
          try {
            results[index] = await mapOne(area);
          } catch {
            // Genuinely failed. One missing area beats no atlas.
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(ATLAS_FANOUT_CONCURRENCY, areas.length) }, () => worker()),
    );
    return results.filter((s): s is string => s !== undefined);
  }

  /**
   * Zero-cost first-turn nudge toward `/atlas`. Fires at most once per session
   * and never for a subagent. Emits a hint when a non-trivial workspace has no
   * atlas, or when its machine-owned atlas has gone git-stale; a hand-edited
   * atlas is left alone. Cheap (one file read + at most one git call) and never
   * throws — atlas building is now an explicit command, so this is only a signpost.
   */
  private maybeHintAtlas(): void {
    if (this.atlasHintFired) return;
    if (this.opts.systemPromptOverride !== undefined) return;
    this.atlasHintFired = true;
    try {
      const raw = readAtlasRaw(this.cwd);
      if (raw === undefined) {
        if (workspaceLooksNonTrivial(this.cwd)) {
          this.emit({
            type: "command_output",
            text: "🗺 no design atlas — run /atlas to map this codebase (speeds up every future session)",
          });
        }
        return;
      }
      if (atlasIsStale(raw, (commit) => gitCommitsSince(this.cwd, commit)) && !atlasWasHandEdited(raw)) {
        this.emit({
          type: "command_output",
          text: "🗺 the design atlas looks stale — run /atlas to rebuild it",
        });
      }
    } catch {
      // A signpost must never break a turn.
    }
  }

  /**
   * A compact snippet of the last exchange, so a follow-up ("improve it") is
   * judged with what came before in view instead of looking open-ended on its
   * own. Shared by every pre-layer that has to reason about the request.
   */
  private recentExchange(): string {
    const recent = this.messages
      .slice(-4)
      .map((m) => ({ role: m.role, text: assistantText(m) }))
      .filter((m) => m.text.trim().length > 0)
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
    // Ground the verdict in a cursory look at the code, so the questions are
    // about real, specific choices — and so nothing the code already answers
    // gets asked. Deterministic (file/graph reads, no model call): it rides
    // inside this one inference, adding no round-trip. Fail-open by design.
    const skim = this.buildClarifySkim();
    let raw: string;
    try {
      raw = await this.runInference({
        system: promptText(CLARIFY_SYSTEM),
        user: `${this.recentExchange()}${skim ? `Codebase overview:\n${skim}\n\n` : ""}Incoming request:\n${userText}`,
        // Three questions with four described options each does not fit in 600
        // either — the same undersized budget as CAREFUL's round, and the same
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
   * Shared by the clarify pre-layer and CAREFUL MODE's pre-proposal round: both
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
   * CAREFUL MODE's question round: what only the user can decide, asked BEFORE
   * the scout reads anything.
   *
   * A separate inference rather than a turn in the conversation, for the same
   * reason predictCareful is one — it has to happen before the hold goes up and
   * before the first model turn, and it is grounded in the deterministic scout
   * map rather than in anything the agent has read. The answers then ride with
   * the user message, so they steer the scout's reading as well as the proposal.
   *
   * Fail-open throughout: a thrown call, a malformed verdict or a frontend that
   * cannot answer all mean "ask nothing", never a lost turn.
   */
  private async askCarefulQuestions(
    userText: string,
    map: CarefulScoutMap | undefined,
  ): Promise<string | undefined> {
    // Announced BEFORE the inference, not after it. This call and the predictor
    // before it are two main-model round trips that happen while the user is
    // looking at nothing at all — which is most of what "it sat there for
    // minutes" was. The banner costs nothing and makes the wait legible.
    this.emit({ type: "command_output", text: "▶ carefully: working out what to ask you" });
    // This runs as its OWN inference, so it sees no system prompt — and
    // therefore no atlas. The scout map deliberately omits the atlas (the scout
    // gets it from the system prompt, and duplicating it would spend the user's
    // context twice), which left this layer with a request-specific slice and
    // nothing else. On a vague request that slice is the least useful thing it
    // could have: the layer is trying to work out what the user MEANS, which
    // needs the shape of the whole project.
    const overview = this.buildClarifySkim();
    // The deterministic vagueness measurement, handed to the model as evidence.
    // Whether to ask should not rest on the model's own sense of how clear a
    // request was; retrieval already counted how much of it this codebase
    // recognizes, and that count is a fact.
    const vagueness =
      map?.weak === true
        ? "Vocabulary check: the request's own words barely appear anywhere in this codebase, so nothing has pinned down what it refers to. Treat asking as necessary here, not optional.\n\n"
        : "";
    const prompt = `${this.recentExchange()}${overview ? `Codebase overview:\n${overview}\n\n` : ""}${map ? `What the request seems to point at:\n${map.text}\n\n` : ""}${vagueness}Incoming request:\n${userText}`;
    // Three defences against the same failure, because a token budget is a
    // guess and this layer's replies are long. Measured: five questions with
    // four described options each is ~3.6k characters at the lengths the prompt
    // asks for, and a model that writes fuller descriptions reaches ~6.6k —
    // which in Turkish is roughly 1.8k and 3.3k tokens. The old 1200 could not
    // fit even the disciplined case.
    //   1. a budget with real headroom over the measured worst case;
    //   2. salvage, so a cut-off reply still asks whatever completed;
    //   3. and this — the engine now KNOWS it was cut off, so when salvage
    //      recovers nothing it can ask again shorter instead of silently
    //      deciding the user had nothing to be asked.
    const ask = async (system: string): Promise<{ raw: string; truncated: boolean }> => {
      let truncated = false;
      const raw = await this.runInference({
        system,
        user: prompt,
        maxTokens: 4000,
        model: this.settings.model,
        onEnd: (reason) => {
          truncated = reason === "max_tokens";
        },
      });
      return { raw, truncated };
    };
    let questions: ShapeQuestion[] | undefined;
    try {
      const first = await ask(carefulQuestionsSystem(userText));
      questions = parseCarefulQuestions(first.raw);
      if (questions === undefined && first.truncated) {
        this.emit({ type: "command_output", text: "▶ carefully: that ran long — asking again, shorter" });
        const retry = await ask(`${carefulQuestionsSystem(userText)}${CAREFUL_QUESTIONS_RETRY}`);
        questions = parseCarefulQuestions(retry.raw);
      }
    } catch {
      return undefined;
    }
    if (questions === undefined) return undefined;
    return this.askQuestionRound(
      questions,
      "The user answered these BEFORE any investigation began. Treat the answers as requirements — they decide what you build, and they tell you where to look while you scout. Anything left unanswered is yours to decide sensibly, and you should state the assumption you chose:",
    );
  }

  /**
   * CAREFUL MODE predictor: decides whether this request earns a proposal the
   * user approves before any work starts. One inference on the MAIN model,
   * grounded in the same cursory skim the clarify pre-layer uses, and strictly
   * fail-open — a thrown call or a malformed verdict yields false, so a broken
   * predictor costs the user a checkpoint but never costs them the turn.
   */
  private async predictCareful(userText: string): Promise<boolean> {
    // Announced before the call, like the question round after it. This is the
    // first thing a careful turn does and it is a full main-model round trip:
    // unannounced, it is a blank screen for as long as the model takes to
    // answer, and the user reads that as the product having hung.
    this.emit({ type: "command_output", text: "▶ carefully: sizing up the request" });
    const skim = this.buildClarifySkim();
    try {
      const raw = await this.runInference({
        system: CAREFUL_PREDICTOR_SYSTEM,
        user: `${this.recentExchange()}${skim ? `Codebase overview:\n${skim}\n\n` : ""}Incoming request:\n${userText}`,
        maxTokens: 200,
        model: this.settings.model,
      });
      return parseCarefulVerdict(raw);
    } catch {
      return false;
    }
  }

  /**
   * The Scout Phase's starting position: a general orientation plus the files
   * this specific request concerns, both derived from the import graph rather
   * than from a model.
   *
   * This is half of why the phase is no longer slow. The old scout began blind
   * and had to discover the codebase before it could name a single file; this
   * hands it the answer to "where does this land" for free, so its reading is
   * spent on what the code MEANS. It is also the source the proposal cites, so
   * the location it states is a repository fact and not a model's guess.
   *
   * The atlas is deliberately skipped when present: buildSystemPrompt already
   * injects it, and putting it in twice would spend the user's context on a
   * duplicate. Best-effort throughout — a scout with no map still works.
   */
  private buildCarefulScoutMap(request: string, answers?: string): CarefulScoutMap | undefined {
    const parts: string[] = [];
    let weak = true;
    let ranked: string[] = [];
    try {
      if (loadAtlas(this.cwd) === undefined) {
        const skim = this.buildClarifySkim();
        if (skim) parts.push(skim);
      }
    } catch {
      // orientation is an enrichment; never let it cost the turn
    }
    try {
      // Deterministic retrieval: BM25 over the code fused with personalized
      // PageRank, rendered as ranked paths, declaration skeletons and the
      // top-scoring source itself. A general capability (knowledge/retrieval.ts)
      // that CAREFUL happens to be the first caller of.
      const retrieved = retrieveContext(this.cwd, request, { answers });
      if (retrieved) {
        parts.push(renderRetrieval(retrieved));
        weak = retrieved.weak;
        // Source files only — `docs` is deliberately kept separate by retrieval,
        // and reading the README is exactly the grounding this floor exists to
        // reject as sufficient.
        ranked = retrieved.files.slice(0, Session.GROUNDING_FLOOR_FILES);
      }
    } catch {
      // ditto — the scout can still read its way there
    }
    const alreadyRead = this.alreadyReadDigest();
    if (alreadyRead) parts.push(alreadyRead);
    return parts.length > 0 ? { text: parts.join("\n\n"), weak, ranked } : undefined;
  }

  /** Top-ranked source files the grounding floor is measured against. */
  private static readonly GROUNDING_FLOOR_FILES = 5;

  /**
   * Whether the scout has opened any of the source files its map ranked.
   *
   * The one thing a proposal about behaviour cannot be honest without, and the
   * one thing the model's own stop test cannot police: a vague request makes all
   * five stop-test questions easy to answer from a README. `wasRead` is
   * session-scoped, not turn-scoped, which is right — a file read on an earlier
   * proposal in this conversation is still read.
   */
  private carefulGroundingGap(ranked: string[]): string[] {
    if (ranked.length === 0) return [];
    return ranked.some((rel) => this.fileState.wasRead(join(this.cwd, rel))) ? [] : ranked;
  }

  /** Files listed as already-read before the list stops being a glance. */
  private static readonly ALREADY_READ_LIMIT = 25;

  /**
   * The files this session has already read and that have not changed on disk
   * since — the second and later CAREFUL turns of a conversation.
   *
   * Without this, every proposal in a session scouts from zero: the same files,
   * opened again, for a request in the same codebase. The freshness data needed
   * to know better is already kept for Edit/Write, so this costs one stat per
   * remembered file and no model round at all. Deliberately phrased to the model
   * as evidence rather than a prohibition — a file may have been read only in
   * part, or its contents may have been summarized away by compaction, and in
   * either case re-reading is the right call.
   */
  private alreadyReadDigest(): string | undefined {
    let paths: string[];
    try {
      paths = this.fileState.unchangedSinceRead();
    } catch {
      return undefined;
    }
    if (paths.length === 0) return undefined;
    const inside = paths
      .map((abs) => relative(this.cwd, abs).split(sep).join("/"))
      .filter((rel) => rel !== "" && !rel.startsWith(".."))
      .sort();
    if (inside.length === 0) return undefined;
    const shown = inside.slice(0, Session.ALREADY_READ_LIMIT);
    const more = inside.length - shown.length;
    return [
      "Already read earlier in this conversation, and UNCHANGED on disk since:",
      ...shown.map((rel) => `  ${rel}`),
      ...(more > 0 ? [`  …and ${more} more`] : []),
      "Do not open these again to re-learn what they contain. Read one only if you need a part you did not see, or if it is no longer visible in the conversation above.",
    ].join("\n");
  }

  /**
   * The paths a proposal names that this workspace does not have.
   *
   * Every path in a proposal is a claim about the user's repository, and it is
   * the one kind of claim that can be silently false — the user cannot check it
   * without leaving the conversation. The location section is graph-derived and
   * so cannot be invented, but the prose around it can still name a file from
   * memory, which is what this catches before the proposal is ever shown.
   */
  private unknownProposalPaths(text: string): string[] {
    const candidates = extractCandidatePaths(text);
    if (candidates.length === 0) return [];
    let basenames: Set<string> | undefined;
    const unknown: string[] = [];
    for (const candidate of candidates) {
      if (existsSync(isAbsolute(candidate) ? candidate : join(this.cwd, candidate))) continue;
      // A bare filename ("careful.ts") is a real reference even though it is not
      // a real path — resolve it against the graph before calling it a lie.
      if (!candidate.includes("/")) {
        basenames ??= this.workspaceBasenames();
        if (basenames.has(candidate)) continue;
      }
      unknown.push(candidate);
    }
    return unknown;
  }

  /** Every scanned file's basename, for resolving bare filenames in a proposal. */
  private workspaceBasenames(): Set<string> {
    const names = new Set<string>();
    try {
      for (const id of Object.keys(loadOrBuildGraph(this.cwd).files)) {
        names.add(id.slice(id.lastIndexOf("/") + 1));
      }
    } catch {
      // no graph — the on-disk check above stands on its own
    }
    return names;
  }

  /**
   * Puts the proposal to the user and classifies what comes back. An interrupt
   * or a frontend that cannot answer resolves as a cancel — the safe reading,
   * since an unanswered approval must never be treated as approval.
   */
  private async askCarefulApproval(
    revisionsSoFar: number,
  ): Promise<ReturnType<typeof classifyCarefulAnswer>> {
    const questions = carefulApprovalQuestion(revisionsSoFar);
    let answers: Record<string, string[]>;
    try {
      answers = await this.opts.askUser(`q_${randomBytes(4).toString("hex")}`, questions);
    } catch {
      return { kind: "cancel" };
    }
    const first = questions[0];
    const selected = answers["q:0"] ?? (first ? answers[first.question] : undefined) ?? [];
    return classifyCarefulAnswer(selected[0]);
  }

  /**
   * A quick, cursory read of the workspace for the clarify pre-layer, so its
   * questions are grounded in what the code actually is. Layered by cost, richest
   * first, and fail-open — any error yields no skim and the clarify proceeds as
   * before. All sources are deterministic reads (no model call):
   *   1. the prebuilt design atlas, if present (the richest map, a free read);
   *   2. else an import-graph skeleton (top files + scale) — cheap on a warm
   *      cache, a one-time build if cold;
   *   3. else a bounded peek at the working dir (README/manifests + layout), so
   *      even an unmapped project still gets an overview before we ask.
   * The result is capped so it stays a cursory glance, never a context dump.
   */
  private buildClarifySkim(): string | undefined {
    let digest: string | undefined;
    try {
      const atlas = loadAtlas(this.cwd);
      if (atlas) {
        digest = `Design atlas (.magentra/ATLAS.md):\n${atlas}`;
      } else {
        // workspaceLooksNonTrivial is a depth-1 check — cheap enough to gate the
        // graph load, which the user opted to allow to build once when cold.
        const skeleton = workspaceLooksNonTrivial(this.cwd)
          ? graphSkeleton(loadOrBuildGraph(this.cwd), projectName(this.cwd))
          : undefined;
        digest = skeleton ?? this.peekWorkspaceOverview();
      }
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

    // A2: hot-reload the crew when its files changed since the last turn.
    if (this.opts.onTeamFilesChanged) {
      const sig = this.teamDirSignature();
      if (this.lastTeamSig !== undefined && sig !== this.lastTeamSig) this.opts.onTeamFilesChanged();
      this.lastTeamSig = sig;
    }

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

    // Skill turn-start injections fire ONCE per conversation, not every turn —
    // repeating them each turn duplicated the same text into history forever
    // (~140 tokens/turn with several skills on). The set tracks which texts
    // are already in context: a skill enabled mid-session injects on the next
    // turn, and compaction clears the set so the surviving conversation gets
    // the reminders re-established after the originals were summarized away.
    for (const text of this.opts.modeEngine?.turnStartInjections() ?? []) {
      if (this.injectedSkillReminders.has(text)) continue;
      this.remind(text);
      this.injectedSkillReminders.add(text);
    }

    // debug.ma: at most one "rerun the repro" verify nudge per turn.
    this.debugVerifyNudgeFired = false;
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
    /** This session's OWN main-loop spend, which is what the per-turn budget and
     *  the crew ledger are about. The tree-wide total (this plus the auxiliary
     *  prompts and every subagent) is the stats phase, opened just below. */
    const turnUsage: Usage = emptyUsage();
    // Open the deliberation phase: from here every invocation anywhere in the
    // tree counts toward this turn's D(t) and T_turn. Only the root opens one —
    // children share this ledger, so a subagent must add to the phase in flight
    // rather than restart it and zero the meter the user is watching.
    if (!this.opts.child) this.stats.beginPhase();

    this.emit({ type: "turn_started", turnId });

    // The pre-layers that put questions to the user, in the order they matter.
    //
    // The CAREFUL predictor runs FIRST, because its verdict decides which
    // question layer the turn gets. A careful turn asks its own, richer round —
    // grounded in the codebase map, and allowed more questions — so running the
    // lighter clarify layer as well would ask the user about the same choices
    // twice. Everything else keeps clarify exactly as it was.
    let carefulTurn = false;
    /** The graph-derived starting position for the scout; undefined when the
     *  workspace yielded nothing to orient with. */
    let carefulMap: CarefulScoutMap | undefined;
    let clarification: string | undefined;
    if (this.isCarefulActive()) carefulTurn = await this.predictCareful(userText);

    if (!carefulTurn && this.settings.clarify && !this.opts.child && !this.unattended) {
      clarification = await this.maybeClarify(userText);
    }

    // CAREFUL MODE. The hold goes up before the first model call, which is what
    // makes the scout phase real rather than advisory — but the questions come
    // up BEFORE even that: their answers steer where the scout looks, so asking
    // after the reading would arrive too late to save any of it.
    if (carefulTurn) {
      carefulMap = this.buildCarefulScoutMap(userText);
      clarification = await this.askCarefulQuestions(userText, carefulMap);
      // Re-rank with the user's answers folded into the query: they name the
      // direction in their own words, which is the strongest query text there is.
      if (clarification !== undefined) carefulMap = this.buildCarefulScoutMap(userText, clarification);
      this.permissions.setCarefulHold(true);
      // The section carries the proposal format, so the scout writes the
      // proposal itself the moment its stop test passes rather than being asked
      // for it two round trips later. It also carries the user's own words, so
      // the language of the proposal is decided from the request and not from
      // whatever language this repository's comments happen to be in.
      this.setPromptSection("careful", carefulScoutSection(userText));
      // Deliberation is silent from the very first round: the user asked for
      // the scouting, the review and the drafting to happen with no output but
      // the tool activity itself.
      this.suppressAssistantText = true;
      // "▶ " marks a phase banner in the renderer — the same convention the
      // Workflow engine already uses, so the scout's steps are visible without
      // a new protocol frame (ADR 0002).
      this.emit({ type: "command_output", text: "▶ carefully: scouting" });
    }

    // OVERDRIVE safety net: before an uncapped autonomous turn starts, park a
    // dangling stash commit of the working tree so anything an in-workspace
    // deletion later removes stays recoverable. Root sessions only — children
    // share the same tree.
    if (this.overdrive && !this.opts.child) await this.snapshotForOverdrive();

    // Zero-cost first-turn hint: point the user at `/atlas` when this workspace
    // has no atlas (or a stale machine-owned one). Fires once per session, never
    // for subagents, and is cheap (one file read + at most one git call) — it
    // must not throw, so any failure is swallowed.
    this.maybeHintAtlas();

    // Fallback: no atlas on disk — nudge the model to suggest /atlas (or map the
    // design itself for non-trivial work), once per session.
    if (!this.atlasReminderFired && loadAtlas(this.cwd) === undefined && workspaceLooksNonTrivial(this.cwd)) {
      this.remind(promptText(NO_ATLAS_REMINDER));
      this.atlasReminderFired = true;
    }

    this.pushMessage({
      role: "user",
      content: this.withReminders([
        { type: "text", text: userText },
        ...(clarification !== undefined ? [{ type: "text" as const, text: clarification }] : []),
        // The scout's starting position rides with the request itself, so its
        // very first round already knows where the work lands.
        ...(carefulMap !== undefined
          ? [{ type: "text" as const, text: carefulScoutMapText(carefulMap.text) }]
          : []),
      ]),
    });

    let stopReason: string = "end_turn";
    let stopHookFired = false;
    let lastBatchHadError = false;
    let nudgeCount = 0;
    // The interactive root turn runs uncapped — the stall detector is the
    // brake. Only unattended (mission) runs and children keep the numeric
    // budgets: a mission's budgetTokens must bound a run nobody is watching,
    // and an explicit spawn-time child cap must still be enforced.
    const capped = this.unattended || (this.opts.child ?? false);
    // CAREFUL MODE turn state. `carefulProposalArmed` marks that the fallback
    // proposal instruction has already been sent, so a scout that stops a second
    // time without proposing is not asked a third time.
    let carefulHeld = carefulTurn;
    let carefulProposalArmed = false;
    /** The grounding floor fires once per proposal — see carefulGroundingGap. */
    let carefulGroundingChecked = false;
    let carefulRevisions = 0;
    // Rounds spent reading since the phase (or the last revision) began, and
    // whether the soft warn has fired for this pass. Neither ever ends the
    // phase: a scout cut off mid-read proposes from a half-formed picture, and
    // a confident wrong understanding is what CAREFUL exists to prevent
    // (ADR 0005).
    let carefulScoutRounds = 0;
    let carefulWarned = false;
    // Re-attempts spent getting a SHOWABLE proposal out of the model — one that
    // is not empty and whose paths exist. Bounded, so a model that cannot manage
    // either still reaches the user rather than looping: a flawed proposal the
    // user can reject beats a turn that never produces one.
    let carefulProposalRetries = 0;
    const CAREFUL_MAX_PROPOSAL_RETRIES = 2;
    // Lifts the hold and drops the scout prompt section. Idempotent — the
    // approval path, the cancel path and the turn's `finally` all call it.
    const releaseCarefulHold = (): void => {
      if (!carefulHeld) return;
      carefulHeld = false;
      this.permissions.setCarefulHold(false);
      this.setPromptSection("careful", undefined);
      this.suppressAssistantText = false;
    };
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

        const { assistant, toolCalls, end } = await this.streamAssistantTurn(signal);
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

        if (toolCalls.length === 0) {
          // Pending steering outranks every end-of-turn decision: the user's
          // mid-run guidance must be acted on, not dropped by a clean break.
          if (drainSteering()) continue;

          // CAREFUL MODE: this turn is not ending, it is advancing through the
          // scout's phases — ground, propose, check, gate. Placed ahead of
          // every other rung because nothing has been built yet: there is no
          // failure to recover from, no task list to finish, and nothing to
          // self-verify. A response the token limit cut off falls through to
          // LAYER 3 instead, so a truncated proposal is resumed rather than
          // mistaken for a finished one.
          if (carefulHeld && stopReason !== "max_tokens") {
            const proposal = assistantText(assistant).trim();
            // The grounding floor, before anything else: a scout that has opened
            // none of the source files its own map ranked is about to describe
            // behaviour it never read. Deterministic, and asked once.
            if (!carefulGroundingChecked) {
              carefulGroundingChecked = true;
              const gap = this.carefulGroundingGap(carefulMap?.ranked ?? []);
              if (gap.length > 0) {
                this.emit({
                  type: "command_output",
                  text: `◉ carefully: about to propose without reading the code — pointing it at ${gap[0]}`,
                });
                this.pushMessage({ role: "user", content: [{ type: "text", text: carefulGroundingText(gap) }] });
                continue;
              }
            }
            // The scout carries the proposal format in its own system prompt, so
            // the common case is that this text ALREADY is the proposal — no
            // round trip is spent asking for one. Only a scout that stopped
            // without writing it is prompted, and only once.
            if (!looksLikeProposal(proposal)) {
              if (!carefulProposalArmed) {
                carefulProposalArmed = true;
                this.emit({ type: "command_output", text: "▶ carefully: writing the proposal" });
                this.pushMessage({ role: "user", content: [{ type: "text", text: carefulProposalText(userText) }] });
                continue;
              }
              // It was asked and still did not produce one. An empty response
              // has nothing to gate on at all; anything else is shown as it is
              // and the user judges it, which beats a turn that never ends.
              if (proposal === "") {
                releaseCarefulHold();
                this.emit({
                  type: "command_output",
                  text: "◉ carefully: no proposal came back — nothing was changed. Try again, or /careful off.",
                });
                stopReason = "end_turn";
                break;
              }
            }
            const retriesLeft = carefulProposalRetries < CAREFUL_MAX_PROPOSAL_RETRIES;
            const unknownPaths = retriesLeft ? this.unknownProposalPaths(proposal) : [];
            if (unknownPaths.length > 0) {
              carefulProposalRetries++;
              this.emit({
                type: "command_output",
                text: `◉ carefully: ${unknownPaths.length} named path${unknownPaths.length === 1 ? " does" : "s do"} not exist — correcting`,
              });
              this.pushMessage({
                role: "user",
                content: [{ type: "text", text: carefulUnknownPathsText(unknownPaths) }],
              });
              continue;
            }
            // Clean. Reveal it and gate on it.
            this.suppressAssistantText = false;
            if (proposal) this.emit({ type: "text_delta", text: proposal });
            const decision = await this.askCarefulApproval(carefulRevisions);
            if (decision.kind === "approve") {
              releaseCarefulHold();
              this.emit({ type: "command_output", text: "▶ carefully: approved — starting work" });
              // The approved proposal is repeated as the brief, not referenced:
              // it is the input the work runs on, and leaving it buried under
              // the scout's tool results would waste the checkpoint.
              this.pushMessage({
                role: "user",
                content: [{ type: "text", text: carefulApprovedText(proposal) }],
              });
              continue;
            }
            if (decision.kind === "revise") {
              carefulRevisions++;
              carefulProposalArmed = false;
              carefulProposalRetries = 0;
              carefulScoutRounds = 0;
              carefulWarned = false;
              // The new direction gets its own floor: files that grounded the
              // last proposal say nothing about where this one lands.
              carefulGroundingChecked = false;
              this.suppressAssistantText = true;
              this.emit({
                type: "command_output",
                text: `▶ carefully: revising the proposal (revision ${carefulRevisions})`,
              });
              // A revision usually redirects, so the old map now points at the
              // wrong part of the repository — re-seed it from what they said.
              const revisedMap = this.buildCarefulScoutMap(`${userText}\n${decision.text}`, decision.text);
              if (revisedMap !== undefined) carefulMap = revisedMap;
              this.pushMessage({
                role: "user",
                content: [
                  { type: "text", text: carefulRevisionText(decision.text) },
                  ...(revisedMap !== undefined
                    ? [{ type: "text" as const, text: carefulScoutMapText(revisedMap.text) }]
                    : []),
                ],
              });
              continue;
            }
            releaseCarefulHold();
            this.emit({ type: "command_output", text: "◉ carefully: cancelled — nothing was changed" });
            this.pushMessage({ role: "user", content: [{ type: "text", text: CAREFUL_CANCELLED_TEXT }] });
            stopReason = "end_turn";
            break;
          }

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
          // turn on a truncated answer.
          if (stopReason === "max_tokens") {
            nudgeCount++;
            this.emit({ type: "command_output", text: "↻ continuing after output-length cutoff" });
            this.pushMessage({ role: "user", content: [{ type: "text", text: promptText(LENGTH_CONTINUATION_TEXT) }] });
            continue;
          }

          // DEBUG VERIFY: debug.ma's repro oracle saw the script fail but never
          // observed it pass again — the fix (if any) is unverified. Force one
          // more iteration demanding a rerun, guarded by its own once-per-turn
          // flag (not the nudge cap) so the oracle is always checked.
          if (
            this.opts.modeEngine?.requiresReproOracle() &&
            this.reproFailedObserved &&
            !this.reproPassedObserved &&
            !this.debugVerifyNudgeFired
          ) {
            this.debugVerifyNudgeFired = true;
            this.emit({ type: "command_output", text: "↻ debug: repro not yet observed passing — verify" });
            this.pushMessage({
              role: "user",
              content: [{ type: "text", text: debugVerifyNudgeText(reproScriptRelPath()) }],
            });
            continue;
          }

          // LAYER 2: the previous tool-result batch had a failure and the
          // turn is ending regardless of what the final text says — weak
          // models sometimes bury a failure under a long non-answer. Nudge
          // it to keep going; the stall detector terminates a model that
          // keeps failing identically.
          if (stopReason === "end_turn" && lastBatchHadError) {
            nudgeCount++;
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
          // same shape as CAREFUL's grounding floor, because it catches the same
          // kind of quiet failure: a turn that looks finished and is not.
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
                content: [{ type: "text", text: runtimeEvidenceText(changedCode, this.settings.vision, doubles) }],
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
          if (stopReason === "end_turn" && !selfVerifyFired && totalToolCallsThisTurn > 0 && this.overdrive) {
            selfVerifyFired = true;
            verifyBuffered = true;
            this.suppressAssistantText = true; // the verify answer streams silently
            this.emit({ type: "command_output", text: "⚡ overdrive: self-verifying against the original query" });
            this.pushMessage({
              role: "user",
              content: [{ type: "text", text: selfVerifyText(codeFilesAmong(this.filesChangedThisTurn)) }],
            });
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
            const checklist = this.opts.modeEngine?.wrapupChecklist() ?? "";
            // Whether anything was actually written, from the same observation
            // the finishing rungs use: a Write that was refused or that failed
            // its freshness check changed no module, so it must not pull in the
            // atlas and standards reminders.
            const wroteOrEdited = this.filesChangedThisTurn.size > 0;
            const mentionAtlas = wroteOrEdited && loadAtlas(this.cwd) !== undefined;
            const mentionStandards = wroteOrEdited && loadStandards(this.cwd) !== undefined;
            this.pushMessage({
              role: "user",
              content: [{ type: "text", text: wrapupNudgeText(checklist, mentionAtlas, mentionStandards) }],
            });
            continue;
          }

          break;
        }

        // A max_tokens stop with tool calls pending means the response was cut
        // off mid-tool-call. Surface the same continuation marker the text path
        // shows (Layer 3); the truncated call is rejected with TOOL_CUTOFF_TEXT
        // inside executeToolCalls, and complete calls in the batch still run.
        if (stopReason === "max_tokens") {
          this.emit({ type: "command_output", text: "↻ continuing after output-length cutoff" });
        }
        totalToolCallsThisTurn += toolCalls.length;
        // CAREFUL MODE soft warn: past a few rounds of reading, remind the scout
        // of the stop test it was already given — once, and without ending
        // anything. A numeric cap would cut it mid-read and leave it proposing
        // from a half-formed picture, which is the failure the whole mode exists
        // to prevent (ADR 0005).
        if (carefulHeld) {
          carefulScoutRounds++;
          if (!carefulWarned && carefulScoutRounds >= CAREFUL_SCOUT_WARN_AFTER_ROUNDS) {
            carefulWarned = true;
            this.remind(CAREFUL_SCOUT_WARN_TEXT);
          }
        }
        const results = await this.executeToolCalls(toolCalls, signal);
        lastBatchHadError = results.some((r) => r.type === "tool_result" && r.isError === true);
        if (lastBatchHadError) {
          this.remind(promptText(ERROR_BATCH_REMINDER));
          for (const text of this.opts.modeEngine?.afterErrorInjections() ?? []) this.remind(text);
        }
        // Stall detector: a round that exactly repeats the previous one (same
        // calls, same results) produced nothing new. Three in a row is a
        // stall — force a strategy pivot; after two spent pivots, force one
        // concrete question to the user instead of burning forever.
        {
          const sig = JSON.stringify([toolCalls.map((c) => c.name + c.json), results]);
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
        // no final answer — the atlas build was the canonical casualty.
        if (capped && iteration === this.settings.maxIterationsPerTurn - 2) {
          this.remind(
            "Final tool round: the per-turn iteration cap is reached after this response. Give your complete final answer now — further tool calls will be cut off.",
          );
        }
        this.pushMessage({ role: "user", content: this.withReminders(results) });
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
      // Nor may a turn that died mid-scout leave the session held: an
      // interrupt, a provider failure or a thrown tool would otherwise lock
      // every subsequent turn out of writing anything, with no way back.
      releaseCarefulHold();
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
            careful: this.careful,
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
        ...(this.autoCompactLimit > 0 && liveContext >= Math.floor(this.autoCompactLimit * 0.9)
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
    // (per model — a crew child may run on a different one), the API time it
    // took, and, for a root session, the window occupancy its input reveals.
    // The ledger is shared with the parent, so a crew/subagent's spend lands in
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
      const tool = this.registry.get(call.name);
      if (!tool) {
        planned.push({
          call,
          parallel: true,
          run: async () => ({
            content: `Unknown tool "${call.name}". Available tools: ${this.registry.list().map((t) => t.name).join(", ")}`,
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
      const parsed = tool.inputSchema.safeParse(rawInput);
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
          // (for a Write) decide whether a new-file creation should be refused.
          if (tool.searchTerms) {
            try {
              this.searchLog.record(tool.searchTerms(input));
            } catch {
              // evidence logging must never break the call it observes
            }
          }
          const gateHit = this.opts.modeEngine?.gateFor(tool.name);
          if (gateHit) {
            if (gateHit.gate.require === "never") {
              return { content: gateHit.gate.message, isError: true };
            }
            if (gateHit.gate.require === "tasks-exist" && this.tasks.list().length === 0) {
              return { content: gateHit.gate.message, isError: true };
            }
            // debug.ma repro oracle: edits stay locked until the repro script has
            // been observed failing — except a Write/Edit into the debug dir
            // itself, so the model can create and refine that very script.
            if (
              gateHit.gate.require === "repro-failed" &&
              !this.reproFailedObserved &&
              !this.isDebugScriptWrite(tool.name, input)
            ) {
              return { content: gateHit.gate.message, isError: true };
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
            this.observeReproRun(tool.name, input, result.isError === true);
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

    return calls.map((call) => {
      const result = results.get(call.id) ?? { content: "Tool did not run.", isError: true };
      this.emit({
        type: "tool_call_finished",
        id: call.id,
        tool: call.name,
        resultPreview: preview(result),
        isError: result.isError ?? false,
      });
      return {
        type: "tool_result",
        toolUseId: call.id,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      };
    });
  }

  private toolContext(): ToolContext {
    return { cwd: this.cwd, session: this.services };
  }

  /**
   * debug.ma repro oracle. Watches Bash calls that run the designated repro
   * script (matched structurally on the command string): a nonzero exit marks
   * the bug reproduced — unlocking edits via the repro-failed gate — while a
   * zero exit AFTER a prior failure marks the fix verified. A pass is credited
   * only once a failure has been seen: the fail→pass sequence is what validates
   * the oracle, so a green run before any red is not a proof.
   */
  private observeReproRun(toolName: string, input: unknown, isError: boolean): void {
    if (toolName !== "Bash") return;
    if (typeof input !== "object" || input === null) return;
    const command = (input as Record<string, unknown>).command;
    if (typeof command !== "string" || !commandRunsRepro(command)) return;
    if (isError) this.reproFailedObserved = true;
    else if (this.reproFailedObserved) this.reproPassedObserved = true;
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
   * True when a Write/Edit targets the debug workspace (<cwd>/.magentra/debug/).
   * The repro-failed gate lets these through before any failing run so the model
   * can create and refine the oracle script itself. Reads `file_path`
   * structurally (this module must not depend on @magentra/tools).
   */
  private isDebugScriptWrite(toolName: string, input: unknown): boolean {
    if (toolName !== "Write" && toolName !== "Edit") return false;
    if (typeof input !== "object" || input === null) return false;
    const filePath = (input as Record<string, unknown>).file_path;
    if (typeof filePath !== "string") return false;
    const debugRoot = resolve(this.cwd, DEBUG_DIR);
    const target = resolve(this.cwd, filePath);
    return target === debugRoot || target.startsWith(debugRoot + sep);
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
    this.autoNameDone = true; // claim before the await so two settling turns can't both fire
    try {
      const raw = await this.runInference({
        system: promptText(AUTO_NAME_ROLE),
        user: `${promptText(AUTO_NAME_INSTRUCTION)}\n\n---\n${this.conversationDigest(4000)}\n---`,
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
   * exactly. Skills physically live inside the system string; they are broken
   * out (and subtracted from it) so their weight is visible on its own without
   * being counted twice. `limit` is the user's auto-compact limit (0 = none
   * set), used to show free space; without a limit there is no window to compute
   * free space against.
   */
  contextBreakdown(): ContextBreakdown {
    const skillsText = skillsBlock(this.opts.skills ?? []) ?? "";
    const skills = estimateTokens(skillsText);
    // System prompt without the skills block, so the two don't double-count.
    const systemPrompt = Math.max(0, estimateTokens(this.buildSystemPrompt()) - skills);
    const tools = estimateTokens(JSON.stringify(this.toolSchemas()));
    const messages = this.estimateContextTokens();
    return { systemPrompt, tools, skills, messages, limit: this.autoCompactLimit };
  }

  /** An estimate of the whole context right now — system prompt + tool schemas +
   * skills + surviving message history — used to seed `contextTokens` after a
   * compaction (before the next response measures it exactly) so the meter never
   * reads a misleading ~0 for a window that still holds the system prompt and
   * the summary. */
  private estimateContextNow(): number {
    const b = this.contextBreakdown();
    return b.systemPrompt + b.tools + b.skills + b.messages;
  }

  /** Set the auto-compact token limit. 0 (or invalid) disables auto-compaction.
   * The ONLY source of this value is the UI's set_compact_limit frame — there is
   * deliberately no settings key or /settings path, so it can never disagree. */
  setAutoCompactLimit(limit: number): void {
    this.autoCompactLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  }

  /** True when the context is within 10% of the user's auto-compact limit — the
   * UI tints its counter as it approaches. False when no limit is set. The engine
   * never guesses the model window; this is purely the user's own chosen number. */
  contextOverWarnThreshold(): boolean {
    return this.autoCompactLimit > 0 && this.stats.contextTokens >= Math.floor(this.autoCompactLimit * 0.9);
  }

  /**
   * Compaction is either MANUAL (`/compact`, force) or fires at a limit the user
   * set in the UI. With no limit set (the default) nothing is compacted
   * automatically — the engine never guesses the model's usable window (it varies
   * by provider, tier, and endpoint, so any guess misinforms). The user knows
   * their own model's size and sets the limit if they want one. Returns whether
   * it compacted.
   */
  async maybeCompact(force = false): Promise<boolean> {
    if (!force) {
      if (this.autoCompactLimit <= 0 || this.stats.contextTokens < this.autoCompactLimit) return false;
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
    // (system prompt + tools + skills + summary + surviving tail) — NOT zero.
    // The window is far from empty, and a ~0 reading would both misinform the
    // context meter and disarm the compaction safety until the next response
    // re-measures. (Cost/usage totals stay — compaction does not un-bill spend.)
    // Root only: the shared figure describes the root's window, and a child
    // compacting its own history says nothing about how full that one is.
    if (!this.opts.child) this.stats.contextTokens = this.estimateContextNow();
    // The original skill reminders likely lived in the summarized span — let
    // the next turn re-establish them in the surviving conversation.
    this.injectedSkillReminders.clear();
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
      this.emit({
        type: "command_output",
        text: `Auto-compacted (~${formatTokens(before)} tokens summarized): the context reached your auto-compact limit of ${formatTokens(this.autoCompactLimit)} tokens. Raise or turn it off in Settings → Context.`,
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
      system: promptText(COMPACTION_SYSTEM),
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

/**
 * How many questions each layer may ask.
 *
 * The clarify pre-layer runs on ordinary turns and stays deliberately light.
 * CAREFUL's round is allowed more: it only fires on substantial work, it runs
 * before the agent reads anything, and its answers steer that reading — so
 * under-asking there wastes a whole investigation, which is the expensive
 * direction to be wrong in.
 */
const CLARIFY_MAX_QUESTIONS = 3;
const CAREFUL_MAX_QUESTIONS = 5;

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

/**
 * Validates a model-authored `questions` array into protocol-shaped questions,
 * dropping anything malformed. Shared by the clarify pre-layer and CAREFUL
 * MODE's pre-proposal round: the wire shape they ask for is identical, so
 * validating it twice would be two places to get the caps wrong.
 * Returns undefined when nothing usable survives — every caller reads that as
 * "ask nothing", which is the fail-open direction.
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
 * Salvages a truncated reply the same way CAREFUL's round does, and for the
 * same reason. A cut-off reply has no closing brace, so `clarify` cannot be
 * read at all — but a reply containing question objects is one where the model
 * had already decided to ask, so recovering them is sound. Without this, a
 * layer that ran too long asks nothing and says nothing.
 */
function parseClarifyVerdict(raw: string): ShapeQuestion[] | undefined {
  const rec = parseJsonObject(raw);
  if (rec !== undefined) {
    if (rec.clarify !== true) return undefined;
    return parseQuestionArray(rec.questions, "Clarify", CLARIFY_MAX_QUESTIONS);
  }
  return parseQuestionArray(salvageQuestionObjects(raw), "Clarify", CLARIFY_MAX_QUESTIONS);
}

/**
 * Parses CAREFUL MODE's pre-proposal round. `{"questions": []}` — the answer the
 * prompt asks for when nothing genuinely needs the user — yields undefined, so
 * the scout starts with no round trip.
 *
 * Falls back to {@link salvageQuestionObjects} when the reply is not valid JSON,
 * because the way this layer fails is not "malformed": it is TRUNCATED. Five
 * questions with described options is a long reply, and a reply cut off at the
 * token limit ends mid-string with no closing brace. Strict parsing then reads
 * an over-long, entirely correct answer as "ask the user nothing" — the exact
 * failure that let a request as open as "improve the existing game" reach the
 * scout unclarified. Whatever question objects completed are still good.
 */
function parseCarefulQuestions(raw: string): ShapeQuestion[] | undefined {
  const rec = parseJsonObject(raw);
  // A `questions` array that parsed is the model's ANSWER, empty or not, and it
  // stands. Salvage is only for the truncation signature — no parseable object,
  // or one whose `questions` never closed — so a deliberate `{"questions": []}`
  // can never be overridden by a question object echoed back somewhere in the
  // prose around it.
  if (rec !== undefined && Array.isArray(rec.questions)) {
    return parseQuestionArray(rec.questions, "Decide", CAREFUL_MAX_QUESTIONS);
  }
  return parseQuestionArray(salvageQuestionObjects(raw), "Decide", CAREFUL_MAX_QUESTIONS);
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

/** debug.ma: the verify nudge fired when the repro failed but was never seen passing again this turn. */
const DEBUG_VERIFY_NUDGE = definePrompt({
  id: "reminder.debug-verify",
  group: "3 · In-turn reminders",
  label: "Repro not seen passing",
  channel: "reminder",
  where:
    "Fires when a discipline skill enforces the repro-failed oracle and the repro script failed but was never observed passing again this turn.",
  placeholders: ["reproPath"],
  text: `<system-reminder>The repro script has not been observed passing since it failed. Rerun {{reproPath}} now and report the result — or state plainly that the fix is UNVERIFIED.</system-reminder>`,
});

function debugVerifyNudgeText(reproPath: string): string {
  return renderPrompt(DEBUG_VERIFY_NUDGE, { reproPath });
}

/** Folds an active mode's wrap-up checklist and the atlas/standards nudges into the wrap-up nudge. */
function wrapupNudgeText(checklist: string, mentionAtlas = false, mentionStandards = false): string {
  let text = promptText(WRAPUP_NUDGE_TEXT);
  if (checklist) {
    text = text.replace("</system-reminder>", `\nAlso check:\n${checklist}</system-reminder>`);
  }
  if (mentionAtlas) {
    text = text.replace(
      "</system-reminder>",
      `\nIf any module or public interface changed, update .magentra/ATLAS.md to match.</system-reminder>`,
    );
  }
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
