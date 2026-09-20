# Desktop-app tests are opt-in, and a `test:ui` run is the ui kind alone

`ui` is the kind that starts a real Electron process
([0004](0004-tests-inherit-on-kind.md)). `tests/lib/uiTest.ts` already says what
that costs: an isolated `--user-data-dir` per test, a display, and seconds per
test rather than milliseconds.

It also already carried the consequence for everybody else. `node --test` runs
test FILES in parallel processes, and with 20 files holding `ui` tests the
default concurrency opened as many desktop apps at once as the machine had
cores — fighting for the display, the GPU and the disk. The fix at the time was
`--test-concurrency=1` in `npm test`. That flag is on the WHOLE suite, so the
508 tests that never open a window pay for the serialisation the 50 that do
require.

Measured on 2026-09-20, on the full suite with the engine freshly built:

```
all 558 tests          206s
the 50 ui tests        123s     59% of the wall clock, 9% of the tests
the other 508          ~68s
```

A gate that takes three and a half minutes is one people stop running before
they push, which is the same failure mode [0009](0009-real-model-tests-are-opt-in.md)
names: a gate nobody runs is a gate that guards nothing.

## The decision

`ui` tests run only when the user asks for them, in that run.

```
npm test         every other kind, ~91s. The ui tests are reported skipped,
                 each one carrying the command that runs it.
npm run test:ui  the ui kind, and nothing else, ~123s.
```

`MAGENTRA_UI_TESTS=1` is the contract, so CI, a one-off `node --test`, or any
other caller can set it directly. `realUiTestsEnabled()` in
`tests/lib/featureTest.ts` is the only reader. The script NAME is the second
signal, for the reason [0009](0009-real-model-tests-are-opt-in.md) gives in
full: `MAGENTRA_UI_TESTS=1 node …` is sh syntax, and npm runs scripts through
`cmd.exe` on Windows.

### This one subtracts, where the other two add

`test:llm` and `test:artifacts` are ADDITIVE — they run the ordinary suite and
their own kind on top. Each adds a handful of tests, so the ordinary suite is
almost free to carry along.

`test:ui` SUBTRACTS: it runs the `ui` kind and sets every other kind aside. The
asymmetry is deliberate. Additive would make `test:ui` the 206s run the split
exists to avoid, and the expensive half would still have no way to be run on its
own — which is the only thing anybody wants the command for. The gate is
therefore two-way, and it is the outermost one in `registerFeatureTests`:

```
uiOnly && kind !== "ui"   → set aside, reason names `npm test`
!uiOnly && kind === "ui"  → withheld,  reason names `npm run test:ui`
```

A `ui` test that is also `artifact` still meets the artifact gate below it. Kind
and cost stay separate questions, exactly as [0010](0010-packaged-artifact-tests-are-opt-in.md)
settled.

### No banner, unlike the other two

`announceWithheld` writes from inside the test file's own process, and every
file is its own process. For `llm` and `artifact` that is invisible. Here the
same code printed 20 banners on an ordinary `npm test` and 109 on a `test:ui`
run — measured, not predicted. A notice repeated 109 times is not a notice.

Nothing is lost by dropping it. Every withheld test is registered with
`{ skip: <reason> }`, the reason names the command that runs it, and the
summary counts it under `skipped` — never under `pass`. That is the whole of
what the banner was for, and it is attached to the individual test rather than
to the file.

### What this does NOT change

`--test-concurrency=1` stays on all four scripts. Dropping it from the default
run is the obvious follow-on and is deliberately not taken here: the `proc`,
`net` and `fs` kinds spawn engines, bind ports and hold `tests/lib/exclusive.ts`,
and whether they are safe in parallel is a separate question with its own
measurements. This decision is about which tests run, not how many at a time.
