# MAGENTRA vs Terminus 2 on Terminal-Bench 2.0 — same model, same endpoint

A controlled harness comparison. The agent is the only variable: identical
model (`zai-org/GLM-5`), identical endpoint (DeepInfra, fp4), identical task
list, identical k=1, same week. Per-run detail in
`RESULTS-GLM5-DEEPINFRA.md` and `RESULTS-TERMINUS2-GLM5.md`; both are generated
from the verifier ledgers, not hand-entered.

## Headline

| Agent | Score (all-89, leaderboard-comparable) |
|---|---|
| **MAGENTRA** 0.17.3 @ `5e5bf52` | **36 / 89 = 40.4%** |
| **Terminus 2** (reference harness) | **34 / 89 = 38.2%** |
| Terminus 2 on GLM 5, published leaderboard | 52.4% ±2.6 |

At k=1 over 89 tasks the binomial standard error is ±5.2 points, and a single
task is worth 1.12. **A 2-task gap is well inside the noise: MAGENTRA and
Terminus 2 are indistinguishable on this evidence.** The honest claim is parity,
not victory.

## The finding that matters: neither harness reproduced 52.4%

Terminus 2 is the benchmark authors' own reference agent, run at its documented
defaults. Under our serving conditions it scored **38.2%**, roughly 14 points
below its published 52.4% — a gap far outside the ±2.6 the leaderboard reports.

Both harnesses landing ~12–14 points below the published figure, while landing
within 2 points of *each other*, points at the shared variable rather than at
either agent. The published row was not obtained on DeepInfra fp4 serving.

The practical consequence: **MAGENTRA's 40.4% should not be read as "12 points
behind the reference."** Measured against the reference under identical
conditions, it is level with it.

## Head-to-head on the 84 tasks both scored

|  | count |
|---|---|
| MAGENTRA wins | 35 |
| Terminus 2 wins | 34 |
| Both solved | 25 |
| Neither solved | 40 |

Solved by **MAGENTRA only** (10): `bn-fit-modify`, `build-pov-ray`,
`configure-git-webserver`, `custom-memory-heap-crash`, `fix-ocaml-gc`,
`password-recovery`, `rstan-to-pystan`, `sparql-university`, `sqlite-with-gcov`,
`vulnerable-secret`

Solved by **Terminus 2 only** (9): `break-filter-js-from-html`, `extract-elf`,
`fix-code-vulnerability`, `kv-store-grpc`, `llm-inference-batching-scheduler`,
`model-extraction-relu-logits`, `pypi-server`, `pytorch-model-cli`,
`query-optimize`

The 40 tasks neither solved are the suite's genuinely hard tail. The near-equal
split of exclusive wins (10 vs 9) is further evidence of parity: the two
harnesses are not strictly ordered, they solve *different* tasks.

## Wall-clock is the shared ceiling

| | timeouts | rate |
|---|---|---|
| MAGENTRA | 22 | 25.6% of 86 |
| Terminus 2 | 26 | 30.2% of 86 |

Roughly a quarter to a third of the suite is lost by **both** harnesses to
Harbor's per-task walls, scoring 0 without ever reaching the verifier. Two
architecturally unrelated agents — different tool loops, different context
management, different terminal drivers — shedding tasks to the clock at
statistically similar rates is the strongest signal in this data.

If MAGENTRA had finished its 22 timed-out tasks at its own 42% conversion rate,
it would have scored ≈52%. The same arithmetic applies to Terminus. **Throughput,
not reasoning, is what both harnesses are leaving on the table on this endpoint.**

## Failures that were not benchmark outcomes

- **Terminus 2**: `qemu-alpine-ssh` and `qemu-startup` never ran — tmux failed
  to start in the container, so the agent never got a terminal. Scored 0 after
  retries. MAGENTRA attempted both and also scored 0, so the head-to-head is
  unaffected, but these two are infrastructure, not capability.
- **MAGENTRA**: `train-fasttext` crashed the engine with
  `ERR_STREAM_WRITE_AFTER_END` — the host wrote an NDJSON frame to stdout after
  the stream had ended. A real defect, unfixed.

## Reproduce

```powershell
cd benchmarks\terminal-bench
.\run-glm5-deepinfra.ps1              # MAGENTRA
.\run-glm5-deepinfra.ps1 -Terminus    # the control
```

Both go through the same wrapper so the model, endpoint, task list, batching and
pricing cannot drift between treatment and control.
