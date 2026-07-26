# Context

The ubiquitous language of MAGENTRA. A glossary, not a spec — no implementation
details, no decisions. Decisions live in `docs/adr/`.

## Stance

A session-scoped posture that changes how much the agent asks before it acts.
Stances are user-thrown switches, never inferred. A session has exactly one
stance at a time.

## OVERDRIVE

The fully-autonomous **stance**: nothing asks. Deletions at any path, edits to
protected files, and writes outside the workspace all run the moment the agent
decides on them; only a deny rule the user wrote themselves still refuses. In
exchange the turn may not end until it has verified its own work against the
original request.

## CAREFUL MODE

A modifier available **inside OVERDRIVE** that reinstates exactly one
checkpoint: before a request that needs real work, the agent must investigate,
decide on an approach, and get the user's approval of that approach — after
which it proceeds with OVERDRIVE's full autonomy.

It is not a third stance and not a retreat from OVERDRIVE. OVERDRIVE removes
approval from every *action*; CAREFUL MODE adds approval back at exactly one
*decision* — which approach to take — and nowhere else.

## Scout Phase

The part of a careful turn before approval, in which the agent may look but not
touch. Its purpose is to make the Briefing honest: consequences stated from
what the repository actually contains, not from a guess about it.

A scout phase reads. It does not delegate work, does not record a task plan,
and does not change anything a later step would have to undo.

## Briefing

What the agent shows the user at the end of the Scout Phase, and the only
output of a careful turn before approval. It answers four questions in a fixed
order: the objective, the proposed solution, the Consequences for this
repository, and what remains unclear.

The Briefing is a proposal, not a report. It describes work that has not
happened yet.

## Consequences

The third section of a Briefing, and the one that carries its weight. Not a
description of the work — a description of *what will be true afterwards that
is not true now*.

Consequences are itemized and deliberately restate the proposed solution in the
user's terms rather than the agent's: a reader who skipped the solution section
should still learn here what the agent is about to do and what they will be
left with.

They come in two halves, always in this order:

1. **What changes for you** — plain language, no paths. What the product will
   do that it does not do now, what the user will be able to do that they could
   not, what will feel different, what will break. On a purely internal change
   this half says so plainly rather than being omitted.
2. **What will be touched** — the concrete prediction: which files change, which
   files are new, which scripts appear. Named paths, not descriptions of areas.

The second half is not documentation of the first. It is a forcing function: a
Briefing that must name real paths cannot be written without having opened
them, so requiring it makes the Scout Phase read more than it otherwise would.

Effects come first because the user reads to decide, and the decision is about
effects. Paths are the evidence, and evidence follows the claim.

## Hold

The state a session is in during a Scout Phase: able to read, unable to change
anything. A hold is enforced, not requested — the distinction matters, because
CAREFUL MODE lives inside a stance whose whole meaning is that nothing asks.

A hold is lifted by Approval, by cancellation, or by the turn ending for any
reason at all. It never outlives the turn that raised it.

## Approval

The user's decision on a Briefing. Work that changes the repository may not
begin without it. Silence is not approval: an unanswered or interrupted gate
cancels.

## Revision

A Briefing the user answered with words instead of a decision. The words are
treated as a requirement rather than a suggestion, the Hold stays raised, and
the agent scouts further and briefs again. Revisions are unlimited.

Each Revision costs the agent one round of self-critique, to a floor of none.
Self-critique substitutes for the user's judgement; once they have supplied it,
the substitute is waste.

## Unclears

The open questions a Briefing names in its fourth section. They are raised in
the Briefing but not answered there — the user approves the approach first,
and only then are the unclears put to them as questions.
