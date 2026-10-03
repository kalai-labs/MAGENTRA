# No test holds prompt wording

Decided 2026-10-04 by the product owner: *"I actually don't want such tests
that control the prompt exact-match something, remove those tests"*, choosing
"every wording check" over keeping the tool pin or the phrase checks. This
supersedes [0015](0015-approved-artifacts-live-in-tests-approved.md).

It was decided after a release carried four reworded core sections into a red
suite: the pins, the brain baseline and five phrase checks all failed on text
the owner had changed on purpose, and the only way through was a regeneration
command and a hand-edited fixture. The owner's answer was not "make approving
easier" but "the wording is mine, and the suite should not hold it".

## The rule

A test may read a prompt's text, but only from brain: `promptDefault(id)`,
`promptText(id)`, `renderPrompt(id, vars)`, or the engine's own builders
(`addonInvocationHeader`, `environmentBlock`, `SECTION_*`). A test never
writes a prompt's words as a literal, never compares against a stored copy,
and never asserts that a phrase is present. A test that checks which reminder
fired, how often, in which request and with which slots filled finds it
through brain, so it holds the behaviour and survives any rewording.

**How this was verified.** Every word of four letters or more in every
`brain/prompts/**` and `brain/tools/**` body was garbled (outside `{{slots}}`,
parentheses and the facts `assertToolParamStates` checks), the engine was
rebuilt, and the suite was run. Before this change 69 tests failed; after it,
only the dependencies listed below can.

## What is gone

| Where | What |
| --- | --- |
| `tests/features/` | `system-prompt-is-pinned.test.ts`, `tool-wire-contract-is-pinned.test.ts` |
| `tests/approved/` | the whole folder: `system-prompt.txt`, `tools.json` |
| `tests/lib/approved.ts` | the printers and `CANONICAL_ENV` |
| `tools/approvals/regenerate.mjs`, `package.json` | the `approve` script |
| `tests/features/fixtures/brain-baseline/` | the pre-migration prompt catalog and addon-author texts |
| `tests/gateway/features/` | `system-prompt-is-pinned.json`, `tool-wire-contract-is-pinned.json` |
| `tests/gateway/descriptions/ready/` | `8a8c6ad0…json`, `41008d29…json`, whose `featureIds` named only those two |
| `FEATURES.md` | the two *is pinned* rows |
| `brain-is-the-single-source` | the pre-migration text check and `the-wire-pin-still-holds-agent-and-workflow-and-every-pinned-text-is-brains` |
| `honest-gap-outranks-a-manufactured-green` | four tests that asserted what the rungs say in their own words |
| `runtime-evidence-floor` | the vision-clause wording test |
| `brain-controls-behavior`, `prompt-contract`, `system-prompt-assembly` | the claim-phrase presence check, the pinned-prompt comparison, the OVERDRIVE forward-reference phrase, and label checks |
| `tools/brain-editor/` | the pin and baseline holders, the probe's use of `tests/lib/approved.ts`, and the "held by test" chips on prompts and tools |

Twenty-two other test files had a phrase as a locator or a refusal regex.
Those assertions now take their expected text from brain, and the tests stay.
Where a test's name described wording, it was renamed and its record's
`tests` array follows.

## What is deliberately NOT gone

Three places where code depends on a word. Removing their checks would hide a
real break, not a rewording:

- **The self-verify sentinel.** `isSelfVerifyDone()`
  (`engine/core/src/runtime/session.ts`) accepts only `DONE`. The
  `finishing.self-verify` head must tell the model that word, or an OVERDRIVE
  self-check round never ends. One check in `self-check-sharpening` asserts
  the head contains a word the engine accepts, read from the engine.
- **Load-time parameter facts.** `assertToolParamStates()` makes the engine
  refuse to load unless Monitor's `timeout_ms` and PushNotification's
  `message` texts state the values the code uses. That is engine code, not a
  test, and it stays.
- **The compiler's `CLAIMS`** (`tools/brain/compile.mjs`) warn when a knob
  contradicts a phrase. They are warnings, never failures. Their tests write
  the phrase from `CLAIMS` into a temporary brain, so they no longer read
  shipped prose. A claim whose phrase was reworded away now guards nothing,
  silently: the harness clause `if an OVERDRIVE section appears, not even on
  those` was removed on 2026-10-03, and its claim is one such.

Also kept: `tool-registry-contract` still pins the 27 tool names, and
`brain-is-the-single-source` still proves the engine's defaults are a fresh
compile of brain and that every brain file round-trips to its own bytes. Both
are about where text comes from, not what it says.

## Costs accepted with open eyes

- **A tool schema change is no longer caught.** The wire pin also froze each
  tool's JSON Schema: field names, which are required, enum widths. Nothing
  replaces that. A renamed or newly required parameter reaches the model with
  the suite green.
- **A rewording reaches every session with the suite green.** The review moves
  from a red test to the owner reading the diff (AGENTS.md rule 5).
- **One invariant promised wording.** `brain-is-the-single-source`'s
  invariant said the move "changed no byte the model receives". The owner
  reworded it the same day to "…is read from brain/ and nowhere else, and
  Agent and Workflow are withheld by default."

## Putting it back

Revert the commit that carries this file. The pins, their records, the
baseline fixture and the approve script come back with their prose intact.
That is why they were deleted rather than skipped.
