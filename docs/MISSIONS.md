# Missions: standing research charters

A mission is a standing directive the agent executes on demand or on a schedule:
sweep the web for your keywords, investigate a question, compile a report. Each
one is a single markdown file — versionable, shareable, and editable by hand.

## The mission file

A mission is one markdown file at `.magentra/missions/<id>.md`. The file name
without the `.md` is the mission id.

```markdown
---
name: Literature scan
keywords: agent memory, tool use benchmarks
schedule: 0 7 * * 1
deliverable: research/weekly-scan.md
---
Track new work on agent memory systems and tool-use benchmarks.
Summarize what changed since the last scan; flag anything that
contradicts our current design notes. Done = report written with
sources for every claim.
```

- `keywords:` — the orchestrator sweeps the web for each (WebSearch +
  WebFetch), capturing source URLs with every claim.
- `deliverable:` — where the final report is written (default
  `.magentra/missions/out/<id>/report.md`).
- `schedule:` — optional 5-field cron for recurring runs.
- `continuous: true` — a standing mission `/mission start` loops forever.
- `cooldown:` — pause between continuous runs (`90s`, `15m`, `1h`; default 5m).
- `budget:` — output-token cap per run (e.g. `60000`). Unattended runs never ask:
  they take the allow-all stance, and anything that still insists on asking
  (deletion guard, questions) is auto-denied.

## Commands

- `/mission` — list missions with their keywords/schedules/loop state.
- `/mission new <id>` — write a starter mission file.
- `/mission run <id>` — launch it now: the orchestrator decomposes the charter
  into tasks with acceptance checks, executes them one at a time, verifies each
  against its check, and writes the deliverable.
- `/mission start <id>` / `/mission stop <id>` — the continuous loop: run,
  cool down, run again, until stopped. The loop is persisted and re-arms
  itself after a restart.
- `/mission schedule <id>` — register the mission's cron so it runs whenever
  the session is idle at the scheduled time (durable across restarts).
  `/mission unschedule <id>` removes it.

A scheduled or continuous mission re-reads its file at fire time, so editing
the charter never requires re-scheduling.

The desktop app lists the same missions under **Missions** (Ctrl+3), with a RUN
button per mission.

## Unattended runs

Scheduled and continuous runs fire with nobody at the keyboard, so they never
block on a prompt:

- The run uses the mission's `mode:` (default `bypass`). The deletion guard
  still fires — and is **auto-denied**, so destructive calls simply do not
  run unattended.
- Any remaining permission ask is auto-denied with a teaching message;
  `AskUserQuestion` fails with "decide autonomously".
- The mission's `budget:` caps output tokens per run.
- Every run appends to `.magentra/missions/out/<id>/log.jsonl` (when, mode,
  outcome, tokens), and an unattended run ends with a notification.

## Standing research memory

When a mission's deliverable already exists, the next run is told to read it
first and **update** it: lead with a dated "What's new since the last run"
section, merge instead of duplicating, prune what turned stale — and say
"no change" honestly when the sweep finds nothing. A continuous research
mission therefore maintains one living report, not a pile of one-offs.
