# Harness performance — converged state, 2026-08-14

Single entry point for the work on making MAGENTRA's agentic harness faster and
better. Read this first; it reconciles two investigation threads that ran in
parallel and states plainly what is settled, what is not, and what has **not**
been changed.

**Nothing in `engine/` has been modified for performance yet.** Every number
below was measured against MAGENTRA 0.17.3 @ `5e5bf52`, stock.

Companion docs:
- `PERF-DEBUG-FINDINGS.md` — the measurement work, method and per-bucket numbers
- `benchmarks/terminal-bench/COMPARISON-GLM5.md` — the controlled harness comparison
- `benchmarks/terminal-bench/README.md` — how to run either harness

The original `PERF-DEBUG-BRIEF.md` was deleted: it framed the job as explaining a
12-point gap to Terminus, and the control run showed no such gap exists. Its
surviving content is in §2 and §6 here. Recover it from git history if you want
the original wording.

---

## 1. Where we actually stand

| Agent | Terminal-Bench 2.0, all-89 |
|---|---|
| **MAGENTRA** 0.17.3 | **36 / 89 = 40.4%** |
| **Terminus 2** (reference harness) | **34 / 89 = 38.2%** |
| Terminus 2 on GLM 5, published leaderboard | 52.4% ±2.6 |

Identical model (`zai-org/GLM-5`), endpoint (DeepInfra, fp4), task list, k=1.

**This is parity, not a win.** SE at k=1/n=89 is ±5.2 points; one task is 1.12.
A 2-task gap is noise. Exclusive wins split 10 (MAGENTRA) / 9 (Terminus) across
the 84 commonly scored tasks — the harnesses solve *different* tasks.

**Terminus did not reproduce its published 52.4%**, missing by ~14 points under
our serving. Both harnesses landing far below the published row while landing
within 2 points of each other implicates the shared variable — fp4 serving on
this endpoint — not either agent. **Do not treat 52.4% as a target.** The
defensible claim is "level with the reference under identical conditions".

## 2. What is settled, and worth not re-deriving

From 86 trials, 18.04 h of agent wall clock, 1,996 model calls, 2,373 tool calls:

| Bucket | % of wall |
|---|---:|
| Model decode — visible streaming | 41.2% |
| Model decode — **tool-call arguments** | 29.8% |
| Tool execution | 17.4% |
| Prefill / TTFT | 5.4% |
| Idle / stalled / other | 6.2% |

- **Model time is 76.4% of wall. Engine overhead rounds to zero.** There is no
  scheduling-loop bug to find.
- **Prefill and context growth are NOT bottlenecks.** TTFT is ~flat in prompt
  size (1.5 s at 20k → 2.2 s at 130k); decode does not degrade as context grows
  (44.8 tok/s overall). A `contextWindow` A/B would measure noise — don't spend
  tasks on it.
- **`Write` is the dominant controllable cost: 200 calls, 3.22 h = 17.9% of the
  entire benchmark.** Median 31.5 s per call; worst cases decode 30–51 KB of file
  body in a single call (556 s / 48.9 KB on `schemelike-metacircular-eval`). The
  agent re-emits whole files instead of patching.
- Timed-out trials spent **26.3%** of their budget on Write/Edit argument decode
  vs **12.8%** for finishers. The signature is **starvation, not looping** —
  18 of 22 timeouts were killed while actively working, duplicate-command counts
  are low.
- **Timeouts are a shared ceiling, not a MAGENTRA defect**: MAGENTRA 22/86
  (25.6%), Terminus 26/86 (30.2%). A harness that never calls MAGENTRA's `Write`
  stalls at least as often. This **bounds** how much the `Write` fix can be
  worth — it cannot be the sole cause.
- `overfull-hbox` finished its work (`ok: true`, `end_turn`, 4/4 tasks done) at
  888 s against a 750 s limit. Scored 0. The throughput thesis in one trial.

## 3. Known defects, unfixed

1. **No stream watchdog.** `engine/providers/src/openai-compat.ts` has no idle
   timeout, no abort signal, no stall detection — the only `setTimeout` in the
   provider layer is backoff in `retry.ts`. Three trials burned ~8 min of dead
   air each; `torch-pipeline-parallelism` died 1 s in after `model_catalog` and
   never issued a request (guaranteed zero).
2. **`ERR_STREAM_WRITE_AFTER_END`** — the host wrote an NDJSON frame to stdout
   after the stream ended, killing `train-fasttext` ~285 KB of events in. Only
   non-timeout crash in 86 trials. Repro:
   `jobs/tb2-GLM-5-20260810-2311-b14-deepinfra/train-fasttext__3fPVPsM/`.
3. **The agent has no wall-clock awareness.** `feal-linear-cryptanalysis`
   granted a Bash call a 600 s timeout with 477 s of trial budget left.
4. **No guard on runaway reasoning.** `polyglot-rust-c` and `regex-log` each
   spent their entire 900 s on one uninterrupted reasoning stream — ~15k thinking
   tokens, zero tool calls.

## 4. Candidate work, ranked by measured hours recoverable

Not a plan — a menu to be argued with before anything is built.

1. **Stop re-emitting whole files.** 3.22 h in `Write`. Constrain `Write` to new
   files, force `Edit` for modification, and/or cap single-call body size.
   Touches `engine/tools/src/write.ts`, `edit.ts`, and tool-selection guidance in
   `engine/core/src/agent/prompts.ts`.
2. **Stream watchdog** in `openai-compat.ts` — idle deadline that aborts and
   retries. Recovers 3 trials, removes a guaranteed-zero failure mode.
3. **Wall-clock budget in context** so the agent can bound its own tool timeouts
   and choose to ship something verifiable over something perfect.
4. **Cap uninterrupted reasoning.**

Explicitly NOT worth doing on this evidence: context-window A/B, context-growth
work, anything in the scheduling loop.

## 5. Caveats on the comparison — audited, and mostly immaterial

Recorded so nobody has to rediscover them, and so the writeup stays honest.

- **Terminus ran with a wrong context limit.** litellm has no entry for
  `deepinfra/zai-org/GLM-5`, so `harbor/llms/lite_llm.py:156` falls back to
  `1000000` against a real 202,752. MAGENTRA had its true window set explicitly.
  **Audited: 0 real context rejections across all 86 trials** — the asymmetry
  existed but never materialised.
- **Terminus lost 2 tasks to infrastructure**: `qemu-alpine-ssh` and
  `qemu-startup` failed with `Failed to start tmux session` — never attempted.
  MAGENTRA attempted both and scored 0 anyway, so the head-to-head is unaffected.
- **Three Terminus tasks were scored twice** (the run was interrupted mid-batch
  and resumed): `query-optimize` [1,0] kept 1, `regex-log` [0,1] kept 0,
  `raman-fitting` [0,0] no effect. Two k=1 violations in **opposite** directions;
  net zero on the score.
- **Run periods differ**: MAGENTRA 2026-08-10→11 uninterrupted; Terminus
  08-11→13 with an 18 h interruption. Endpoint load is uncontrolled between them,
  and since a quarter of tasks die on the clock, latency variation moves the
  score directly. **This is the largest uncontrolled variable and its direction
  is unknown.**
- The "finish all 22 timeouts → ≈52%" arithmetic is an **upper bound**, not an
  estimate: the timed-out tasks are the long ones, not a random sample.

## 6. Constraints that must hold while implementing

- `engine/*` has **no unit test suite**; `tsc -b` is its only automated gate, and
  it does not see `app/` at all. Read `.claude/skills/bigboycoding` before
  editing, run `blast-radius.mjs` on every target, and write a purpose-built
  `*-check.mjs` for any engine invariant you change.
- Run `bigpicture.mjs impact <file>` before, `check` after; §14/§15 are already
  stale from unrelated uncommitted TUI/app work — don't clear someone else's
  staleness with a blanket `sync`.
- **The benchmark bundle does not rebuild itself.** Check
  `benchmarks/terminal-bench/bundle/version.json` against `git rev-parse --short
  HEAD` before trusting any measured behaviour. This has already caused one
  near-miss (bundle sat at 0.16.9 while HEAD was 0.17.3).
- Re-running the suite costs ~$7–12 and 10–11 h, and **re-downloads ~123 GB of
  task images** (Docker was purged 2026-08-14). Any A/B must justify that.
- A 10-task subset cannot resolve a 5-point effect. Decide the measurement design
  *before* spending a run.

## 7. Evidence locations

```
benchmarks/terminal-bench/jobs/tb2-GLM-5-20260810-2311-b*/   MAGENTRA trials
benchmarks/terminal-bench/jobs/tb2-GLM-5-terminus-2-*/       Terminus trials
    <task>__<id>/agent/magentra-events.ndjson   every frame (MAGENTRA only)
    <task>__<id>/agent/magentra-result.json     usage/turns (clean exit only)
    <task>__<id>/agent/trajectory.json          Terminus equivalent
    <task>__<id>/verifier/reward.txt            0 or 1, Harbor's verifier
    <task>__<id>/exception.txt                  timeout or crash
benchmarks/terminal-bench/tb2-state/*/ledger.json   authoritative scores
```

**Gitignored — do not delete, this is the only copy.** Timed-out trials write no
`magentra-result.json` (clean exit only), so all token and cost totals understate
reality; use the event logs for anything about timeouts.
