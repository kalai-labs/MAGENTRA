# The Scout Phase has no hard cap

A numeric cap on the Scout Phase's tool rounds is the obvious fix for a phase
that once ran for ten minutes, and it is the one guaranteed to work: at N
rounds, force the Briefing. We deliberately did not do it.

A cap cuts mid-work. The scout stopped at round N has read part of what it
needed and none of the rest, and it then writes a Briefing from a half-formed
picture — confidently, because nothing in the Briefing's four sections says
"I was interrupted". A wrong understanding that the user approves is worse than
a slow one they wait for, and CAREFUL MODE exists to stop exactly that.

Instead the phase is bounded by two things that never interrupt it:

1. **A stop test in the prompt.** Not "when you have investigated enough" (a
   feeling) but a checkable condition: *stop when you can answer all four
   questions without guessing; you do not need to know which files you will
   change.* The old prompt had no test, which is why nothing ever told it to
   stop.
2. **A soft warn.** After N rounds the engine injects one `remind()` — the same
   teaching shape already used before the iteration cap in `runTurn` — saying
   the agent has read a lot and that anything still unknown belongs in the
   Unclear section. The model finishes its own round and decides. Nothing is
   cut.

The real cause of the ten minutes was removed separately: the Briefing no
longer promises a file manifest (ADR 0003), so the scout no longer has to open
every file it intends to name.

## Consequences

- The bound is persuasion plus evidence, not enforcement. If the prompt is
  weakened, the slow behaviour can return — the scout prompt is load-bearing
  and must be edited with that in mind.
- Running long is visible rather than silent: the phase banners mark each step,
  and whatever the scout could not check appears in the Briefing's fourth
  section instead of being quietly dropped.
- If a future reader finds an unbounded phase and assumes a cap was forgotten,
  this ADR is the answer. A cap would trade a slow correct understanding for a
  fast wrong one.
