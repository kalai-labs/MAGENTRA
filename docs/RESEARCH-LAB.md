# The Research Lab: multi-endpoint crews, team packs, and continuous missions

Magentra's crew system lets a workspace define specialist agents the orchestrator
routes work to. This document covers the three layers that turn a crew into a
distributable research lab:

1. **Per-member endpoints** — each specialist can run on its own API and model.
2. **Team packs** — a whole crew (knowledge, experience, missions included)
   exported as one shareable file, hired into any other workspace.
3. **Missions** — standing research charters the lab executes on demand or on a
   schedule: web sweeps for your keywords, investigations, compiled reports.

## 0. One file to rule the lab: `magentricks.md`

You never have to hand-manage the per-file layout. Declare the whole lab in
one blueprint at the workspace root:

```markdown
# My lab

## member: scout
---
name: Scout
role: Fast Researcher
model: deepseek-ai/DeepSeek-V4-Flash
---
You are Scout. Find answers fast, report bullets with evidence.

## member: sage
---
name: Sage
role: Deep Analyst
baseurl: https://api.deepinfra.com/v1/openai
apikeyenv: DEEPINFRA_API_KEY
---
You are Sage. Produce structured analyses.

## mission: radar
---
name: Field radar
keywords: agent frameworks
continuous: true
cooldown: 15m
---
Watch the field. Done per run = radar updated.
```

- `/lab load` — compiles the blueprint into the real team/mission files and
  hot-loads the roster. Upsert only: members/missions the blueprint doesn't
  mention (e.g. hired ones) are never touched. Broken sections are reported
  and skipped; the rest apply.
- `/lab save` — the inverse: snapshots the current lab (however it was built
  — by hand, `/build-crew`, or hiring a pack) into `magentricks.md`, ready to
  edit, version, and share.
- On startup, a blueprint with no live crew prints a `/lab load` hint.

Each section's content is *exactly* the individual file format below — one
syntax, two granularities.

## 1. Per-member endpoints

Every crew member is one file at `.magentra/team/<id>.md`. Besides `model:`,
three optional frontmatter keys give a member its **own inference endpoint**:

```markdown
---
name: Forge
role: Coder
model: qwen3.6-35b-a3
baseurl: http://localhost:11434/v1
---
You are Forge, the lab's coder. ...
```

```markdown
---
name: Sage
role: Deep Researcher
model: deepseek-ai/DeepSeek-V4-Pro
apikeyenv: MY_DEEPINFRA_KEY
---
You are Sage, the lab's deep researcher. ...
```

- `provider:` — `openai-compatible` (default) or `anthropic`.
- `baseurl:` — a dedicated OpenAI-compatible endpoint URL (local Ollama /
  LM Studio / vLLM, or any hosted `/v1` API). Local endpoints need no key.
- `apikeyenv:` — the **NAME** of the environment variable holding that
  endpoint's API key. Never the key itself: team files are shareable, keys
  stay in the environment or `.env`.

The main session stays the orchestrator on the session provider (configure it
with `/model` and `/settings`). So a typical lab is: a fast cheap orchestrator
for talking, a local coder model for code tasks, a big-brain hosted model for
deep research — mixed freely in one crew.

Resolution fails soft: if a member's endpoint cannot be resolved (its env var
is unset), the run falls back to the session's default provider **and model**
with a visible warning — never a silent 404 against the wrong host. Providers
are cached per distinct endpoint, so repeated `CrewRun`s reuse connections.

## 2. Team packs

Single members already travel as `.crewpack.json` (`/crew export`, `/crew
hire`). Team packs lift that to the whole lab:

- `/team export [name] [redact]` — packs **every** member (definition, docs,
  built backpack, surviving lessons, hash-chained service record) plus every
  mission file into `<name>.teampack.json`. Export fails closed when any
  member or mission contains secret-shaped content; `redact` masks and
  proceeds.
- `/team hire <path-or-https-url>` — imports a team pack (from a local file
  or straight from a URL — share a link, hire a lab): each member is
  validated (hashes, record chain, path traversal) and hired; an id that
  already exists here is skipped (the rest still hire); missions are added
  without ever overwriting existing ones. Imported lessons re-enter probation
  — knowledge arrives ready, trust is re-earned.

That makes teams community-distributable: share your lab, hire someone
else's, mix members. Endpoint frontmatter travels with the definitions; the
recipient just sets the named env vars (or edits the files) to light the
endpoints up.

## 3. Missions

A mission is one markdown file at `.magentra/missions/<id>.md` — a standing
research charter, versionable and shareable:

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

Commands:

- `/mission` — list missions with their keywords/schedules/loop state.
- `/mission new <id>` — write a starter mission file.
- `/mission run <id>` — launch it now: the orchestrator decomposes the
  charter into owned tasks with acceptance checks, routes them through the
  crew via `CrewRun` (independent tasks dispatched in parallel), verifies
  each report, and writes the deliverable.
- `/mission start <id>` / `/mission stop <id>` — the continuous loop: run,
  cool down, run again, until stopped. The loop is persisted and re-arms
  itself after a restart.
- `/mission schedule <id>` — register the mission's cron so the lab runs it
  whenever the session is idle at the scheduled time (durable across
  restarts). `/mission unschedule <id>` removes it.

A scheduled or continuous mission re-reads its file at fire time, so editing
the charter never requires re-scheduling.

## Unattended runs

Scheduled and continuous runs fire with nobody at the keyboard, so they never
block on a prompt:

- The run uses the mission's `mode:` (default `bypass`). The deletion guard
  still fires — and is **auto-denied**, so destructive calls simply do not
  run unattended.
- Any remaining permission ask is auto-denied with a teaching message;
  `AskUserQuestion` fails with "decide autonomously".
- The mission's `budget:` caps output tokens per run — for the orchestrator
  turn and each specialist run.
- Every run appends to `.magentra/missions/out/<id>/log.jsonl` (when, mode,
  outcome, tokens), and an unattended run ends with a notification.

## Standing research memory

When a mission's deliverable already exists, the next run is told to read it
first and **update** it: lead with a dated "What's new since the last run"
section, merge instead of duplicating, prune what turned stale — and say
"no change" honestly when the sweep finds nothing. A continuous research
mission therefore maintains one living report, not a pile of one-offs.

## Cost ledger

Every specialist run banks its token usage per member in
`.magentra/team/ledger.json`; `/crew` shows each member's lifetime spend
(`1.2k in / 340 out over 3 runs`). With members on different paid APIs, you
always know where the tokens went.
