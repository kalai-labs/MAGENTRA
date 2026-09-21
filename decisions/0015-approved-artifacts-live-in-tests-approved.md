# An approved artifact is a committed file, and only a person moves it

Some things the product produces are too large to assert a property of and too
important to leave unasserted. The standing system prompt is 89 lines; the tool
registry's wire contract is 923. The suite already pinned how MANY prompts
exist and the ORDER the nine sections compose in. Nothing pinned what any of
them said, so rewording a behaviour section changed every session's
instructions and left the whole suite green.

## The decision

An **approved artifact** is a committed file holding the exact bytes some part
of the product produces. A test renders the same thing and compares byte for
byte. A mismatch is not a number to adjust — it is a diff a person reads.

```
tests/approved/<feature-id>/<artifact>
```

Two exist: `system-prompt-is-pinned/system-prompt.txt` and
`tool-wire-contract-is-pinned/tools.json`.

This is the only place in `tests/` that holds something other than a test, and
that is the reason this record exists rather than the convention appearing in a
commit unannounced.

## Why a byte-for-byte snapshot is right here and wrong almost everywhere else

Khorikov's second pillar is resistance to refactoring, and *Software
Engineering at Google* devotes a chapter to not writing change detectors. A
snapshot usually earns that criticism, because it pins implementation detail
and goes red when nothing broke.

These two do not, because **the artifact is the observable behaviour**. The
literal text of the system prompt and the literal JSON Schema of each tool are
what leaves the process. There is no implementation underneath them to refactor
independently. Hyrum's law applies to a model as it applies to any caller: with
enough use, every observable detail of these is something the model's behaviour
already depends on.

The test for a property would be weaker, not stronger. "The prompt mentions
OVERDRIVE" passes for a prompt that has been rewritten around it.

## No self-approval, and this is the load-bearing part

The usual approval-test design offers an escape hatch — `APPROVE=1 npm test`
rewrites the expectation in place. **There is none here, deliberately.**

This repository is developed with coding agents. An agent that reworded the
prompt, hit a red test and found an environment variable that turns red into
green would use it, report success, and leave behind a file that costs disk and
proves nothing. The failure mode is specific, likely, and fatal to the whole
idea.

So:

- `tests/lib/approved.ts` holds the printers and **never writes**. Its only
  `node:fs` import is `readFileSync`.
- `npm run approve` (`tools/approvals/regenerate.mjs`) is the only writer, and
  a person runs it.
- Running it approves nothing by itself. It moves the bytes; **the approval is
  the diff in the commit.**
- `system-prompt-is-pinned`'s item 5 asserts this mechanically: neither test
  file nor the printer may name a write API. It reads its own source to do it.

## One printer, not two

The regeneration command imports the same functions the tests call. A generator
that renders the artifact one way and a test that renders it another is a
mirrored pair, and this repository already knows what those cost — BIG-PICTURE
§16 names the pattern, and `engine/protocol` ↔ `app/main/config.js` is the
standing example. The pair agrees the day it is written and stops agreeing
later, at which point the artifact pins nothing and the test still passes.

## Two costs accepted with open eyes

**Overrides.** `promptsDir()` is `MAGENTRA_PROMPTS_DIR` when set and
`~/.magentra/prompts` otherwise, so prompt overrides are global to the user and
need no environment variable to be live. A developer who had tuned one prompt
would otherwise regenerate the artifact from their own tuning and commit it as
the product's default. Both the test and the regeneration command refuse when
any prompt is overridden, and name it.

**zod.** `z.toJSONSchema` output can shift between zod minor versions. That
arrives as a one-off diff to re-approve, not a regression. The product owner
accepted this on 2026-09-21 before the tests were written.

## What proves it

Both features were revert-verified on 2026-09-21, the discipline tests/README
requires. Rewording one sentence of the identity section failed
`the-canonical-render-is-byte-identical-to-the-approved-artifact` and nothing
else, naming line 2 and printing both sides. Changing one `.describe()` inside
`readTool`'s zod schema failed
`the-rendered-contract-is-byte-identical-to-the-approved-artifact` and nothing
else, naming `Read`. Both sources were restored and rebuilt.
