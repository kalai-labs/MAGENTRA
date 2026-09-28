# Real-model tests are opt-in, and counted as skipped

> **Partly superseded by [0013](0013-a-test-llm-run-is-the-llm-kind-alone.md)
> (2026-09-21).** The opt-in, the two signals, and skipped-not-unregistered all
> stand. What changed is the shape of the run: `npm run test:llm` no longer
> means "the same suite, with the real-model tests too" — it runs the `llm` kind
> ALONE. The two commands below are correct except for that line.

`llm` is the sixth kind [0004](0004-tests-inherit-on-kind.md) named and the only
one that was never written. The reason it was never needed is also the reason it
now is: fifteen records declare it, and the product owner has gone through the
engine descriptions marking the ones whose tests a scripted provider cannot
prove — *Tests of this has to be done using real LLM … No need to write any
mockup or scaffold test for this.*

That note is the same standard `FEATURES.md` already set and the 2026-09-09
reset enforced: **a test that asserts a mock returned what the mock was told to
return is not a test.** For a feature whose subject is the model's own behaviour
— whether a reminder changes the next turn, whether a compaction summary kept
what the session needed — `FakeProvider` is exactly that mock. So those tests
need a real endpoint.

A real endpoint is the problem. It costs tokens per turn, it needs a connection
this repository does not carry, and it can fail for a provider's reasons rather
than for a defect here. Making `npm test` do all three would mean the ordinary
gate either costs money on every run or goes red on a fresh clone — and a gate
that is red for reasons nobody owns is a gate people learn to ignore.

## The decision

`llm` tests run only when the user asks for them, in that run.

```
npm test           every other kind. Real-model tests are reported skipped,
                   each one named, with the command that runs it.
npm run test:llm   the same suite, with the real-model tests too.
```

`MAGENTRA_LLM_TESTS=1` is the contract, so CI, a one-off `node --test`, or any
other caller can set it directly. `realModelTestsEnabled()` in
`tests/lib/featureTest.ts` is the only reader.

### The opt-in is a variable, not a file

A checked-in flag was considered and rejected. It would be the state of the
*repository* rather than of one run: ticking it turns real API calls on for
everyone who pulls it, including CI, which has no connection. The thing being
expressed is "I want these now", and that belongs to an invocation.

### It is also `npm_lifecycle_event`, and that is not a second mechanism

The obvious spelling of the script, `"test:llm": "MAGENTRA_LLM_TESTS=1 node
--test …"`, is sh syntax. npm runs scripts through `cmd.exe` on Windows, where
it is not an assignment but a command by that name, which does not exist — and
*every test runs on Windows, macOS and Linux* is a standing promise of this
suite, not an aspiration. The alternatives were a `cross-env` dependency or a
wrapper script that spawns the runner; npm already exports the name of the
script it is running to every child of it, on every platform, so
`realModelTestsEnabled()` reads that too. One question, two ways of being asked.

## Skipped, not unregistered — and the first attempt had this backwards

Not registering a withheld test looks like the stricter answer: nothing
registered cannot read green. It is the opposite, and measuring it is what
showed why. `node:test` reports a file that registers NO tests as **one passing
test — the file itself**. A file of three real-model tests, withheld, printed:

```
✔ tests/features/turn-loop.test.ts
ℹ tests 1 · pass 1 · skipped 0
```

One pass, no assertions behind it: the ticked box with nothing behind it that
the reset removed, reintroduced by the mechanism meant to prevent it.

Registering with `{ skip }` counts them where they belong — `pass 0 ·
skipped 1`, each named in the reporter with its reason:

```
﹣ turn-loop · probe · # needs a real model — not run without MAGENTRA_LLM_TESTS. Run: npm run test:llm
```

### Why this is not the skip rule 4 forbids

tests/README rule 4 and [0004](0004-tests-inherit-on-kind.md) forbid a test
being talked out of failing: no skip, no soft assertion, no expected-failure
state. That rule is about a test quieting **itself**, and it is enforced
structurally — `run()` is handed a `TestRun` with no `skip`, `todo` or `plan`,
and nothing in this change touches that.

The decision here is made once, in the registrar, before any test body exists,
from a question the user answered on the command line. A real-model test the
user DID ask for has no escape hatch whatsoever: it runs, and it fails until the
feature is right.

## What it forecloses

- **`llm` can no longer be part of a record's `covered`** on an ordinary run,
  and that is honest: coverage claimed by a test nobody ran is the claim
  [0007](0007-tests-are-discovered-not-declared.md) removed. `status` derives
  from the FILES, so an `llm` test that exists still counts there; whether it
  *passed* is a run's answer, and the gateway has never claimed to know it.
- **A feature cannot be quietly downgraded to `llm` to stop it running.** Kind
  decides the base class, so retagging is visible in the test file, in the
  record, and in the gateway's REAL-MODEL TESTS view, which lists both signals
  and names every record where they disagree rather than picking a winner.
- **The gateway still does not run tests** ([0006](0006-the-gateway-does-not-run-or-brief.md)).
  It shows which tests need a model and what the command is. It does not hold
  the switch, and there is no route that sets it.

## The mismatch this surfaced

`circular-check-floor` carries the product owner's note and its record declares
`pure`. Both cannot be right: kind is *a claim about what proving the feature
requires* (tests/README), and the note is a claim that this one needs a model.
It is left disagreeing, and named in the view, because re-declaring a record's
kind is a judgement about the feature — not something to settle by string match
while doing something else.
