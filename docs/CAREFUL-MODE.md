# CAREFUL MODE

> **Status: working, but not finished.** The mechanism is built, enforced and
> tested. It is too slow to use in anger — see [Open issues](#open-issues).
> Last worked on 2026-07-27.

A modifier of OVERDRIVE, not a third stance. OVERDRIVE removes approval from
every *action*; CAREFUL adds it back at exactly one *decision* — which approach
to take — and nowhere else. Domain vocabulary is in [`CONTEXT.md`](../CONTEXT.md);
the two decisions worth knowing are [ADR 0001](adr/0001-careful-mode-is-enforced-by-the-permission-engine.md)
and [ADR 0002](adr/0002-careful-rides-the-overdrive-frame.md).

## The shape of a careful turn

```
user message
   ↓
clarify pre-layer          unchanged, still runs first
   ↓
careful predictor          one main-model inference, fail-open
   ↓ several steps, or one irreversible step?
   │
   ├─ no  → ordinary OVERDRIVE turn
   │
   └─ yes → HOLD RAISED (PermissionEngine)
            ↓
            scout: Read / Grep / Glob / GraphQuery / BackpackSearch / Skill
                   everything else refused; all prose suppressed
            ↓
            self-critique ×2   "is there a better way?"   (silent)
            ↓
            BRIEFING           four H1 sections, streams as markdown
            ↓
            approval gate      question_request
              ├─ "Start work"           → hold lifts → unclears → work
              ├─ "Cancel"               → hold lifts → turn ends, nothing changed
              └─ free text (a Revision) → hold STAYS → re-scout → new briefing
                                          critique budget 2 → 1 → 0
```

Revisions are unlimited. An unanswered or interrupted gate reads as **cancel**,
never as approval.

## Where the code is

| Concern | Location |
| --- | --- |
| Allowlist, prompts, verdict + answer parsing | `engine/core/src/runtime/careful.ts` (new) |
| The hold itself | `engine/core/src/runtime/permissions.ts` — `setCarefulHold`, checked after deny rules and ahead of everything else |
| Predictor, approval gate, phase orchestration | `engine/core/src/runtime/session.ts` — `predictCareful`, `askCarefulApproval`, and the careful rung inside `runTurn` |
| `careful` field on the two frames | `engine/protocol/src/types.ts` |
| Frame handling, `/careful on\|off`, resume | `engine/core/src/runtime/engine.ts` |
| The composer pill | `app/renderer/{index.html, styles.css}`, `modules/{dom,state,overdrive,tabs}.js` |

Two things about the design that are easy to undo by accident:

- **The hold is enforcement, not instruction.** CAREFUL only exists inside
  OVERDRIVE, where nothing asks — so a prompt-level "do not edit yet" would be a
  request the model is free to ignore while rewriting the repository. See ADR 0001.
- **There is no `set_careful` frame.** `careful` rides `set_overdrive` and
  `overdrive_changed`, and **absent means unchanged, never off**. See ADR 0002.

## What is verified

```bash
npm run build                                                  # tsc -b, engine only
node .claude/skills/bigboycoding/careful-hold-check.mjs         # 46 hold invariants
node app/tests/run-ui-tests.js                                  # 26 scenarios
```

The hold check is the important one: `engine/*` has no unit suite and `tsc`
cannot see any of this, so it asserts against `engine/core/dist/` directly that
the hold refuses `Write`/`Edit`/`Bash`, admits the six scout tools, and outranks
allow rules, `allow_always` grants, session allows and OVERDRIVE itself.

Pre-existing failures, unrelated and present before this work: `test:version`
(shells out to `mkdir -p`, absent on Windows) and `app/tests/changes.test.js`
(CRLF/LF assertion).

## Open issues

### 1. The scout reads far too much — blocking

Ten minutes in the reading phase alone. Not usable.

Nothing bounds the scout: interactive root turns run uncapped (`capped` is false
in `runTurn`), and `CAREFUL_SCOUT_SECTION` tells it to "follow the imports, find
the callers" with no budget attached. The critique rounds then explicitly invite
*more* reading. It behaves correctly and terminates — it just costs more time
than the checkpoint is worth.

Leads, roughly in order of expected payoff:

- **Start it from the map instead of making it discover one.** `predictCareful`
  already calls `buildClarifySkim()` — the atlas, or an import-graph skeleton —
  and then throws it away. Injecting that into the scout's first message would
  replace a great deal of blind reading with a starting position.
- **Push it toward `GraphQuery` and `Grep` before `Read`.** The scout prompt
  never mentions the design atlas or the import graph, so the model brute-forces
  with `Read`. Naming them, and saying "locate before you open", is cheap.
- **Bound the held phase.** A maximum number of tool rounds while held, after
  which the briefing instruction is forced — the same shape as the existing
  iteration cap, scoped to the scout. This is the one guaranteed fix; the
  others are persuasion.
- **Cap what a scout `Read` returns.** Reading whole files to name them is
  wasteful when `offset`/`limit` would do.

### 2. No phase feedback in the UI — blocking for usability

While held, all assistant prose is suppressed (deliberately — steps 1–3 are
meant to be silent), so the user sees tool rows and nothing else for minutes and
cannot tell scouting from critiquing from briefing.

Today the only signal is four `command_output` lines: `◉ careful: investigating
before proposing a plan`, `◉ careful: revising the plan (revision N)`, `◉
careful: approved — starting work`, `◉ careful: cancelled — nothing was changed`.

Note the constraint before designing: ADR 0002 deliberately avoided new protocol
frames. More `command_output` lines cost nothing and add no seam; a real phase
indicator (a chip, a progress rail) needs either a new frame or a marker string
the renderer sniffs — which is exactly the untyped seam `bigboycoding` warns
about. Decide that trade-off explicitly rather than drifting into it.

### 3. Multi-tab behaviour is untested

Single-tab only so far. Specifically unverified:

- Whether a `question_request` for the approval gate routes to the right pane in
  a tiled layout, and what a *background* pane's briefing does.
- Per-tab state: `ts.careful` is recorded from `overdrive_changed` and restored
  on focus change, and a tab that has never reported one is deliberately left
  alone rather than read as "off" — `tabs.js`. Untested with two live engines.
- Each tab is its own engine and therefore its own `PermissionEngine`, so a hold
  in one pane should not touch another. Believed true by construction, not
  demonstrated.
- `applySafetySettings(true)` on a new engine link pushes the global `careful`
  to that engine; confirm it does not stomp a per-tab `/careful` setting.

## Smaller things deliberately left

- **Briefing headings were lightly reworded** from the original spec
  (`What's the objective?`, `…have to be clarified by you?`). The originals read
  `What s the objective?` and `enlighted`. Both live in `CAREFUL_BRIEFING_TEXT` —
  restore them if the original voice was wanted.
- **The scout cannot run `git`.** `Bash` is `execute`, so no `git log`/`git
  diff`/`npm ls` while held. That was a deliberate scoping call; widening it is
  one entry in `SCOUT_TOOLS`, but see issue 1 before making the scout able to do
  more.
- **Clarify still runs first**, so a careful turn can ask up to three times
  (clarify → approval → unclears). Chosen deliberately; revisit if it grates.
