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
state the direction it proposes, and get the user's approval of that direction —
after which it proceeds with OVERDRIVE's full autonomy.

It is not a third stance and not a retreat from OVERDRIVE. OVERDRIVE removes
approval from every *action*; CAREFUL MODE adds approval back at exactly one
*decision* — which direction to take — and nowhere else.

## Scout Phase

The part of a careful turn before approval, in which the agent may look but not
touch. Its purpose is to make the Proposal correct: the agent confirms what the
request means and where in the repository it lands, so that what the user
approves is a real understanding and not a guess.

It confirms the target. It does not prove the path — no file manifest, no
impact analysis, no decomposition. That work belongs after approval, where
OVERDRIVE already does it.

A scout phase reads. It does not delegate work, does not record a task plan,
and does not change anything a later step would have to undo.

## Proposal

What the agent shows the user at the end of the Scout Phase, and the only
output of a careful turn before approval. It answers four questions in a fixed
order: the objective, the solution it suggests, the Consequences for this
repository, and what remains unclear.
_Avoid_: plan, briefing

A Proposal is of DIRECTION, not of implementation. The user approves that the
agent read the request correctly and is pointed the right way — not a
decomposition, a task list, or a promised diff. Those come after approval.

"Plan" is the word this is not. A plan needs an ordered decomposition and the
files it will touch, and demanding those before approval is what made the first
version of this feature unusable.

It describes work that has not happened yet, and it is written in Plain Speech.

## Plain Speech

The style the agent writes to the user in: short sentences, one idea each,
common words, active voice.

It is a style, never a language. It follows whatever language the user writes
in — plain Turkish for a Turkish user, plain English for an English one.

## Consequences

The third section of a Proposal, and the one that carries its weight. Not a
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
2. **Where it lands** — which part of the repository the work falls in. Derived
   from the import graph rather than claimed by the agent, so it states what the
   repository contains and never what the agent assumes it contains.

Effects come first because the user reads to decide, and the decision is about
effects. Location is context for that decision, not a promise about the diff.

## Hold

The state a session is in during a Scout Phase: able to read, unable to change
anything. A hold is enforced, not requested — the distinction matters, because
CAREFUL MODE lives inside a stance whose whole meaning is that nothing asks.

A hold is lifted by Approval, by cancellation, or by the turn ending for any
reason at all. It never outlives the turn that raised it.

## Approval

The user's decision on a Proposal. Work that changes the repository may not
begin without it. Silence is not approval: an unanswered or interrupted gate
cancels.

## Review Pass

One silent look the agent takes at its own draft Proposal before showing it.
It may improve the draft or leave it exactly as it is; both are correct
outcomes and neither needs defending.

It happens once, on the first Proposal of a turn, and it reads nothing new —
anything the agent does not know at that point is an Unclear, not a reason to
go back to the repository.

## Revision

A Proposal the user answered with words instead of a decision. The words are
treated as a requirement rather than a suggestion, the Hold stays raised, and
the agent scouts further and proposes again. Revisions are unlimited.

A Revision gets no Review Pass. The Review Pass substitutes for the user's
judgement; once they have supplied it, the substitute is waste.

## Unclears

What is still open once the agent has asked the user everything that was
theirs to decide. Named in a Proposal's fourth section, each with the
assumption the agent chose to proceed on.

The questions themselves are put to the user BEFORE the Proposal is written,
never after it is approved. A question whose answer would change what gets
built cannot be asked after the user has approved what gets built — by then
they have approved a direction chosen on a question they never answered.
