# Three 5-minute scenarios — the whole lab, end to end

Each scenario is self-contained, takes ~5 minutes, and together they exercise
every feature of the research-lab stack: per-member endpoints, backpacks,
parallel crew dispatch, the cost ledger, missions (run / continuous / cron),
unattended runs, the standing-report discipline, run logs, single-member
crew packs, whole-team packs, and URL hiring.

## One-time setup (2 minutes, shared by all scenarios)

```powershell
# 1. Build once (from the repo root)
npm run build

# 2. Make a playground and give it your API key
mkdir C:\labs\demo1
copy <repo>\.env C:\labs\demo1\.env        # or create .env with DEEPINFRA_API_KEY=...

# 3. Launch Magentra in it
cd C:\labs\demo1
node <repo>\packages\cli\bin\magentra.js
```

Everything below is typed into the Magentra prompt (slash commands), unless
marked `PS>` (a separate PowerShell window).

---

## Scenario 1 — Assemble a multi-endpoint crew, dispatch in parallel, read the bill

**Features:** team files · per-member `model`/`baseurl`/`apikeyenv` · backpacks ·
task owners · CrewRun **parallel dispatch** · `/crew` readiness + **cost ledger**.

**1. Give the crew something to know** (`PS>` in `C:\labs\demo1`):

```powershell
mkdir notes
"Project Atlas: a hypothetical CLI for note-taking. Rule: all commands must be reversible. Rule: no telemetry." | Out-File -Encoding utf8 notes\project.md
```

**2. Create two specialists on their own endpoints** — `.magentra\team\scout.md`:

```markdown
---
name: Scout
role: Fast Researcher
model: deepseek-ai/DeepSeek-V4-Flash
apikeyenv: DEEPINFRA_API_KEY
emoji: 🔎
docs: notes/project.md
---
You are Scout, the lab's fast researcher. Given a question, find the answer
quickly and report it as bullet points with evidence. Never pad.
```

and `.magentra\team\sage.md` (a different model — swap in any model your
endpoint serves; a local Ollama member would instead use
`baseurl: http://localhost:11434/v1` and no apikeyenv):

```markdown
---
name: Sage
role: Deep Analyst
model: openai/gpt-oss-120b
baseurl: https://api.deepinfra.com/v1/openai
apikeyenv: DEEPINFRA_API_KEY
emoji: 🦉
docs: notes/project.md
---
You are Sage, the lab's deep analyst. Given a topic, produce a short,
structured analysis: claims, counterpoints, and a recommendation.
```

The roster hot-loads. Watch the startup/console: backpacks build in the
background (`backpack_progress`), and `/crew` shows each member flipping
from `building` to `ready`.

**3. Verify the endpoints loaded** — type `/crew`. Expect both members listed;
`Scout` and `Sage` each with their model. (A typo'd `provider:` would have
produced a warning, not a silent failure.)

**4. Parallel dispatch.** Ask the orchestrator:

```
Create two tasks: (1) owned by scout — list 3 realistic risks of building a
note-taking CLI, each with a one-line mitigation; (2) owned by sage — argue
for and against making every command reversible, citing our project notes.
The tasks are independent: dispatch BOTH with CrewRun in the same message,
then verify each report and complete the tasks.
```

Expect: two `agent_spawned` events **at the same time** (not one after the
other), each report verified, tasks completed. Sage's answer should reference
the "reversible" rule — that's its backpack working.

**5. Read the bill** — type `/crew` again. Each member's line now ends with its
ledger, e.g. `· 3.1k in / 420 out over 1 run`. That is per-member token
accounting across APIs. Also try `/crew record scout` and `/crew lessons scout`
(the verified-work CV and the experience ledger — lessons appear as tasks get
verified over time).

---

## Scenario 2 — A continuous, unattended, budgeted mission with a living report

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

**2. First run (attended):** type `/mission run radar`. Watch the lab sweep
the web (WebSearch/WebFetch rows), create owned tasks, and write `radar.md`.
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

**5. Prove restart survival (optional, +1 min):** quit Magentra (Ctrl+C),
relaunch it — the console prints `🔁 continuous mission "radar" re-armed`.

**6. Stop and schedule instead:** type `/mission stop radar`. Then add
`schedule: 0 7 * * *` to the frontmatter and type `/mission schedule radar` —
the listing now shows `cron 0 7 * * * (scheduled ✓)` and the job is durable
(it fires at 07:00 whenever the session is idle, re-reading the file fresh).
`/mission unschedule radar` removes it.

---

## Scenario 3 — Package the lab and hire it somewhere else (the community loop)

**Features:** `/team export` (fail-closed redaction) · whole-team
`.teampack.json` with **missions inside** · `/team hire` from **file and URL** ·
member validation + collision skip · hired backpacks arrive ready · lessons
re-enter probation · service-record chain verification · single-member
`/crew export` / `hire ... as`.

**1. Export the whole lab** (still in `C:\labs\demo1`): type

```
/team export demolab
```

Expect `📦 team exported → C:\labs\demo1\demolab.teampack.json` — Scout, Sage,
their docs, built backpacks, lessons, service records, **and the radar
mission** in one file. (If you had pasted an API key into a team file, the
export would have refused, listing the finding — that's the fail-closed gate;
`/team export demolab redact` would mask and proceed.)

**2. Hire it into a second workspace:**

```powershell
PS> mkdir C:\labs\demo2 ; copy C:\labs\demo1\.env C:\labs\demo2\.env
PS> cd C:\labs\demo2 ; node <repo>\packages\cli\bin\magentra.js
```

then type `/team hire C:\labs\demo1\demolab.teampack.json`. Expect:

```
🤝 team "demolab" hired — 2 members, 1 mission added
   ✓ scout — Scout   ✓ sage — Sage   🧪 mission radar.md
```

Check what traveled: `/crew` (members ready — backpacks were NOT rebuilt or
re-paid; lessons show as "on probation"; the CV line ends with
`chain verified ✓`), and `/mission` (radar is here — run it in the new
workspace immediately).

**3. Hire from a URL** — the community share path (`PS>` in `C:\labs\demo1`):

```powershell
PS> python -m http.server 8765
```

then in a third workspace's Magentra:
`/team hire http://127.0.0.1:8765/demolab.teampack.json` — same validation,
straight from a link. (This is exactly how a lab shared on GitHub raw URLs
gets hired.)

**4. Single-member poaching:** in `demo2`, type `/crew export scout`, then
`/crew hire scout.crewpack.json as scout2`. Expect the collision-safe hire:
`scout2` joins with Scout's knowledge and record intact. Trying
`/team hire ...demolab.teampack.json` again shows the other side:
`✗ scout skipped: already exists`, while nothing is overwritten.

---

## Feature coverage map

| Feature | S1 | S2 | S3 |
|---|---|---|---|
| Per-member endpoints (`model`/`baseurl`/`apikeyenv`) | ✔ | | |
| Backpacks (docs → knowledge, hot readiness) | ✔ | | ✔ (travel ready) |
| Parallel CrewRun dispatch | ✔ | | |
| Cost ledger in `/crew` | ✔ | | |
| Service record + lessons | ✔ | | ✔ (chain ✓, probation) |
| `/mission` new · run · keywords sweep · deliverable | | ✔ | ✔ (hired mission) |
| Continuous loop (start/stop, cooldown, restart re-arm) | | ✔ | |
| Unattended policy (bypass + auto-deny + budget) | | ✔ | |
| Standing-report "what's new" discipline | | ✔ | |
| Run log (`log.jsonl`) + notifications | | ✔ | |
| Cron schedule/unschedule (durable) | | ✔ | |
| `/team export` (fail-closed redaction, missions inside) | | | ✔ |
| `/team hire` file + **URL**, collision skip | | | ✔ |
| `/crew export` / `hire ... as` (single member) | | | ✔ |
