# tests/

All MAGENTRA tests live here, permanently. Nothing else in the repository holds
tests.

```
tests/
├── lib/                          the test class hierarchy
│   ├── featureTest.ts            the abstract base every test extends
│   ├── procTest.ts               kind: spawns a real process, owns its life
│   ├── uiTest.ts                 kind: runs the real desktop app under Electron
│   ├── childProcesses.ts         the kill-the-tree guarantee both kinds hold
│   ├── engineHarness.ts          a real engine + a fake provider, for proc tests
│   ├── appHarness.cjs            hosts app/main.js unchanged, for ui tests
│   └── inventory.ts              reads a feature record; imports no gateway code
├── features/<feature-id>.test.ts one file per feature
├── tsconfig.json                 typecheck only; not in the root `tsc -b` chain
└── gateway/
    └── features/<feature-id>.json  the inventory — 164 records, committed
```

## Running them

```
npm test              # node --test "tests/features/**/*.test.ts"
npm run typecheck:tests
```

Two things about that command, both verified on Node 24.20.0 rather than assumed:

- **`node --test tests/` does not work, on any Node this suite can use.** A
  directory argument is not expanded; it is loaded as if it were a module, and
  the run fails with `Cannot find module …/tests`. Bare `node --test` from the
  repository root works (it globs, skipping `node_modules`), and so does the
  explicit glob `npm test` uses. Rule 5 below is about the *gateway* not being a
  precondition, and it is unaffected — only the spelling of the command changed.
- **The suite needs Node ≥ 22.18, and Node 24 is what it is developed on.**
  Tests are TypeScript and are run by Node's own type stripping — no build step,
  no `tsx`, so a broken `npm run build` still leaves a runnable suite. Node 20
  cannot parse them at all, which is a live problem for `.github/workflows/ci.yml`:
  every job there pins Node 20, and the commented-out test job's 20/22/24 matrix
  has to lose the 20 when it is restored.

One gap in that command, recorded rather than papered over: with `features/`
empty, `npm test` reports `tests 0` and **exits 0**. A green with nothing behind
it is the thing this suite was reset to remove, so it is worth knowing that the
runner cannot currently tell "everything passed" from "nothing ran". It closes
the moment the first test lands, and the durable answer is the gateway's derived
`status` (no record reads `covered` without a test per declared kind) rather
than a flag on `node --test`, which has none. Adding a wrapper that fails on an
empty discovery would be a runner, and decisions/0006 removed the runner on
purpose.

Because Node strips types instead of compiling them, **imports inside `tests/`
carry the `.ts` extension** (`from "../lib/procTest.ts"`). A `.js` specifier is
resolved literally and is not found. `tests/tsconfig.json` sets
`allowImportingTsExtensions` so tsc agrees, and `erasableSyntaxOnly` so an enum
or a parameter property — which tsc accepts and the stripper cannot — is caught
as a type error instead of as an unrunnable test.

## Status

**There are no feature tests yet — 164 of 164 records read `untested`.** The
previous suite was deleted on 2026-09-09 (21 files, 6,366 lines) because 28 of
its ticked boxes had no assertion behind them. The inventory in
`gateway/features/` is the backlog, and it is verified against the source rather
than against `FEATURES.md`.

`lib/` is SPEC §11 step 6: the base plus the `proc` kind (2026-09-10) and the
`ui` kind (2026-09-11). `pure`, `fs`, `net` and `llm` are not written — each is
a small subclass, and each is best written against the first real test that
needs it rather than guessed at in advance.

One feature is proven: `a-connection-change-re-points-the-live-session`, seven
tests over both its halves. Each was checked by breaking the feature on purpose
and confirming the right test failed.

**A `ui` test needs a display.** macOS and Windows have one; Linux and CI need
`xvfb-run`, exactly as the app's own smoke job already does. A `proc` or `ui`
test that drives the engine also needs `npm run build` first — it runs the built
engine, which is what the app spawns, and `dist/` is gitignored.

What the base enforces, by mechanism rather than by reminder:

| Rule | How |
| --- | --- |
| every test names its record, invariant and `whyItExists` | abstract members — a test missing one does not compile |
| no skip, no soft assert, no expected-failure | `run()` is handed a narrowed `TestRun`, which has no `skip`, `todo` or `plan` |
| **a test asserts something** | `run()` uses the counted `t.assert` it is given; a run that asserts nothing fails, naming the 28 boxes |
| a test agrees with its record | its kind must be one the record declares, its `invariant` must match verbatim, and its id must be listed in the record's `tests` |
| a spawning test leaves no orphan | children are spawned into their own process group and killed SIGTERM→SIGKILL on teardown, in an outer `finally`; a survivor fails the test. `proc` and `ui` share one copy of this (`childProcesses.ts`) |
| a test file is findable | the gateway parses `features/` and derives each record's status from it — see *What the gateway reads out of a test file* below |

## What the gateway reads out of a test file

`tools/magentra-gateway/src/tests.ts` parses this directory and derives each
record's `status` from what it finds ([`../decisions/0007`](../decisions/0007-tests-are-discovered-not-declared.md)).
It parses; it never imports or runs a test. Four things it needs, each of which
becomes a named problem in the gateway rather than a silent omission:

1. **The class extends a kind base** — `ProcTest`, `PureTest`, … An alias
   (`import { ProcTest as Base }`) and a local `abstract` class in between are
   both fine; anything outside the hierarchy is invisible to the inventory.
2. **`featureId`, `id`, `whyItExists` and `invariant` are readable statically** —
   a string literal, a plain template, or a module-level `const` holding one.
   An id built by a function call cannot be read without running the file.
3. **The class is passed to `registerFeatureTests()`** — an unregistered class
   never runs, so it counts as absent, not as coverage.
4. **The file is named for the feature** it proves: `tests/features/<feature-id>.test.ts`.

## Why the inventory comes first

A test that cannot say which feature it proves, and why it exists, is the
scaffold this reset removed. So a feature record exists before its test, and the
record carries the dependency information an agent needs in order to write that
test without guessing what else it touches.

Design and rationale: [`../decisions/`](../decisions/). Read
`decisions/SPEC.md` before adding anything here.

## The rules that are not negotiable

1. **A feature is in the inventory before its code is written.** The gateway is
   the single source of truth; code implementing an unregistered feature cannot
   be reasoned about.
2. **Tests inherit on kind**, not on area. `pure` / `fs` / `proc` / `net` /
   `llm` / `ui` decide setup, teardown, and whether the test can run at all.
3. **Every test states `whyItExists`** — the failure it would have caught.
4. **A failing test stays failing until the feature is fixed correctly.** No
   skip, no soft assertion, no expected-failure state.
5. **The suite must run without the gateway.** `npm test` imports nothing from
   `tools/magentra-gateway/` — `lib/inventory.ts` reads the committed records
   with `readFileSync` for exactly this reason. A broken tool must never mean no
   tests. (See *Running them* above for why the command is not literally
   `node --test tests/`.)
6. **Stale blocks everything.** If any record's entry files have changed since
   the record was last reviewed, no test runs until it is reconciled.
7. **No connection, no run** — whether or not the test involves a model.

## The 164 records

| Section | Records |
| --- | --- |
| Tools | 31 |
| Desktop app | 26 |
| Runtime — the turn loop | 23 |
| Tooling | 13 |
| Addons | 10 |
| Protocol & host | 10 |
| Scheduling | 8 |
| Packaging | 7 |
| Mirrored constants | 7 |
| Terminal UI | 6 |
| OVERDRIVE · Finishing rungs · Agent · Knowledge · Config | 4 each |
| State | 3 |

155 are testable now. 9 are `deferred: true` — renderer-only features, excluded
at this stage by decision, not by oversight.
