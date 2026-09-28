# `deferred` means "not required", not "not allowed"

Nine of the approved descriptions name features whose entry files all sit under
`app/renderer/`. The schema sets `deferred: true` on exactly those, by rule —
and `tests/lib/featureTest.ts` was refusing to run any test written for one,
with the message that removing the flag was a decision to be made first.

That refusal was wrong, and it was mine. SPEC §2.1 says a deferred feature
"carries no test expectation yet" and "never counts against coverage". Neither
sentence forbids a test. The rule turned a flag that is *derived from a
record's entry files* into a prohibition, so a description the user had
explicitly approved could not be implemented — by a check nobody had asked for.

## What changes

`inventoryLinkageProblems` no longer treats `deferred` as a problem. Everything
else about the flag is untouched: it is still set by rule and cannot be
hand-cleared (schema.ts), a deferred feature still never counts against
coverage, and the 2026-09-09 decision that renderer modules were out of scope
*at that stage* stands as the record of why they were not done then.

## Why this is not the renderer quietly coming into scope

It is the renderer coming into scope, and it was decided in the ordinary way:
the user marked those nine descriptions `ready`, which §2.2 defines as "the user
has read it and it is the test procedure a coding agent should implement", and
then asked for them. `ready` is the explicit user action the whole status exists
to require. Nothing here promotes a feature on its own.

The practical objection — that renderer modules are hard to reach — turned out
not to hold. They are loaded by the real page as classic scripts, so they cannot
be imported, but they are perfectly drivable in the running app: three features
already proven (`full-screen-can-always-be-left`, `permission-prompt`,
`setup-wizard`) assert against `app/renderer/modules/*.js` through the real DOM.
Those records were never deferred only because they ALSO name a file outside
`app/renderer/` — which is a fact about their entry lists, not about how hard
they are to test.

## What a renderer test must still not do

The `ui` kind runs the real app and drives the real page. A renderer test may
read the DOM the product built and click the controls the product wired, and it
may deliver an event on the same channel `app/main.js` delivers it on. It may
not reach inside a module for a function the page does not expose, and it may
not add anything to the product to make itself possible — the note at the top of
`tests/lib/appHarness.cjs` records what that cost the last time.
