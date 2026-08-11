r"""Merge several Harbor job directories into one uploadable job directory.

`run-tb2.ps1` shards Terminal-Bench 2.0 into ~10 small harbor jobs so a dying
API key only strands one batch. `harbor upload` takes exactly one job_dir, so
the batches have to be stitched back together before submission. Every trial
directory harbor writes is already self-contained, so this is a pure offline
repack -- no containers, no re-running, nothing re-paid.

The job-level files are rebuilt with Harbor's OWN models rather than hand-rolled
JSON, so the stats block (reward_stats, exception_stats, token totals) is
computed by exactly the code that would have written it had the suite run as a
single job. The result is then re-read through the uploader's own loader, so a
successful run here means `harbor upload` can parse what we produced.

Duplicate trials for the same task (a task re-queued after its key died) are
resolved in favour of the one that produced a verifier reward; ties go to the
most recent.

Must run under Harbor's interpreter:

    & "$env:APPDATA\uv\tools\harbor\Scripts\python.exe" merge-jobs.py \
        --out jobs-merged/tb2-full jobs/tb2-*-b*

Then:

    harbor upload jobs-merged/tb2-full
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from harbor.models.job.result import JobResult, JobStats
from harbor.models.trial.result import TrialResult
from harbor.upload.uploader import _load_job_from_disk


def _trial_dirs(job_dir: Path) -> list[Path]:
    """Child dirs harbor would treat as trials -- same rule as the uploader."""
    return sorted(
        c for c in job_dir.iterdir() if c.is_dir() and (c / "result.json").exists()
    )


def _has_reward(trial_dir: Path) -> bool:
    return (trial_dir / "verifier" / "reward.txt").is_file()


def _mtime(trial_dir: Path) -> float:
    return (trial_dir / "result.json").stat().st_mtime


def _task_name(trial_dir: Path) -> str:
    data = json.loads((trial_dir / "result.json").read_text(encoding="utf-8"))
    name = data.get("task_name")
    if name:
        return str(name)
    return trial_dir.name.split("__")[0]


def choose_trials(job_dirs: list[Path]) -> tuple[dict[str, Path], list[tuple[str, Path]]]:
    """Pick one trial per task. Returns (kept, dropped)."""
    best: dict[str, Path] = {}
    dropped: list[tuple[str, Path]] = []

    for job_dir in job_dirs:
        for trial in _trial_dirs(job_dir):
            task = _task_name(trial)
            incumbent = best.get(task)
            if incumbent is None:
                best[task] = trial
                continue
            # A scored trial always beats an unscored one; otherwise newest wins.
            challenger_wins = (_has_reward(trial), _mtime(trial)) > (
                _has_reward(incumbent),
                _mtime(incumbent),
            )
            if challenger_wins:
                best[task] = trial
                dropped.append((task, incumbent))
            else:
                dropped.append((task, trial))
    return best, dropped


def repoint_trial(trial_dir: Path, out_dir: Path) -> None:
    """Rewrite the copied trial's absolute self-references to the merged dir."""
    result_path = trial_dir / "result.json"
    data = json.loads(result_path.read_text(encoding="utf-8"))
    data["trial_uri"] = trial_dir.resolve().as_uri()
    config = data.get("config")
    if isinstance(config, dict) and "trials_dir" in config:
        config["trials_dir"] = str(out_dir)
    result_path.write_text(json.dumps(data, indent=1), encoding="utf-8")


def build_lock(job_dirs: list[Path], kept: dict[str, Path], out_dir: Path) -> None:
    """Job lock = first batch's lock as template, trials = each kept trial's lock."""
    template = json.loads((job_dirs[0] / "lock.json").read_text(encoding="utf-8"))
    trials = []
    for task in sorted(kept):
        trial_lock = out_dir / kept[task].name / "lock.json"
        if not trial_lock.is_file():
            print(f"  warn: {task} has no trial lock.json; upload may reject it")
            continue
        trials.append(json.loads(trial_lock.read_text(encoding="utf-8")))
    template["trials"] = trials
    (out_dir / "lock.json").write_text(json.dumps(template, indent=4), encoding="utf-8")


def build_config(job_dirs: list[Path], kept: dict[str, Path], out_dir: Path) -> None:
    config = json.loads((job_dirs[0] / "config.json").read_text(encoding="utf-8"))
    config["job_name"] = out_dir.name
    datasets = config.get("datasets")
    if isinstance(datasets, list) and datasets:
        # One dataset across every batch, so the merged task list is the union.
        datasets[0]["task_names"] = sorted(kept)
        for extra in datasets[1:]:
            extra.pop("task_names", None)
    (out_dir / "config.json").write_text(json.dumps(config, indent=1), encoding="utf-8")


def build_result(job_dirs: list[Path], out_dir: Path) -> JobResult:
    """Regenerate job stats with Harbor's own aggregator over the merged trials."""
    trial_results = [
        TrialResult.model_validate_json((t / "result.json").read_text(encoding="utf-8"))
        for t in _trial_dirs(out_dir)
    ]
    stats = JobStats.from_trial_results(trial_results, n_total_trials=len(trial_results))

    starts, ends = [], []
    for job_dir in job_dirs:
        raw = json.loads((job_dir / "result.json").read_text(encoding="utf-8"))
        if raw.get("started_at"):
            starts.append(datetime.fromisoformat(raw["started_at"]))
        if raw.get("finished_at"):
            ends.append(datetime.fromisoformat(raw["finished_at"]))

    now = datetime.now(timezone.utc)
    result = JobResult(
        id=uuid.uuid4(),
        started_at=min(starts) if starts else now,
        updated_at=max(ends) if ends else now,
        finished_at=max(ends) if ends else now,
        n_total_trials=len(trial_results),
        stats=stats,
    )
    (out_dir / "result.json").write_text(
        result.model_dump_json(indent=4, exclude={"trial_results"}), encoding="utf-8"
    )
    return result


def merge_logs(job_dirs: list[Path], out_dir: Path) -> None:
    lines = []
    for job_dir in job_dirs:
        log = job_dir / "job.log"
        if log.is_file():
            lines.append(f"===== {job_dir.name} =====\n")
            lines.append(log.read_text(encoding="utf-8", errors="replace"))
    if lines:
        (out_dir / "job.log").write_text("".join(lines), encoding="utf-8")


def verify(out_dir: Path) -> bool:
    """Re-read the merged dir with the uploader's own loader."""
    try:
        job_result, job_config, trial_results, trial_dirs = _load_job_from_disk(out_dir)
    except Exception as exc:  # noqa: BLE001 - the whole point is to surface it
        print(f"\nFAIL: harbor cannot parse the merged job: {exc}")
        return False

    missing_lock = [n for n, p in trial_dirs.items() if not (p / "lock.json").is_file()]
    if missing_lock:
        print(f"\nFAIL: {len(missing_lock)} trial(s) missing lock.json (upload requires it):")
        for name in missing_lock[:5]:
            print(f"  - {name}")
        return False

    if not (out_dir / "lock.json").is_file():
        print("\nFAIL: merged job lock.json missing")
        return False

    print("\nVerified with harbor's own loader (the call `harbor upload` makes):")
    print(f"  job id            {job_result.id}")
    print(f"  job name          {job_config.job_name}")
    print(f"  trials parsed     {len(trial_results)}")
    print(f"  n_total_trials    {job_result.n_total_trials}")
    print(f"  completed/errored {job_result.stats.n_completed_trials}/{job_result.stats.n_errored_trials}")
    for key, ev in job_result.stats.evals.items():
        print(f"  eval {key}")
        print(f"    scored trials   {ev.n_trials}  errors {ev.n_errors}")
        for metric, buckets in ev.reward_stats.items():
            for value, names in sorted(buckets.items()):
                print(f"    {metric}={value}: {len(names)}")
        for exc_type, names in ev.exception_stats.items():
            print(f"    exception {exc_type}: {len(names)}")
    print(f"  tokens            {job_result.stats.n_input_tokens} in / {job_result.stats.n_output_tokens} out")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_dirs", nargs="+", type=Path, help="Batch job directories to merge")
    parser.add_argument("--out", required=True, type=Path, help="Merged job directory to create")
    parser.add_argument("--overwrite", action="store_true", help="Replace --out if it exists")
    args = parser.parse_args()

    job_dirs = []
    for path in args.job_dirs:
        if not path.is_dir():
            print(f"skip (not a directory): {path}")
            continue
        if not (path / "result.json").is_file():
            print(f"skip (no result.json, not a job dir): {path}")
            continue
        job_dirs.append(path)

    if not job_dirs:
        print("No usable job directories.")
        return 1

    out_dir: Path = args.out
    if out_dir.exists():
        if not args.overwrite:
            print(f"{out_dir} already exists. Pass --overwrite to replace it.")
            return 1
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    print(f"Merging {len(job_dirs)} job dir(s) -> {out_dir}")
    kept, dropped = choose_trials(job_dirs)
    print(f"  {len(kept)} unique task(s); {len(dropped)} duplicate trial(s) discarded")
    for task, path in dropped:
        print(f"    dropped {task} from {path.parent.name} (kept {kept[task].parent.name})")

    for task in sorted(kept):
        src = kept[task]
        shutil.copytree(src, out_dir / src.name)
        repoint_trial(out_dir / src.name, out_dir)

    build_lock(job_dirs, kept, out_dir)
    build_config(job_dirs, kept, out_dir)
    result = build_result(job_dirs, out_dir)
    merge_logs(job_dirs, out_dir)

    scored = sum(1 for t in _trial_dirs(out_dir) if _has_reward(t))
    print(f"  copied {len(kept)} trial(s), {scored} with a verifier reward")

    if not verify(out_dir):
        return 1

    print(f"\nReady:  harbor upload {out_dir}")
    print("Run `harbor auth login` first if you have not already.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
