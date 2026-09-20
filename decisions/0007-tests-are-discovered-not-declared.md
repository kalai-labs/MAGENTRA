# A feature's status is read from the test files, not from the record

`status` was derived from the record's own `tests` array, and nothing ever read
`tests/features/`. So the array was a hand-typed copy of a fact nobody checked,
and §2.1 already defined that fact as something else entirely: *"test ids
present in `tests/features/<id>.test.ts`"*. The file was the referent all along;
the array was a cache with no writer and no reader.

**What this is not.** No wrong answer had been given yet. Checked on the day
this was written: `tests/features/` did not exist, no `*.test.*` file existed
anywhere in the repository, and all 164 records carried `tests: []` — so

> no tests. This feature is unproven: nothing in the repository asserts the
> invariant above.

was **correct** for every record, and the old `deriveStatus` (`if
(rec.tests.length === 0) return "untested"`) could not have said anything else.
Nothing was broken and nothing was hidden. This decision is the outstanding half
of §11 step 6 being built, not a bug being fixed, and it changes no answer the
gateway was giving.

What it removes is the *only-answer* problem and one latent failure. `covered`
was unreachable by construction: `deriveStatus` could return it only when handed
a set of kinds resolved from the test files, and no caller ever resolved one. And
because `status` keyed off a hand-typed array, an id typed into it would have
read as coverage with nothing behind it — `FEATURES.md`'s ticked box, moved into
the inventory, where the tool that exists to catch it could not look. Neither had
happened; both were reachable from the first test written.

## What is authoritative now

**The files.** `tools/magentra-gateway/src/tests.ts` parses `tests/features/`
and `status` is derived from what it finds. A test counts only when it exists
**and runs** — a class that is never passed to `registerFeatureTests()` is
reported as a problem, never as coverage, because a test that cannot run is the
thing this decision is about.

The record's `tests` array stays, and stays hand-authored. It is now the
*stored copy* — the reviewable, committed statement of what is proven, visible
in a `git diff` without a parser — and `driftOf()` compares it against the
files. Two disagreements matter:

| Drift | What it means |
| --- | --- |
| `recordedWithoutTest` | the record claims an id no file defines — **a ticked box** |
| `testedWithoutRecord`  | a test runs that the record does not list |

Neither changes `status`, which is already honest; both are shown on the feature
and counted in the header. `tests/lib/featureTest.ts` enforces the same
agreement from the other side: a test whose id is not in its record's array
fails. The two directions are now both closed.

## Parsed, never run, never imported

decisions/0006 took the runner out of the gateway, so discovery is static. It
does not import a test module either: importing one calls `node:test`'s
`test()`, which outside the runner *executes* it — a gateway that spawned an
Electron `ui` test to learn that the test exists is a gateway nobody leaves
open.

It uses the TypeScript parser rather than a regex. A hand-rolled scanner would
be the second parser SPEC §6 refuses for the import graph, and this one must
survive an aliased base class, a property inherited from a local abstract base,
an invariant shared through a `const`, and `"proc" as const`. A regex that reads
any of those wrong **fails silently**: it reports a feature as untested, which
is indistinguishable from the truth. `typescript` is already the repo's compiler
and a root devDependency; only its parser is used, so no build has to have run.

Everything it cannot read statically becomes a named problem carrying file and
line — an unregistered class, an id built by a function call, a bare `node:test`
call outside the hierarchy, a file named for the wrong feature. Nothing is
skipped, because a silently skipped test file is the one state this decision
exists to make impossible.

## Two things deliberately not done

**Discovery is not a third stage of the gate.** decisions/0005 defines two, and
`blocked` means the inventory may not be believed. A test file the parser cannot
read is a gap in coverage, not a reason to distrust every record's freshness, so
it is reported beside the gate and never sets `blocked`. Making it a third stage
is a decision, not a side effect of fixing discovery.

**There is no route that writes the `tests` array.** `POST /api/features` still
answers 501: editing records from the UI is out of scope for §11 steps 1–5, and
a tool that ticks its own boxes — however well it read the file first — is a
tool arguing with its own reason for existing. The array is edited by the person
who wrote the test, in the commit that adds it.

## The pair this creates

`KIND_BY_BASE_CLASS` in `tests.ts` names the six classes of `tests/lib/`, which
is a mirrored pair in the sense BIG-PICTURE §16 uses. It is deliberate and it
only points one way: `tests/lib` may not import the gateway (a broken tool must
never mean no tests — tests/README rule 5), so the gateway carries the copy. A
kind base renamed in `tests/lib` and not here does not fail quietly, because
that map is also the definition of what counts as a test: every class extending
the renamed base becomes "extends an unknown base class", with its file and
line.

## Unrelated gap found while doing this

`decisions/0006-the-gateway-does-not-run-or-brief.md` is cited by `SPEC.md`
eleven times and by `gate.ts` five, and **has never existed** in this
repository's history. The decision it names is real and is implemented — there
is no runner and no brief route — but the record was never written. It is not
this document; taking the number would leave every one of those citations
pointing at the wrong thing.
