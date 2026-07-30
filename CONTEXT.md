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

## Plain Speech

The style the agent writes to the user in: short sentences, one idea each,
common words, active voice.

It is a style, never a language. It follows whatever language the user writes
in — plain Turkish for a Turkish user, plain English for an English one.

## Finishing Rungs

The checks a turn must climb after the agent has stopped talking and before the
work counts as delivered. They all rank above the self-check: the self-check
ends the turn where it stands when it passes, so a rung below it would never run
on the turns that go well.

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

A reminder, never a block, and asked once per shape.

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

