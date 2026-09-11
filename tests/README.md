# tests/

All MAGENTRA tests live here, permanently. Nothing else in the repository holds
tests.

```
tests/
├── lib/                          the test class hierarchy
│   ├── featureTest.ts            the abstract base every test extends
│   ├── pureTest.ts               kind: touches nothing, and proves it
│   ├── fsTest.ts                 kind: a temp workspace, a redirectable HOME
│   ├── procTest.ts               kind: spawns a real process, owns its life
│   ├── netTest.ts                kind: a real server on 127.0.0.1, closed after
│   ├── uiTest.ts                 kind: runs the real desktop app under Electron
│   ├── childProcesses.ts         the kill-the-tree guarantee the kinds share
│   ├── localServer.ts            the far end of a socket, for net and ui alike
│   ├── exclusive.ts              a lock for what the whole suite shares
│   ├── engineHarness.ts          a real engine + a fake provider, for proc tests
│   ├── appHarness.cjs            hosts app/main.js unchanged, for ui tests
│   ├── appDriver.ts              driving that app: workspaces, profiles, its log
│   ├── appConnection.ts          app/main/connection.js, loaded as main loads it
│   ├── scriptedFetch.ts          a network that answers from a script
│   └── inventory.ts              reads a feature record; imports no gateway code
├── features/<feature-id>.test.ts one file per feature
├── tsconfig.json                 typecheck only; not in the root `tsc -b` chain
└── gateway/
    └── features/<feature-id>.json  the inventory — 164 records, committed
```

## Running them

```
npm test              # node --test --test-concurrency=1 "tests/features/**/*.test.ts"
npm run typecheck:tests
```

Three things about that command, all verified on the platform rather than assumed:

- **`--test-concurrency=1` is load-bearing, and not a speed knob.** `node --test`
  runs test FILES in parallel processes, defaulting to roughly one per core.
  Eighteen of the twenty-eight files hold `ui` tests, so the default opened up to
  sixteen real desktop applications at once — sixteen Electrons fighting over one
  display, one GPU and one disk. That is a design fault rather than a platform
  one, so the fix is not per-OS: files run one at a time, `node:test` already runs
  the tests inside a file sequentially, and the suite therefore starts **exactly
  one app at a time** everywhere. It also removes at a stroke the whole class of
  cross-file races this file used to catalogue: the packager's single output
  directory, and macOS serialising full-screen transitions across applications.
  `lib/exclusive.ts` stays, because it is what makes two *runs* on one machine
  safe, and because the cost of holding it when it is uncontended is nothing.
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

`lib/` is SPEC §11 step 6: the base plus the `pure`, `fs`, `proc`, `net` and
`ui` kinds. `llm` is not written — no feature has yet needed a real model to
prove, and several that declared one did not (see *kinds are a claim* below).

**Every approved description is implemented: 28 features, 101 tests** — 45
`ui`, 30 `pure`, 17 `proc`, 8 `fs`, 1 `net`.

Every one of them was checked by breaking the feature on purpose and confirming
that the right test, and only it, failed. That found eleven tests that passed
without proving anything, each fixed and re-checked:

| What the mutation revealed | The fix |
| --- | --- |
| a leftover `.tmp` is the only case the trailing `chmod` exists for | write into one, then assert the mode |
| `/v1/openai` does not discriminate suffix order; `/openai/v1` does | assert the suffixes that end in `/v1` |
| a bundle left in the repo resolves the repo's own `node_modules` | copy it out of the tree first |
| a 404 body with no tag agrees with both readings | give the refused answer a valid-looking tag |
| exit 1 also comes from the smoke timer | require the crash to end the run at once |
| an instance turned away by the lock also exits 0 | require the second instance to outlive the lock check |
| `$5, not $7` is refused before the prose test is reached | add `$a, b$`, a code span, and `$x^2 $` |
| the body swap already removes the caret | finalize a message with no text, where it cannot |
| two queued requests make `shift` and `pop` identical | queue three |
| hiding the card does not prove the queue was cleared | deliver a fresh request and check which one shows |
| the log cannot say which tab's engine got a frame | kill the asking engine and require the drop |
| with a menu present, deleting the F11 handler passes — Electron's own accelerator answers instead | press it again with `Menu.setApplicationMenu(null)`, the packaged non-mac condition, where the handler is the only route |

**Kinds are a claim about what proving a feature requires, and fifteen records
were wrong.** `a-404-on-models-is-disambiguated-not-assumed` and
`endpoint-discovery` were `proc` but take their `fetch` as a parameter (`pure`).
`linux-artifact` was `ui` and involves no window (`pure` + `proc`).
`permission-prompt` was `llm` and is about a queue (`ui`).
`images-go-to-a-second-model-never-to-the-coding-one` was `llm` and is about
routing, which a stub at the second endpoint proves (`proc`). Each was
re-declared where the test sits, and the test file says why.

**A deferred feature may be proven.** Nine records are `deferred` by rule — all
their entry files sit under `app/renderer/` — and this base used to refuse any
test written for one. SPEC §2.1 says only that such a feature "carries no test
expectation" and "never counts against coverage"; it does not forbid a test. All
nine are now proven, through the real page in a real app. See
[`../decisions/0008`](../decisions/0008-a-deferred-feature-may-still-be-proven.md).

**A `ui` test needs a display.** macOS and Windows have one; Linux and CI need
`xvfb-run`, exactly as the app's own smoke job already does. A `proc` or `ui`
test that drives the engine also needs `npm run build` first — it runs the built
engine, which is what the app spawns, and `dist/` is gitignored.

## Every test runs on Windows, macOS and Linux

Not "is expected to": each platform-specific fact is asserted as what THAT
platform can express, never skipped where it cannot.

- **File modes** are asserted on POSIX; on Windows, which has none, the same
  tests assert that the write landed.
- **The Linux launcher wrapper** is executed under `/bin/sh`, and under a
  pseudo-terminal via `script(1)`, on macOS and Linux. Windows has neither and
  ships no wrapper — so there the test asserts that packaging produces none,
  which is the Windows truth rather than a skipped Linux one.
- **Process trees** are killed by process group on POSIX and `taskkill /T` on
  Windows (`childProcesses.ts`).
- **Paths and homes**: nothing hard-codes a POSIX path; `HOME` and `USERPROFILE`
  are both redirected, because `os.homedir()` reads one on each.
- **Per-OS packages**: the ripgrep test finds which platform's binary is absent
  rather than assuming, since only the running platform's is installed.
- **The electron-builder stand-in** is a `.cmd` under cmd.exe and a shell script
  elsewhere, because `dist.js` spawns it through the platform's own shell.
- **The app is driven over a loopback socket, never over its stdin.** Electron's
  MAIN process has no usable `process.stdin` on Windows: `electron.exe` is a
  GUI-subsystem binary, and the browser process hands Node a placeholder
  `Readable` that emits `end` immediately instead of the pipe the parent opened.
  Every command written to it is accepted by the parent, delivered to nothing,
  and answered never — while stdOUT on the same process is real, so the app
  announced itself and then ignored every instruction. That is the whole of why
  this suite passed on macOS and failed on Windows, at thirty seconds per
  `evaluate`, with all forty-nine `ui` tests red. `UiTest` listens on 127.0.0.1
  on a port the OS picks and passes it in `MAGENTRA_HARNESS_PORT`;
  `lib/appHarness.cjs` connects back before it does anything else, so even a
  boot that fails can say why. One mechanism on all three platforms, not one per
  OS. (`node tests/lib/…` cannot show this — it needs Electron; the probe that
  established it spawns Electron directly and prints `{"stdinType":"Readable"}`
  followed by `end` before the parent has written a byte.)
- **A temp directory is removed with retries.** Windows keeps one open a moment
  after its process is gone, and `rm`'s `force` only forgives ENOENT, so three
  `ui` tests failed in teardown with EPERM after every assertion had passed.
  `maxRetries`/`retryDelay` forgive EPERM and EBUSY; the final attempt is allowed
  to fail, because a handle the operating system has not finished closing is not
  a defect in the feature under test. A leaked live PROCESS is still reported —
  that check is `stopAll`'s and is unchanged.

`full-screen-can-always-be-left` asserts the ASK, not the grant, and that is a
deliberate line: macOS serialises full-screen transitions across applications,
so a window's actual posture depends on a desktop that is free to refuse — `app/main.js` already treats it that way
and falls back to maximizing. Every route the feature promises (F11, the VIEW
item, the top-strip buttons) is asserted as reaching the window with the right
request, exactly once. Asserting on the grant instead made that file fail
roughly one full run in four, always for a reason that had nothing to do with
the app.

Asserting the ask is also what FOUND a real bug, on 2026-09-12, the first time
these tests could run on Windows at all: one F11 press was recorded as
`[false, true]` — two toggles, so the window never moved. Electron's default
application menu (kept in development and on macOS; `Menu.setApplicationMenu(null)`
runs only for packaged non-mac builds) binds F11 to its own togglefullscreen
role on Windows and Linux, and `app/main.js` was not consuming the key. macOS
binds Ctrl+Cmd+F to that role, which is why the same suite was green on a Mac.
Fixed with `evt.preventDefault()` in the `before-input-event` handler, whose
comment had claimed this route was "handled here rather than through a menu
accelerator" all along. The renderer's half — the strip appearing while full screen — is driven
by delivering `window:fullscreen` on the same channel `app/main.js` pushes it.

Flakiness is treated as a defect in the test, not something to re-run past. Six
were found here and each was fixed at the level the product actually owns, with
every fix re-checked by mutation to confirm it still catches a real break. Two
were not timing at all but SHARED STATE between files: `node --test` ran files
in parallel processes, and three features run the packager, which removes and
rewrites one fixed output directory. `lib/exclusive.ts` is the lock that makes
that a critical section; a fixed pause that was long enough alone and not under
a full run is polled for instead. `--test-concurrency=1` has since removed the
cross-file case outright (see *Running them*), and the lock is kept because it
is also what makes two concurrent RUNS on one machine safe.

What the base enforces, by mechanism rather than by reminder:

| Rule | How |
| --- | --- |
| every test names its record, invariant and `whyItExists` | abstract members — a test missing one does not compile |
| no skip, no soft assert, no expected-failure | `run()` is handed a narrowed `TestRun`, which has no `skip`, `todo` or `plan` |
| **a test asserts something** | `run()` uses the counted `t.assert` it is given; a run that asserts nothing fails, naming the 28 boxes |
| a test agrees with its record | its kind must be one the record declares, its `invariant` must match verbatim, and its id must be listed in the record's `tests` |
| a `pure` test really is pure | the environment and working directory are snapshotted and compared; a test that leaks either fails, because the next test in the process inherits it and fails somewhere else |
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
