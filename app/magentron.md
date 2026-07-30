---
name: magentron
description: Read before you write — map what a change touches, reuse what already exists instead of writing a second copy, and delete superseded code in the same change. Invoke for refactors, renames, deletions, or any edit in crowded code. COSTS EXTRA TOKENS: it front-loads a reconnaissance pass before the first edit, so reach for it when a broken change would cost more than the reading.
---

Every change must leave the codebase **smaller in concept than it looks on the
diff**: no second copy of something that already exists, and no orphaned remains
of what the change replaced. You are editing one coherent system, not appending
to a pile.

Work in three phases. Do not skip Phase 1 because the task "looks like a
one-liner" — that is exactly when duplication sneaks in.

## Phase 1 — Map before you write

Before writing any new function, type, endpoint, component or helper, find out
what already exists for this job. The goal is to **reuse or extend, not
reinvent.**

1. **Search for the capability, not just the name.** The thing you are about to
   write may already exist under a different name. Search by intent (domain
   nouns and verbs), by the data shape it operates on, and by the call sites you
   would expect. Read the public surface of sibling files in the same module.
2. **Use the import graph, not guesswork.** `GraphQuery blast` names what
   breaks if the files you are about to edit change; `GraphQuery deps` names
   what they rely on; `GraphQuery structure` gives the skeleton when you do not
   know the repo yet. Run it on every file you intend to edit — before the first
   edit, not after something breaks.
3. **Read the seams, not whole files.** Signatures, exports, module boundaries.
   Read full bodies only for the few functions you will actually touch.
4. **Read the callers.** The graph names them; open them. A caller's assumption
   is the thing you are about to violate.
5. **Decide: reuse, extend, or add** — in that order of preference. Extending one
   function so it serves both the old and the new caller is almost always better
   than a near-duplicate. State which you chose, in one line, before writing.

Stop and consolidate if you catch yourself: copy-pasting a block and tweaking a
few lines; naming something `fooV2`, `handleXNew`, `processData2`,
`*Improved`; re-implementing parsing, validation, formatting, retry, auth or
date handling; or adding a file whose name is a synonym of an existing one
(`utils` vs `helpers`, `format` vs `formatter`).

## Phase 2 — Replace in place

When new code supersedes old code, the old code leaves **in the same change**.
New and old must never coexist "for now."

1. Change a function's behaviour **in place** rather than adding a parallel one,
   unless the original has other live callers that genuinely need it.
2. When you replace something, before calling the task done: find every
   reference to the old symbol across the whole repo — including tests, configs,
   docs, string-keyed lookups, route tables, and re-exports — migrate each call
   site, then delete the old definition **and** anything that only existed to
   support it (private helpers, now-unused imports, constants, types, fixtures).
3. **Never leave** commented-out code, dead branches behind a flag that is now
   always one value, unreachable returns, or a file nothing imports.
4. **Follow the thread.** Removing a function orphans its helpers; removing the
   last caller of a helper makes that helper dead too. Chase the chain until
   nothing new is orphaned.

**Verify dead before you delete.** Deleting code that was actually reachable is
worse than leaving it. Account for dynamic dispatch, string-keyed registries,
event and route tables, serialization, plugin discovery, CLI entry points, and
test-only usage. If a symbol is part of a published API, or you cannot prove it
is unused, say so and ask rather than deleting on assumption. Make a deletion
and its replacement part of the same change, so the tree is never left
referencing something that is gone.

## Phase 3 — Coherence audit

After the change works, sweep it as a whole. Scope the audit to what you touched
and what it reaches.

- **No dead code left.** Re-grep the name of everything you removed to confirm
  zero stragglers. Re-grep helpers whose last caller you deleted.
- **No duplication introduced.** If two pieces of code now do nearly the same
  thing — one yours, one pre-existing — consolidate into one and route both
  callers through it.
- **Improvement over addition.** For each new function, confirm an existing one
  could not have been improved to cover the case instead. If it could, do that
  now.
- **Imports and exports clean.** No unused imports; no exports of deleted
  symbols.
- **Run the project's own gates.** Build, typecheck, and whatever test command
  the repo actually has — and report the real output. A typecheck that only
  covers part of the tree is not evidence about the rest of it; say which half
  you proved.

Close by stating briefly what you reused or extended versus added new, and what
dead code you removed. If you deliberately left something that looks dead, call
it out and say why.
