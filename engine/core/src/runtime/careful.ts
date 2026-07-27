// CAREFUL MODE — the OVERDRIVE modifier that reinstates exactly one checkpoint.
//
// OVERDRIVE removes approval from every ACTION. CAREFUL adds it back at exactly
// one DECISION — which direction to take — and nowhere else. A careful turn runs:
//
//   predictor  → is this substantial enough to propose?  (one inference, fail-open)
//   scout      → read-only investigation, everything else held by the permission
//                engine, deliberation suppressed so the user sees no prose yet
//   review     → one silent look at its own draft; leaving it unchanged is fine
//   proposal   → the five-section document, the first prose the user sees
//   approval   → start / cancel / free-text revision (revisions are unlimited)
//
// What the user approves is a PROPOSAL OF DIRECTION, not a plan: what they want,
// what MAGENTRA suggests, what changes for them, what it would newly depend on,
// and what is still unclear. The decomposition happens after approval, where
// OVERDRIVE already does it. See
// ADR 0003 — the earlier design demanded a proven file manifest before approval,
// which is what made the scout phase cost ten minutes.
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

/**
 * Tool rounds a held scout may spend before the soft warn fires.
 *
 * This is NOT a cap — nothing is cut off at this number (ADR 0005). It is when
 * the engine reminds the agent of the stop test it was already given. A cap
 * would stop the scout mid-read and leave it proposing from a half-formed
 * picture, and a confident wrong understanding is the one thing CAREFUL exists
 * to prevent.
 */
export const CAREFUL_SCOUT_WARN_AFTER_ROUNDS = 4;

/** Refusal shown to the model when the hold blocks a call. It must teach, not
 *  just deny — a bare "denied" reads as a broken tool and gets retried. */
export function carefulHoldMessage(toolName: string): string {
  return `CAREFUL MODE: ${toolName} is held until the user approves your proposal. You are in the scout phase — you may only ${[...SCOUT_TOOLS].join(", ")}. Do not retry this call and do not look for a way around it. Finish investigating with the reading tools, then present your proposal; every held tool unlocks the moment the user approves.`;
}

// ── Predictor ───────────────────────────────────────────────────────────────
// Decides whether an incoming request earns the ritual. Size decides, not
// clarity: a perfectly clear ten-step refactor still gets a proposal, because
// the point is that the user sees what is about to happen, not that the agent
// was unsure. (Clarity is the clarify pre-layer's job, and it runs first.)

export const CAREFUL_PREDICTOR_SYSTEM = `You are the CAREFUL MODE predictor of an autonomous coding agent. You see ONE incoming user request (plus a snippet of the previous exchange, and an overview of the codebase) and decide one thing: does this request deserve a short proposal the user approves before any work starts?

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

Judge SIZE and REVERSIBILITY only. Do NOT judge whether the request is clear — a request can be perfectly unambiguous and still deserve a proposal, because the proposal exists so the user sees what is coming, not because you were confused. When genuinely torn, prefer true: an unwanted proposal costs one round trip, an unwanted refactor costs the user their afternoon.`;

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
 *  moment the hold lifts, so the working half of the turn is ordinary OVERDRIVE.
 *
 *  This prompt is load-bearing: the phase has no numeric cap (ADR 0005), so the
 *  stop test below is the whole bound. Weakening it brings the ten minutes back. */
export const CAREFUL_SCOUT_SECTION = `# CAREFUL MODE — scout phase (you have NOT been approved to act yet)
The user has asked to approve your proposal before you touch anything. Right now you may look, and nothing else.

- Available to you: Read, Grep, Glob, GraphQuery, BackpackSearch, Skill. Every other tool — writing, editing, running commands, spawning agents, recording tasks, network — is held by the permission engine and will refuse. That is not a malfunction and there is no way around it; it unlocks when the user approves.
- You are confirming the TARGET, not proving the PATH. What you write at the end is a proposal of DIRECTION, not a plan: no step list, no task breakdown, no promised diff. You do NOT need to know which files you will change. You will plan properly after the user approves, when every tool is back.
- THE USER HAS ALREADY ANSWERED your questions, above. Those answers are requirements, and they also tell you where to look — let them narrow what you open rather than reading as if you had never asked.
- DO NOT RE-READ. On a second or later proposal in this conversation, the map lists what you already read and what has not changed since. Trust it. Re-open a file only when you need a part you did not see, or when it is no longer visible above.
- LOCATE BEFORE YOU OPEN. GraphQuery answers "which files matter for this topic" (slice), "what breaks if these change" (blast) and "what does this rely on" (deps) from the import graph, without reading anything. Grep finds a name across the whole repository in one call. Use Read when you need to know what code MEANS — and read the part you need with offset/limit instead of opening whole files.
- STOP TEST. After each round, ask yourself: can I answer all five of these without guessing?
    1. What does the user want?
    2. What do I suggest?
    3. What changes for them?
    4. Does this need anything the app does not already have?
    5. What am I unsure about?
  The moment the answer is yes, stop reading. You are not trying to reach certainty — you are trying to reach an honest proposal the user can correct in one sentence. Anything still unknown after that is question 5, never a reason to read more.
- Say nothing to the user yet. Your prose during this phase is not shown to them — you are thinking, not reporting. When you have what the stop test asks for, state the direction you have chosen and why, and you will be prompted for the next step.`;

/**
 * The starting position handed to the scout before its first round: the design
 * atlas or import-graph skeleton, plus a slice of the files this request
 * actually touches. Deterministic — it comes from the graph, not from a model —
 * which is what lets the proposal state where the work lands without the agent
 * having to open every file to earn the right to name it.
 */
export function carefulScoutMapText(map: string): string {
  return `<system-reminder>Starting position for this scout phase. It was derived from this workspace's import graph and design map — no model wrote it, so treat it as a statement of what the repository actually contains and start FROM it rather than rediscovering it.

${map}

Use it to decide what is worth opening. It is also the source for the "where it lands" half of your proposal, so you do not need to open a file merely to be allowed to name it.</system-reminder>`;
}

/** The soft warn — a reminder of the stop test, never an interruption (ADR 0005). */
export const CAREFUL_SCOUT_WARN_TEXT =
  "<system-reminder>You have now spent several rounds reading. Apply the stop test: can you answer all five questions without guessing? If yes, stop reading and state your direction — the proposal comes next. If something is still unknown, that is the last question (\"unclear things\"), not a reason to keep going. Finish the round you are in; nothing is being cut off.</system-reminder>";

/**
 * The Review Pass: one silent look at the draft before the user sees it. It may
 * leave the draft untouched — that is a correct outcome and needs no defence,
 * which is why this text does not ask for one. It also grants no permission to
 * read, because that is what turned the old two-round critique into a second
 * scout phase.
 */
export const CAREFUL_REVIEW_TEXT =
  "<system-reminder>Internal review — NOT a user message, and nothing you write here is shown to the user. Read your own draft once, and once only.\n\n- Does it answer the user's actual question, or a nearby one you found more interesting?\n- Did you add scope they did not ask for?\n- Is anything in it a guess about this repository rather than something you saw or the map told you?\n\nIf one of those is true, improve the draft. If none is, leave it exactly as it is and say so in one line — an unchanged draft is a correct outcome. Do not read anything new: if you do not know, that is the last section, not a reason to go back to the repository.</system-reminder>";

/**
 * The question round: what only the user can decide, asked BEFORE the scout
 * reads anything.
 *
 * It moved twice. First it sat AFTER approval, which was backwards — a question
 * whose answer changes what gets built cannot be asked once the user has
 * approved what gets built. Then it sat after the scout, which was still wrong
 * for a subtler reason: the answers do not only shape the proposal, they shape
 * WHERE THE AGENT LOOKS. Asked after the reading, they arrive too late to save
 * any of it.
 *
 * Running before the scout also removes the pressure that made it ask too
 * little. A round placed after the reading is naturally told "you have just read
 * the repository, do not ask what you can see" — which suppresses the questions
 * that were never about the repository at all.
 */
export const CAREFUL_QUESTIONS_SYSTEM = `You are the question layer of CAREFUL MODE in an autonomous coding agent. A substantial piece of work is about to begin. You see the user's request, a snippet of the previous exchange, and a map of the codebase derived from its import graph.

Ask the user everything that only THEY can decide — BEFORE the agent reads anything or proposes anything. Their answers do two jobs: they decide what gets built, and they tell the agent WHERE TO LOOK. A question asked later is worth far less.

Reply with STRICT JSON only — no markdown fences, no prose:
  {"questions": []}
or
  {"questions": [{"question": "...?", "header": "max 12 chars", "options": [{"label": "...", "description": "..."}, ...], "multiSelect": false}]}

WHAT TO ASK ABOUT. Go through these and ask about every one the request genuinely leaves open:
  1. DIRECTION — "improve the UI" does not say improve it HOW. Which way do they want to go?
  2. SCOPE — the whole application or one screen? All of it now, or a first slice?
  3. PRIORITY — when two good goals pull apart (speed vs clarity, smallest diff vs proper fix), which one wins?
  4. CONSTRAINTS — what must NOT change: behaviour, appearance, public interfaces, dependencies, files they are working in.
  5. DONE — what would make them call this finished, when that is not obvious from the request.
  6. AUDIENCE or STYLE — whenever the work produces something a person will read or look at.

WHEN THE VOCABULARY CHECK FIRES. You may be told that the request's words barely appear in this codebase. That is a measurement, not an opinion, and it means nothing has yet pinned down what the request refers to. In that case asking is necessary: pick the questions whose answers would most narrow the search, and lean toward the upper end of the range below.

HOW MANY. Ask every question whose answer would change what gets built or where the agent looks. For a request that reached this layer that is usually 2 to 4, and never more than 5. UNDER-ASKING IS THE EXPENSIVE MISTAKE HERE: this request is large enough that the agent is about to spend real effort on it, and one wrong assumption wastes all of it. Do not pad with questions that change nothing — but do not talk yourself out of a real one either.

WHAT NOT TO ASK.
  - Anything the codebase answers. The map shows what exists and the agent will read the code itself. Never ask the user to describe their own repository.
  - Implementation detail that is yours to choose: which file, which function, which pattern.
  - Anything the user already said in the request or the previous exchange.
  - Confirmation ("shall I proceed?", "is this OK?"). The user approves the proposal at a later step; that is not this.

HOW TO ASK. Write every question and every option in THE USER'S OWN LANGUAGE — if they write Turkish, ask in Turkish. Keep them short and plain: one idea per sentence, common words. 2-4 mutually distinct options each, with a one-line description; put your recommended option first with " (Recommended)" appended to its label. multiSelect true only when the choices genuinely combine.

If the request truly leaves nothing open — it names exactly what to do and there is one sensible way to do it — answer {"questions": []}.`;

export const CAREFUL_PROPOSAL_TEXT = `<system-reminder>Now write the proposal. THIS text IS shown to the user — it is the first thing they will see from you this turn, and the only thing they have to decide on.

Use exactly these five headings, in this order, as markdown H1s:

# What's the objective?
# What solution am I suggesting as MAGENTRA?
# What are you going to see as consequences after this change at this repository?
# Could these changes introduce any new dependencies other than the ones the app's current version uses?
# Are there any unclear things that have to be clarified by the user?

They are written above in English. Write them in THE LANGUAGE THE USER IS WRITING IN, translated naturally — a Turkish user must read Turkish headings. Keep all five, keep this order, keep each one a question, and keep its meaning exact. Never add, merge, drop or reorder one.

WRITE IN PLAIN SPEECH. Short sentences, one idea each, common words, active voice. No nested clauses, no long asides. Plain is a STYLE, never a language: write it in whatever language the user is writing to you in — plain Turkish for a Turkish user, plain English for an English one.

Rules for each section:

1. OBJECTIVE — what the user actually wants, in your own words, in a sentence or two. If your reading of it differs at all from a literal reading of their message, say so here.

2. SOLUTION — the direction you propose, and the one line of reasoning behind it. This is a DIRECTION, not a plan: no numbered steps, no task breakdown, no ordering. The user is approving where you are headed, and you will plan the route after they say yes.

3. CONSEQUENCES — the section that carries the weight. Two labelled halves, always in this order:

   **What changes for you**
   Plain language, no file paths. What the product will do that it does not do now, what the user will be able to do that they could not, what will feel different, what will slow down, what will break. This is a restatement of your direction in the user's terms — someone who skipped section 2 must still learn here what you are about to do and what they will be left with. If the change is purely internal and they will notice nothing, say exactly that in one bullet rather than inventing an effect.

   **Where it lands**
   Which part of the repository this falls in: the area, and the few files that matter most. The map you were given at the start of this phase is the source — it came from the import graph, so it states what this repository contains. Do NOT promise a complete file list and do NOT predict the diff. Naming the neighbourhood is the job; a list you cannot stand behind is worse than no list.

4. DEPENDENCIES — could this make the app need anything it does not already ship with? Three kinds count, not just the first:
   - a new PACKAGE (npm or otherwise);
   - a new SYSTEM requirement — a binary on the machine, a service, a call to the network at runtime;
   - a new PLATFORM capability the app would now rely on (a browser/runtime feature newer than what it already needs).
   For each one: name it, say in one line why the work needs it, and name its licence. If writing the code instead would avoid it, say so and say what that costs. MAGENTRA is deliberately close to dependency-free and ships everything it uses locally, so that it works offline — "None — this uses what is already here." is both the expected answer and the best one. Never list something that is already in package.json; the question is about what would be ADDED.

5. UNCLEAR — what is still open AFTER the round of questions you just had. You have already asked the user everything that was theirs to decide, and their answers are above and binding; this section is the remainder. List the assumptions you are proceeding on that they did not settle, and anything you could not check, each with the assumption you chose. ASK NOTHING HERE — the time for questions has passed, and the user is about to decide on the whole proposal. If nothing genuinely remains, say "Nothing — the request is unambiguous." and do not manufacture doubt.

Itemize. Keep every bullet to something a person can read at a glance. Write the proposal now and nothing else — no preamble, no sign-off, no offer to proceed. The approval prompt is added for you.</system-reminder>`;

// ── Path check ──────────────────────────────────────────────────────────────
// Every path the proposal names is a claim about the user's repository, and the
// one kind of claim that can be silently false. The location half of section 3
// comes from the graph and so cannot be invented — but the prose around it can
// still name a file from memory, and that is what this catches.

const CODE_SPAN_RE = /`([^`\n]+)`/g;
/** A single path-ish token: word characters and separators, nothing else. The
 *  optional trailing separator admits a directory — the location half of a
 *  proposal names areas, and an area is as checkable as a file. */
const PATH_SHAPE_RE = /^[A-Za-z0-9_.@~-]+(?:[\\/][A-Za-z0-9_.@~-]+)*[\\/]?$/;
/** A file extension proper — starts with a letter, so "0.9.0" is not a file. */
const FILE_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * The path-like tokens a proposal claims, taken from its backticked spans only
 * (the format the proposal instructions ask for). Pure, so it can be checked
 * without a workspace.
 *
 * Deliberately conservative in what it treats as a path: prose, commands, flags
 * and version numbers must not be reported as missing files, because a false
 * alarm sends the model editing something that was already correct.
 */
export function extractCandidatePaths(text: string): string[] {
  const out = new Set<string>();
  CODE_SPAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_SPAN_RE.exec(text)) !== null) {
    const raw = match[1]!
      .trim()
      .replace(/:\d+(?::\d+)?$/, "") // a file:line reference is still a file
      .replace(/[),.;:]+$/, "");
    if (raw.length === 0 || raw.length > 200) continue;
    if (/\s/.test(raw)) continue; // a command or a sentence, not a path
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) continue; // a URL
    if (!PATH_SHAPE_RE.test(raw)) continue;
    // A bare backticked word is a symbol or a flag. Only a separator or a real
    // file extension makes it a claim about a file.
    if (!raw.includes("/") && !raw.includes("\\") && !FILE_EXT_RE.test(raw)) continue;
    out.add(raw.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return [...out];
}

/** Sent back when the proposal names paths this workspace does not have. */
export function carefulUnknownPathsText(paths: string[]): string {
  return `<system-reminder>Path check — these do not exist in this workspace:

${paths.map((p) => `- ${p}`).join("\n")}

Every path you name is a claim about the user's repository, and they will read it as one. For each: correct it to the real path, say plainly that it is a file you would CREATE, or drop the mention. Then output the whole proposal again in the same five-section format, changing nothing else.</system-reminder>`;
}

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
          ? "Approve this proposal and start work? To change it, type what you want different."
          : `Approve this revised proposal (revision ${revisionsSoFar}) and start work? To change it again, type what you want different.`,
      header: "APPROVE",
      multiSelect: false,
      options: [
        {
          label: CAREFUL_APPROVE_LABEL,
          description:
            "The hold lifts and the agent works in the direction it just described, with full OVERDRIVE autonomy. Anything it listed as unclear is put to you first.",
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
  return `<system-reminder>The user did NOT approve that proposal. They read it and replied:\n\n${feedback}\n\nThis is direct steering and it outranks your own judgement about the direction — take it as a requirement, not a suggestion. You are still in the scout phase and still held to the reading tools. A fresh map for their new direction follows this message. Read whatever you now need to read, revise the direction accordingly, and write a fresh proposal in the same five-section format. Do not defend the previous one; do not re-present it unchanged unless the user's message actually asks you to.</system-reminder>`;
}

/**
 * Handed to the model the moment the hold lifts. The approved proposal is
 * repeated here in full ON PURPOSE: it is the brief for the work, not a
 * reference back to something buried in the transcript under the scout's tool
 * results. This is what makes the checkpoint worth its cost — the working phase
 * starts from an understanding the user has already corrected, which is better
 * input than the raw request was.
 */
export function carefulApprovedText(proposal: string): string {
  return `<system-reminder>The user APPROVED your proposal. The hold is lifted — every tool is available to you again and you are back in ordinary OVERDRIVE: nothing asks from here on.

This is what they approved. It is your brief for the work:

${proposal.trim()}

Everything that was the user's to decide was already put to them before this proposal was written, and their answers are in this conversation above. Do NOT open another round of questions now — they have answered, read, and approved. Start.

Plan the work and build it. The proposal is a direction; the plan is yours to make now, so decompose it with TaskCreate as you normally would. If the work turns out to need something materially different from what the user approved — a consequence you did not predict, a scope you did not describe — say so plainly rather than quietly widening it.</system-reminder>`;
}

export const CAREFUL_CANCELLED_TEXT =
  "<system-reminder>The user declined the proposal and the turn is over. Nothing was changed.</system-reminder>";
