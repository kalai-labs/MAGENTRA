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

A Scout Phase starts from the user's own answers, not from a blank page: the
Unclears are settled before it opens a single file, so its reading is already
pointed somewhere.

A scout phase reads. It does not delegate work, does not record a task plan,
and does not change anything a later step would have to undo.

## Proposal

What the agent shows the user at the end of the Scout Phase, and the only
output of a careful turn before approval. It answers five questions in a fixed
order: the objective, the solution it suggests, the Consequences for this
repository, the Dependencies it would add, and what remains unclear.
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

## Dependencies

The fourth section of a Proposal: anything the app would need that it does not
already ship with. Three kinds count — a new package, a new system requirement
(a binary, a service, a call to the network at runtime), and a new platform
capability the app would come to rely on.

The expected answer is none. MAGENTRA ships what it uses and runs offline, so
adding to that list is a decision the user gets to see before it is made, with
the reason and the licence stated.

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

The three questions the agent puts to its own draft Proposal before sending it:
does it answer the actual request, did it add unasked-for scope, and is anything
in it a guess about the repository. It may improve the draft or leave it exactly
as it is; both are correct outcomes and neither needs defending.

It is not a separate step. It runs inside the same inference that writes the
Proposal, against the real text — as a step of its own it cost a full model
round trip to review a draft that had not been written yet. It reads nothing
new: anything the agent does not know at that point is an Unclear, not a reason
to go back to the repository.

## Finishing Rungs

The checks a turn must climb after the agent has stopped talking and before the
work counts as delivered. There are two, and both rank above the self-check:
the self-check ends the turn where it stands when it passes, so a rung below it
would never run on the turns that go well.

They judge the turn by what it DID, not by what it says it did — which files it
actually changed, and whether it ever executed anything.

## Runtime Evidence Floor

The deterministic check that a turn which rewrote runnable source has observed
the real thing. What it catches is a turn that reads as finished: the code is
written, the explanation is confident, and nothing in it has been seen behaving.

It asks for behaviour and not for ceremony. Compiling is not evidence, and
neither is reading the file back. What counts is a real result the agent can
read — an exit code, a line of output, a value returned, a file the code wrote.

The proof is meant to be thrown away. A one-off run, or a harness written
outside the repository and deleted in the same turn; a permanent test only where
the project already keeps a suite this change belongs in. Growing a test suite
by one file per edit is its own kind of mess.

Editing documentation is not a behaviour change, so it is not asked to prove
anything.

A reminder, never a block, and asked once per shape — the same form, and for the
same reason, as the [[Grounding Floor]].

It has two shapes, because there are two ways to arrive with no real evidence:
nothing was run at all, or something was run and it was a [[Circular Check]].

## Circular Check

A check that agrees with the code because the same understanding wrote both.

Its shape is always the same: the agent needs something it did not write, does
not know its exact contract, assumes one, writes a stand-in from that
assumption, and watches the stand-in agree. The check passes. The assumption is
never touched. The program breaks the first time it meets the real thing.

The stand-in is not the mistake. The mistake is where its contract came from —
memory instead of the dependency. A double written from a contract that was
actually confirmed is an ordinary, useful test.

What makes it worth a rung of its own is that it is invisible to every other
check. A turn with a circular check has run commands, has green output, and
looks better verified than a turn that honestly ran nothing.

## Confirming a Contract

Establishing the exact shape of something the agent did not write — return type,
exception type, units, encoding, bytes or text — from the thing itself rather
than from memory.

It is cheap and it is almost always possible, because a contract can be
confirmed where behaviour cannot: a function that needs a console, a device or a
credential to RUN will still state what it gives back. Importing it and printing
its signature is one command.

Where the answer is "I assumed it", that is the thing to fix, not the code.

## Honest Gap

Naming what could not be verified, and why, as a complete ending to a turn.

It exists so that the floors cannot manufacture the failure they were built to
catch. A rung that demands a passing check, aimed at a dependency this machine
cannot execute, does not produce evidence — it produces a [[Circular Check]],
because standing the dependency in is the cheapest way to go quiet.

So both shapes of the [[Runtime Evidence Floor]] say it outright: an honest gap
is a correct answer, and it outranks a green result that had to be manufactured.
Nothing in MAGENTRA asks a turn to end with a passing check. It asks the turn to
know, and to say, what it actually observed.

## Readability Pass

The optional last look a turn takes at its own diff. A user-thrown switch, off
unless asked for, and the only finishing rung that is.

It asks two questions and no others: is this clean enough to hand over, and is
anything still owed to the user. The first is about the code — names, dead code,
duplication, leftovers. The second is about the handover — an assumption made
for them, scope left out, a limitation, a step they must take themselves.

It runs once, at the end, and never in the middle. Small fixes it makes; anything
larger it names in the wrap-up and leaves alone. A second pass is how a tidy-up
becomes a refactor, so there is no second pass.

Its whole value is that it costs one round trip. A pass that grows past that has
already failed, whatever it found.

## Grounding Floor

The deterministic check that an agent has opened at least one of the source
files retrieval ranked for this request, before it proposes. What it catches is
quiet and looks like success — a scout reads a README, passes its own Stop Test,
and proposes a change to behaviour it never looked at.

A reminder, never a block: it fires once per Proposal, names the ranked files,
and tells the agent to say so and carry on if the work genuinely needs no code.

## Revision

A Proposal the user answered with words instead of a decision. The words are
treated as a requirement rather than a suggestion, the Hold stays raised, and
the agent scouts further and proposes again. Revisions are unlimited.

A Revision re-seeds the map from what the user said, and the Grounding Floor
resets with it: the files that grounded the last Proposal say nothing about
where the new direction lands.

## Unclears

What is still open once the agent has asked the user everything that was
theirs to decide. Named in a Proposal's fourth section, each with the
assumption the agent chose to proceed on.

The questions themselves are put to the user BEFORE the Scout Phase begins.
Their answers do two jobs: they decide what gets built, and they tell the agent
where to look. Asked after the reading they would arrive too late to save any
of it; asked after Approval they would be a question about a direction the user
has already agreed to.
