# Terminal-Bench 2.0 — run ledger

Tasks already attempted, so the full run can skip them (`-x <name>` per task)
and their rewards can be merged into the final tally instead of re-paying.

## smoke: magentra-smoke2 — 2026-08-01 · DeepInfra `deepseek-ai/DeepSeek-V4-Flash`

Drawn by `-l 2` (accidentally two Carlini "hard" tasks). Plumbing validated;
rewards not representative.

| task | difficulty | reward | note |
|---|---|---|---|
| make-mips-interpreter | hard (expert ~16h) | 0 | killed at 30-min task wall mid-debug; 72 tool calls, wrote full vm.js, was fixing delay slots at cutoff; ~130k ctx / 69k output tokens |
| circuit-fibsqrt | hard (expert 16h) | — | cancelled by user before its 60-min wall; no verifier run |

## fireworks-easy10 — 2026-08-01 · Fireworks `accounts/fireworks/models/deepseek-v4-flash-0731`

The suite's 4 "easy" tasks + 6 quickest mediums by expert estimate.
**5/8 scored = 62.5%** (5/10 attempted). Job total: 2.47M input tokens
(2.33M of them cache reads) + 125k output.

| task | difficulty | expert est | reward |
|---|---|---|---|
| fix-git | easy | 5m | 1 |
| prove-plus-comm | easy | 5m | 1 |
| cobol-modernization | easy | 20m | 1 |
| overfull-hbox | easy | — | 0 (AgentTimeoutError at 750s) |
| crack-7z-hash | medium | 5m | 1 |
| raman-fitting | medium | 5m | 0 (AgentTimeoutError) |
| mteb-leaderboard | medium | 5m | — env boot timeout, never ran; RE-RUN |
| constraints-scheduling | medium | 15m | 1 |
| kv-store-grpc | medium | 15m | 0 |
| pytorch-model-recovery | medium | 15m | — env boot timeout, never ran; RE-RUN |

## Full-run exclusion list

Tasks with a *kept* result (do not re-run; merge rewards instead):

```
-x terminal-bench/fix-git -x terminal-bench/prove-plus-comm \
-x terminal-bench/cobol-modernization -x terminal-bench/overfull-hbox \
-x terminal-bench/crack-7z-hash -x terminal-bench/raman-fitting \
-x terminal-bench/constraints-scheduling -x terminal-bench/kv-store-grpc
```

Include in the full run (no kept Fireworks result): `mteb-leaderboard` and
`pytorch-model-recovery` (env-boot timeouts — images now cached, add
`--environment-build-timeout-multiplier 3`), `circuit-fibsqrt` (cancelled),
and `make-mips-interpreter` (its 0 was on DeepInfra, a different endpoint —
re-run on Fireworks for a consistent tally).

## Vision-gated tasks (no vision endpoint configured in container)

Truly require reading content out of pixels — without a vision connection the
agent cannot see them. Exclude from runs (or expect 0):

```
-x terminal-bench/code-from-image -x terminal-bench/chess-best-move \
-x terminal-bench/extract-moves-from-video
```

Borderline: `install-windows-3.11` (GUI via VNC — scriptable blind, brutal).
Programmatic image tasks (sam-cell-seg, video-processing, path-tracing,
qemu-*, caffe-cifar-10 …) need NO vision — code does the looking; keep them.

NOTE for the paper: when comparing against leaderboard numbers, report the
all-89 score (vision-gated tasks as 0) — an excluded-subset score is not
leaderboard-comparable. MAGENTRA does have a vision sidecar path
(settings.visionConnection describes images via a second endpoint) — wiring a
cheap Fireworks VL model into the container would un-gate these three; option,
not done.

## Endpoint notes

- DeepInfra `deepseek-ai/DeepSeek-V3.2`: overloaded 2026-08-01 — streaming
  requests are held open with SSE pings and queue indefinitely instead of
  returning 429; a run against it stalls into task timeouts. Re-probe before use.
- Fireworks `deepseek-v4-flash-0731`: tool calling verified, emits
  `reasoning_content` (thinking variant). No entry in MAGENTRA's rate card →
  driver reports tokens but `costUsd: null`; compute cost from Fireworks pricing.
