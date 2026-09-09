# The gateway is the inventory, and the inventory leads the code

MAGENTRA reached 0.17.4 with no test suite and a feature list kept as prose. On
2026-09-09 the remaining tests were deleted deliberately (21 files, 6,366 lines:
`app/tests/`, `tools/version/test/`, and seven `*-check.mjs` invariant checks) to
be rebuilt from scratch rather than extended. That reset is the constraint this
design is built on: there is nothing to preserve compatibility with, and exactly
one chance to get the foundation right.

The failure being designed against is not "we have no tests". It is the failure
the deleted suite actually had: **28 ticked boxes in `FEATURES.md` whose tests
did not exist or did not assert anything**, and three source comments naming a
`connection-check.mjs` that has never existed in any commit on any branch. A
test inventory that can drift from the code is worse than no inventory, because
it is trusted.

## The decision

`magentra-gateway` is the single source of truth for every feature MAGENTRA
ships. Not a dashboard over some other truth — the truth itself.

Three consequences, in the order they bind:

1. **A feature exists when it is in the inventory.** A new feature, a change to
   one, or a bugfix is entered in the inventory *first*. Code that implements an
   unregistered feature is code the gateway cannot reason about, which means no
   agent writing a test for it can be told what it depends on.
2. **The registry is canonical; `FEATURES.md` is generated from it.** The prose
   is preserved verbatim as a field, so nothing that made that document worth
   reading is lost. What is removed is the possibility of the two disagreeing.
3. **The inventory covers all of MAGENTRA, including its tooling.** The version
   tool decides every release and writes every changelog; prompt-lab edits the
   prompts the engine sends. Both are load-bearing and both are features.

## What the gateway is for

Four abilities, in priority order. Everything else is deferred.

| # | Ability |
| --- | --- |
| 1 | Awareness of every feature MAGENTRA supports |
| 2 | The tests for each feature, and **why** each test exists |
| 3 | User-authored descriptions of what tests must be written, saved durably |
| 4 | **Dependency awareness**, so an agent writing a test is told what else to check |

Ability 4 is the one that makes the other three worth building. A description
that says "write an `fs` test for the profile store" is a wish; the same
description delivered with the profile store's entry files, its transitive
importers, the untyped `app/` files that reach it, and the frame strings it
crosses becomes a brief an agent can execute without guessing. That data already
exists in this repo — `engine/core/src/knowledge/graph.ts` computes it and
`GraphQuery` serves it to the agent at runtime. The gateway consumes that index
rather than growing a second one.

## Non-goals

- **Not a PR review surface in v1.** Diff review with per-hunk approval is
  deferred (see `SPEC.md` §Deferred). A feature-anchored comment stays valid
  forever; a hunk-anchored comment dies when the line moves, and the anchoring
  machinery that fixes it is not v1's problem.
- **Not a CI replacement.** `node --test tests/` must work standalone, so a
  broken gateway never means no tests.
- **Not a git mutator.** No stage, commit, or diff-revert in v1. Two writers on
  one workspace violates an invariant this repo already documents.

## What proves it

Nothing yet — this record precedes the implementation. The gate in
[0005](0005-the-two-stage-gate.md) is what will prove the inventory matches the
code, and it is the only mechanism in this design that can.
