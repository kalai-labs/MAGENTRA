# An OS-specific test is selected by subject, not excused by platform

[0011](0011-ui-tests-are-opt-in.md) split the suite by KIND. This splits it by
the operating system a test is ABOUT, and the distinction that makes it safe is
that those are two different questions from "which OS am I on".

## The rule that does not change

`tests/README.md`: *each platform-specific fact is asserted as what THAT
platform can express, never skipped where it cannot.* The Linux launcher test
asserts, on Windows, that packaging produces no wrapper — the Windows truth,
not a skipped Linux one. That convention stays exactly as it was, and this
decision does not give any test a way out of it.

One test had already stepped outside it. `tty-dispatch ·
windows-prefers-a-sibling-magentra-exe-over-its-own-execpath` opened with:

```ts
t.assert.equal(process.platform, "win32", "this checklist item's platform branch — recorded, not assumed");
```

which is permanently red on macOS and Linux. A red nobody can act on is not a
gap being stated; it is a result being ignored, and it trains people to read a
red suite as normal. The product's branch is
`process.platform === 'win32' && existsSync(sibling)`, and that branch has a
fact for every OS: on Windows the sibling `MAGENTRA.exe` must be preferred, and
everywhere else it must be IGNORED — a handoff that ran a `.exe` on macOS would
be executing a binary the OS cannot run. Both halves are now asserted, so the
test proves something wherever it runs.

## The decision

A test may declare the OS its SUBJECT belongs to:

```ts
override readonly platform = "darwin" as const;
```

`platform` selects; it never excuses. A `darwin`-tagged test still runs on
Windows in an ordinary `npm test` and still has to assert the Windows truth
there. What the tag buys is a way to ask for one OS's tests by name:

```
npm run test:mac       the tests whose subject is macOS, and nothing else
npm run test:windows   the same for Windows
```

`MAGENTRA_MAC_TESTS=1` / `MAGENTRA_WINDOWS_TESTS=1` are the contracts, with the
script name as the second signal, for the `cmd.exe` reason
[0009](0009-real-model-tests-are-opt-in.md) gives in full. Linux has no script
yet, deliberately: nobody has asked for one, and `linux-artifact.test.ts`
already branches internally.

### Subtractive, and it implies the artifact opt-in

Like `test:ui` and unlike `test:llm`, these SUBTRACT: `npm run test:mac` runs
the mac-subject tests alone. They also imply `MAGENTRA_ARTIFACT_TESTS`, because
the mac-subject tests ARE the expensive ones — they run the real packager and
launch the dmg — and a `test:mac` that packaged nothing would do nothing at all.

### Asking for an OS you are not on is neither an error nor a green

`npm run test:windows` on a Mac selects the Windows-subject tests and then
withholds every one of them:

```
﹣ windows-artifact · the-build-produces-both-the-portable-exe-and-the-nsis-installer
  # needs Windows — this machine is macOS. Run it on Windows.
ℹ pass 0   fail 0
```

`pass 0` is the honest number. Exiting green on a machine that proved nothing
is the manufactured green this repository has a feature named after
(`honest-gap-outranks-a-manufactured-green`), and a non-zero exit would be
worse: it would report a defect where there is only a machine.

### What is NOT tagged

The `ci-smoke-…` tests in `mac-artifact` and `windows-artifact` read
`.github/workflows/release.yml` and assert that the release leg launches what it
packaged. A file read is not an OS-specific fact — those tests are correct on
every platform, so they stay untagged and keep running in the ordinary suite on
all three. Tagging them would have hidden a deliberate product-owner red behind
the operating system, which is precisely the failure this decision is written to
avoid.
