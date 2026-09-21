# A `test:llm` run is the `llm` kind alone

Supersedes the ADDITIVE half of [0009](0009-real-model-tests-are-opt-in.md).
Everything else 0009 decided stands unchanged: `llm` tests are still opt-in,
the opt-in is still a variable and a script name rather than a checked-in flag,
and a withheld test is still registered with `{ skip }` so it counts as skipped
and never as passed.

## What was measured

On 2026-09-21, on `fix/fixing-tests-and-build-issue` at v0.19.0, with the engine
freshly built:

```
npm test           558 registered · 499 pass · 59 skipped · 93s
npm run test:llm   558 registered · 499 pass · 59 skipped · 85s
```

The two runs' test-name lists, sorted and compared line by line, are identical —
including the same 59 withheld (51 desktop, 8 packaged-artifact). Neither run
printed the word "real-model". The second command is, today, an 85-second
synonym for the first.

The immediate cause is that **no test extends `LlmTest`**. The class exists at
`tests/lib/llmTest.ts:89`; the only other mention of the name in the repository
is the gateway's mirror map at `tools/magentra-gateway/src/tests.ts:73`. Fifteen
records declare `kinds: ["llm"]` and every one of them carries `"tests": []`.
`a-to-do.txt` §1 tracks that as the LLM track, not started.

That is a gap in the tests, and writing them is a separate piece of work. It is
not what this record decides. What the measurement exposed is that the COMMAND
was built to a shape that would not have served those tests once they existed.

## Why additive was the wrong shape

[0011](0011-ui-tests-are-opt-in.md) made `test:ui` subtractive and left `test:llm`
additive, on this reasoning:

> `test:llm` and `test:artifacts` are ADDITIVE — they run the ordinary suite and
> their own kind on top. Each adds a handful of tests, so the ordinary suite is
> almost free to carry along.

The premise has not survived. The ordinary suite is 499 tests and 85–93 seconds;
"almost free" described a suite that no longer exists. Three consequences follow,
and each is worse for `llm` than it was for `ui`:

1. **The expensive half waits on the cheap half.** An `llm` test is a network
   round trip per model call against a paid endpoint, which is why
   `LlmTest.timeoutMs` is 180s where `ProcTest` gets 60. Making every such run
   pay 90 seconds of local tests first is the delay 0011 removed for `ui`, on a
   command where the wait buys nothing.

2. **A red run stops naming its own cause.** The one question `npm run test:llm`
   exists to answer is whether the model's behaviour still satisfies the
   invariant. With 499 local tests in the same run, a red result is far more
   likely to be a local failure than a model one, and the reader has to sort out
   which — on the one command whose failures are the hardest to reproduce.

3. **It bills nothing and proves nothing twice.** Whoever runs `test:llm` has
   just run, or is about to run, `npm test`. The local suite is re-run for the
   second time in the same sitting, and the endpoint is charged for none of it.

The subject-scoped commands `test:mac` and `test:windows`
([0012](0012-os-tests-are-selected-by-subject.md)) reached the same answer
independently and for the same reason: the point of asking for one slice is not
to run the other five hundred as well.

## The decision

```
npm test           every kind that can prove itself locally. Each `llm` test is
                   reported skipped, named, carrying the command that runs it.
npm run test:llm   the `llm` kind, and nothing else.
```

`MAGENTRA_LLM_TESTS=1` remains the contract and the script name remains the
second signal, both for the `cmd.exe` reason 0009 gives in full. The gate is now
two-way, and reads exactly as `test:ui`'s does:

```
llmOnly && kind !== "llm"   → set aside, reason names `npm test`
!llmOnly && kind === "llm"  → withheld,  reason names `npm run test:llm`
```

### One kind scope per run, and asking for two is an error

`test:ui` and `test:llm` are both SUBTRACTIVE, and they subtract on the same
axis. Asked for together — reachable only by setting both variables, since npm
exports one `npm_lifecycle_event` — the two rules intersect at nothing: a `ui`
test is not `llm`, an `llm` test does not open the app, and every one of the 558
tests would be set aside. The run would report `pass 0` and exit 0.

That is the manufactured green this suite was reset to remove, and this
repository has a feature record named for it. So `kindScopeRequested()` throws
instead, naming both variables. It is the same shape as the duplicate-id throw
already in `registerFeatureTests`: a question the caller has asked incoherently
is answered with an error, not with a winner picked silently.

The OS scope is a different axis and still composes. `platform` selects by
SUBJECT, kind selects by what proving the feature requires. An OS-scoped run is
that OS's WHOLE slice, so a kind scope does not subtract inside it — it unlocks,
which is the same rule that already lets `test:mac` carry `ui` tests and imply
`artifactsEnabled`. `MAGENTRA_MAC_TESTS=1 MAGENTRA_LLM_TESTS=1` is therefore
every mac-subject test with the real-model ones included.

An OS-scoped run on its own still withholds `llm` tests, unchanged from 0009:
`npm run test:mac` must not bill the endpoint just for being asked for an OS.

### No banner in the subtracting direction

`announceWithheld` still fires for the `llm` tests a plain `npm test` withheld —
a handful of files, a handful of banners, and the absence is the thing worth
announcing there.

It deliberately does not fire for the 499 tests a `test:llm` run sets aside.
0011 measured that exact mistake on `ui`: 109 banners in one run, and "a notice
repeated 109 times is not a notice". The per-test `{ skip: <reason> }` names the
command, and the summary counts it under `skipped`. That is the whole of what a
banner was for.

## What it forecloses

- **`npm run test:llm` is no longer a way to run the ordinary suite.** Anyone
  who wants both runs both. This is the point, not a cost.
- **A `test:llm` run with no `llm` tests reports `pass 0 · skipped 558`**, which
  is the honest answer to "run the real-model tests" while there are none. It
  exits 0, because nothing failed; the gap is `FEATURES.md`'s and the gateway's
  to report, and neither has ever claimed a test nobody wrote. That was the
  state for the few hours this record describes: 26 real-model tests landed the
  same day, across 9 of the 15 records, and the command now runs those and
  nothing else in about five minutes.
- **`test:artifacts` stays additive, and is deliberately not changed here.** Its
  8 tests build a real installer and it holds the exclusive lock while doing so;
  whether the local suite should ride along is a question with its own
  measurements, and this record does not pretend to have taken them.
