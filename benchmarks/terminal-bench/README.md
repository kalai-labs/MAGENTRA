# MAGENTRA on Terminal-Bench 2.0

Runs the **unmodified** MAGENTRA engine on [Terminal-Bench 2.0](https://www.tbench.ai/)
via [Harbor](https://www.harborframework.com/), as an *installed agent*: the
engine bundle is uploaded into each task container and driven over its normal
NDJSON stdio protocol by `driver.mjs` — a second frontend beside the desktop
app, not a fork of anything.

## Pieces

| File | Role |
|---|---|
| `build-bundle.mjs` | Host-side: bundles `engine/host` into `bundle/engine.cjs` (same esbuild recipe as the shipped app, ripgrep shim included), fetches linux-x64 `rg`, stamps `bundle/version.json`. |
| `driver.mjs` | In-container: spawns the engine, turns OVERDRIVE on, sends the task as one user turn, auto-answers any interactive frame, exits on `turn_finished`. Writes `magentra-events.ndjson` (full frame log) and `magentra-result.json` (usage/cost/stop reason) to `/logs/agent/`. |
| `magentra_agent.py` | Harbor `BaseInstalledAgent`: installs Node (nvm, ≥20), uploads the bundle, runs the driver, reports tokens/cost back to Harbor. |

## Run

```bash
# 1. Build the engine and the container bundle (repo root)
npm run build
node benchmarks/terminal-bench/build-bundle.mjs

# 2. Credentials (DeepInfra; OPENAI_API_KEY / DEEPINFRA_API_KEY also work)
export MAGENTRA_API_KEY=...

# 3. Smoke: oracle first (validates harness), then one easy task with MAGENTRA
cd benchmarks/terminal-bench
export PYTHONPATH=$PWD   # harbor imports magentra_agent by module name
harbor run -d terminal-bench/terminal-bench-2 -a oracle -l 5
harbor run -d terminal-bench/terminal-bench-2 \
  --agent-import-path magentra_agent:MagentraAgent \
  -m deepseek-ai/DeepSeek-V3.2 -k 1 -l 3

# 4. Full suite
harbor run -d terminal-bench/terminal-bench-2 \
  --agent-import-path magentra_agent:MagentraAgent \
  -m deepseek-ai/DeepSeek-V3.2 -k 1 -n 4
```

`-m` takes the endpoint's literal model id (a leading `deepinfra/` prefix is
stripped). The engine's default `baseUrl` is already DeepInfra; point
`MAGENTRA_BASE_URL` elsewhere for other OpenAI-compatible endpoints.

## Full 89-task run across a pool of API keys

The suite costs more than any one of our Fireworks accounts holds, so
`run-tb2.ps1` shards it into small harbor jobs and walks the key pool from the
fattest account down.

```powershell
cd benchmarks\terminal-bench
.\run-tb2.ps1 -DryRun          # print the plan; no containers, no spend
.\run-tb2.ps1 -Rebuild         # the real thing (rebuilds the bundle first)
```

| File | Role |
|---|---|
| `run-tb2.ps1` | The runner: batching, key rotation, ledger, final report. |
| `run-glm5-deepinfra.ps1` | Thin wrapper pinning the DeepInfra **GLM-5** run (see below). |
| `tb2-keys.txt` | `<key>\|<label>\|<budget-usd>` per line. **Gitignored.** Sorted by budget descending at load, so the order in the file does not matter. |
| `tb2-tasks.txt` | The 89 task names. Regenerate with `tb2-list-tasks.py` if the dataset changes. |
| `tb2-state/<run-id>/` | `ledger.json`, `keys.json`, `run.log`, `report.md`. **Gitignored.** |

- **Rotation.** A key is retired when its estimated spend reaches
  `-BudgetSafetyFraction` (0.92) of its stated budget, or when a live one-token
  probe against Fireworks returns 401/402/403. Billing-ish strings in trial logs
  only *schedule* a probe — they never retire a key by themselves, so a task
  that prints "unauthorized" in its own output cannot burn a good account.
- **Resume.** State is written after every batch; re-invoking with no arguments
  picks the newest run back up. Ctrl-C is safe. Tasks whose batch died because
  the *key* died are re-queued without spending a retry.
- **Already-scored tasks are not re-paid.** `-SeedFrom fireworks-easy10`
  (default) reads the 8 rewards from that job into the ledger — but only if
  that job ran on the *same model*, checked against its own `config.json`.
  A reward earned by a different model says nothing about this one.
- **Runs are scoped to a model.** Each `tb2-state/<run-id>/` carries a
  `meta.json` naming its model, and only a matching directory is auto-resumed;
  pointing `-RunId` at another model's ledger is refused outright. So switching
  models starts a new run and leaves the old one complete and resumable:

  ```powershell
  .\run-tb2.ps1                                                   # gpt-oss-120b (default)
  .\run-tb2.ps1 -Model "accounts/fireworks/models/deepseek-v4-flash-0731" `
                -InputUsdPerMTok 0.14 -OutputUsdPerMTok 0.28      # resumes the v4-flash run
  ```
- **`-AgentTimeoutSec` caps each task's agent wall (0 = off, the default).**
  Measured on the v4-flash run, a 15-minute cap would have cost 4 of 16 wins to
  reclaim 4 minutes: losses fail fast (median ~5 min) while the hard *wins* are
  the long ones — `circuit-fibsqrt` was solved in 57 min against a 16-hour
  expert estimate. Use 3600 if you want a backstop. A cap can only lower a
  score, never inflate it.
- **Cost is estimated, not reported.** Fireworks ids are absent from MAGENTRA's
  rate card, so the driver writes `costUsd: null`; the runner prices exact token
  counts at `-InputUsdPerMTok` / `-OutputUsdPerMTok` (default 0.90/0.90 — set
  these to the model's real Fireworks rate before trusting the rotation
  threshold). The probe is the backstop that catches a genuinely empty account.
- **Scoring.** The headline is always wins / 89, counting every task not run or
  not scored as 0 — the leaderboard-comparable convention. The report also
  prints the subset mean over the tasks actually funded, labelled as *not*
  comparable, so the two cannot be confused.
- **Vision tasks are skipped by default.** `code-from-image`, `chess-best-move`
  and `extract-moves-from-video` need to read content out of pixels and the
  container has no vision endpoint, so they can only score 0. Skipping saves
  ~45 min of container time but does **not** raise the ceiling: it stays
  86/89 = 96.6% either way, because the comparable denominator is always 89.
  Pass `-IncludeVision` to pay for them anyway.
- `-ReportOnly` rebuilds `report.md` from the ledger without running anything.

### The DeepInfra GLM-5 run (single key)

`run-glm5-deepinfra.ps1` wraps `run-tb2.ps1` for the one configuration that has
a **published same-model baseline**: `zai-org/GLM-5`, where Terminus 2 scored
**52.4% ±2.6** on the Terminal-Bench 2.0 leaderboard. GLM-5.2 has no row at all,
so a score on it compares to nothing.

```powershell
cd benchmarks\terminal-bench
.\run-glm5-deepinfra.ps1 -DryRun    # plan only, no containers, no spend
.\run-glm5-deepinfra.ps1            # the real thing (rebuilds first)
```

Keys go in `deepinfra-keys.txt` (`<key>|<label>|<budget-usd>`, gitignored via
`*-keys.txt`). This run uses **one** key, not the Fireworks pool — so the
rotation machinery is inert, and everything Fireworks-specific in the runner's
defaults is overridden explicitly by the wrapper: model, base URL, all three
token rates, and `-SeedFrom @()` so no reward from the Fireworks easy-10 job
can be blended into a different model's score. A single key means the run halts
rather than rotates if DeepInfra ever refuses it; re-invoke to resume.

Estimated spend for the full suite is **$10–25** at DeepInfra's published GLM-5
rates ($0.60 / $0.12 cached / $2.08 per Mtok), which match
`MODEL_PRICING["zai-org/GLM-5"]` in `engine/core/src/config/pricing.ts` exactly,
so the driver's `costUsd` and the runner's ledger agree instead of drifting.

Caveat worth stating in any writeup: DeepInfra serves GLM-5 at **fp4**. Reported
precision comparisons put fp4 within measurement noise of fp8 on reasoning and
tool-calling, with long-context exact recall the documented exception — which is
the one axis these tasks lean on. First-party Z.ai is fp8 if that matters.

### Uploading

`harbor upload` takes exactly one job directory, and the batching produces ~10.
`merge-jobs.py` stitches them back into a single uploadable job — a pure offline
repack, no containers, nothing re-run:

```powershell
& "$env:APPDATA\uv\tools\harbor\Scripts\python.exe" merge-jobs.py `
    --out jobs-merged\tb2-full jobs\tb2-*-b*
harbor auth login       # GitHub OAuth, once
harbor upload jobs-merged\tb2-full
```

The job-level `result.json` is regenerated with Harbor's own `JobStats`
aggregator, not hand-rolled, and the merged directory is then re-read through
the uploader's own loader — so a clean run means `harbor upload` can parse it.
Verified against `fireworks-easy10`: split into two batches and re-merged, the
stats block comes back byte-identical to the original single job.

Duplicate trials for a task (re-queued after a key died) resolve in favour of
the one with a verifier reward; ties go to the newest.

Note that `harbor upload` publishes to Harbor Hub — it is not a leaderboard
submission. Public leaderboard rows are curated by the dataset owner. Harbor
redacts agent env values in the artifacts (`fw_9****Z6E`), so keys do not travel
with an upload; rotate them after the run anyway.

## What the adapter configures (and nothing else)

- `MAGENTRA_MODEL`, key + base-url env vars — the engine's own documented overrides.
- `~/.magentra/settings.json` = `{"clarify": false}` — the clarify pre-layer
  interviews the *user* before open-ended work; a benchmark has no user.
- `settings.contextWindow`, **only when `MAGENTRA_TB_CONTEXT_WINDOW` is set**
  (unset = stock behaviour). `contextWindowFor()` falls back to a conservative
  128k for *every* model because the engine's `MODEL_CONTEXT_WINDOWS` table is
  empty, and `settings.ts` deliberately gives `contextWindow` no env override —
  the settings file is the only way in. Without it a 200k+ model compacts at
  128k and is measured handicapped against baselines that had its real window.
  It is written to the same user-writable settings file as `clarify`, so this
  is configuration, not an engine change.
- OVERDRIVE on (a per-session protocol frame, same switch the desktop exposes):
  fully autonomous, nothing asks, self-verify end check active.

Everything else — prompts, tools, knowledge graph, reuse gate, permission
engine, turn caps — is stock MAGENTRA, byte-identical to the shipped engine.

## Notes

- The engine writes its usual state (`.magentra/` in the task workdir, session
  transcripts under `~/.magentra`) inside the container; it is discarded with
  the container and never touches task verification.
- Driver exit codes: `0` turn finished, `1` fatal engine/provider error,
  `124` driver self-timeout (`MAGENTRA_TB_TIMEOUT_SEC`, off by default —
  Harbor owns task timeouts).
- Harbor needs Python ≥ 3.12: `uv tool install harbor --python 3.13`.
