# CAREFUL MODE

> **Status: redesigned and working.** The mechanism is built, enforced and
> tested. The slowness that made the first version unusable was a design fault,
> not a tuning problem — see [What changed](#what-changed-and-why).
> Last worked on 2026-07-27.

A modifier of OVERDRIVE, not a third stance. OVERDRIVE removes approval from
every *action*; CAREFUL adds it back at exactly one *decision* — which direction
to take — and nowhere else. Domain vocabulary is in [`CONTEXT.md`](../CONTEXT.md);
the decisions worth knowing are ADRs [0001](adr/0001-careful-mode-is-enforced-by-the-permission-engine.md),
[0002](adr/0002-careful-rides-the-overdrive-frame.md),
[0003](adr/0003-the-briefing-proposes-a-direction-not-a-plan.md),
[0004](adr/0004-the-import-graph-has-two-tiers.md),
[0005](adr/0005-the-scout-phase-has-no-hard-cap.md),
[0006](adr/0006-code-retrieval-is-deterministic.md) and
[0008](adr/0008-a-silent-pre-layer-is-worse-than-a-slow-one.md).

## What the user approves

A **Proposal** — of direction, not of implementation. Five questions:

```
# What's the objective?
# What solution am I suggesting as MAGENTRA?
# What are you going to see as consequences after this change at this repository?
# Could these changes introduce any new dependencies other than the ones the app's current version uses?
# Are there any unclear things that have to be clarified by the user?
```

It is **not a plan**. There is no step list, no task breakdown and no promised
diff. The user approves that the agent read the request correctly and is pointed
the right way; the decomposition happens afterwards, in OVERDRIVE, which already
does it. The old design demanded a proven file manifest before approval, and
producing one cost around ten minutes — see [ADR 0003](adr/0003-the-briefing-proposes-a-direction-not-a-plan.md).

The approved proposal is then **injected as the brief for the work**. That is
what makes the checkpoint worth its cost: the working phase starts from an
understanding the user has already corrected, which is better input than the raw
request was. CAREFUL is a context-building step; the gate is a side effect.

## The shape of a careful turn

```
user message
   ↓
careful predictor         one main-model inference, fail-open
   ↓ several steps, or one irreversible step?
   │
   ├─ no  → clarify pre-layer, then an ordinary OVERDRIVE turn
   │
   └─ yes → scout map built       deterministic retrieval: BM25 over the code
            ↓                     fused with personalized PageRank, rendered as
            ↓                     ranked paths, declaration skeletons and the
            ↓                     top-scoring source itself — plus what this
            ↓                     session already read and is still unchanged
            OPEN QUESTIONS        up to 5, grounded in that map — asked BEFORE
            ↓                     anything is read, because the answers decide
            ↓                     where to read  ▶ carefully: working out what to ask you
            ↓                     a truncated reply is salvaged, never silently dropped
            HOLD RAISED (PermissionEngine)          ▶ carefully: scouting
            ↓
            scout: Read / Grep / Glob / GraphQuery / BackpackSearch / Skill
                   everything else refused; all prose suppressed
                   soft warn after 4 rounds — a reminder, never a cut
            ↓
            grounding floor       opened NONE of the ranked source files? one
            ↓                     reminder naming them, then never again
            PROPOSAL written      five H1 sections, written straight from the
            ↓                     scout's own system prompt — still not shown
            path check            every path it names must exist (≤2 corrections)
            ↓
            proposal revealed to the user
            ↓
            approval gate         question_request
              ├─ "Start work"           → hold lifts → proposal injected as the
              │                           brief → work starts immediately
              ├─ "Cancel"               → hold lifts → turn ends, nothing changed
              └─ free text (a Revision) → hold STAYS → FRESH map seeded from what
                                          they said → new proposal
```

Revisions are unlimited. An unanswered or interrupted gate reads as **cancel**,
never as approval.

The proposal is written while still muted and only revealed once its paths check
out. Streaming it live would mean showing a proposal that names a file which does
not exist, then contradicting it — which is exactly the failure the check exists
to prevent.

**Two main-model rounds, not four.** The scout carries the proposal format in its
own system prompt, so the first response it sends with no tool call in it *is*
the proposal. The phase used to spend two further rounds after the reading was
already finished — one where the scout announced it was ready, and one "review
your own draft" that reviewed a draft which did not exist yet, since the proposal
had not been written. The three review questions now run inside the same
inference that writes it, against the real text. A scout that stops without
proposing is asked once, explicitly; that fallback is the only path that still
costs a round trip.

## Where the code is

| Concern | Location |
| --- | --- |
| Allowlist, prompts, path extraction, verdict + answer parsing, truncated-JSON salvage, proposal detection | `engine/core/src/runtime/careful.ts` |
| The hold itself | `engine/core/src/runtime/permissions.ts` — `setCarefulHold`, checked after deny rules and ahead of everything else |
| Predictor, scout map, grounding floor, path check, phase orchestration | `engine/core/src/runtime/session.ts` — `predictCareful`, `buildCarefulScoutMap`, `carefulGroundingGap`, `unknownProposalPaths`, `askCarefulApproval`, and the careful rung inside `runTurn` |
| Request → ranked code (BM25 + PageRank + RRF, the three-grade ladder) | `engine/core/src/knowledge/retrieval.ts` — a general capability, CAREFUL is its first caller |
| Request → graph seeds | `engine/core/src/knowledge/seeds.ts` — shared with the GraphQuery tool |
| Multi-language import graph | `engine/core/src/knowledge/graph.ts`, `symbols.ts` |
| `careful` field on the two frames | `engine/protocol/src/types.ts` |
| Frame handling, `/careful on\|off`, resume | `engine/core/src/runtime/engine.ts` |
| The composer pill | `app/renderer/{index.html, styles.css}`, `modules/{dom,state,overdrive,tabs}.js` |

Four things about the design that are easy to undo by accident:

- **The hold is enforcement, not instruction.** CAREFUL only exists inside
  OVERDRIVE, where nothing asks — so a prompt-level "do not edit yet" would be a
  request the model is free to ignore while rewriting the repository. ADR 0001.
- **There is no `set_careful` frame.** `careful` rides `set_overdrive` and
  `overdrive_changed`, and **absent means unchanged, never off**. ADR 0002.
- **The proposal must not become a plan again.** The word "plan" is kept out of
  every prompt the model reads on purpose: an approval card that says "approve
  this plan" reliably produces a plan, and a plan needs a file manifest, and a
  file manifest needs the ten minutes back. ADR 0003.
- **`carefulScoutSection` is load-bearing.** The phase has no numeric cap, so
  its stop test is the entire bound. ADR 0005.
- **The question layer's parse must stay tolerant.** Its reply is long, and the
  way it fails is truncation, not corruption. Strict JSON parsing reads a
  correct-but-cut-off answer as "ask the user nothing" — silently, with no card
  and no banner. `salvageQuestionObjects` keeps whatever completed. ADR 0008.
- **The language is decided from the user's own words, quoted into the prompt.**
  "Write in the user's language" alone loses to the language the model has just
  spent a whole phase reading. ADR 0008.

## What is verified

```bash
npm run build                                                  # tsc -b, engine only
node .claude/skills/bigboycoding/careful-turn-check.mjs         # 41 whole-turn invariants
node .claude/skills/bigboycoding/careful-turn-check.mjs ~/repo  # …or against a real repository
node .claude/skills/bigboycoding/careful-hold-check.mjs         # 60 hold + path-claim invariants
node .claude/skills/bigboycoding/graph-languages-check.mjs      # 20 language invariants on a fixture repo
node .claude/skills/bigboycoding/retrieval-check.mjs             # 25 retrieval invariants
node .claude/skills/bigboycoding/permission-check.mjs           # 27 permission invariants
node app/tests/run-ui-tests.js                                  # 28 scenarios
```

`engine/*` has no unit suite and `tsc` cannot see any of this, so the check
scripts assert against `engine/core/dist/` directly:

- **the turn check** — a whole careful turn, driven over the protocol frames a
  frontend uses, against a scripted provider that never touches the network. It
  asserts the choreography, which is where the bugs were: that the question card
  comes before any reading, that a *truncated* question reply still asks
  something, that the phase costs two main-loop rounds and not four, that a
  scout which opened no ranked source file is caught, that a scout which never
  proposes ends the turn instead of gating the user on a blank card, and that a
  `Write` during the phase is refused and the file really is not created. It
  takes an optional repository path, so it can be run against the codebase where
  a report came from.
- **the hold check** — that the hold refuses `Write`/`Edit`/`Bash`, admits the
  six scout tools, and outranks allow rules, `allow_always` grants, session
  allows and OVERDRIVE itself; that a proposal's path claims are extracted
  without swallowing commands, flags, versions or URLs (a false alarm sends the
  model correcting prose that was already right); that a truncated question
  reply salvages; that a proposal is recognized in any language; and that the
  user's own words are quoted into every prompt that has to choose one.
- **the language check** — that a Go import reaches its package's files, a Rust
  `mod` its sibling, a Java import its class, a PSR-4 `use` its file through the
  namespace root, and that a Tier 2 language still produces a *node*.

Pre-existing failures, unrelated and present before this work: `test:version`
(shells out to `mkdir -p`, absent on Windows) and `app/tests/changes.test.js`
(CRLF/LF assertion).

## What changed, and why

The first version was correct and unusable. Ten minutes in the reading phase.
The cause was not tuning — it was that the Proposal was specified as a plan, and
`CONTEXT.md` recorded the file manifest as a *deliberate forcing function* to
make the scout read more. It worked exactly as designed.

| Area | Before | Now |
| --- | --- | --- |
| What is approved | A plan, with a proven file manifest | A proposal of direction |
| Location in section 3 | Every file, only ones the agent opened | The area, derived from the import graph |
| Scout's starting point | Nothing — it discovered the repo itself | Atlas/graph skeleton + a slice seeded from the request |
| Scout's bound | None at all | A stop test in the prompt + one soft warn |
| Self-critique | 2 rounds, each inviting more reading | 3 questions inside the same inference that writes the proposal |
| Rounds after the reading is done | 3 (announce, review, write) | 1 (write), and the review is part of it |
| A question round cut off at the token limit | read as "ask nothing", silently | the complete questions are salvaged and asked |
| While a pre-layer thinks | a blank screen | `▶ carefully: working out what to ask you` |
| Proposing without opening any ranked source file | nothing noticed | one reminder naming the files, then never again |
| Which language the proposal is in | inferred — and it drifted to the code's | decided from the user's own words, quoted into the prompt |
| Hallucinated paths | Nothing checked them | Engine checks each, sends bad ones back |
| After approval | "Build what you described", then ask the unclears | The proposal injected as the working brief; work starts |
| When questions are asked | After approval | Before the scout reads anything |
| How many questions | at most 3, biased toward none | up to 5, biased toward asking |
| Proposal headings | always English | the user's own language |
| Second proposal in a session | scouts from zero again | skips files already read and unchanged |
| What the scout starts with | a list of file paths | ranked paths, declaration skeletons with line numbers, and the top-scoring code quoted |
| Phase feedback | Four plain notes | `▶ ` phase banners (the Workflow convention) |
| Graph languages | TS, JS, Python | 8 with edges, everything else as nodes |
| Slice seeds | File paths only | Paths **and** declared symbol names |
| Ranked files in a flat repository | capped at 4, the rest unreachable | the whole ranking, up to the path budget |

Two supporting changes fell out of it. `resolveSeeds` moved into
`knowledge/seeds.ts` so the GraphQuery tool and the scout map cannot disagree
about which files a request concerns. And question cards now route their answer
back to the engine that asked (`app/renderer/modules/landing.js`) — previously
the answer went to whichever pane had focus, so with two workspaces open an
approval could start work in the wrong one.

## Deliberately left

- **Plain Speech applies to the Proposal only.** The rule — short sentences, one idea each,
  active voice, in whatever language the user writes in — lives in
  `carefulProposalSpec`. Applying it product-wide means moving it to
  `SECTION_COMMUNICATION` in `prompts.ts`, which changes MAGENTRA's whole voice
  and is a wider decision than this feature.
- **The language rule is anchored, not detected.** The user's request is quoted
  into the prompt and the model picks the language from that quote. Detecting it
  in the engine would be a language-ID table for a decision the model already
  makes correctly once it is told which text to look at.
- **The scout's reading stays in context after approval.** The proposal is the
  distillate of it, so the raw file reads could be compacted away once the hold
  lifts — the working phase would then start with the request plus the approved
  proposal and nothing else. `maybeCompact` already handles the tool_use/
  tool_result pairing that makes this safe. Worth doing; not needed for the
  feature to work.
- **The scout cannot run `git`.** `Bash` is `execute`, so no `git log`/`git
  diff`/`npm ls` while held. Deliberate: widening it is one entry in
  `SCOUT_TOOLS`, but a scout confirming a target needs less, not more.
- **A careful turn interrupts the user exactly twice** — the question round, then
  the approval gate. The clarify pre-layer is skipped on a careful turn (the
  question round replaces it and is strictly richer), and the Unclears are stated
  in the proposal rather than asked after approval.
- **Multi-tab is partly verified.** The answer-routing bug is fixed and covered
  by the existing concurrent-tabs UI scenario. Still untested with two *live*
  engines: whether a background pane's proposal behaves, and whether
  `applySafetySettings(true)` on a new engine link stomps a per-tab `/careful`.
