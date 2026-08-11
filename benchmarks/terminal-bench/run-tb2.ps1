<#
.SYNOPSIS
    Run MAGENTRA on Terminal-Bench 2.0 across a pool of Fireworks API keys,
    draining each one until the endpoint refuses it, then rotating to the next.

.DESCRIPTION
    The 89-task suite costs more than any single one of these accounts holds, so
    the run is sharded into small batches. Between batches the runner checks the
    current key still works; when it does not, it moves to the next key and
    re-queues whatever the refused key failed to finish.

    A key is retired ONLY when the endpoint actually refuses it - a live probe
    coming back 401/402/403, or a 400 whose body names a balance/credit/quota
    problem. The refusal text is recorded in the report so a rotation is never
    a mystery. Estimated spend does NOT retire a key: the per-token rate is a
    guess, and guessing retired keys that still had money on them. Pass
    -BudgetGuard to restore the old spend-based retirement.
    Log markers (payment/quota/auth strings in trial logs) never retire a key on
    their own - they only trigger an immediate probe, so a task that merely
    *mentions* "unauthorized" in its own output cannot burn a good key.

    Everything is journalled to tb2-state\<run-id>\ledger.json after every batch,
    so the run resumes exactly where it stopped: re-invoke the script with no
    arguments and it picks the newest state directory back up. Ctrl-C is safe.

    Per-task accounting is by reward file: a trial that produced
    verifier\reward.txt is scored and never re-paid; a trial that died before
    verification (environment boot timeout, dead key) is re-queued. Attempts are
    only charged against a task when the key was healthy at the end of the
    batch, so key death does not consume a task's retry budget.

.EXAMPLE
    # Full 89-task run, resuming the newest state dir if one exists.
    .\run-tb2.ps1

.EXAMPLE
    # Show the exact harbor invocations without spending anything.
    .\run-tb2.ps1 -DryRun

.EXAMPLE
    # Fresh run, 6 concurrent containers, rebuild the engine bundle first.
    .\run-tb2.ps1 -Fresh -Concurrency 6 -Rebuild

.EXAMPLE
    # Score-only: rebuild the report from the ledger without running anything.
    .\run-tb2.ps1 -ReportOnly
#>

[CmdletBinding()]
param(
    # The endpoint's literal model id (magentra_agent strips litellm prefixes).
    # Every model gets its own state directory and its own ledger, so switching
    # here never touches a previous model's results.
    #   gpt-oss-120b is the CONTROLLED COMPARISON (published baselines:
    #   Terminus 2 18.7%, Mini-SWE-Agent 14.2%); other models measure ceiling.
    [string]$Model = "accounts/fireworks/models/minimax-m2p7",
    [string]$BaseUrl = "https://api.fireworks.ai/inference/v1",
    [string]$Dataset = "terminal-bench/terminal-bench-2",

    # Tasks per harbor job. Small batches bound the blast radius of a key dying
    # mid-job; large batches amortise harbor's startup. 6 is a good middle.
    [int]$BatchSize = 6,
    [int]$Concurrency = 4,
    [int]$MaxAttemptsPerTask = 2,

    [string]$KeysFile,
    [string]$TasksFile,
    [string]$RunId,

    # Prior jobs whose rewards count as already-paid-for (same model+endpoint).
    [string[]]$SeedFrom = @("fireworks-easy10"),

    # Pricing is REPORTING ONLY - it no longer drives key rotation (see
    # -BudgetGuard). Defaults are MiniMax M2.7's Fireworks rates. Cache reads
    # get their own rate because they dominate this workload: the gpt-oss run
    # was 45.3M cached against 2.9M fresh, so charging cache at the uncached
    # rate would overstate spend by roughly 4x.
    #   minimax-m2p7  0.30 / 0.059 / 1.20   (default)
    #   glm-5p2       1.40 / 0.14  / 4.40
    #   gpt-oss-120b  0.15 / 0.014 / 0.60
    #   deepseek-v4-flash-0731  0.14 / 0.028 / 0.28
    [double]$InputUsdPerMTok = 0.30,
    [double]$CachedUsdPerMTok = 0.059,
    [double]$OutputUsdPerMTok = 1.20,

    # Retire a key once estimated spend reaches this fraction of its stated
    # budget. OFF by default: rotation is now driven purely by the endpoint
    # actually refusing the key (see Test-KeyAlive). Estimated spend was only
    # ever a guess at the real rate, and guessing retired keys that still had
    # money on them.
    [switch]$BudgetGuard,
    [double]$BudgetSafetyFraction = 0.95,

    # Hard per-task wall for the agent, in seconds. 0 = off, and off is the
    # default on purpose: measured against the v4-flash run, a 15-minute cap
    # would have destroyed 4 of 16 wins (feal-differential 25m, fix-ocaml-gc
    # 27m, compile-compcert 39m, circuit-fibsqrt 57m) to reclaim 4 minutes,
    # because losses fail fast (median ~5 min) while hard WINS are the long
    # ones. If you want a backstop, 3600 costs nothing observed. A cap can
    # only ever lower the score, never inflate it.
    # Mechanism: the driver self-times-out and exits 124; harbor records
    # NonZeroAgentExitCodeError and STILL runs the verifier, so the task is
    # graded 0 rather than re-queued (single_step.py:83).
    [int]$AgentTimeoutSec = 0,

    # 3 tasks need a vision endpoint the container does not have, so they score
    # 0 no matter what. They are skipped by default: running them buys three
    # guaranteed zeros at ~45 min of container time. Skipping does NOT raise the
    # leaderboard-comparable ceiling - that stays 86/89 = 96.6% either way,
    # because the comparable denominator is always 89. Pass -IncludeVision to
    # pay for them anyway (e.g. to show the zeros are real, not skipped).
    [switch]$IncludeVision,
    [switch]$Rebuild,
    [switch]$Fresh,
    [switch]$DryRun,
    [switch]$ReportOnly
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $Root "..\..")
Set-Location $Root

if (-not $KeysFile)  { $KeysFile  = Join-Path $Root "tb2-keys.txt" }
if (-not $TasksFile) { $TasksFile = Join-Path $Root "tb2-tasks.txt" }
$StateRoot = Join-Path $Root "tb2-state"
$JobsDir = Join-Path $Root "jobs"

# Truly pixel-reading tasks: no vision connection is wired into the container.
$VisionGated = @(
    "terminal-bench/code-from-image",
    "terminal-bench/chess-best-move",
    "terminal-bench/extract-moves-from-video"
)

# Substrings that mean "this trial may have hit a billing/auth wall". These only
# schedule a probe; the probe is what actually retires a key.
$ExhaustionMarkers = @(
    "payment required", "insufficient", "quota", "billing", "out of credit",
    "invalid api key", "invalid_api_key", "unauthorized", "authentication",
    "spending limit", "account is not active", "is suspended", "past invoice",
    "returned 412", "402", "401", "403", "412"
)

$Script:LogFile = $null

function Write-Log {
    param([string]$Message, [string]$Color = "Gray")
    $stamp = (Get-Date).ToString("HH:mm:ss")
    $line = "[$stamp] $Message"
    Write-Host $line -ForegroundColor $Color
    if ($Script:LogFile) { Add-Content -Path $Script:LogFile -Value $line -Encoding UTF8 }
}

function Fail {
    param([string]$Message)
    Write-Log $Message "Red"
    exit 1
}

# ---------------------------------------------------------------- preflight --

function Test-Preflight {
    if (-not (Get-Command harbor -ErrorAction SilentlyContinue)) {
        Fail "harbor is not on PATH. Install it: uv tool install harbor --python 3.13"
    }

    $dockerOk = $false
    try {
        $info = & docker info --format "{{.ServerVersion}} {{.OSType}}"
        if ($LASTEXITCODE -eq 0 -and $info) { $dockerOk = $true; Write-Log "Docker: $info" }
    } catch { $dockerOk = $false }
    if (-not $dockerOk) {
        if ($DryRun) {
            Write-Log "Docker's engine is not responding - fine for -DryRun, but a real run needs it." "Yellow"
        } else {
            Fail "Docker Desktop's engine is not responding. Start it and retry."
        }
    }

    if ($Rebuild) {
        Write-Log "Rebuilding engine + container bundle..." "Cyan"
        Push-Location $RepoRoot
        try {
            & npm run build
            if ($LASTEXITCODE -ne 0) { Fail "npm run build failed." }
            & node (Join-Path $Root "build-bundle.mjs")
            if ($LASTEXITCODE -ne 0) { Fail "build-bundle.mjs failed." }
        } finally { Pop-Location }
    }

    $bundle = Join-Path $Root "bundle"
    foreach ($f in @("engine.cjs", "rg", "driver.mjs")) {
        if (-not (Test-Path (Join-Path $bundle $f))) {
            Fail "bundle\$f missing. Run: node benchmarks\terminal-bench\build-bundle.mjs (or pass -Rebuild)"
        }
    }
    $versionFile = Join-Path $bundle "version.json"
    if (Test-Path $versionFile) {
        $v = Get-Content $versionFile -Raw | ConvertFrom-Json
        Write-Log "Bundle: MAGENTRA $($v.version)+$($v.sha)"
    }

    # harbor imports magentra_agent by module name, so this directory must be
    # importable. Set for this process only.
    $env:PYTHONPATH = $Root
}

# --------------------------------------------------------------------- keys --

function Import-Keys {
    if (-not (Test-Path $KeysFile)) {
        Fail "Keys file not found: $KeysFile  (format: <key>|<label>|<budget-usd> per line)"
    }
    $keys = @()
    foreach ($raw in Get-Content $KeysFile) {
        $line = $raw.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { continue }
        $parts = $line.Split("|")
        if ($parts.Count -lt 2) { Write-Log "Skipping malformed key line: $line" "Yellow"; continue }
        # Budget is optional now and purely informational - it orders the pool
        # and shows up in the report, but never retires a key on its own.
        $budget = 0.0
        if ($parts.Count -ge 3 -and $parts[2].Trim() -ne "") {
            try { $budget = [double]$parts[2].Trim() } catch { $budget = 0.0 }
        }
        $keys += [pscustomobject]@{
            Key         = $parts[0].Trim()
            Label       = $parts[1].Trim()
            Budget      = $budget
            Spent       = 0.0
            InTokens    = 0
            CachedToks  = 0
            OutTokens   = 0
            Batches     = 0
            Dead        = $false
            DeadWhy     = $null
        }
    }
    if ($keys.Count -eq 0) { Fail "No usable keys in $KeysFile" }
    # Still fattest-first, so the thin accounts survive as end-of-run reserves.
    return @($keys | Sort-Object -Property Budget -Descending)
}

function Test-KeyAlive {
    <#  One-token completion against the real endpoint. Costs a fraction of a
        cent and is the only signal that distinguishes "account empty" from
        "task failed for its own reasons". 401/402/403 => dead. #>
    param([pscustomobject]$KeyInfo)

    if ($DryRun) { return $true }

    $body = @{
        model      = $Model
        messages   = @(@{ role = "user"; content = "ping" })
        max_tokens = 1
    } | ConvertTo-Json -Depth 5 -Compress

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $null = Invoke-RestMethod -Method Post -Uri "$BaseUrl/chat/completions" `
                -Headers @{ Authorization = "Bearer $($KeyInfo.Key)"; "Content-Type" = "application/json" } `
                -Body $body -TimeoutSec 60
            return $true
        } catch {
            $status = $null
            if ($_.Exception.Response) { $status = $_.Exception.Response.StatusCode.value__ }

            # Read the response body: Fireworks explains WHY in the payload, and
            # "no balance" vs "bad key" vs "model not available to this account"
            # all arrive as 4xx. Recording the reason turns a rotation from a
            # mystery into a log line we can act on.
            $detail = ""
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $detail = $reader.ReadToEnd()
                    $reader.Close()
                }
            } catch { }
            if (-not $detail) { $detail = $_.ErrorDetails.Message }
            if (-not $detail) { $detail = $_.Exception.Message }
            $detail = ($detail -replace "\s+", " ").Trim()
            if ($detail.Length -gt 240) { $detail = $detail.Substring(0, 240) }

            # 412 is what Fireworks actually returns for a SUSPENDED account
            # ("reaching the monthly spending limit or failure to pay past
            # invoices"). Learned the hard way: a whole 14-batch run was spent
            # against a suspended key because 412 was not in this list and fell
            # through to "inconclusive - assume the key is fine".
            if ($status -in 401, 402, 403, 412) {
                $KeyInfo.DeadWhy = "HTTP $status - $detail"
                Write-Log "  probe: $($KeyInfo.Label) refused (HTTP $status): $detail" "Yellow"
                return $false
            }
            # Any other 4xx whose BODY names a money/account problem. Catches
            # endpoints that report an empty account under an unexpected code.
            if ($status -ge 400 -and $status -lt 500 -and
                $detail -match "(?i)balance|credit|quota|payment|billing|fund|suspend|spending limit|past invoice") {
                $KeyInfo.DeadWhy = "HTTP $status (account) - $detail"
                Write-Log "  probe: $($KeyInfo.Label) account problem: $detail" "Yellow"
                return $false
            }
            if ($status -eq 429) {
                # Throttling, not exhaustion - back off and re-probe.
                Write-Log "  probe: 429 on $($KeyInfo.Label), backing off $($attempt * 20)s" "Yellow"
                Start-Sleep -Seconds ($attempt * 20)
                continue
            }
            # Network blip or 5xx: assume the key is fine, the endpoint isn't.
            Write-Log "  probe: inconclusive for $($KeyInfo.Label) ($($_.Exception.Message))" "Yellow"
            Start-Sleep -Seconds 10
        }
    }
    # Three inconclusive probes in a row is an endpoint problem, not a key
    # problem - do not burn the key over it.
    return $true
}

function Get-ActiveKey {
    param([array]$Keys)
    foreach ($k in $Keys) {
        if ($k.Dead) { continue }
        # Opt-in only. A key is normally retired by the endpoint refusing it,
        # not by our own estimate of what it has spent.
        if ($BudgetGuard -and $k.Budget -gt 0 -and $k.Spent -ge ($k.Budget * $BudgetSafetyFraction)) {
            $k.Dead = $true
            $k.DeadWhy = ("estimated spend {0:N2} reached {1:P0} of budget {2:N2}" -f $k.Spent, $BudgetSafetyFraction, $k.Budget)
            Write-Log "Retiring key $($k.Label): $($k.DeadWhy)" "Yellow"
            continue
        }
        Write-Log ('Probing key {0} (budget ${1:N2}, spent ~${2:N2})...' -f $k.Label, $k.Budget, $k.Spent) "Cyan"
        if (Test-KeyAlive $k) { return $k }
        $k.Dead = $true
        Write-Log "Retiring key $($k.Label): $($k.DeadWhy)" "Yellow"
    }
    return $null
}

# ------------------------------------------------------------------- ledger --

function New-Ledger { return @{} }

function Import-Ledger {
    param([string]$Path)
    $ledger = New-Ledger
    if (-not (Test-Path $Path)) { return $ledger }
    $obj = Get-Content $Path -Raw | ConvertFrom-Json
    foreach ($prop in $obj.PSObject.Properties) {
        $v = $prop.Value
        $ledger[$prop.Name] = @{
            reward    = $v.reward
            attempts  = [int]$v.attempts
            job       = $v.job
            keyLabel  = $v.keyLabel
            exception = $v.exception
            inTokens  = [int]$v.inTokens
            cachedTokens = [int]$v.cachedTokens
            outTokens = [int]$v.outTokens
            source    = $v.source
        }
    }
    return $ledger
}

function Export-Ledger {
    param([hashtable]$Ledger, [string]$Path)
    ($Ledger | ConvertTo-Json -Depth 6) | Out-File -FilePath $Path -Encoding utf8
}

function Get-TaskEntry {
    param([hashtable]$Ledger, [string]$Task)
    if (-not $Ledger.ContainsKey($Task)) {
        $Ledger[$Task] = @{
            reward = $null; attempts = 0; job = $null; keyLabel = $null
            exception = $null; inTokens = 0; cachedTokens = 0; outTokens = 0; source = $null
        }
    }
    return $Ledger[$Task]
}

function Get-JobModel {
    <#  The model a previous job ran on, from its own config.json. #>
    param([string]$JobDir)
    $configPath = Join-Path $JobDir "config.json"
    if (-not (Test-Path $configPath)) { return $null }
    try {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.agents -and $config.agents.Count -gt 0) { return $config.agents[0].model_name }
    } catch { }
    return $null
}

function Import-SeedJobs {
    <#  Rewards already bought on this model+endpoint are not re-paid.

        Seeding is model-gated: a reward earned by a DIFFERENT model says
        nothing about this one, and silently blending two models into one
        score is the single easiest way to ruin a benchmark number. #>
    param([hashtable]$Ledger)
    foreach ($job in $SeedFrom) {
        $dir = Join-Path $JobsDir $job
        if (-not (Test-Path $dir)) { Write-Log "Seed job not found, skipping: $job" "Yellow"; continue }
        $seedModel = Get-JobModel $dir
        if ($seedModel -and $seedModel -ne $Model) {
            Write-Log "Seed job '$job' ran on $seedModel, not $Model - NOT seeding it." "Yellow"
            continue
        }
        $seeded = 0
        foreach ($trial in Get-ChildItem -Path $dir -Directory) {
            $short = ($trial.Name -split "__")[0]
            $task = "terminal-bench/$short"
            $rewardFile = Join-Path $trial.FullName "verifier\reward.txt"
            if (-not (Test-Path $rewardFile)) { continue }
            $entry = Get-TaskEntry $Ledger $task
            if ($null -ne $entry.reward) { continue }
            $entry.reward = [double]((Get-Content $rewardFile -Raw).Trim())
            $entry.job = $job
            $entry.source = "seed"
            $seeded++
        }
        Write-Log "Seeded $seeded scored task(s) from job '$job'."
    }
}

# ------------------------------------------------------------------ harvest --

function Read-TrialTokens {
    param([string]$TrialDir)
    $out = @{ inTokens = 0; cachedTokens = 0; outTokens = 0 }
    $resultFile = Join-Path $TrialDir "agent\magentra-result.json"
    if (-not (Test-Path $resultFile)) { return $out }
    try {
        $r = Get-Content $resultFile -Raw | ConvertFrom-Json
        $u = $r.usage
        if ($u) {
            # Cache reads are billed at their own (much lower) rate on
            # Fireworks and dominate this workload, so they are tracked apart
            # from fresh input rather than lumped in with it.
            if ($null -ne $u.inputTokens) { $out.inTokens = [int]$u.inputTokens }
            foreach ($f in @("cacheReadTokens", "cacheWriteTokens")) {
                if ($null -ne $u.$f) { $out.cachedTokens += [int]$u.$f }
            }
            if ($null -ne $u.outputTokens) { $out.outTokens = [int]$u.outputTokens }
        }
    } catch { }
    return $out
}

function Get-EstimatedCost {
    param([double]$InTok, [double]$CachedTok, [double]$OutTok)
    return ($InTok / 1000000.0) * $InputUsdPerMTok +
           ($CachedTok / 1000000.0) * $CachedUsdPerMTok +
           ($OutTok / 1000000.0) * $OutputUsdPerMTok
}

function Test-TrialHitBillingWall {
    param([string]$TrialDir)
    $candidates = @(
        (Join-Path $TrialDir "exception.txt"),
        (Join-Path $TrialDir "trial.log"),
        (Join-Path $TrialDir "agent\magentra-result.json")
    )
    foreach ($file in $candidates) {
        if (-not (Test-Path $file)) { continue }
        $text = (Get-Content $file -Raw -ErrorAction SilentlyContinue)
        if (-not $text) { continue }
        $lower = $text.ToLowerInvariant()
        foreach ($marker in $ExhaustionMarkers) {
            if ($lower.Contains($marker)) { return $true }
        }
    }
    return $false
}

function Update-LedgerFromJob {
    <#  Returns a summary of what the batch produced. #>
    param([hashtable]$Ledger, [string]$JobName, [string[]]$Tasks, [pscustomobject]$KeyInfo)

    $summary = @{ Scored = 0; Missing = 0; BillingSuspect = $false; InTokens = 0; CachedToks = 0; OutTokens = 0 }
    $jobDir = Join-Path $JobsDir $JobName
    if (-not (Test-Path $jobDir)) {
        Write-Log "  job directory missing: $jobDir" "Yellow"
        $summary.Missing = $Tasks.Count
        $summary.BillingSuspect = $true
        return $summary
    }

    foreach ($trial in Get-ChildItem -Path $jobDir -Directory) {
        $short = ($trial.Name -split "__")[0]
        $task = "terminal-bench/$short"
        if ($Tasks -notcontains $task) { continue }

        $entry = Get-TaskEntry $Ledger $task
        $tok = Read-TrialTokens $trial.FullName
        $entry.inTokens += $tok.inTokens
        $entry.cachedTokens += $tok.cachedTokens
        $entry.outTokens += $tok.outTokens
        $summary.InTokens += $tok.inTokens
        $summary.CachedToks += $tok.cachedTokens
        $summary.OutTokens += $tok.outTokens

        $exceptionFile = Join-Path $trial.FullName "exception.txt"
        if (Test-Path $exceptionFile) {
            $entry.exception = ((Get-Content $exceptionFile -Raw).Trim() -split "`n")[0]
        }

        $rewardFile = Join-Path $trial.FullName "verifier\reward.txt"
        if (Test-Path $rewardFile) {
            $entry.reward = [double]((Get-Content $rewardFile -Raw).Trim())
            $entry.job = $JobName
            $entry.keyLabel = $KeyInfo.Label
            $entry.source = "run"
            $summary.Scored++
        } else {
            $summary.Missing++
            if (Test-TrialHitBillingWall $trial.FullName) { $summary.BillingSuspect = $true }
        }
    }
    return $summary
}

# ---------------------------------------------------------------- the batch --

function Invoke-Batch {
    param([string[]]$Tasks, [pscustomobject]$KeyInfo, [string]$JobName)

    $harborArgs = @(
        "run",
        "-d", $Dataset,
        "-a", "magentra_agent:MagentraAgent",
        "-m", $Model,
        "--ae", "MAGENTRA_API_KEY=$($KeyInfo.Key)",
        "--ae", "MAGENTRA_BASE_URL=$BaseUrl",
        "--environment-build-timeout-multiplier", "3"
    )
    if ($AgentTimeoutSec -gt 0) {
        $harborArgs += @("--ae", "MAGENTRA_TB_TIMEOUT_SEC=$AgentTimeoutSec")
    }
    $harborArgs += @(
        "-n", "$Concurrency",
        "-k", "1",
        "-o", "jobs",
        "--job-name", $JobName,
        "-y", "-q"
    )
    foreach ($t in $Tasks) { $harborArgs += @("-i", $t) }

    $shown = ($harborArgs -join " ").Replace($KeyInfo.Key, "fw_****")
    Write-Log "  harbor $shown" "DarkGray"

    if ($DryRun) { return 0 }

    # Out-Host, not bare invocation: a native command's stdout lands in the
    # success stream, and would otherwise be returned alongside the exit code.
    & harbor @harborArgs | Out-Host
    return $LASTEXITCODE
}

# ---------------------------------------------------------------- reporting --

function Write-Report {
    param([hashtable]$Ledger, [array]$Keys, [string[]]$AllTasks, [string]$Path, [datetime]$StartedAt)

    $scored = @($AllTasks | Where-Object { $Ledger.ContainsKey($_) -and $null -ne $Ledger[$_].reward })
    $wins = @($scored | Where-Object { $Ledger[$_].reward -ge 1.0 })
    $unscored = @($AllTasks | Where-Object { -not ($scored -contains $_) })

    $totIn = 0; $totCached = 0; $totOut = 0
    foreach ($t in $AllTasks) {
        if ($Ledger.ContainsKey($t)) {
            $totIn += $Ledger[$t].inTokens
            $totCached += $Ledger[$t].cachedTokens
            $totOut += $Ledger[$t].outTokens
        }
    }
    $estCost = Get-EstimatedCost $totIn $totCached $totOut
    $elapsed = (Get-Date) - $StartedAt

    $sb = New-Object System.Text.StringBuilder
    $null = $sb.AppendLine("# Terminal-Bench 2.0 - MAGENTRA run report")
    $null = $sb.AppendLine("")
    $null = $sb.AppendLine("- Generated: $((Get-Date).ToString('u'))")
    $null = $sb.AppendLine("- Model: ``$Model`` via ``$BaseUrl``")
    $null = $sb.AppendLine("- Dataset: ``$Dataset`` ($($AllTasks.Count) of $ComparableTotal tasks funded this run)")
    $null = $sb.AppendLine("- Wall clock this invocation: $([int]$elapsed.TotalHours)h $($elapsed.Minutes)m")
    $null = $sb.AppendLine("")
    $null = $sb.AppendLine("## Headline")
    $null = $sb.AppendLine("")
    $null = $sb.AppendLine("**$($wins.Count) / $ComparableTotal = $('{0:P1}' -f ($wins.Count / [double]$ComparableTotal))**  <- quote this one")
    $null = $sb.AppendLine("")
    $null = $sb.AppendLine("This is the leaderboard-comparable score: the denominator is the whole")
    $null = $sb.AppendLine("suite, and every task not run or not scored counts as 0.")
    $null = $sb.AppendLine("")
    $skippedCount = $ComparableTotal - $AllTasks.Count
    if ($skippedCount -gt 0) {
        $null = $sb.AppendLine("Subset score over the $($AllTasks.Count) tasks actually funded: $($wins.Count) / $($AllTasks.Count) = $('{0:P1}' -f ($wins.Count / [double]$AllTasks.Count)).")
        $null = $sb.AppendLine("**Not comparable to leaderboard numbers** - $skippedCount task(s) were skipped as")
        $null = $sb.AppendLine("unwinnable without a vision endpoint. Ceiling for this run is therefore")
        $null = $sb.AppendLine("$($AllTasks.Count) / $ComparableTotal = $('{0:P1}' -f ($AllTasks.Count / [double]$ComparableTotal)), not 100%.")
        $null = $sb.AppendLine("")
    }
    $null = $sb.AppendLine("Scored $($scored.Count) of $($AllTasks.Count) funded tasks; $($unscored.Count) still unscored.")
    $null = $sb.AppendLine("")
    $null = $sb.AppendLine("- Fresh input tokens: $('{0:N0}' -f $totIn)")
    $null = $sb.AppendLine("- Cached input tokens: $('{0:N0}' -f $totCached)")
    $null = $sb.AppendLine("- Output tokens: $('{0:N0}' -f $totOut)")
    $null = $sb.AppendLine(('- Estimated spend at ${0} fresh / ${1} cached / ${2} output per Mtok: ${3:N2}' -f $InputUsdPerMTok, $CachedUsdPerMTok, $OutputUsdPerMTok, $estCost))
    $null = $sb.AppendLine("")
    $null = $sb.AppendLine("## Keys")
    $null = $sb.AppendLine("")
    $null = $sb.AppendLine("| key | budget | est. spend | batches | status |")
    $null = $sb.AppendLine("|---|---|---|---|---|")
    foreach ($k in $Keys) {
        $status = "live"
        if ($k.Dead) { $status = "retired - $($k.DeadWhy)" }
        $null = $sb.AppendLine(('| {0} | ${1:N2} | ${2:N2} | {3} | {4} |' -f $k.Label, $k.Budget, $k.Spent, $k.Batches, $status))
    }
    $null = $sb.AppendLine("")
    $null = $sb.AppendLine("## Per task")
    $null = $sb.AppendLine("")
    $null = $sb.AppendLine("| task | reward | attempts | key | job | note |")
    $null = $sb.AppendLine("|---|---|---|---|---|---|")
    foreach ($t in $AllTasks) {
        $e = $null
        if ($Ledger.ContainsKey($t)) { $e = $Ledger[$t] }
        if ($null -eq $e) {
            $null = $sb.AppendLine("| $t | - | 0 | | | never run |")
            continue
        }
        $reward = "-"
        if ($null -ne $e.reward) { $reward = "$($e.reward)" }
        $note = ""
        if ($e.exception) { $note = $e.exception }
        if ($e.source -eq "seed") { $note = "kept from prior job; $note" }
        $null = $sb.AppendLine("| $t | $reward | $($e.attempts) | $($e.keyLabel) | $($e.job) | $note |")
    }

    $sb.ToString() | Out-File -FilePath $Path -Encoding utf8

    Write-Log ""
    Write-Log "================ RESULT ================" "Green"
    Write-Log "comparable: $($wins.Count) / $ComparableTotal = $('{0:P1}' -f ($wins.Count / [double]$ComparableTotal))" "Green"
    if ($skippedCount -gt 0) {
        Write-Log "subset:     $($wins.Count) / $($AllTasks.Count) = $('{0:P1}' -f ($wins.Count / [double]$AllTasks.Count))  (NOT leaderboard-comparable)" "Yellow"
        Write-Log "ceiling:    $($AllTasks.Count) / $ComparableTotal = $('{0:P1}' -f ($AllTasks.Count / [double]$ComparableTotal))  ($skippedCount vision task(s) skipped)" "Yellow"
    }
    Write-Log "scored $($scored.Count), unscored $($unscored.Count)" "Green"
    Write-Log ('tokens: {0:N0} fresh + {1:N0} cached in / {2:N0} out, est ${3:N2}' -f $totIn, $totCached, $totOut, $estCost) "Green"
    Write-Log "report: $Path" "Green"
    Write-Log "========================================" "Green"
}

# --------------------------------------------------------------------- main --

Test-Preflight

if (-not (Test-Path $TasksFile)) {
    Fail "Task manifest not found: $TasksFile  (regenerate with tb2-list-tasks.py)"
}
$ManifestTasks = @(Get-Content $TasksFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" -and -not $_.StartsWith("#") })
# The comparable denominator is always the full manifest, whatever we choose to
# spend money on. Skipping a task is a decision about cost, not about scoring.
$Script:ComparableTotal = $ManifestTasks.Count
$AllTasks = $ManifestTasks
if (-not $IncludeVision) {
    $AllTasks = @($AllTasks | Where-Object { $VisionGated -notcontains $_ })
    $skipped = $ManifestTasks.Count - $AllTasks.Count
    Write-Log "Skipping $skipped vision-gated task(s) - no vision endpoint in the container, so they can only score 0." "Yellow"
    Write-Log "They still count as 0 in the leaderboard-comparable score. Ceiling: $($AllTasks.Count)/$($ManifestTasks.Count) = $('{0:P1}' -f ($AllTasks.Count / [double]$ManifestTasks.Count))" "Yellow"
}

# Resume the newest state directory unless told otherwise.
if (-not (Test-Path $StateRoot)) { $null = New-Item -ItemType Directory -Path $StateRoot }
# Every run directory is stamped with its model, and only a matching directory
# is ever auto-resumed. Switching models therefore starts a new run instead of
# silently appending one model's results to another's ledger; the old run stays
# on disk, complete, and resumable by passing the same -Model again.
$ModelSlug = ($Model -split "/")[-1] -replace "[^A-Za-z0-9._-]", ""

function Get-StateMeta {
    param([string]$Dir)
    $path = Join-Path $Dir "meta.json"
    if (-not (Test-Path $path)) { return $null }
    try { return Get-Content $path -Raw | ConvertFrom-Json } catch { return $null }
}

if (-not $RunId) {
    if ($DryRun) {
        # Throwaway, and prefixed with "_" so it is never auto-resumed: a dry
        # run fakes rewards, and a real run inheriting those would silently
        # score the whole suite 0 without launching a single container.
        $RunId = "_dryrun"
    } else {
        if (-not $Fresh) {
            $newest = Get-ChildItem -Path $StateRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { -not $_.Name.StartsWith("_") } |
                Where-Object {
                    # Only resume a run of the SAME model. An unstamped legacy
                    # directory is skipped rather than guessed at.
                    $meta = Get-StateMeta $_.FullName
                    ($null -ne $meta) -and ($meta.model -eq $Model)
                } |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($newest) { $RunId = $newest.Name; Write-Log "Resuming $($newest.Name) (same model)." "Cyan" }
        }
        if (-not $RunId) { $RunId = "tb2-$ModelSlug-" + (Get-Date).ToString("yyyyMMdd-HHmm") }
    }
}
if ($DryRun) { $Fresh = $true }
$StateDir = Join-Path $StateRoot $RunId
# Only ever wipe the throwaway "_"-prefixed dry-run directory. A -DryRun that
# was handed an explicit -RunId must not destroy a real run's ledger.
if ($DryRun -and $RunId.StartsWith("_") -and (Test-Path $StateDir)) {
    Remove-Item $StateDir -Recurse -Force
}
if (-not (Test-Path $StateDir)) { $null = New-Item -ItemType Directory -Path $StateDir }
$Script:LogFile = Join-Path $StateDir "run.log"

# Refuse to append this model's results to another model's ledger.
$existingMeta = Get-StateMeta $StateDir
if ($existingMeta -and $existingMeta.model -and $existingMeta.model -ne $Model) {
    Fail ("Run '$RunId' belongs to model $($existingMeta.model), but -Model is $Model. " +
          "Mixing models in one ledger would corrupt the score. Use -Fresh for a new run, " +
          "or pass -Model $($existingMeta.model) to continue that one.")
}
if (-not $existingMeta) {
    ([ordered]@{
        model     = $Model
        baseUrl   = $BaseUrl
        dataset   = $Dataset
        createdAt = (Get-Date).ToString("o")
    } | ConvertTo-Json) | Out-File -FilePath (Join-Path $StateDir "meta.json") -Encoding utf8
}

$LedgerPath = Join-Path $StateDir "ledger.json"
$KeyStatePath = Join-Path $StateDir "keys.json"
$ReportPath = Join-Path $StateDir "report.md"

Write-Log "Run id: $RunId   (state: $StateDir)" "Cyan"

$Keys = Import-Keys
# Carry forward per-key spend from a previous invocation of this same run.
if ((Test-Path $KeyStatePath) -and -not $Fresh) {
    $prior = @(Get-Content $KeyStatePath -Raw | ConvertFrom-Json)
    foreach ($p in $prior) {
        $match = $Keys | Where-Object { $_.Label -eq $p.Label } | Select-Object -First 1
        if ($match) {
            $match.Spent = [double]$p.Spent
            $match.InTokens = [int]$p.InTokens
            $match.CachedToks = [int]$p.CachedToks
            $match.OutTokens = [int]$p.OutTokens
            $match.Batches = [int]$p.Batches
            $match.Dead = [bool]$p.Dead
            $match.DeadWhy = $p.DeadWhy
        }
    }
    Write-Log "Restored key spend state from a previous invocation."
}
Write-Log ("Key order (highest budget first): " + (($Keys | ForEach-Object { '{0} (${1:N2})' -f $_.Label, $_.Budget }) -join " -> "))

$Ledger = New-Ledger
if (-not $Fresh) { $Ledger = Import-Ledger $LedgerPath }
if ($Ledger.Count -eq 0) { Import-SeedJobs $Ledger }

$StartedAt = Get-Date

if ($ReportOnly) {
    Write-Report $Ledger $Keys $AllTasks $ReportPath $StartedAt
    exit 0
}

$batchNo = 0
while ($true) {
    $pending = @($AllTasks | Where-Object {
        $keep = $true
        if ($Ledger.ContainsKey($_)) {
            $e = $Ledger[$_]
            $keep = (($null -eq $e.reward) -and ($e.attempts -lt $MaxAttemptsPerTask))
        }
        $keep
    })

    if ($pending.Count -eq 0) { Write-Log "All tasks resolved." "Green"; break }

    $key = Get-ActiveKey $Keys
    if ($null -eq $key) {
        Write-Log "No key left with budget. $($pending.Count) task(s) unfinished." "Red"
        Write-Log "Top up or add keys to $KeysFile, then re-run this script - it resumes." "Red"
        break
    }

    $batchNo++
    $take = [Math]::Min($BatchSize, $pending.Count)
    $batch = @($pending[0..($take - 1)])
    $jobName = "$RunId-b$('{0:D2}' -f $batchNo)-$($key.Label -replace '[^A-Za-z0-9]','')"

    Write-Log ""
    Write-Log "--- batch $batchNo | key $($key.Label) | $($batch.Count) task(s) | $($pending.Count) pending ---" "Cyan"
    foreach ($t in $batch) { Write-Log "    $t" }

    $exitCode = Invoke-Batch $batch $key $jobName
    if ($DryRun) {
        # Pretend the batch scored, so the dry run walks the whole plan.
        foreach ($t in $batch) { (Get-TaskEntry $Ledger $t).reward = 0 }
        continue
    }
    if ($exitCode -ne 0) { Write-Log "  harbor exited $exitCode" "Yellow" }

    $summary = Update-LedgerFromJob $Ledger $jobName $batch $key

    $batchCost = Get-EstimatedCost $summary.InTokens $summary.CachedToks $summary.OutTokens
    $key.Spent += $batchCost
    $key.InTokens += $summary.InTokens
    $key.CachedToks += $summary.CachedToks
    $key.OutTokens += $summary.OutTokens
    $key.Batches++

    Write-Log ('  scored {0}, unscored {1}, tokens {2:N0} in / {3:N0} out, est ${4:N3} (key total ${5:N2} of ${6:N2})' -f `
        $summary.Scored, $summary.Missing, $summary.InTokens, $summary.OutTokens, $batchCost, $key.Spent, $key.Budget)

    # A key only dies on a probe. Suspicious log text just brings the probe
    # forward; a whole batch failing unscored does the same, since that is what
    # a mid-batch exhaustion looks like from the outside.
    $keyDied = $false
    if ($summary.BillingSuspect -or ($summary.Scored -eq 0 -and $summary.Missing -gt 0)) {
        Write-Log "  batch looks like it may have hit a billing wall - probing $($key.Label)..." "Yellow"
        if (-not (Test-KeyAlive $key)) {
            $key.Dead = $true
            $keyDied = $true
            Write-Log "  key $($key.Label) is exhausted ($($key.DeadWhy)); rotating. Its unscored tasks are re-queued at no attempt cost." "Yellow"
        } else {
            Write-Log "  probe OK - those failures are the tasks' own, not the key's." "Gray"
        }
    }

    # Charge an attempt only when the key was healthy: a dead key must not eat
    # a task's retry budget.
    if (-not $keyDied) {
        foreach ($t in $batch) {
            $e = Get-TaskEntry $Ledger $t
            if ($null -eq $e.reward) { $e.attempts++ }
        }
    }

    Export-Ledger $Ledger $LedgerPath
    ($Keys | Select-Object Label, Budget, Spent, InTokens, CachedToks, OutTokens, Batches, Dead, DeadWhy |
        ConvertTo-Json -Depth 4) | Out-File -FilePath $KeyStatePath -Encoding utf8
}

Export-Ledger $Ledger $LedgerPath
Write-Report $Ledger $Keys $AllTasks $ReportPath $StartedAt
