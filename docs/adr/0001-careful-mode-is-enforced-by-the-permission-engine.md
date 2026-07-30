# CAREFUL MODE is enforced by the permission engine, not by the system prompt

> **Superseded — 2026-07-30.** CAREFUL MODE was removed from the product. This record is kept for the reasoning; the code it describes no longer exists.

CAREFUL MODE asks the agent to investigate, propose a plan, and wait for the
user's approval before changing anything. The obvious implementation is a
system-prompt section saying so — MAGENTRA steers behaviour that way everywhere
else, and it costs nothing. We instead added a hold to `PermissionEngine` that
refuses every tool outside a small reading allowlist until approval arrives.

The reason is that CAREFUL MODE only exists inside OVERDRIVE, and OVERDRIVE
means *nothing asks*. A prompt-level "do not edit yet" is a request; the one
thing OVERDRIVE guarantees is that a model which ignores such a request meets no
obstacle. The failure mode is not theoretical or cosmetic — it is the agent
rewriting the user's repository before they have seen the plan they were
supposed to approve, in the one stance where no other guard would have stopped
it. A gate that holds only when the model cooperates is not a gate, and the
whole feature is the gate.

## Consequences

- The hold sits after the user's own deny rules and ahead of everything else, so
  it beats allow rules, `allow_always` grants, session allows, and the allow-all
  stance. A user who has granted `Bash` broadly still gets a scout that cannot
  run commands.
- It covers subagents for free, because `Session` hands children the parent's
  `PermissionEngine` instance. A held session cannot spawn an unheld child.
- Every refusal must teach rather than just deny. A bare "permission denied"
  reads to the model as a broken tool and gets retried until the turn stalls, so
  `carefulHoldMessage` states what is available, why, and when it lifts.
- The hold is turn-scoped state on a long-lived object, which makes leaking it
  the real risk: a hold that survives its turn locks the session out of writing
  anything with no way back. `runTurn`'s `finally` lifts it unconditionally, and
  that is load-bearing, not defensive.
- `engine/*` has no unit suite and `tsc` cannot see any of this, so the
  invariants are asserted directly against the built output by
  `.claude/skills/bigboycoding/careful-hold-check.mjs`. Changing the allowlist or
  the resolution order without running it is how this quietly stops working.
