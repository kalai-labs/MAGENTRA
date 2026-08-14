# Performance debugging findings — MAGENTRA on Terminal-Bench 2.0

Measured from the per-task event logs in
`benchmarks/terminal-bench/jobs/tb2-GLM-5-20260810-2311-b*/`. 86 trials,
18.04 h of agent wall clock, 1,996 model calls, 2,373 tool calls.

No engine code was changed. Bundle `version.json` reads `5e5bf52`, which is the
SHA the run was produced at, so the evidence is self-consistent.

Method: every event in every `magentra-events.ndjson` was ordered by timestamp
and each inter-event gap attributed to a bucket according to what was in flight
at that moment. Tool-execution intervals are `tool_call_started` →
`tool_call_finished` (merged when parallel). The buckets partition the wall
clock exactly; nothing is double-counted.

---

## Q1 — Where does the wall time actually go?

| Bucket | Hours | % of wall |
|---|---:|---:|
| Model decode — **visible streaming** (thinking + text deltas) | 7.43 | 41.2% |
| Model decode — **tool-call arguments** (no deltas emitted) | 5.37 | 29.8% |
| Tool execution | 3.15 | 17.4% |
| Model prefill / TTFT | 0.98 | 5.4% |
| Idle, stalled, other | 1.11 | 6.2% |

**Model time is 76.4% of the wall clock. Engine overhead is not measurable —
it rounds to zero.** There is no harness bug to find in the scheduling loop.

But the hypothesis as stated ("if it's model latency, engine work won't fix it")
splits in two, because the two model buckets have very different causes.

### Prefill is not the problem, and context size is not the problem

TTFT — measured strictly as `tool_call_finished` → first delta of the next
model call — is small and nearly flat in prompt size:

| Prompt size | n calls | TTFT median | TTFT p90 | decode rate |
|---|---:|---:|---:|---:|
| 0–20k | 534 | 1.5 s | 2.7 s | 31.7 tok/s |
| 20–40k | 758 | 1.5 s | 2.8 s | 50.7 tok/s |
| 40–60k | 306 | 1.9 s | 3.2 s | 50.6 tok/s |
| 60–90k | 280 | 1.9 s | 3.3 s | 51.8 tok/s |
| 90–130k | 114 | 2.2 s | 3.3 s | 58.2 tok/s |

Total prefill across the whole run is 0.98 h — 5.4%. Overall decode is
44.8 tok/s and does **not** degrade as the conversation grows.

This retires two open questions. **Q4 (is the agent re-reading
context it already has?)** — irrelevant to speed. The 96.9% cache-read rate is
doing its job; growing context costs ~0.7 s of extra TTFT between an empty
conversation and a 130k one. **Q5 (does `contextWindow` 202,752 help or hurt?)**
— the feared mechanism ("larger windows mean larger prompts and slower turns")
does not exist in this data. An A/B on that setting would be measuring noise;
don't spend the tasks on it.

### The 30% that *is* addressable: tool-call arguments

`tool_call_started` carries the fully-formed `input` object. The model decodes
those argument tokens with no delta frames in between, so the time lands in a
gap that looks like idle. It isn't — it is decode.

| Tool | Hours | n calls | median gap | median arg size |
|---|---:|---:|---:|---:|
| **Write** | **3.22** | 200 | **31.5 s** | 4,114 B |
| Bash | 1.18 | 986 | 1.7 s | 172 B |
| TaskUpdate | 0.42 | 261 | 1.9 s | 38 B |
| Edit | 0.30 | 125 | 5.8 s | 523 B |
| TaskCreate | 0.13 | 67 | 6.7 s | 188 B |
| Read | 0.08 | 179 | 1.0 s | 55 B |

**200 `Write` calls consumed 3.22 h — 17.9% of the entire benchmark's wall
clock.** The single worst calls decode 30–51 KB of file body in one tool call:

```
 556 s   48.9 KB   Write   schemelike-metacircular-eval
 418 s   38.5 KB   Write   feal-differential-cryptanalysis
 412 s   51.0 KB   Write   distribution-search
 320 s   40.8 KB   Write   make-mips-interpreter
 258 s   35.2 KB   Write   circuit-fibsqrt
```

A nine-minute tool call that produces one file. The agent re-emits whole file
bodies instead of patching, and on a 45 tok/s endpoint that is the dominant
controllable cost in the run.

**So: it is model latency, but not the kind that is out of reach.** Nothing can
be done about the endpoint's tok/s. A great deal can be done about how many
tokens the harness asks it to emit.

---

## Q2 — Were the 22 close to finishing, or thrashing?

Neither, mostly. Comparing each log's span against the Harbor limit named in its
own `exception.txt` (limits vary 750–3600 s per task):

**18 of 22 were killed while actively working** — last event within ~90 s of the
wall. **4 went silent long before the wall**, which is a different bug entirely.

They were not thrashing. Duplicate-command counts are low (median 3 repeated
Bash invocations per trial; only `llm-inference-batching-scheduler` at 17 and
`overfull-hbox` at 13 look repetitive). The signature is **starvation, not
looping**: forward progress at too few tool calls per minute.

The decisive contrast:

| | wall | Write/Edit arg decode |
|---|---:|---:|
| Timed-out trials | 8.89 h | **2.33 h (26.3%)** |
| Finished trials | 9.16 h | 1.18 h (12.8%) |

Trials that died spent **twice the share** of their budget emitting file text as
trials that finished. Per-trial, it is stark:

```
regex-chess                        36.9 min of 59.3 min wall   62.3%
llm-inference-batching-scheduler   19.4 min of 30.2 min wall   64.2%
dna-assembly                       13.9 min of 30.2 min wall   45.9%
make-mips-interpreter              12.9 min of 31.1 min wall   41.5%
feal-differential-cryptanalysis    12.4 min of 31.4 min wall   39.4%
```

`feal-differential-cryptanalysis` managed **7 tool calls in 31 minutes**. It was
not stuck — it was typing.

### The strongest single data point

`overfull-hbox` wrote `magentra-result.json` with `ok: true`,
`stopReason: "end_turn"`, and a task list reading **4 of 4 completed** — at
888 s against a **750 s** limit. It finished the work and lost the trial by
138 seconds. It scores 0.

That is the throughput hypothesis in one trial.

### Four trials that are a different bug — silent, not killed

| Task | Limit | Log span | Silent for | What the tail shows |
|---|---:|---:|---:|---|
| `torch-pipeline-parallelism` | 900 s | 1 s | 899 s | Died after `model_catalog`. Never issued a single request. Total loss. |
| `fix-code-vulnerability` | 900 s | 331 s | 569 s | Mid-sentence in a `text_delta` stream, then nothing. |
| `tune-mjcf` | 900 s | 478 s | 422 s | Mid-`thinking_delta` ("Let me research"), then nothing. |
| `feal-linear-cryptanalysis` | 1800 s | 1323 s | 477 s | `Bash` started with `timeout: 600000` running `gcc -O3 -o attack && ./attack`, never returned. |

The first three are stream stalls. `engine/providers/src/openai-compat.ts` has
**no idle timeout, no abort signal, and no stall watchdog** — I grepped it; the
only `setTimeout` in the provider layer is in `retry.ts`, for backoff. If the
SSE stream stalls, nothing reclaims it and the trial burns to the wall in
silence. Three trials × ~8 min of dead air, and one that never started.

The fourth is not a hang: the agent granted a Bash call a 600 s timeout with
477 s of trial budget left. **The agent has no awareness of the wall clock.**

### Two trials never called a tool at all

`polyglot-rust-c` and `regex-log` each consumed their **entire 900 s** producing
one uninterrupted reasoning stream — ~15k thinking tokens, 19,010 and 21,218
output tokens respectively, zero tool calls. Both tails show the model still
circling ("Let me try another…", "Wait, there's an issue with precedence"). This
is GLM-5 reasoning runaway, and MAGENTRA has no guard against it.

---

## What the evidence supports

The throughput hypothesis holds, with a sharper target than "throughput". Ranked by
measured hours recoverable:

1. **Stop re-emitting whole files.** 3.22 h in `Write`, 26.3% of the timed-out
   trials' budgets. Constrain `Write` to new files and force `Edit` for
   modification, and/or cap single-call body size. `engine/tools/src/write.ts`,
   `engine/tools/src/edit.ts`, plus the tool-selection guidance in
   `engine/core/src/agent/prompts.ts`. This is the whole ballgame.
2. **Add a stream watchdog** to `engine/providers/src/openai-compat.ts` — an
   idle deadline that aborts and retries. Recovers 3 trials outright and stops
   the failure mode that makes `torch-pipeline-parallelism` a guaranteed zero.
3. **Give the agent a wall-clock budget.** It set a 600 s Bash timeout with
   477 s left. A remaining-time signal in context would also let it choose to
   ship something verifiable rather than perfect.
4. **Cap uninterrupted reasoning.** Two trials spent 900 s thinking without
   acting.

Not worth doing, on this evidence: context-window A/B (Q5), context-growth work
(Q4), and anything in the scheduling loop — engine overhead is unmeasurable.

## Resolved after this document was written

The Terminus 2 control run — unavailable when the above was measured — has since
landed: **34/89 = 38.2%** against MAGENTRA's 36/89 = 40.4%, and Terminus timed
out on **26/86 (30.2%)** against MAGENTRA's 22 (25.6%).

This does not change any measurement here, but it **bounds the conclusions**. A
harness that never calls MAGENTRA's `Write` hits the wall at least as often, so
whole-file re-emission cannot be the sole cause of the timeout ceiling — some of
it is the endpoint's decode rate, which no harness change reaches. Size any
expected gain from item 1 against that, and do not treat Terminus's published
52.4% as a target: it did not reproduce here.

The 42%-conversion arithmetic ("finish all 22 → ≈52%") assumes the timed-out
tasks are of average difficulty. They are not a random sample — they are the long
ones. Read it as an upper bound, not an estimate.

See `HARNESS-PERF-STATE.md` for the reconciled picture and the comparison's
audited caveats.
