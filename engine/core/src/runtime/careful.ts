// CAREFUL MODE — the OVERDRIVE modifier that reinstates exactly one checkpoint.
//
// OVERDRIVE removes approval from every ACTION. CAREFUL adds it back at exactly
// one DECISION — which approach to take — and nowhere else. A careful turn runs:
//
//   predictor  → is this substantial enough to brief?   (one inference, fail-open)
//   scout      → read-only investigation, everything else held by the permission
//                engine, deliberation suppressed so the user sees no prose yet
//   critique   → "is there a better way?", 2 rounds on the first briefing and one
//                fewer after each revision — user steering outranks self-doubt
//   briefing   → the four-section proposal, the first prose the user sees
//   approval   → start / cancel / free-text revision (revisions are unlimited)
//
// Everything here is data and prose; the orchestration lives in Session.runTurn
// and the enforcement in PermissionEngine. This file deliberately imports
// nothing from either, so it can be unit-checked in isolation.

import type { Question } from "@magentra/protocol";

/**
 * The only tools a Scout Phase may call. Everything absent from this set is
 * refused by the permission hold with a teaching message.
 *
 * Reading tools only, and deliberately not the delegating ones: Agent and
 * CrewRun are `permissionClass: "read"` yet spawn children that write, and
 * Task* would populate the task list with work the user has not yet approved.
 * Children inherit the parent's PermissionEngine, so a spawned session would in
 * fact be held too — they are excluded because a scout is a reading session,
 * not because the hold would leak.
 */
export const SCOUT_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "GraphQuery",
  "BackpackSearch",
  "Skill",
]);

/** Self-critique rounds granted to the FIRST briefing of a turn. Each revision
 *  the user types spends one, floor zero: once they have steered, the agent
 *  arguing with itself is wasted work. */
export const CAREFUL_CRITIQUE_ROUNDS = 2;

/** Refusal shown to the model when the hold blocks a call. It must teach, not
 *  just deny — a bare "denied" reads as a broken tool and gets retried. */
export function carefulHoldMessage(toolName: string): string {
  return `CAREFUL MODE: ${toolName} is held until the user approves your plan. You are in the scout phase — you may only ${[...SCOUT_TOOLS].join(", ")}. Do not retry this call and do not look for a way around it. Finish investigating with the reading tools, then present your briefing; every held tool unlocks the moment the user approves.`;
}

// ── Predictor ───────────────────────────────────────────────────────────────
// Decides whether an incoming request earns the ritual. Size decides, not
// clarity: a perfectly clear ten-step refactor still briefs, because the point
// is that the user sees what is about to happen, not that the agent was unsure.

export const CAREFUL_PREDICTOR_SYSTEM = `You are the CAREFUL MODE predictor of an autonomous coding agent. You see ONE incoming user request (plus a snippet of the previous exchange, and an overview of the codebase) and decide one thing: does this request deserve a plan the user approves before any work starts?

Answer with JSON and nothing else.
  {"careful": false}
  {"careful": true}

Set careful=true when EITHER holds:
  A. The request needs SEVERAL tool-driven steps to satisfy — building a feature, a refactor across files, a migration, an investigation that ends in changes, anything with more than one distinct move.
  B. The request needs even ONE step that cannot be undone — deleting files or folders, rewriting git history, force-pushing, dropping or migrating data, or writing anywhere outside this workspace.

Set careful=false for everything else:
  - questions, explanations, and anything answered by reading and replying;
  - conversational messages;
  - a single small reversible edit (fix this typo, rename this variable, bump this version);
  - follow-ups that just continue work already approved in this conversation.

Judge SIZE and REVERSIBILITY only. Do NOT judge whether the request is clear — a request can be perfectly unambiguous and still deserve a briefing, because the briefing exists so the user sees what is coming, not because you were confused. When genuinely torn, prefer true: an unwanted briefing costs one round trip, an unwanted refactor costs the user their afternoon.`;

/**
 * Parses the predictor's verdict. Anything malformed reads as false — the
 * feature fails open, exactly like the clarify pre-layer, so a broken verdict
 * costs the user a checkpoint but never costs them the turn.
 */
export function parseCarefulVerdict(raw: string): boolean {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  return (parsed as Record<string, unknown>).careful === true;
}

// ── Scout phase ─────────────────────────────────────────────────────────────

/** The system-prompt section that rides for the whole held phase. Removed the
 *  moment the hold lifts, so the working half of the turn is ordinary OVERDRIVE. */
export const CAREFUL_SCOUT_SECTION = `# CAREFUL MODE — scout phase (you have NOT been approved to act yet)
The user has asked to approve your plan before you touch anything. Right now you may look, and nothing else.

- Available to you: Read, Grep, Glob, GraphQuery, BackpackSearch, Skill. Every other tool — writing, editing, running commands, spawning agents, recording tasks, network — is held by the permission engine and will refuse. That is not a malfunction and there is no way around it; it unlocks when the user approves.
- Investigate properly. You are about to promise the user which files this change touches, and you cannot know that from guessing. Open the files you intend to name. Follow the imports. Find the callers. A briefing that names a file you never opened is the one failure this phase exists to prevent.
- Think in whole-system terms: what depends on the thing you are about to change, what breaks if you are wrong, and what the smallest change is that genuinely serves the request.
- Say nothing to the user yet. Your prose during this phase is not shown to them — you are thinking, not reporting. When you have investigated enough, state the approach you have chosen and why, and you will be prompted for the next step.`;

export const CAREFUL_CRITIQUE_TEXT =
  "<system-reminder>Internal challenge — NOT a user message, and nothing you write here is shown to the user. Attack the approach you just chose.\n\n- Is there a genuinely better option you dismissed too fast, or never considered? Name it.\n- Why this approach and not that one? If you cannot give a concrete reason, you do not yet have a reason.\n- What does this approach cost that the alternative does not — in blast radius, in things that could break, in work the user did not ask for?\n\nIf the challenge changes your mind, say so and state the new approach. If it does not, say so and state plainly why the original still wins. You may read more first if that is what settles it. Do not write the briefing yet.</system-reminder>";

export const CAREFUL_BRIEFING_TEXT = `<system-reminder>Now write the briefing. THIS text IS shown to the user — it is the first thing they will see from you this turn, and the only thing they have to decide on.

Use exactly these four headings, in this order, as markdown H1s and with this exact wording:

# What's the objective?
# What solution am I suggesting as MAGENTRA?
# What are you going to see as consequences after this change at this repository?
# Are there any unclear things that have to be clarified by you?

Rules for each section:

1. OBJECTIVE — what the user actually wants, in your own words, in a sentence or two. If your reading of it differs at all from a literal reading of their message, say so here.

2. SOLUTION — the approach you chose. Short. The reasoning that got you here belongs in one line, not a page.

3. CONSEQUENCES — the section that carries the weight. Two labelled halves, always in this order:

   **What changes for you**
   Plain language, no file paths. What the product will do that it does not do now, what the user will be able to do that they could not, what will feel different, what will slow down, what will break. This is a restatement of your solution in the user's terms — someone who skipped section 2 must still learn here what you are about to do and what they will be left with. If the change is purely internal and they will notice nothing, say exactly that in one bullet rather than inventing an effect.

   **What will be touched**
   The concrete prediction: every file you will change, every file you will create, every script you will add. Named paths in backticks, one per bullet, each with a few words on what happens to it. Mark new files NEW. Only name files you actually opened during the scout — if you are guessing, go back and look first.

4. UNCLEAR — the questions whose answers would change what you build. ASK NOTHING HERE — just list them, and note what you would assume if the user says nothing. You will get to put them to the user properly if they approve. If there are genuinely none, say "Nothing — the request is unambiguous." and do not manufacture doubt.

Itemize. Keep every bullet to something a person can read at a glance. Write the briefing now and nothing else — no preamble, no sign-off, no offer to proceed. The approval prompt is added for you.</system-reminder>`;

// ── Approval gate ───────────────────────────────────────────────────────────
// The card reuses the existing question_request path, so there is no new wire
// string and no new renderer case. The renderer's free-text "Other…" box sends
// whatever the user typed as the answer value, which is how a revision arrives:
// anything that is not one of the two known labels IS the revision.

export const CAREFUL_APPROVE_LABEL = "Start work";
export const CAREFUL_CANCEL_LABEL = "Cancel — change nothing";

export function carefulApprovalQuestion(revisionsSoFar: number): Question[] {
  return [
    {
      question:
        revisionsSoFar === 0
          ? "Approve this plan and start work? To change it, type what you want different."
          : `Approve this revised plan (revision ${revisionsSoFar}) and start work? To change it again, type what you want different.`,
      header: "APPROVE",
      multiSelect: false,
      options: [
        {
          label: CAREFUL_APPROVE_LABEL,
          description:
            "The hold lifts and the agent does exactly what it just described, with full OVERDRIVE autonomy. Anything it listed as unclear is put to you first.",
        },
        {
          label: CAREFUL_CANCEL_LABEL,
          description:
            "The turn ends here. Nothing in the repository has been touched — the scout only read.",
        },
      ],
    },
  ];
}

/** Classifies an approval answer. Anything that is neither known label is the
 *  user's typed revision, which is the whole point of leaving the box open. */
export function classifyCarefulAnswer(
  answer: string | undefined,
): { kind: "approve" } | { kind: "cancel" } | { kind: "revise"; text: string } {
  const text = (answer ?? "").trim();
  if (text === "" || text === CAREFUL_CANCEL_LABEL) return { kind: "cancel" };
  if (text === CAREFUL_APPROVE_LABEL) return { kind: "approve" };
  return { kind: "revise", text };
}

export function carefulRevisionText(feedback: string): string {
  return `<system-reminder>The user did NOT approve that plan. They read your briefing and replied:\n\n${feedback}\n\nThis is direct steering and it outranks your own judgement about the approach — take it as a requirement, not a suggestion. You are still in the scout phase and still held to the reading tools. Read whatever you now need to read, revise the approach accordingly, and write a fresh briefing in the same four-section format. Do not defend the previous plan; do not re-present it unchanged unless the user's message actually asks you to.</system-reminder>`;
}

export const CAREFUL_APPROVED_TEXT = `<system-reminder>The user APPROVED your plan. The hold is lifted — every tool is available to you again and you are back in ordinary OVERDRIVE: nothing asks from here on.

Before you touch anything: if your briefing listed unclear items, put them to the user NOW with a single AskUserQuestion call, offering concrete options and your recommendation for each. That was the promise the briefing made. If it listed nothing unclear, skip this and start.

Then build exactly what you described. If the work turns out to need something materially different from what the user approved — a file you did not list, a consequence you did not predict — say so plainly in your wrap-up rather than quietly widening the scope.</system-reminder>`;

export const CAREFUL_CANCELLED_TEXT =
  "<system-reminder>The user declined the plan and the turn is over. Nothing was changed.</system-reminder>";
