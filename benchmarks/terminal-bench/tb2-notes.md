# TB2 full run — what to do tonight

Everything below assumes the adapter as it stands on 2026-08-01. Scored results
so far live in `RESULTS.md`; this file is the action list.

---

## 1. Pre-flight (5 min)

```powershell
# Docker Desktop must be RUNNING (its engine, not just the tray icon):
docker info --format "{{.ServerVersion}} {{.OSType}}"     # expect: 28.4.0 linux

# Engine + bundle fresh? Only needed if engine/ changed since the bundle was built.
npm run build
node benchmarks\terminal-bench\build-bundle.mjs           # writes bundle/{engine.cjs,rg,driver.mjs,version.json}
```

`bundle/version.json` records which MAGENTRA build the run used — check it goes
into the paper's reproducibility section.

---

## 2. Decide two things first

**a) Vision policy** — 3 tasks need actual pixel-reading (`code-from-image`,
`chess-best-move`, `extract-moves-from-video`); the container has no vision
endpoint, so they score 0. Options:
- **run them anyway** (recommended — keeps the number leaderboard-comparable;
  costs ~45 min of container time), or
- `-x` them (subset score, must be labelled as such next to leaderboard numbers), or
- wire `visionConnection` into the adapter's settings write (a Fireworks VL
  model) — un-gates all three, ~20 min of work, good architecture point for the
  paper. Not done.

**b) Concurrency** — `-n 6` if this machine has the CPU/RAM (each task container
wants 1–2 CPUs, 2 GB). Drop to `-n 4` if Docker starts thrashing; the two
env-boot failures today were partly image-pull contention.

---

## 3. The run

```powershell
cd C:\Users\alini\phdworks\MAGENTRA\benchmarks\terminal-bench
$env:PYTHONPATH = "C:\Users\alini\phdworks\MAGENTRA\benchmarks\terminal-bench"

harbor run -d terminal-bench/terminal-bench-2 `
  -a magentra_agent:MagentraAgent `
  -m "accounts/fireworks/models/deepseek-v4-flash-0731" `
  --ae MAGENTRA_API_KEY=<fireworks key> `
  --ae MAGENTRA_BASE_URL=https://api.fireworks.ai/inference/v1 `
  --environment-build-timeout-multiplier 3 `
  -x terminal-bench/fix-git -x terminal-bench/prove-plus-comm `
  -x terminal-bench/cobol-modernization -x terminal-bench/overfull-hbox `
  -x terminal-bench/crack-7z-hash -x terminal-bench/raman-fitting `
  -x terminal-bench/constraints-scheduling -x terminal-bench/kv-store-grpc `
  -n 6 -k 1 -y -q --job-name full-v1
```

- 81 tasks (89 minus the 8 already scored on this exact endpoint).
- **Estimated 5–8 h** at `-n 6`. Per-task agent walls sum to 41.5 h across the
  whole suite; the 30 hard tasks dominate because a cheap model runs most of
  them to the wall.
- Launch it and leave it — do NOT babysit; check in the morning.

---

## 4. Optional, before launching (worth ~30 min)

`overfull-hbox` is rated **easy** and still timed out at 750 s. Read
`jobs/fireworks-easy10/overfull-hbox__SeYZWmw/agent/magentra-events.ndjson`
(tool-call timeline) and see whether the agent was stuck in a slow
recompile loop or genuinely lost. If it's a pacing problem, that is a real
finding for the paper — and possibly a cheap fix — rather than a capability gap.
Same file exists for `raman-fitting`.

---

## 5. After the run

```powershell
# headline number
(Get-Content jobs\full-v1\result.json | ConvertFrom-Json).stats.evals | ConvertTo-Json -Depth 6

# per-task rewards
Get-ChildItem jobs\full-v1\*\verifier\reward.txt | ForEach-Object {
  "$($_.Directory.Parent.Name -replace '__.*',''): $(Get-Content $_.FullName)" }
```

- **Final score = (wins in full-v1 + 5 kept wins) / 89.** The 5 kept wins are
  fix-git, prove-plus-comm, cobol-modernization, crack-7z-hash,
  constraints-scheduling; the 3 kept zeros are overfull-hbox, raman-fitting,
  kv-store-grpc. Do NOT report harbor's own mean from full-v1 alone — it is
  computed over 81 tasks, not 89.
- Any `EnvironmentStartTimeoutError` / `AgentTimeoutError` counted as errors,
  not scores — re-run just those tasks with `-i <name>` before finalising.
- Append everything to `RESULTS.md`, and record token totals + wall-clock (they
  become the cost-efficiency table in the preprint).

---

## 6. Gotchas already paid for

| Symptom | Cause / fix |
|---|---|
| `No module named 'magentra_agent'` | `PYTHONPATH` not set to this directory. |
| `No tasks matched the filter(s)` | Task names need the `terminal-bench/` prefix in `-i`/`-x`. |
| `EnvironmentStartTimeoutError` (600 s) | First-time image pull. Images are cached now; `--environment-build-timeout-multiplier 3` covers the rest. |
| Run stalls with no output, no errors | DeepInfra `DeepSeek-V3.2` was overloaded — it holds streams open with SSE pings instead of returning 429. Re-probe an endpoint with a 60 s curl before committing a long run. |
| `costUsd: null` in driver results | Fireworks model ids are not in MAGENTRA's rate card. Token counts are still exact — price them by hand from Fireworks' published rates. |

**Housekeeping:** rotate the DeepInfra and Fireworks API keys after the runs —
both were pasted into a chat transcript.
