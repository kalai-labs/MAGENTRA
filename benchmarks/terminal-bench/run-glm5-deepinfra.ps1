<#
.SYNOPSIS
    MAGENTRA on Terminal-Bench 2.0 — DeepInfra, zai-org/GLM-5, k=1.

.DESCRIPTION
    A thin wrapper over run-tb2.ps1. It adds nothing the general runner does
    not already do; it only pins the settings that make THIS run comparable to
    a published number, so they cannot be forgotten or mistyped:

      model      zai-org/GLM-5   — the ONLY GLM with a Terminal-Bench 2.0
                                   baseline: Terminus 2 scored 52.4% +/-2.6.
                                   GLM-5.2 has no row on the leaderboard, so a
                                   score on it compares to nothing.
      endpoint   DeepInfra's OpenAI-compatible /v1/openai
      pricing    0.60 / 0.12 cached / 2.08 per Mtok — DeepInfra's published
                 rates, which match MODEL_PRICING["zai-org/GLM-5"] in
                 engine/core/src/config/pricing.ts exactly, so the driver's own
                 costUsd and this runner's ledger agree instead of drifting.
      k          1 (run-tb2.ps1 hardcodes -k 1 in Invoke-Batch)
      seeding    OFF. The default -SeedFrom pulls rewards from the Fireworks
                 easy-10 job; that ran on a different model and blending two
                 models into one score is how a benchmark number gets ruined.
                 run-tb2.ps1 is model-gated and would refuse it anyway — this
                 is belt and braces.

    Two things this wrapper does that the general runner does not:

      1. Rebuilds by default. The committed bundle was stamped v0.16.9 while
         the repo is v0.17.3 — the engine bundle does NOT rebuild itself, and a
         stale one silently benchmarks last month's engine. Pass -NoRebuild
         only when you know the bundle is current.
      2. Sets MAGENTRA_TB_CONTEXT_WINDOW. contextWindowFor() falls back to
         128_000 for every model because MODEL_CONTEXT_WINDOWS is empty, and
         GLM-5's real window is 202_752. Left at the fallback, MAGENTRA
         compacts 37% early against a baseline that had the whole window.
         Harbor's installed-agent base reads process env, so this needs no
         --ae plumbing and no change to run-tb2.ps1.

.EXAMPLE
    # Print the plan. No containers, no spend. Do this first.
    .\run-glm5-deepinfra.ps1 -DryRun

.EXAMPLE
    # The real run: rebuilds the bundle, then walks all 86 funded tasks.
    .\run-glm5-deepinfra.ps1

.EXAMPLE
    # Resume after Ctrl-C without paying to rebuild or re-score.
    .\run-glm5-deepinfra.ps1 -NoRebuild

.EXAMPLE
    # Rebuild report.md from the ledger; runs nothing.
    .\run-glm5-deepinfra.ps1 -ReportOnly -NoRebuild

.NOTES
    LOGGING: use Start-Transcript, never `2>&1 | Tee-Object`.

        Start-Transcript -Path .\glm5-run.log
        .\run-glm5-deepinfra.ps1
        Stop-Transcript

    Merging stderr into the pipeline makes PowerShell wrap every native-command
    stderr line as a NativeCommandError, and run-tb2.ps1 runs under
    $ErrorActionPreference = "Stop" — so `npm notice ...` from the bundle
    rebuild becomes a terminating error and the run dies before it starts.
    Verified: identical invocation succeeds bare and fails through `2>&1`.
    Start-Transcript captures both streams without merging them.
#>

[CmdletBinding()]
param(
    # Concurrent task containers. 4 is what the gpt-oss-120b run used; raise it
    # only if Docker has the headroom, since each container is a full task env.
    [int]$Concurrency = 4,
    [int]$BatchSize = 6,

    # GLM-5's real context window (DeepInfra model card). Pass 128000 to
    # reproduce stock fallback behaviour — that is the one knob that makes this
    # run behaviourally different from the earlier gpt-oss-120b run, so it is
    # exposed rather than buried.
    [int]$ContextWindow = 202752,

    # Hard per-task agent wall, seconds. 0 = off, and off is the right default:
    # measured on the v4-flash run, a 15-minute cap would have cost 4 of 16
    # wins, because losses fail fast while the hard WINS are the long ones.
    [int]$AgentTimeoutSec = 0,

    [string]$KeysFile,
    [string]$RunId,

    # Run Terminus 2 — the benchmark authors' reference agent — instead of
    # MAGENTRA, on the IDENTICAL model, endpoint and task list. The agent is the
    # only variable that changes, which is the whole point: it isolates the
    # harness from the model. Terminus scored 52.4% +/-2.6 on GLM 5 on the
    # public leaderboard, so this also cross-checks our setup against a known
    # number — if it reproduces, any MAGENTRA delta is real.
    [switch]$Terminus,

    [switch]$IncludeVision,
    [switch]$NoRebuild,
    [switch]$Fresh,
    [switch]$DryRun,
    [switch]$ReportOnly
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $Root "run-tb2.ps1"
if (-not (Test-Path $Runner)) {
    throw "run-tb2.ps1 not found beside this script: $Runner"
}

if (-not $KeysFile) { $KeysFile = Join-Path $Root "deepinfra-keys.txt" }
if (-not (Test-Path $KeysFile)) {
    throw ("Keys file not found: $KeysFile`n" +
           "Format, one per line:  <api-key>|<label>|<budget-usd>")
}

# The adapter reads this from the environment it is launched in and writes it
# into the container's ~/.magentra/settings.json. Scoped to this process, so it
# cannot leak into an unrelated harbor invocation in the same shell.
if ($ContextWindow -gt 0 -and -not $Terminus) {
    $env:MAGENTRA_TB_CONTEXT_WINDOW = "$ContextWindow"
} else {
    Remove-Item Env:\MAGENTRA_TB_CONTEXT_WINDOW -ErrorAction SilentlyContinue
}

$forward = @{
    BaseUrl          = "https://api.deepinfra.com/v1/openai"
    KeysFile         = $KeysFile
    Concurrency      = $Concurrency
    BatchSize        = $BatchSize
    AgentTimeoutSec  = $AgentTimeoutSec

    # DeepInfra published rates. Cache reads get their own rate because they
    # dominate this workload — the gpt-oss run was 45.3M cached against 2.9M
    # fresh, so pricing cache at the uncached rate overstates spend ~4x.
    InputUsdPerMTok  = 0.60
    CachedUsdPerMTok = 0.12
    OutputUsdPerMTok = 2.08

    SeedFrom         = @()
}

if ($Terminus) {
    # Terminus is a harbor-native litellm agent, so the model needs a provider
    # prefix (litellm resolves deepinfra/<id> to the same endpoint MAGENTRA hits
    # directly) and the key must arrive under the provider's own variable. No
    # base-url env: the provider prefix already determines the endpoint.
    # run-tb2.ps1 derives the probe model by stripping that prefix, so the
    # liveness probe still talks plain OpenAI to DeepInfra.
    $forward["Model"]          = "deepinfra/zai-org/GLM-5"
    $forward["Agent"]          = "terminus-2"
    $forward["KeyEnvNames"]    = @("DEEPINFRA_API_KEY")
    $forward["BaseUrlEnvName"] = ""
} else {
    $forward["Model"] = "zai-org/GLM-5"
}

# Rebuild unless explicitly waived: `npm run app` never compiles the engine and
# the bundle never rebuilds itself, so "I built it recently" is not evidence.
if (-not $NoRebuild) { $forward["Rebuild"] = $true }

if ($RunId)         { $forward["RunId"]         = $RunId }
if ($IncludeVision) { $forward["IncludeVision"] = $true }
if ($Fresh)         { $forward["Fresh"]         = $true }
if ($DryRun)        { $forward["DryRun"]        = $true }
if ($ReportOnly)    { $forward["ReportOnly"]    = $true }

$who = if ($Terminus) { "TERMINUS 2 (control)" } else { "MAGENTRA" }
Write-Host ""
Write-Host "$who - Terminal-Bench 2.0 - DeepInfra GLM-5" -ForegroundColor Cyan
Write-Host "  agent          $(if ($Terminus) { 'terminus-2' } else { 'magentra_agent:MagentraAgent' })"
Write-Host "  model          $($forward['Model'])   (published: Terminus 2 52.4% +/-2.6)"
Write-Host "  endpoint       https://api.deepinfra.com/v1/openai"
Write-Host "  keys           $KeysFile"
Write-Host "  k              1"
Write-Host "  concurrency    $Concurrency   batch $BatchSize"
if ($Terminus) {
    Write-Host "  contextWindow  n/a (terminus manages its own context)"
    Write-Host "  note           token/cost columns stay 0 - only MAGENTRA's driver" -ForegroundColor DarkGray
    Write-Host "                 writes magentra-result.json. Scores are unaffected." -ForegroundColor DarkGray
} else {
    Write-Host "  contextWindow  $ContextWindow"
}
if ($NoRebuild) {
    Write-Host "  rebuild        SKIPPED - bundle/version.json is what will run" -ForegroundColor Yellow
} else {
    Write-Host "  rebuild        yes (npm run build + build-bundle.mjs)"
}
Write-Host "  est. spend     ~`$10-25 for the full suite" -ForegroundColor DarkGray
Write-Host ""

$startedAt = Get-Date
$threw = $false
try {
    & $Runner @forward
} catch {
    $threw = $true
    Write-Host "run-tb2.ps1 raised: $($_.Exception.Message)" -ForegroundColor Red
}

<#  Why this does not forward $LASTEXITCODE.

    run-tb2.ps1 has no exit-code contract, and $LASTEXITCODE is not a usable
    proxy for one. Verified on this machine, both cases read 1:

      - a CLEAN run leaves 1 behind, because the preflight `docker info` probe
        (run-tb2.ps1:172) is a native call that legitimately fails on a host
        with Docker Desktop stopped, and nothing resets the variable after it;
      - the Fail path uses `exit 1`, which for a script invoked with `&`
        terminates only that script — it does NOT throw, so the try/catch above
        never sees it and execution continues here regardless.

    The one signal that separates them is the report: Write-Report is the last
    statement run-tb2.ps1 executes, and Fail always exits before reaching it.
    So "a report.md was written after we started" means it ran to completion. #>
$report = Get-ChildItem -Path (Join-Path $Root "tb2-state") -Recurse -Filter "report.md" `
              -ErrorAction SilentlyContinue |
          Where-Object { $_.LastWriteTime -ge $startedAt } |
          Sort-Object LastWriteTime -Descending |
          Select-Object -First 1

Write-Host ""
if (-not $threw -and $report) {
    Write-Host "Completed. Report: $($report.FullName)" -ForegroundColor Green
    exit 0
}
Write-Host "Did NOT complete - no report was written. Read the log above for the cause." -ForegroundColor Red
exit 1
