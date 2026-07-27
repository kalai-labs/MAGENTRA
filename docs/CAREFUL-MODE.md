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
[0004](adr/0004-the-import-graph-has-two-tiers.md) and
[0005](adr/0005-the-scout-phase-has-no-hard-cap.md).

## What the user approves

A **Proposal** — of direction, not of implementation. Four questions:

```
# What's the objective?
# What solution am I suggesting as MAGENTRA?
# What are you going to see as consequences after this change at this repository?
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
clarify pre-layer         unchanged, still runs first
   ↓
careful predictor         one main-model inference, fail-open
   ↓ several steps, or one irreversible step?
   │
   ├─ no  → ordinary OVERDRIVE turn
   │
   └─ yes → HOLD RAISED (PermissionEngine)          ▶ careful: scouting
            ↓
            scout map injected    atlas or graph skeleton, plus a slice of the
                                  repo seeded from the request itself
            ↓
            scout: Read / Grep / Glob / GraphQuery / BackpackSearch / Skill
                   everything else refused; all prose suppressed
                   soft warn after 4 rounds — a reminder, never a cut
            ↓
            review pass ×1        "read your own draft once"   ▶ careful: reviewing
            ↓
            open questions        anything only the USER can decide is asked
                                  HERE — before a direction exists to bias it
            ↓
            PROPOSAL written      four H1 sections — still not shown
            ↓                                                  ▶ careful: writing
            path check            every path it names must exist (≤2 corrections)
            ↓
            proposal revealed to the user
            ↓
            approval gate         question_request
              ├─ "Start work"           → hold lifts → proposal injected as the
              │                           brief → work starts immediately
              ├─ "Cancel"               → hold lifts → turn ends, nothing changed
              └─ free text (a Revision) → hold STAYS → FRESH map seeded from what
                                          they said → new proposal, no review pass
```

Revisions are unlimited. An unanswered or interrupted gate reads as **cancel**,
never as approval.

The proposal is written while still muted and only revealed once its paths check
out. Streaming it live would mean showing a proposal that names a file which does
not exist, then contradicting it — which is exactly the failure the check exists
to prevent.

## Where the code is

| Concern | Location |
| --- | --- |
| Allowlist, prompts, path extraction, verdict + answer parsing | `engine/core/src/runtime/careful.ts` |
| The hold itself | `engine/core/src/runtime/permissions.ts` — `setCarefulHold`, checked after deny rules and ahead of everything else |
| Predictor, scout map, path check, phase orchestration | `engine/core/src/runtime/session.ts` — `predictCareful`, `buildCarefulScoutMap`, `unknownProposalPaths`, `askCarefulApproval`, and the careful rung inside `runTurn` |
| Request → graph seeds, and the scout's location digest | `engine/core/src/knowledge/seeds.ts` — shared with the GraphQuery tool |
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
- **`CAREFUL_SCOUT_SECTION` is load-bearing.** The phase has no numeric cap, so
  its stop test is the entire bound. ADR 0005.

## What is verified

```bash
npm run build                                                  # tsc -b, engine only
node .claude/skills/bigboycoding/careful-hold-check.mjs         # 60 hold + path-claim invariants
node .claude/skills/bigboycoding/graph-languages-check.mjs      # 20 language invariants on a fixture repo
node .claude/skills/bigboycoding/permission-check.mjs           # 27 permission invariants
node app/tests/run-ui-tests.js                                  # 27 scenarios
```

`engine/*` has no unit suite and `tsc` cannot see any of this, so the two check
scripts assert against `engine/core/dist/` directly:

- **the hold check** — that the hold refuses `Write`/`Edit`/`Bash`, admits the
  six scout tools, and outranks allow rules, `allow_always` grants, session
  allows and OVERDRIVE itself; and that a proposal's path claims are extracted
  without swallowing commands, flags, versions or URLs (a false alarm sends the
  model correcting prose that was already right).
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
| Self-critique | 2 rounds, each inviting more reading | 1 review pass, reads nothing new |
| Hallucinated paths | Nothing checked them | Engine checks each, sends bad ones back |
| After approval | "Build what you described", then ask the unclears | The proposal injected as the working brief; work starts |
| When questions are asked | After approval | Before the proposal is written |
| Phase feedback | Four plain notes | `▶ ` phase banners (the Workflow convention) |
| Graph languages | TS, JS, Python | 8 with edges, everything else as nodes |
| Slice seeds | File paths only | Paths **and** declared symbol names |

Two supporting changes fell out of it. `resolveSeeds` moved into
`knowledge/seeds.ts` so the GraphQuery tool and the scout map cannot disagree
about which files a request concerns. And question cards now route their answer
back to the engine that asked (`app/renderer/modules/landing.js`) — previously
the answer went to whichever pane had focus, so with two workspaces open an
approval could start work in the wrong one.

## Deliberately left

- **Plain Speech applies to the Proposal only.** The rule — short sentences, one idea each,
  active voice, in whatever language the user writes in — lives in
  `CAREFUL_PROPOSAL_TEXT`. Applying it product-wide means moving it to
  `SECTION_COMMUNICATION` in `prompts.ts`, which changes MAGENTRA's whole voice
  and is a wider decision than this feature.
- **The scout's reading stays in context after approval.** The proposal is the
  distillate of it, so the raw file reads could be compacted away once the hold
  lifts — the working phase would then start with the request plus the approved
  proposal and nothing else. `maybeCompact` already handles the tool_use/
  tool_result pairing that makes this safe. Worth doing; not needed for the
  feature to work.
- **The scout cannot run `git`.** `Bash` is `execute`, so no `git log`/`git
  diff`/`npm ls` while held. Deliberate: widening it is one entry in
  `SCOUT_TOOLS`, but a scout confirming a target needs less, not more.
- **Clarify still runs first**, so a careful turn can ask up to three times
  (clarify → approval → unclears). Chosen deliberately; revisit if it grates.
- **Multi-tab is partly verified.** The answer-routing bug is fixed and covered
  by the existing concurrent-tabs UI scenario. Still untested with two *live*
  engines: whether a background pane's proposal behaves, and whether
  `applySafetySettings(true)` on a new engine link stomps a per-tab `/careful`.
