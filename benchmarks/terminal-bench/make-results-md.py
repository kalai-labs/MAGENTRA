#!/usr/bin/env python3
"""Render a committable results document from a tb2-state run directory.

The ledger is the source of truth for scores; nothing here is typed by hand, so
the published number cannot drift from what the verifier actually returned.

    python make-results-md.py tb2-state/tb2-GLM-5-20260810-2311 -o RESULTS-GLM5.md

Write with -o, never `> file`: on Windows a bare redirect encodes stdout in the
console codepage (cp1254 here), which mangles every em dash in the output. -o
writes UTF-8 explicitly.
"""
import argparse
import json
import math
import sys
from pathlib import Path

# The comparable denominator is ALWAYS the whole suite. Tasks not run, skipped,
# or unscored count as 0 — that is the leaderboard convention, and a
# subset-mean quoted as if it were comparable is the easiest way to publish a
# number nobody can reproduce.
SUITE = 89
VISION_GATED = 3

# Published leaderboard rows for the same model, for context. Terminus 2 is the
# benchmark authors' own reference agent.
BASELINES = [("Terminus 2", "GLM 5", 52.4, 2.6)]


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return default


def main():
    # Model-specific facts are flags, not constants: rendering one model's run
    # with another's precision/window/rates would publish confident nonsense,
    # which is exactly what a validation pass against the gpt-oss ledger showed.
    ap = argparse.ArgumentParser()
    ap.add_argument("state", help="tb2-state/<run-dir>")
    ap.add_argument("-o", "--out", help="output path (UTF-8); stdout if omitted")
    ap.add_argument("--precision", default="fp4 (DeepInfra's served quantization)")
    ap.add_argument("--context-window", default="202,752 (the model's real window)")
    ap.add_argument("--usd-in", type=float, default=0.60)
    ap.add_argument("--usd-cached", type=float, default=0.12)
    ap.add_argument("--usd-out", type=float, default=2.08)
    args = ap.parse_args()

    state = Path(args.state)
    ledger = load(state / "ledger.json")
    meta = load(state / "meta.json", {}) or {}
    if ledger is None:
        sys.exit(f"no readable ledger.json in {state}")

    out_lines = []

    rows = sorted(ledger.items())
    scored = [(k, v) for k, v in rows if v.get("reward") is not None]
    wins = [(k, v) for k, v in scored if (v.get("reward") or 0) > 0]
    n_win = len(wins)

    comparable = 100.0 * n_win / SUITE
    subset = (100.0 * n_win / len(scored)) if scored else 0.0
    # Binomial standard error on the comparable score at k=1. One task is
    # 1/89 = 1.12 points, so small gaps are noise, not signal.
    p = n_win / SUITE
    se = 100.0 * math.sqrt(p * (1 - p) / SUITE)

    # Ledger semantics, per run-tb2.ps1 Read-TrialTokens (:443-447): inTokens is
    # usage.inputTokens = FRESH input only, and cachedTokens is
    # cacheRead+cacheWrite tracked ALONGSIDE it, not inside it. They are
    # disjoint. Subtracting one from the other (the natural-looking
    # "fresh = in - cached") drives fresh to zero and silently drops the
    # fresh-input term from the bill — observed live, where cachedTokens
    # exceeded inTokens 32x. Mirrors Get-EstimatedCost (:455) exactly.
    fresh = sum(v.get("inTokens") or 0 for _, v in rows)
    tcache = sum(v.get("cachedTokens") or 0 for _, v in rows)
    tout = sum(v.get("outTokens") or 0 for _, v in rows)
    tin = fresh + tcache
    cost = ((fresh / 1e6) * args.usd_in
            + (tcache / 1e6) * args.usd_cached
            + (tout / 1e6) * args.usd_out)

    bundle = load(Path(__file__).parent / "bundle" / "version.json", {}) or {}

    def o(line=""):
        out_lines.append(line)
    o("# MAGENTRA on Terminal-Bench 2.0 — GLM-5 (DeepInfra)")
    o()
    o(f"**{n_win} / {SUITE} = {comparable:.1f}%**")
    o()
    o("This is the leaderboard-comparable score: the denominator is the whole")
    o("suite, and every task not run or not scored counts as 0.")
    o()
    o(f"Subset over the {len(scored)} tasks actually run: {n_win} / {len(scored)} = "
      f"{subset:.1f}% — **not** leaderboard-comparable.")
    o()

    o("## Configuration")
    o()
    o("| | |")
    o("|---|---|")
    o(f"| Model | `{meta.get('model', 'zai-org/GLM-5')}` |")
    o(f"| Endpoint | `{meta.get('baseUrl', 'https://api.deepinfra.com/v1/openai')}` |")
    o(f"| Precision | {args.precision} |")
    o(f"| Context window | {args.context_window} |")
    o("| Trials per task | k = 1 |")
    o(f"| Engine | MAGENTRA {bundle.get('version', '?')} @ `{bundle.get('sha', '?')}` |")
    o(f"| Dataset | `{meta.get('dataset', 'terminal-bench/terminal-bench-2')}` |")
    o(f"| Run started | {meta.get('createdAt', '?')} |")
    o()
    o("The engine is the shipped bundle, driven over its normal NDJSON protocol.")
    o("The adapter configures only: model/key/endpoint, `clarify: false` (an")
    o("unattended benchmark has no user to interview), `contextWindow`, and")
    o("OVERDRIVE. Prompts, tools, knowledge graph, reuse gate, permission engine")
    o("and turn caps are stock.")
    o()

    o("## Comparison")
    o()
    o("| Agent | Model | Score |")
    o("|---|---|---|")
    o(f"| **MAGENTRA** | GLM-5 (fp4) | **{comparable:.1f}%** |")
    for agent, model, score, err in BASELINES:
        o(f"| {agent} | {model} | {score:.1f}% ±{err} |")
    o()
    o(f"At k=1 over {SUITE} tasks the binomial standard error on this score is")
    o(f"±{se:.1f} points, and a single task is worth 1.12 points. Differences")
    o("smaller than roughly twice that error are not distinguishable from noise;")
    o("separating two harnesses confidently needs k>1 or a wider gap.")
    o()
    o(f"{VISION_GATED} tasks require reading content out of pixels and no vision")
    o("endpoint was configured in the container, so they can only score 0. They")
    o(f"are counted as 0 above; the ceiling for this run is "
      f"{SUITE - VISION_GATED}/{SUITE} = {100.0 * (SUITE - VISION_GATED) / SUITE:.1f}%.")
    o()

    o("## Cost")
    o()
    o(f"- Input tokens: {tin:,} total — {fresh:,} fresh + {tcache:,} cached "
      f"({100.0 * tcache / max(tin, 1):.1f}% served from cache)")
    o(f"- Output tokens: {tout:,}")
    o(f"- Estimated spend at ${args.usd_in} / ${args.usd_cached} cached / "
      f"${args.usd_out} per Mtok: **${cost:,.2f}**")
    o()
    o("Cost is estimated, not billed: cache *writes* are counted with cache")
    o("reads and priced at the cached rate, because DeepInfra publishes no")
    o("separate write rate and returned a null write count on probe.")
    o()

    # Failure analysis from the trial dirs. jobs/ is gitignored, so if this is
    # not captured into the document now the evidence is gone the moment the
    # directory is cleaned — and "0" alone cannot distinguish an agent that was
    # wrong from one that never got to finish.
    # Deduplicate by TASK, not by trial directory: a re-queued task has one
    # exception file per attempt, so counting files reports 8 failures where
    # there are 2 tasks. Timeout wins over other errors when a task has both,
    # since the timeout is what actually decided the score.
    jobs = Path(__file__).parent / "jobs"
    timeout_set, other = set(), {}
    for exc in jobs.glob(f"*{state.name}*/*/exception.txt"):
        task = exc.parent.name.rsplit("__", 1)[0]
        try:
            body = exc.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if "AgentTimeoutError" in body:
            timeout_set.add(task)
        else:
            kind = ("tmux session failed to start"
                    if "Failed to start tmux" in body
                    else "engine/agent error")
            other[task] = kind
    timeouts = sorted(timeout_set)
    crashes = sorted(k for k in other if k not in timeout_set)

    if timeouts or crashes:
        o("## Failure analysis")
        o()
        o(f"Of {len(scored)} scored tasks, **{len(timeouts)} hit the per-task time")
        o(f"wall** ({100.0 * len(timeouts) / max(len(scored), 1):.0f}%) and scored 0 without ever")
        o("reaching the verifier. These are not capability failures — the agent was")
        o("still working when Harbor killed it — but they are scored as losses, which")
        o("is the correct benchmark convention. They are also invisible in the token")
        o("totals above: the driver writes its usage file on clean exit only, so work")
        o("done inside a timed-out trial is unrecorded and the real spend is higher")
        o("than the estimate.")
        o()
        o("Timed out: " + ", ".join(f"`{t}`" for t in sorted(timeouts)))
        o()
        if crashes:
            o(f"**{len(crashes)} task(s) failed for a reason other than the clock.**")
            o("These are infrastructure or agent failures rather than benchmark")
            o("outcomes — the task was never genuinely attempted and lost:")
            o()
            for t in crashes:
                o(f"- `{t}` — {other[t]}")
            o()

    o("## Per-task results")
    o()
    o("| task | reward | in | cached | out |")
    o("|---|---|---|---|---|")
    for k, v in rows:
        r = v.get("reward")
        mark = "—" if r is None else ("**1**" if r > 0 else "0")
        o(f"| {k.replace('terminal-bench/', '')} | {mark} | "
          f"{v.get('inTokens') or 0:,} | {v.get('cachedTokens') or 0:,} | "
          f"{v.get('outTokens') or 0:,} |")
    o()
    o("Generated from `ledger.json` by `make-results-md.py` — no hand-entered scores.")

    text = "\n".join(out_lines) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out} ({len(out_lines)} lines)", file=sys.stderr)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
