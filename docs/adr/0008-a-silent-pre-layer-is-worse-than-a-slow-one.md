# A silent pre-layer is worse than a slow one

> **Partly superseded — 2026-07-30.** CAREFUL MODE, whose failure prompted this
> record, was removed. The principle and its fix still govern the surviving
> clarify pre-layer: it announces itself before the inference, and the truncated
> reply salvage (`salvageQuestionObjects`, now in `runtime/session.ts`) is what
> keeps a cut-off question round from reading as "nothing to ask".

CAREFUL MODE puts three single-shot inferences in front of a turn: the
predictor, the question round, and the map that grounds them. Each one is
fail-open by design — a broken verdict costs a checkpoint, never the turn. That
is right, and it is also how the mode's worst failure got through.

The report: *"I want to improve existing game"*. No questions were asked. The
scout read the README and a file of constants, took three and a half minutes,
and produced a proposal with English headings over a Turkish body. Four
complaints, three of them the same bug wearing different clothes.

## What actually happened

**The question round was cut off, and the cutoff was indistinguishable from a
decision.** Five questions with four described options each does not fit in
1200 output tokens, least of all in a language that tokenizes worse than
English. The reply ended mid-string. `JSON.parse` failed, the layer returned
`undefined`, and `undefined` means "nothing needed asking" — the same value a
model returns when it genuinely has nothing to ask. The user saw no card, no
banner, and no error. The most open request the mode will ever see went to the
scout unclarified.

**Nothing was shown while it happened.** The two pre-layer round trips emitted
their banner only *after* the inference returned, so the first minute of the
turn was a blank screen. A layer that fails open must still say it ran.

**Two of the four main-loop rounds bought nothing.** The scout announced it was
ready; a reminder then asked it to review its own draft — a draft that did not
exist, because the proposal had not been written yet; a third reminder asked
for the proposal. Each round re-sends the whole conversation to the largest
model in the session.

**The language rule had no anchor.** "Write in the language the user is writing
in" is a comparison the model resolves against whatever it has most recently
read, and it had just spent a phase reading Turkish source comments. The
instruction also offered a literal English sentence as the model answer for the
dependencies section, which was duly pasted, in English, into a Turkish
document.

## Decision

**Fail open, but never fail silently, and never let a length limit look like an
answer.**

1. The question layer gets three defences, because a token budget is a guess and
   this layer's replies are long. Measured: five questions with four described
   options each is ~3.6k characters at the lengths the prompt asks for, and a
   model that writes fuller ones reaches ~6.6k — roughly 1.8k and 3.3k tokens in
   Turkish. The old 1200 could not fit even the disciplined case. So: a budget
   with real headroom; salvage, so a cut-off reply still asks whatever
   completed; and `runInference` now reports its stop reason, so the engine
   *knows* it was cut off rather than inferring it from a failed parse. When
   salvage recovers nothing from a truncated reply, it asks once more and asks
   for less. A well-formed empty answer is never retried — that is a decision,
   not a failure. The same undersized budget and the same silent outcome existed
   in the older clarify pre-layer; it was fixed there too.
2. Every pre-layer announces itself *before* its inference, not after.
3. The proposal format moved into the scout's own system prompt. Its first
   text-only response *is* the proposal, and the three review questions run
   inside that same inference, against the real draft. Two rounds, not four.
4. The user's request is quoted verbatim into both the question prompt and the
   proposal prompt, and the language is decided from that quote alone. No
   English exemplar sentence is offered anywhere for copying.

A fifth change is not a prompt change at all. The engine knows which source
files retrieval ranked and which files were opened, so it can tell — with no
model involved — when a scout is about to describe behaviour it never read. That
fires one reminder naming the ranked files, and never again. It does not block:
a request about documentation genuinely needs no code, and the scout is told to
say so and carry on.

## Consequences

- A truncated pre-layer degrades instead of disappearing.
- The floor is a reminder, not a gate, so it cannot deadlock a turn and cannot
  cost more than one round.
- Recognizing the proposal means counting H1 headings, because they are written
  in the user's language and cannot be matched literally. Four of five is the
  threshold. Ordinary scout deliberation contains no H1 at all.
- The scout's system prompt now varies with the request (it quotes it), so it is
  set per turn rather than once.
- `.claude/skills/bigboycoding/careful-turn-check.mjs` drives whole turns against
  a scripted provider and asserts the round-trip count directly, because the
  regression here is not a wrong answer — it is an extra inference, or a missing
  question card, and neither shows up in a type check.
