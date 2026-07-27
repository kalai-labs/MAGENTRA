# The Briefing proposes a direction, not a plan

CAREFUL MODE's Briefing was built as a plan the user approves, and its third
section demanded a file manifest: *every* file the change would touch, and only
files the agent had actually opened. `CONTEXT.md` recorded that requirement as a
deliberate forcing function — "a Briefing that must name real paths cannot be
written without having opened them, so requiring it makes the Scout Phase read
more than it otherwise would." It worked exactly as designed, and that is the
problem: proving a manifest before approval took around ten minutes, which is
more than the checkpoint is worth.

We reverse it. The Briefing is a **proposal of direction**, not of
implementation: what the user wants, what MAGENTRA suggests, what changes for
them, and what is still unclear. The user approves an understanding. The
decomposition happens after approval, in OVERDRIVE, which already does it
(`TaskCreate`, the working-method prompt section) — so the old design was paying
for planning twice, once badly and expensively before approval and once properly
after.

## Consequences

- **The Scout Phase confirms the target, it does not prove the path.** It reads
  enough to answer the four questions without guessing, and stops. Anything it
  does not know is an Unclear, not a reason to keep reading.
- **The location half of Consequences comes from the import graph**, not from
  the agent. A model that is not asked to produce a file list has no reason to
  invent one, so the highest-hallucination-risk part of the Briefing stops being
  model-authored at all.
- **The word "plan" leaves the prompts.** It is not cosmetic: the approval card,
  the hold's refusal message and the post-approval reminder are all read by the
  model, and "approve this plan" reliably produces a plan. The domain word is
  **Proposal**.
- **The approved proposal becomes input, not history.** It is injected at the
  start of the working phase rather than left buried under the scout's tool
  results. This is what makes CAREFUL worth its cost: the working phase starts
  from an understanding the user has already corrected, which is better input
  than the raw request was.
- If a future reader finds a Scout Phase that never verifies its own file list
  and assumes the feature is unfinished, this ADR is the answer. Adding the
  manifest back reintroduces the ten minutes.
