# Records are committed JSON, one file per feature — not SQLite

SQLite was preferred at first, on two stated grounds: seeing every feature and
its tests in one place, and a schema that fits the object hierarchy the tests
use. Both goals are right. SQLite serves neither as well as the alternative
once one requirement is fixed: **the records are committed to git.**

## Why committed changes the answer

- **A committed binary cannot be merged.** This repo merges branches — HEAD~5 is
  `Merge branch 'research/lab-2'` and work happens on branches like
  `tests/lab-1`. Two branches each adding a feature produce a binary conflict
  with no three-way merge: you keep one side and redo the other by hand. For the
  single source of truth of the whole application, that is the worst available
  failure mode.
- **An opaque diff cannot be reviewed.** The inventory is the thing that must be
  tracked most carefully. A change to it should show *what* changed; a SQLite
  blob shows `Binary files differ`.
- **SQLite's schema guarantee is weaker than TypeScript's.** SQLite has type
  affinity, not type enforcement. A zod schema validated on load, over a
  TypeScript interface, is checked at compile time *and* at read time.
- **Seeing everything at once is a rendering concern.** 112-odd records load
  into memory in milliseconds; in-memory `filter`/`map` beats SQL at this size.

## The decision

| Aspect | Choice |
| --- | --- |
| Format | JSON |
| Granularity | **one file per feature**, at `tests/gateway/features/<feature-id>.json` |
| Descriptions | one file per description, `tests/gateway/descriptions/<id>.json` |
| Committed? | Yes — the inventory travels with the branch |
| Validation | zod on load; a malformed record is a loud failure, never a silent default |
| Writes | `writeJsonAtomic` (the helper already protecting `settings.json` and `profiles.json`) |
| Run results | in memory for the life of the run. Not persisted. |

One file per feature is what removes the merge problem rather than resolving
it: two people adding different features never touch the same file.

## Run history is not stored

An earlier draft added a gitignored SQLite database for run history. That was
scope creep — history is not among the four abilities, and it would have raised
the tool's Node floor to ≥24 (`node:sqlite` is unflagged only from 23.4) to
serve a feature nobody asked for. Removed.

The gate needs the *current* run's result, not a trend line.

## What would reopen this

Flakiness detection or trends across hundreds of runs is a real database case.
It would be its own record, decided then, with the run store kept separate from
the inventory — derived data and source of truth do not share a home.
