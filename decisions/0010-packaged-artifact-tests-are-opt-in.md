# Packaged-artifact tests are opt-in, on the switch 0009 already built

Two records are about what `electron-builder` PRODUCES: `windows-artifact` and
`mac-artifact`. Proving either one means running the real packager and then
looking at — or launching — what it wrote. There is no cheaper honest route:
the subject IS the artifact, so a test that inspects `dist.js` instead of the
installer proves the script and not the product, which is the scaffold the
2026-09-09 reset removed.

Running the packager is not like running a test. It takes minutes rather than
milliseconds, it writes hundreds of megabytes into the working tree, and it
holds `tests/lib/exclusive.ts`'s lock for the whole of it, so nothing else in
the suite can run beside it. Putting that in `npm test` would mean the ordinary
gate takes ten minutes and fills a disk — and a gate people stop running is a
gate that stops being true.

That is the same problem [0009](0009-real-model-tests-are-opt-in.md) solved for
`llm`, so this is that decision extended rather than a second one.

## The decision

Packaged-artifact tests run only when the user asks for them, in that run.

```
npm test             every other test. These are reported skipped, each one
                     named, with the command that runs them.
npm run test:artifacts   the same suite, with the packaged-artifact tests too.
```

`MAGENTRA_ARTIFACT_TESTS=1` is the contract, and the script NAME is the second
way of asking, for the reason 0009 spells out: the obvious spelling,
`"test:artifacts": "MAGENTRA_ARTIFACT_TESTS=1 node --test …"`, is sh syntax, and
npm runs scripts through `cmd.exe` on Windows, where it is a command by that
name rather than an assignment. `realArtifactTestsEnabled()` in
`tests/lib/featureTest.ts` is the only reader, and it sits beside
`realModelTestsEnabled()` with the same two signals.

Withheld tests are REGISTERED with `{ skip }` and a named reason, exactly as in
0009 and for the measured reason given there: a file that registers nothing is
reported by `node:test` as one passing test — the file itself.

## A member, not a seventh kind

`artifact` is a `readonly artifact = true` member on the test class, read by the
registrar. It was tempting to make it a kind, and that would have been wrong.

Kind is *a claim about what proving a feature requires* in setup and teardown —
`fs` gets a temp workspace and a redirected HOME, `proc` gets the child-process
lifecycle, `ui` gets Electron and a display. Packaging is none of those. It is a
COST. The two records also need genuinely different kinds from each other:
`windows-artifact` drives a launched app and is `ui`; `mac-artifact` is
`pure`+`fs`+`proc`. Forcing both into an `artifact` kind would have taken away
the setup each one actually needs in order to express a cost that is orthogonal
to it. So each test keeps its honest kind, and the flag says only that the proof
is expensive enough to be asked for.

This also keeps 0004's six kinds closed, and keeps the gateway's kind vocabulary
— which records declare and the discovery cross-checks — unchanged.

## What it forecloses

- **A packaged-artifact test cannot be part of a record's `covered` on an
  ordinary run**, the same honesty 0009 accepted for `llm`. `status` derives
  from the FILES, so the test still counts there; whether it PASSED is a run's
  answer, and the gateway has never claimed to know it.
- **A test cannot be quietly marked `artifact` to stop it running.** The flag is
  a visible member on the class, in a file the gateway parses, and the withheld
  announcement names every test it withheld on every ordinary run. An expensive
  test that stops running stops silently; this one says so, twice.
- **It does not add a second mechanism.** One registrar, one announcer, two
  questions asked the same way. A test that is both `llm` and `artifact` is
  withheld as `llm` first, because that is the check the registrar reaches
  first and either answer is "not in this run".
