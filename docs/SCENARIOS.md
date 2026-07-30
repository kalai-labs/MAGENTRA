# A 5-minute scenario — a continuous mission, end to end

Self-contained, takes ~5 minutes, and exercises the mission stack: run /
continuous / cron, unattended runs, the standing-report discipline, budgets,
and run logs.

## One-time setup (2 minutes)

```powershell
# 1. Build once (from the repo root)
npm run build

# 2. Make a playground and give it your API key
mkdir C:\labs\demo1
copy <repo>\.env C:\labs\demo1\.env        # or create .env with MAGENTRA_API_KEY=...

# 3. Launch the desktop app and open the playground in it
cd <repo>
npm run app        # then pick C:\labs\demo1 from the landing screen
```

Everything below is typed into the Magentra prompt (slash commands), unless
marked `PS>` (a separate PowerShell window).

---

## A continuous, unattended, budgeted mission with a living report

**Features:** `/mission new` · keywords web sweep · deliverable report ·
`continuous`/`cooldown`/`budget`/`mode` keys · `/mission start|stop` loop ·
**unattended** runs (auto-denied asks) · **standing-report** update discipline ·
run **log.jsonl** · `/mission schedule` (cron) · restart survival.

**1. Scaffold:** type `/mission new radar`, then edit
`.magentra\missions\radar.md` to exactly:

```markdown
---
name: Field radar
keywords: open source agent frameworks, LLM tool use
deliverable: radar.md
continuous: true
cooldown: 90s
budget: 60000
---
Watch the field of AI agent tooling. Each run: sweep the keywords, keep
radar.md current — notable projects, releases, and claims, every claim with
its source URL. Done per run = radar.md updated (or an honest "no change").
```

**2. First run (attended):** type `/mission run radar`. Watch the agent sweep
the web (WebSearch/WebFetch rows), create tasks, and write `radar.md`.
Open `radar.md` — every claim should carry a URL.

**3. Start the loop:** type `/mission start radar`. Expect the start banner:
unattended, mode bypass, destructive calls auto-denied, 60000-token budget,
survives restarts. The first looped run begins immediately; after it, the next
run is **armed** with a ~90s cooldown.

**4. While it loops** (~2 minutes):
- `/mission` — the listing shows `🔁 running continuously (cooldown 90s)`.
- After the second run finishes, open `radar.md` again: it now leads with a
  dated **"What's new since the last run"** section instead of a rewrite —
  the standing-report discipline. If nothing changed, it says so honestly.
- `PS> type .magentra\missions\out\radar\log.jsonl` — one JSON line per run:
  `{"ts":...,"unattended":true,"ok":true,"outputTokens":...}`.

**5. Prove restart survival (optional, +1 min):** quit the app, relaunch it and
reopen the workspace — the chat prints `🔁 continuous mission "radar" re-armed`.

**6. Stop and schedule instead:** type `/mission stop radar`. Then add
`schedule: 0 7 * * *` to the frontmatter and type `/mission schedule radar` —
the listing now shows `cron 0 7 * * * (scheduled ✓)` and the job is durable
(it fires at 07:00 whenever the session is idle, re-reading the file fresh).
`/mission unschedule radar` removes it.

---

## Feature coverage map

| Feature | Covered |
| --- | --- |
| `/mission new` scaffold | ✔ |
| Keywords web sweep (WebSearch + WebFetch, sourced claims) | ✔ |
| Deliverable report path | ✔ |
| `/mission run` (attended) | ✔ |
| `/mission start` / `stop` continuous loop + cooldown | ✔ |
| Unattended stance (auto-denied asks, deletion guard) | ✔ |
| Per-run output-token budget | ✔ |
| Standing-report update discipline | ✔ |
| `log.jsonl` per-run record | ✔ |
| `/mission schedule` / `unschedule` (cron, durable) | ✔ |
| Restart survival (loop re-arm) | ✔ |
