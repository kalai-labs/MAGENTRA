# The gate: freshness, then connection, then tests

The gateway is named for what it does. It is not a viewer with a run button; it
is the thing that decides whether a test result may be believed. A test suite
run against a stale inventory reports green about features whose code has moved
underneath it — which is precisely the failure that made the old suite worth
deleting.

## Stage 1 — freshness

Every feature record stores the files that implement it (`entryFiles`) plus a
SHA-256 hash of their contents. Before any test runs, the gateway rehashes and
compares.

The mechanism is copied, not invented: `.claude/skills/bigpicture/bigpicture.mjs`
already does this for the architecture document — a rollup hash per record and
per-file hashes so it can name *which* file drifted. Its `hashFiles()` digests
`path + NUL + content`, and its header records why it is content-based and not
mtime-based: two mtime schemes were tried and both failed, one because `tsc -b`
never re-emits an unchanged file, the other because `git checkout` rewrites
mtimes with identical content, so the guard fired on a clean tree and no build
could clear it. **Ask the content, never the clock.**

Drift is not an error in the code. It means a human has not yet confirmed that
the record still describes the feature. Reconciling is a review, then a
re-record.

## Hard block

**Any stale record stops the entire run.** Not the affected feature's tests —
all of them.

An earlier draft proposed per-feature blocking, on the reasoning that one stale
record should not stop 112 features and that a global block trains you to bypass
the gate. That was overruled, and the override is right: a gate you can get a
partial green out of is a gate you will learn to read past. The gateway's value
is that a green result means something. Partial credit destroys that in exchange
for convenience during exactly the moment — a code change in flight — when
precision matters most.

The gate is not bypassable by flag. If it were, the flag would become the
default in every hurry.

## Stage 2 — connection

**No test runs without a connection, whether or not it involves a model.**
Optimising the non-model tiers to run without one was rejected as a false
economy: a model is involved somewhere in nearly every path worth testing, and
two different preconditions for one suite is a rule nobody remembers.

The check mirrors the TUI exactly, because the TUI's behaviour is already the
approved behaviour:

1. **Presence, not reachability.** `tui/src/profiles.ts::workspaceConnected()`
   asks whether the engine could boot here as it stands — a key in the
   environment, a key line in `<ws>/.env`, or a `.magentra/settings.json` naming
   a connection (keyless local servers have no key line at all). There is no
   network probe. The suite therefore still runs offline; a dead endpoint
   surfaces as a test failure, not as a gate failure.
2. **Connected already** → proceed.
3. **Not connected, profiles exist** → offer them, as the TUI's startup picker
   does. Choosing one writes the same two files the IDE writes: the key to
   `<ws>/.env`, the connection to `<ws>/.magentra/settings.json`.
4. **Not connected, no profiles** → refuse, and say where profiles live:
   *no credentials in this folder and no saved profiles (~/.magentra/profiles.json)
   — define one in the MAGENTRA UI first.*

No new connection mechanism is built. The gateway reuses `tui/src/profiles.ts`.
That file is already the second consumer of this logic and the gateway is the
third, which is the signal to promote it out of the terminal frontend and into
the engine; that promotion is recorded as debt here rather than done silently.

## Blocked is not passed

A run that could not execute reports `BLOCKED`, exits non-zero, and names what
it could not verify. A summary can never read green while anything is blocked.
Collapsing "cannot run" into either "pass" or "fail" is a lie in one direction
or the other, and the whole point of the gate is to stop lying about coverage.

## Order

```
trust/connection gate  →  freshness gate  →  tests
        (refuse)              (hard block)     (run)
```

Connection is checked at startup, as the TUI does, not at run time.
