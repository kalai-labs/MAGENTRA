# Feature inventory — verification result

Built by reading the source, area by area, not by trusting `FEATURES.md`.
Working notes per area: [`inventory-notes/`](inventory-notes/).

## Answer: 112 is an undercount. The exact figure is 164.

`FEATURES.md` declares **112** feature lines across 16 `## ` headings. Reading
the code found three distinct gaps, one of which you already suspected.

| | Features |
| --- | --- |
| Declared in `FEATURES.md` | 112 |
| **Gap 1** — `## Scheduling` is an EMPTY section | +8 |
| **Gap 2** — MAGENTRA's own tooling has no section at all | +13 |
| **Gap 3** — `## Protocol & host` carries 4 lines for the whole wire contract | +6 |
| **Gap 4** — 13 Tools lines covered 27 registered tools (split, 2026-09-09) | +18 |
| **Gap 5** — 7 mirrored app/engine constant pairs, each now its own record | +7 |
| **Verified total** | **164** |

All 164 records are written to `tests/gateway/features/`, one JSON file each,
with a validated entry-file list and a computed freshness hash. Every entry file
was checked to exist; the drift detection was verified to fire on a one-character
change and to clear on restore.

Gaps 4 and 5 were the granularity questions this document previously left open;
they were decided on 2026-09-09 in favour of splitting. Renderer modules were
deferred in the same decision: 9 records carry `deferred: true`, so 155 are
testable now.

---

## Gap 1 — `## Scheduling` exists and is empty

```
    0  Scheduling
```

The heading is in the document with zero feature lines under it, while the code
holds **778 lines** of scheduling (`scheduling/cron.ts` 348, `workflow.ts` 328,
`background.ts` 102, plus the 4 registered cron tools). Some of it is covered
obliquely from the Tools section ("Cron / ScheduleWakeup", "Background task
manager", "Agent / Workflow tools"), but these eight capabilities have no record
anywhere:

1. Cron expression parsing — `parseCron` / `matchesCron` / `nextCronMatch`
2. Idle-gating — a job fires only when the minute matches AND the session is
   idle, never mid-turn
3. Recurring jobs auto-expire 7 days after creation
4. Durability — session-only unless `durable`, and surviving a restart when set
5. Workflow: `meta` must be a PURE literal, parsed before execution
6. Workflow: `pipeline` (no barrier, per-item) vs `parallel` (barrier); a
   throwing stage drops that item to null rather than failing the run
7. Workflow: `schema` validates the agent reply, strips markdown fences, retries
   ONCE, returns null on final failure
8. Workflow: the output-token `budget` is ENFORCED (`agent()` throws at zero),
   with concurrency capped at 4 and total agent calls at 100

## Gap 2 — MAGENTRA's own tooling is absent (your instruction)

You asked for prompt-lab and the version tool to be included. Neither appears in
`FEATURES.md` at all, and both are load-bearing:

**Version tool** (`tools/version/`, ~1,600L) decides every release and writes
every changelog:

9. Semver parse / format / bump / compare / `largestLevel`
10. Conventional-commit checking — 11 types (only `feat` bumps minor), 10 allowed
    scopes, `subjectMaxLength` 72, git-generated messages exempted
11. `makePlan` — the next version derived from a commit range
12. Changelog rendering and prepending
13. `syncTargets` — the version written into **8** package.json files at once
14. Git helpers — `versionTags`, `commitsSince`, `originUrl`, `githubHttpsUrl`,
    `hasUncommittedChanges`
15. The `commit-msg` hook path plus the CI PR-title and commit-range checks

**Prompt registry + Prompt Lab** — the live editing surface for all **43**
registered prompts across 7 groups:

16. `definePrompt` registry — catalog, override, disable, `orphanedPromptFiles`
17. An override `.txt` is re-read live: a prompt change lands on the next turn
    with no restart
18. Emptying a prompt cancels its whole inference round rather than sending a
    blank message
19. Prompt-lab HTTP surface — `/api/catalog`, `/api/events` (SSE),
    `/api/import`, `/api/reset-all`
20. `promote` — writing an override back into the TypeScript source literal
21. Self-write detection, so the lab's own writes do not retrigger its watcher

## Gap 3 — the wire contract has 4 feature lines

`## Protocol & host` carries 4 lines for **30 event types, 24 request types**,
the token algebra, and the framing. These are separately provable and separately
breakable — and this is the seam `tsc` cannot check at all, because `app/`
consumes frames by string:

22. NDJSON framing survives a malformed line (it yields an `error` frame instead
    of killing the transport), plus CRLF and an unterminated trailing line
23. Usage normalization to four DISJOINT classes — OpenAI-compat reports
    `prompt_tokens` as the whole prompt with `cached_tokens` a subset, so the
    adapter must subtract
24. The token algebra as one definition: B(t) never accumulates, output is never
    added, κ=3.5 deliberately under-estimates, `formatTokens` thresholds never
    read backwards across one token (9,949→"9.9k", 9,950→"10k")
25. Reasoning-effort clamping — an unavailable level maps to the nearest, never
    refused and never silently wrong
26. `ConnectionSpec.vision` absent MEANS CLEARED (same rule as `baseUrl`)
27. The slash-command registry ships from the engine so the palette cannot drift

---

## What the reading confirmed, beyond the count

Facts the inventory needs and the docs did not have:

- **27 registered tools**, verified against `createDefaultRegistry()`, in 5
  permission classes (read 9 / mutate 2 / execute 6 / interact 8 / network 2).
  `FEATURES.md` covers them in 13 grouped lines, so tool-level coverage is
  coarser than tool count — grouping `Read / Write / Edit` is defensible, but it
  means one green box can hide two broken tools.
- **10 slash commands**, from one registry that also feeds the frontend palette.
- **24 settings keys**, each with an apply-timing (session / nextTurn / restart /
  clear). The timing note is the only thing telling a user whether their change
  took effect, so a wrong entry is a lie the UI tells.
- **49 preload methods and 36 IPC channels** — the app's whole capability
  boundary.
- **43 registered prompts** in 7 groups, every one overridable at runtime, none
  tested.
- The permission resolution order is exact and load-bearing: **deny rules >
  protected-path guard > deletion guard > allow rules > stance default**, with
  the stance defaulting to ALLOW since 2026-07-26 because what deserves
  confirming is a class of TARGET, not a class of tool.

## Two drift risks found while reading

Neither is a feature; both are things the gateway should record as invariants.

- **`tui/src/protocol.ts` is a hand-copied duplicate of the wire contract** —
  190 lines redefining `PROTOCOL_VERSION`, `CoreEvent`, `FrontendRequest` and
  the rest, with nothing keeping it in step with `engine/protocol`. A second
  definition of the contract this repo calls its most dangerous seam.
- **`tools/prompt-lab/findings.json` has three entries** whose recorded
  rationale is "no change needed — `addon-check.mjs` guards this". That guard was
  deleted in the test reset, so those three decisions now rest on nothing.

## Granularity calls for you

The `~` in ~139 is these. I have counted each as one:

1. **Tool grouping.** Keep `Read / Write / Edit` as one feature (as
   `FEATURES.md` does), or split to 27 tool-level features? Splitting pushes the
   total past 150 and makes coverage honest per tool; grouping keeps the list
   readable. My recommendation: split the ones with distinct invariants (Read's
   image/document/binary paths are three different behaviours), keep genuine
   pairs together.
2. **Mirrored constants.** BIG-PICTURE §16 lists 7 app↔engine literal pairs
   (image types, local-endpoint test, vision key env, default base URL,
   reasoning efforts, theme names, token algebra). Each is a pair `tsc` cannot
   compare and every one is now unguarded. One feature ("mirrored constants
   agree") or seven?
3. **Renderer modules.** 21 modules, 7,459 lines, covered by 26 `Desktop app`
   lines. `math.js` alone is a hand-written 492-line LaTeX→MathML renderer;
   `rain.js` is a 222-line canvas effect. Are these one feature each or several?

Answer those three and the count becomes exact rather than approximate.
