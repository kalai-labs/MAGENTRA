# Performance debugging brief — MAGENTRA on Terminal-Bench 2.0

Handoff for a debugging session. Everything here is measured, not inferred.
Source data: `benchmarks/terminal-bench/RESULTS-GLM5-DEEPINFRA.md` (committed)
and `benchmarks/terminal-bench/tb2-state/tb2-GLM-5-20260810-2311/` (gitignored,
still on disk — **do not delete**, it is the only copy of the evidence).

## The result being debugged

MAGENTRA 0.17.3 @ `5e5bf52`, `zai-org/GLM-5` on DeepInfra (fp4), k=1, 86 funded
tasks, 10h51m, $7.10 recorded.

| | |
|---|---|
| Score | **36 / 89 = 40.4%** (leaderboard-comparable) |
| Subset | 36 / 86 = 41.9% (not comparable) |
| Reference | Terminus 2 on GLM 5 = **52.4% ±2.6** (public leaderboard) |
| Prior run | gpt-oss-120b = 20.2% |
| Binomial SE at k=1, n=89 | ±5.2 points |

The ~12-point gap to Terminus is larger than the error bar, so it is real.

## The primary hypothesis: this is a THROUGHPUT problem, not a capability one

**22 of 86 tasks (26%) hit the per-task wall and scored 0 without ever reaching
the verifier.** The agent was still working when Harbor killed it. Harbor's
per-task limits are part of the benchmark (1200s / 2400s / 3600s depending on
task); they were NOT overridden (`-AgentTimeoutSec 0`).

Arithmetic that motivates the whole investigation: the run converted 42% of the
tasks it *finished*. If even half the 22 timed-out tasks had finished at that
rate, the score would be ≈ 40.4% + 5 points ≈ 45%, and all 22 would put it at
≈ 52% — level with Terminus. **Speed, not reasoning, is what is being left on
the table.**

Timed out (all 22):
`break-filter-js-from-html`, `caffe-cifar-10`, `circuit-fibsqrt`,
`compile-compcert`, `dna-assembly`, `feal-differential-cryptanalysis`,
`feal-linear-cryptanalysis`, `fix-code-vulnerability`, `gpt2-codegolf`,
`llm-inference-batching-scheduler`, `make-doom-for-mips`,
`make-mips-interpreter`, `model-extraction-relu-logits`, `overfull-hbox`,
`path-tracing`, `polyglot-rust-c`, `protein-assembly`, `regex-chess`,
`regex-log`, `torch-pipeline-parallelism`, `torch-tensor-parallelism`,
`tune-mjcf`

Counter-evidence worth taking seriously before accepting the hypothesis:
`fix-ocaml-gc` used nearly its full 3600s wall and **won**. Long runtime is not
automatically waste — some tasks are legitimately long. The question is whether
the 22 were *close* to finishing or nowhere near.

## Where the evidence lives

Per-task event logs, the highest-value artifact:

```
benchmarks/terminal-bench/jobs/tb2-GLM-5-20260810-2311-b*/<task>__<id>/
    agent/magentra-events.ndjson   every protocol frame (only on clean exit)
    agent/magentra-result.json     usage/turns/toolCalls/durationMs (clean exit only)
    verifier/reward.txt            0 or 1, written by Harbor's verifier
    exception.txt                  present on timeout or crash
```

**Trap:** the driver writes `magentra-result.json` on clean exit only, so every
timed-out trial has NO result file and reports zero tokens. Timed-out work is
invisible in all token/cost totals — the real spend exceeds $7.10. Use
`magentra-events.ndjson` (which is written incrementally) to study timeouts.

## Questions worth answering, roughly in order of value

1. **Where does the time actually go in a timed-out trial?** Per-turn wall time
   from `magentra-events.ndjson` timestamps: model latency vs tool execution vs
   engine overhead. If it is dominated by model latency, this is a model/serving
   choice, not a harness bug, and no amount of engine work fixes it.
2. **Were the 22 close to done?** Read the tail of each event log. "Nearly
   finished" and "thrashing in a loop" have very different remedies.
3. **Turn efficiency vs Terminus.** A control run of Terminus 2 on the identical
   model/endpoint is running now (see below). Compare turns-to-solve on tasks
   both solved.
4. **Is the agent re-reading context it already has?** 96.9% of input was cache
   reads (41.5M cached vs 1.33M fresh). Cheap, but it still costs *latency* per
   turn. Is the conversation growing faster than it needs to?
5. **Does the `contextWindow` 202,752 setting help or hurt?** It was raised from
   the engine's 128k fallback for this run (see below). Larger windows mean
   larger prompts and slower turns. This is untested either way — an A/B on a
   10-task subset would settle it.

## One confirmed engine bug, unrelated to speed

`train-fasttext` crashed the engine:

```
Error [ERR_STREAM_WRITE_AFTER_END]: write after end
    at Writable.write  ...  engine exited early (code 1, signal none)
```

The host wrote an NDJSON frame to stdout after the stream had ended, ~285 KB of
events into the task. This is the ONLY non-timeout failure in 86 trials. It is a
real defect in the host's stdout handling, not a benchmark artifact. Repro
evidence: `jobs/tb2-GLM-5-20260810-2311-b14-deepinfra/train-fasttext__3fPVPsM/`.

## Context you need before changing anything

- **The engine bundle does not rebuild itself.** `npm run app` never compiles the
  engine, and the benchmark bundle is separate again. Check
  `benchmarks/terminal-bench/bundle/version.json` against `git rev-parse --short
  HEAD` before trusting any behaviour you observe. This already bit once: the
  bundle sat at 0.16.9 while HEAD was 0.17.3.
- **`contextWindowFor()` returns 128k for every model** because
  `MODEL_CONTEXT_WINDOWS` in `engine/core/src/config/pricing.ts` is an empty
  array. `settings.ts` deliberately gives `contextWindow` no env override. The
  benchmark adapter writes it into `~/.magentra/settings.json` gated on
  `MAGENTRA_TB_CONTEXT_WINDOW`.
- Read `.claude/skills/bigboycoding` before editing engine code: `app/` is
  untyped and joined to the engine by bare frame strings, and `engine/*` has no
  unit tests, so `npm run build` passing proves very little.

## The control run (in flight as of this writing)

Terminus 2 — the benchmark authors' reference agent — on the **identical** model
and endpoint, so the agent is the only variable:

```
benchmarks/terminal-bench/tb2-state/tb2-GLM-5-terminus-2-20260811-1941/
```

Interpretation when it lands:

- **lands near 52.4%** → the setup is validated and MAGENTRA's 12-point gap is a
  genuine harness difference worth debugging.
- **lands near 40%** → the gap is the fp4 serving or this endpoint, not the
  harness, and the debugging target changes completely.

Do not start deep engine work until this number exists; it decides what the
target even is.
