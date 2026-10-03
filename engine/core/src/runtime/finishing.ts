// FINISHING RUNGS — the end-of-turn checks that stand between "the model stopped
// talking" and "the work is delivered".
//
// They live at the bottom of the same ladder in Session.runTurn, ahead of the
// self-verify rung, because a self-verify that answers DONE breaks the loop and
// nothing placed after it would ever run.
//
//   runtime evidence  → deterministic. The turn changed source files and never
//                       executed anything, so nothing about it has been OBSERVED
//                       working. Fires once, names the files, and asks for a real
//                       run. A reminder, never a block — the same shape as the
//                       Grounding Floor, for the same reason: the failure it
//                       catches looks like success. It has a second shape for the
//                       turn that DID run something, where what it ran was a
//                       stand-in it wrote itself.
//
// Everything here is prose and pure functions. It deliberately imports nothing
// from the session or the permission engine, so it can be checked in isolation.

import { extname } from "node:path";
import { brainPrompt, promptText, renderPrompt, renderPromptIfEnabled, type BrainBehavior } from "@magentra/protocol";

// The detector lists and counts below come from brain/behavior.json (the
// `evidence` section, finishing.maxNamedFiles, finishing.selfVerify.maxHedges).
// Every exported judge takes the behaviour object the session is running with
// — the base, or base + overdrive.overrides while OVERDRIVE is on — so nothing
// here holds a value of its own.

/** Escapes `text` for a RegExp source. `-` is left alone: outside a character
 *  class it is literal, and leaving it keeps the rebuilt sources byte-equal to
 *  the hand-written patterns they replaced. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches nothing: what an emptied list compiles to. */
const NEVER = /(?!)/;

/** The detectors one behaviour object implies, built once per object. */
interface Detectors {
  readonly codeExtensions: ReadonlySet<string>;
  readonly uiExtensions: ReadonlySet<string>;
  /** `name.<infix>.ext` — a test or story, never the page. */
  readonly uiExclude: RegExp;
  readonly testDoubleMarkers: readonly string[];
  /** A command word or flag that drives a browser. */
  readonly browserRun: RegExp;
  /** Heads that only READ or print a command's words: `cat playwright.config.ts` runs no browser. */
  readonly notARun: RegExp;
  readonly screenshot: RegExp;
}

const detectorCache = new WeakMap<BrainBehavior, Detectors>();

function detectorsOf(b: BrainBehavior): Detectors {
  let d = detectorCache.get(b);
  if (d === undefined) {
    const infixes = b.evidence.uiExcludeInfixes;
    const tools = b.evidence.browserRun.tools;
    const runParts = [
      ...(tools.length > 0 ? [`\\b(?:${tools.map(escapeRegExp).join("|")})\\b`] : []),
      ...b.evidence.browserRun.flags.map((flag) => `${escapeRegExp(flag)}\\b`),
    ];
    const heads = b.evidence.browserRun.readOnlyHeads;
    const shots = b.evidence.screenshotExtensions;
    d = {
      codeExtensions: new Set(b.evidence.codeExtensions),
      uiExtensions: new Set(b.evidence.uiExtensions),
      uiExclude: infixes.length > 0 ? new RegExp(`\\.(?:${infixes.map(escapeRegExp).join("|")})\\.[^.\\\\/]+$`, "i") : NEVER,
      testDoubleMarkers: b.evidence.testDoubleMarkers,
      browserRun: runParts.length > 0 ? new RegExp(runParts.join("|"), "i") : NEVER,
      notARun: heads.length > 0 ? new RegExp(`^(?:${heads.map(escapeRegExp).join("|")})$`, "i") : NEVER,
      // A regex, not extname: extname(".png") is "", and the old pattern
      // matched a bare ".png" too.
      screenshot: shots.length > 0 ? new RegExp(`\\.(?:${shots.map((e) => escapeRegExp(e.slice(1))).join("|")})$`, "i") : NEVER,
    };
    detectorCache.set(b, d);
  }
  return d;
}

/**
 * The subset of `paths` whose suffix marks them as runnable source
 * (evidence.codeExtensions). The list is deliberately generous — the rung it
 * feeds only ever reminds, and a reminder on a file that turns out to be
 * unrunnable costs one honest sentence, while a miss costs an unverified
 * change. Documentation, configuration and data files are absent on purpose:
 * editing a README or a lockfile is not a behaviour change.
 */
export function codeFilesAmong(paths: Iterable<string>, b: BrainBehavior): string[] {
  const { codeExtensions } = detectorsOf(b);
  const out: string[] = [];
  for (const path of paths) {
    if (codeExtensions.has(extname(path).toLowerCase())) out.push(path);
  }
  return out;
}

/**
 * Whether written text stands something in for a real dependency
 * (evidence.testDoubleMarkers, plain substrings). The markers are chosen for
 * PRECISION, not coverage: a miss costs nothing beyond today's behaviour, while
 * a false positive spends a round trip and teaches the model to skim past the
 * reminder.
 */
export function looksLikeTestDouble(text: string, b: BrainBehavior): boolean {
  return detectorsOf(b).testDoubleMarkers.some((marker) => text.includes(marker));
}

/** The subset of `paths` a user looks at in a browser (evidence.uiExtensions —
 *  plain .js is left out: it is as often a server as a page). A test or spec
 *  file is not the page, however it is spelled (evidence.uiExcludeInfixes). */
export function uiFilesAmong(paths: Iterable<string>, b: BrainBehavior): string[] {
  const { uiExclude, uiExtensions } = detectorsOf(b);
  const out: string[] = [];
  for (const path of paths) {
    if (uiExclude.test(path)) continue;
    if (uiExtensions.has(extname(path).toLowerCase())) out.push(path);
  }
  return out;
}

/** Whether a Read of `path` looked at a picture of the page (evidence.screenshotExtensions). */
export function isScreenshotPath(path: string, b: BrainBehavior): boolean {
  return detectorsOf(b).screenshot.test(path);
}

/** Installing or updating a browser driver is not driving one. */
const INSTALL = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|remove|rm|uninstall|update|up)\b|pip3?\s+install\b|python3?\s+-m\s+(?:pip|playwright)\s+install\b|(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:-y\s+)?playwright\s+install\b|playwright\s+install\b|brew\s+install\b|apt(?:-get)?\s+install\b)/i;

/** Whether a shell command drives a browser — one of its commands, not a mention of one. */
export function looksLikeBrowserRun(command: string, b: BrainBehavior): boolean {
  const { browserRun, notARun } = detectorsOf(b);
  return command.split(/&&|\|\||[;|\n]/).some((segment) => {
    const s = segment.trim().replace(/^(?:sudo|env|time|nohup)\s+/, "");
    if (!browserRun.test(s)) return false;
    const head = s.split(/\s+/)[0]?.split(/[\\/]/).pop() ?? "";
    if (notARun.test(head) || INSTALL.test(s)) return false;
    return !/(?:^|\s)--?(?:version|help|v|h)\b/.test(s);
  });
}

/** The changed files a rung names, then a count (finishing.maxNamedFiles). A
 *  reminder that lists forty paths teaches nothing and costs the context it
 *  takes; the point is to name the work, not to reprint the diff. */
function fileList(files: string[], b: BrainBehavior): string {
  if (files.length <= b.finishing.maxNamedFiles) return files.join(", ");
  return `${files.slice(0, b.finishing.maxNamedFiles).join(", ")} and ${files.length - b.finishing.maxNamedFiles} more`;
}

/**
 * The runtime-evidence rung. Sent when source files changed this turn and no
 * command was ever run, which means the change has been reasoned about but
 * never observed.
 *
 * It asks for behaviour, not ritual: run the path that changed and the callers
 * it reaches, watch something real (exit code, stdout, a log line, a returned
 * value), and throw the scaffolding away afterwards. It explicitly does NOT ask
 * for a new permanent test — growing a suite on every edit is its own kind of
 * mess, and the user asked for proof, not for files.
 *
 * The closing paragraph is load-bearing and must not be trimmed. A rung that
 * demands green, applied to a dependency this machine cannot execute, does not
 * produce evidence — it produces a stand-in written from the same assumption
 * that is about to be wrong, and a passing test on top of it. Naming "I could
 * not run this, here is what stays unverified" as a FULLY correct ending is what
 * keeps the rung from manufacturing the very failure it exists to catch.
 */
const RUNTIME_EVIDENCE = brainPrompt("finishing.runtime-evidence");

const VISION_ON = brainPrompt("finishing.vision-on");

const VISION_OFF = brainPrompt("finishing.vision-off");

/**
 * The circular-evidence clause, folded into the rung above rather than shipped
 * as a rung of its own.
 *
 * It answers a question the rest of the reminder cannot: the turn DID run
 * something, so "nothing was observed" is false — but what it observed was a
 * model of the dependency, authored by the same understanding that authored the
 * code. The two agree by construction. Only the argument survives the merge;
 * confirming a contract from the dependency and naming an honest gap are
 * already said once in the closing paragraphs, and saying them twice in one
 * reminder teaches the model to skim.
 */
const DOUBLE_CLAUSE = brainPrompt("finishing.double-clause");

/**
 * The runtime-evidence rung's text, or undefined when finishing.runtime-evidence
 * is switched off (enabled: false or a blank override): the caller then skips
 * the rung, since a blank message would still cost the round it was emptied to avoid.
 */
export function runtimeEvidenceText(files: string[], vision: boolean, doubleFiles: string[], b: BrainBehavior): string | undefined {
  return renderPromptIfEnabled(RUNTIME_EVIDENCE, {
    files: fileList(files, b),
    visionNote: promptText(vision ? VISION_ON : VISION_OFF),
    doubleNote: doubleFiles.length === 0
      ? ""
      : renderPrompt(DOUBLE_CLAUSE, { doubleFiles: fileList(doubleFiles, b) }),
  });
}

/**
 * The browser shape of the same floor, for the turn that DID run things — the
 * server, curl, a bot against the API — and changed a page nobody opened. HTTP
 * 200 proves the file was served, not that the page works: in the 2026-09-23
 * field test every client defect the owner hit in minutes (aim, visibility,
 * feedback, the unshown "STAIRS OPEN") passed that check. Its own prompt rather
 * than a clause, because the runtime-evidence opening ("did not run a single
 * command") would be false here; it reuses the vision clauses and the fuse.
 */
const BROWSER_EVIDENCE = brainPrompt("finishing.browser-evidence");

/** The browser rung's text, or undefined when finishing.browser-evidence is switched off (the rung is skipped). */
export function browserEvidenceText(files: string[], vision: boolean, b: BrainBehavior): string | undefined {
  return renderPromptIfEnabled(BROWSER_EVIDENCE, {
    files: fileList(files, b),
    visionNote: promptText(vision ? VISION_ON : VISION_OFF),
  });
}

/**
 * The circular-evidence rung — the second shape of the same question, for the
 * turn that DID run something, where what it ran was a stand-in it wrote itself.
 *
 * This is the failure the first shape cannot see. A double is a model of the
 * dependency, authored by the same understanding that authored the code, so the
 * two agree by construction: the test passes, the assumption is never
 * challenged, and the program breaks the first time it meets the real thing. The
 * rung is a reminder, so it never blocks; what it asks for is either the real
 * contract or an honest statement of what remains unverified.
 */


/**
 * The end-of-turn self check. Judges the turn against the user's own query —
 * completeness and economy — and answers with the DONE sentinel or with the work
 * that was still missing.
 *
 * `changedCode` sharpens it rather than adding a rung of its own. The generic
 * text has to warn the model off inventing rituals, because on a conversational
 * turn a build is pure waste; but on a turn that rewrote source files the
 * opposite failure is the likely one, so the closing clause flips to demand the
 * evidence instead of warning against it.
 */
const SELF_VERIFY = brainPrompt("finishing.self-verify");

const SELF_VERIFY_CLOSING_CODE = brainPrompt("finishing.self-verify.closing-code");

const SELF_VERIFY_SYMPTOMS = brainPrompt("finishing.self-verify.symptoms");

const SELF_VERIFY_HEDGES = brainPrompt("finishing.self-verify.hedges");

/** Sentences of `text`, trimmed, each at most 200 characters. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().replace(/^[-*•]\s*/, ""))
    .filter((s) => s.length > 0)
    .map((s) => (s.length > 200 ? `${s.slice(0, 199)}…` : s));
}

/** A sentence that reports something failing. */
const SYMPTOM = /\b(?:never|does not|doesn't|do not|don't|did not|didn't|is not|isn't|are not|aren't|was not|wasn't|were not|weren't|won't|can't|cannot|fails?|failed|failing|broken|crash(?:es|ed|ing)?|throws?|threw|stuck|no longer|missing|invisible|wrong|incorrect(?:ly)?)\b|\bno (?:\w+ )?(?:feedback|output|response|effect|damage|sound)\b/i;
/** Sentences the symptom words match that report no failure: a plan, a success, code. */
const NOT_A_SYMPTOM = /\b(?:don't|do not|doesn't|does not|didn't|did not|won't|will not) (?:need|have to|want)\b|\bnever mind\b|\bno longer (?:fails?|crash\w*|throws?|breaks?|errors?|hangs?)\b|\bno longer (?:emits?|shows?|prints?|logs?|has) (?:any )?(?:warnings?|errors?)\b|\b(?:doesn't|does not) exist yet\b|\bthrow new\b/i;

/** A sentence that leaves something open. */
const HEDGE = /\b(?:may|might|could) still\b|\b(?:may|might) remain\b|\bnot (?:yet )?(?:been )?(?:verified|tested|checked|confirmed)\b|\bun(?:verified|tested|confirmed)\b|\b(?:could not|couldn't|did not|didn't|have not|haven't|was not able to|wasn't able to|unable to) (?:yet )?(?:verif(?:y|ied)|test(?:ed)?|run|confirm(?:ed)?|check(?:ed)?)\b|\bshould (?:now )?work\b|\bshould be (?:fine|ok|okay|good)\b|\b(?:probably|likely) (?:works|fine|ok)\b|\bnot sure\b/i;

/** The failures a model reported in `text` — what the self-check must see re-tested. */
export function findSymptoms(text: string): string[] {
  return sentencesOf(text).filter((s) => SYMPTOM.test(s) && !NOT_A_SYMPTOM.test(s) && !HEDGE.test(s));
}

/** The sentences of a final answer that leave something open. At most finishing.selfVerify.maxHedges. */
export function findHedges(text: string, b: BrainBehavior): string[] {
  return sentencesOf(text).filter((s) => HEDGE.test(s)).slice(0, b.finishing.selfVerify.maxHedges);
}

/** Quoted, for a clause: «a»; «b». */
function quoted(items: string[]): string {
  return items.map((s) => `«${s}»`).join("; ");
}

const SELF_VERIFY_CLOSING_PLAIN = brainPrompt("finishing.self-verify.closing-plain");

/**
 * The rung's text, or undefined when it has been switched off.
 *
 * Emptying the prompt has to cancel the whole round, not send a blank message:
 * the caller pays a full inference round either way, and that round is the cost
 * the operator was trying to remove.
 */
export function selfVerifyText(
  changedCode: string[],
  open: { symptoms?: string[]; hedges?: string[] },
  b: BrainBehavior,
): string | undefined {
  const base = changedCode.length > 0
    ? renderPrompt(SELF_VERIFY_CLOSING_CODE, { files: fileList(changedCode, b) })
    : promptText(SELF_VERIFY_CLOSING_PLAIN);
  // The turn's own loose ends, quoted so the model does not have to find them.
  // They ride inside the one closing slot, so the sentinel head never varies.
  const clauses = [
    base,
    open.symptoms && open.symptoms.length > 0 ? renderPrompt(SELF_VERIFY_SYMPTOMS, { symptoms: quoted(open.symptoms) }) : "",
    open.hedges && open.hedges.length > 0 ? renderPrompt(SELF_VERIFY_HEDGES, { hedges: quoted(open.hedges) }) : "",
  ];
  const closing = clauses.filter((c) => c.trim() !== "").join("\n\n");
  const text = renderPrompt(SELF_VERIFY, { closing });
  return text.trim() === "" ? undefined : text;
}
