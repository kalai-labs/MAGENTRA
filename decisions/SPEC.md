# magentra-gateway — implementation specification

Status: **§11 steps 1–5, 7 and 9 implemented 2026-09-09. Steps 6 (test hierarchy) and 8 (runner) outstanding.**
Decisions: [0001](0001-the-gateway-is-the-inventory.md) ·
[0002](0002-the-gateway-is-typescript-in-process.md) ·
[0003](0003-storage-is-committed-json-per-feature.md) ·
[0004](0004-tests-inherit-on-kind.md) ·
[0005](0005-the-two-stage-gate.md)

If this document and the implementation disagree, one of them is a bug. Read the
five decision records first; they carry the *why*, and this document deliberately
does not repeat it.

---

## 1. Layout

```
tools/magentra-gateway/
├── package.json            name: @magentra/gateway, private, type: module
├── tsconfig.json           own project; NOT in the root tsc -b chain
├── src/
│   ├── cli.ts              entry: npm run gateway [-- --port N] [--no-open]
│   ├── server.ts           node:http; routes in §5
│   ├── registry.ts         load/validate/write feature + description records
│   ├── schema.ts           zod schemas; the only definition of record shape
│   ├── freshness.ts        stage 1 (§4.1)
│   ├── connection.ts       stage 2 (§4.2) — wraps tui/src/profiles.ts
│   ├── gate.ts             §4.3 — composes the two stages; owns the hard block
│   ├── deps.ts             dependency resolution (§6) — calls blast-radius --json
│   └── ui/
│       ├── index.html      single page, no framework, no CDN
│       ├── app.js          vanilla; SSE consumer
│       └── style.css
tests/
├── lib/                    the class hierarchy (§3)
├── features/               <feature-id>.test.ts, one per feature
└── gateway/
    ├── features/           <feature-id>.json     committed
    └── descriptions/       <id>.json             committed — draft
        └── ready/          <id>.json             committed — ready (moved here on `ready`)
```

Root `package.json` gains:

```json
"gateway": "tsx tools/magentra-gateway/src/cli.ts",
"typecheck:gateway": "tsc -p tools/magentra-gateway"
```

`tests/` is permanent and root-level. Nothing else holds tests, ever.

---

## 2. Record schemas

`src/schema.ts` is the single definition. Every record is validated on load; a
malformed record fails loudly and names the file. Never default-and-continue.

### 2.1 Feature

```ts
{
  id: string,              // kebab-case, stable,never reused. e.g. "turn-loop"
  name: string,            // short title
  area: "engine" | "app" | "tui" | "protocol" | "providers" | "tooling",
  section: string,         // FEATURES.md grouping, e.g. "Runtime — the turn loop"
  prose: string,           // the description, verbatim from FEATURES.md
  kinds: ("pure"|"fs"|"proc"|"net"|"llm"|"ui")[],   // >= 1
  entryFiles: string[],    // repo-relative; hashed for freshness. >= 1
  invariant: string,       // one sentence: what is true while this works
  tests: string[],         // test ids present in tests/features/<id>.test.ts
  status: "untested" | "partial" | "covered",
  freshness: {
    hash: string,                      // rollup over entryFiles
    fileHashes: Record<string,string>, // per file, so drift can be named
    recordedAt: string                 // ISO date
  }
}
```

`deferred: true` means the feature is tracked but carries no test expectation
yet. It is set by rule, not by opinion: a feature is deferred exactly when every
one of its `entryFiles` sits under `app/renderer/`. Renderer modules are out of
scope at this stage (2026-09-09 decision). A deferred feature still appears in
the inventory, still resolves dependencies, and never counts against coverage —
and it must never be silently promoted: removing the flag is a decision.

`status` is **derived, never authored**: `untested` = no tests; `partial` = tests
exist but not for every declared kind; `covered` = one per kind. It is computed
on load and never written to disk.

### 2.2 Description

The user-authored specification an agent acts on.

```ts
{
  id: string,              // generated
  featureIds: string[],    // one description may cover several features
  body: string,            // free text: how the tests shall be written
  status: "draft" | "ready",
  createdAt: string,
  updatedAt: string
}
```

`draft` means the description is still being written — an AI suggestion, or the
user's own text not yet approved. `ready` means the user has read it and it is
the test procedure a coding agent should implement, as written. **Ready says
nothing about a test existing**; that is the feature's derived `status`
(§2.1), which is computed from the test files and never from a description.
(Renamed 2026-09-09 from `pending` / `done`, which read as "the test was
done" — the wrong fact.)

`status` moves to `ready` **only by explicit user action.** The gateway may
*suggest* it and must never apply it: a generated draft handed to an agent as
if approved is exactly the unreviewed directive this field exists to keep out.

**The folder mirrors the status** (added 2026-09-09). A `draft` is
`tests/gateway/descriptions/<id>.json`; marking it ready moves the file to
`tests/gateway/descriptions/ready/<id>.json`, and sending it back to draft
moves it back. So `ls` on either folder is the tracking view, with no tool in
between. A file whose `status` disagrees with its folder is a malformed record
and fails the load — the two places the user reads "ready" from may never
differ.

The body is free text, but the seeded descriptions follow a shape the UI
renders as labelled rows: an ALL-CAPS line (`WHAT`, `WHY`, `WHERE`,
`TEST CHECKLIST`) opens a block, numbered lines become a list, backticked spans
and file paths render as code. Text of any other shape is shown as typed.

---

## 3. Test hierarchy

`tests/lib/` exports the abstract base and six subclasses per
[0004](0004-tests-inherit-on-kind.md). The base requires `featureId`,
`invariant`, `whyItExists`, and `run()`. `whyItExists` is mandatory and must name
the failure the test would catch — the gateway surfaces it as ability 2, and a
test that cannot state it is the scaffold this effort exists to prevent.

Subclass responsibilities:

| Class | Owns |
| --- | --- |
| `PureTest` | nothing; no I/O permitted |
| `FsTest` | a temp workspace per test, removed on teardown even on throw |
| `ProcTest` | child process lifecycle; kill on teardown; no orphans |
| `NetTest` | network, no model |
| `LlmTest` | a resolved profile; may assume §4.2 already passed |
| `UiTest` | an Electron process, headless flags, teardown |

No skip. No soft assert. No expected-failure state. A failing test stays failing
until the feature is fixed.

---

## 4. The gate

### 4.1 Stage 1 — freshness

```
for each feature record:
    now = sha256(path + NUL + content) rolled over entryFiles
    if now != record.freshness.hash:  STALE
```

Copy `hashFiles()` from `.claude/skills/bigpicture/bigpicture.mjs` exactly,
including per-file hashes so the UI can name the drifted file. **Content, never
mtime** — the reasons are in that file's header and in
[0005](0005-the-two-stage-gate.md).

**Any stale record hard-blocks the whole inventory.** No flag bypasses it.
Until [0006](0006-the-gateway-does-not-run-or-brief.md) the block stopped a
test run; nothing runs here now, so what it stops is trust — no record, and no
description written against one, may be taken as describing the code.

Reconciling is a human review followed by a re-record (`POST /api/features/:id/reconcile`),
which rewrites `freshness` and stamps `recordedAt`. Re-recording without
reviewing defeats the mechanism; the UI states this where the button is.

### 4.2 Stage 2 — connection

Checked **at startup**, mirroring the TUI. Reuse `tui/src/profiles.ts` — do not
reimplement; it is already the second copy of this logic and this is the third
(see the promotion debt in [0005](0005-the-two-stage-gate.md)).

```
if workspaceConnected(repoRoot):        proceed — AND keep offering the profiles,
                                        marking which one this folder matches,
                                        plus a way to clear the connection
else if readProfiles().length > 0:      offer the picker; applying writes
                                        <ws>/.env + <ws>/.magentra/settings.json
else:                                   refuse, with the TUI's message:
   "no credentials in this folder and no saved profiles (~/.magentra/profiles.json)
    — define one in the MAGENTRA UI first."
```

Presence, not reachability. No network probe: the suite still runs offline, and
a dead endpoint is a test failure, not a gate failure.

**Connected is not a terminal state** (added 2026-09-09). An earlier reading of
this section offered the picker only while disconnected, which made applying a
profile a one-way door: the picker vanished and the only route back was deleting
two files by hand. Switching endpoints is the ordinary case — a local server for
`proc` tests, a hosted API for `llm` ones — so the connected state carries the
profile list, what the folder currently names, and `POST /api/connection/clear`.

Clearing is **surgical, never `rm`**: it removes the key line from `<ws>/.env`
and the connection keys from `<ws>/.magentra/settings.json`, leaving both files
and every unrelated key in them intact. Neither file is the connection's private
property. A key held in the ENVIRONMENT cannot be cleared by any write to the
folder, so the state names the variable instead of reporting a success the user
cannot see.

The inverse write lives in `tui/src/profiles.ts` beside `applyProfile`, not in
the gateway — this is the promotion debt [0005](0005-the-two-stage-gate.md)
recorded, coming due. Nothing in this repo cleared a connection before, so there
was no fourth copy to avoid, only a first one to put in the right place.

### 4.3 Outcome

One verdict: `BLOCKED`, or not. `BLOCKED` names what could not be verified, and
**the UI may never read green while anything is blocked.** `PASS` and `FAIL`
were run outcomes; they left with the runner
([0006](0006-the-gateway-does-not-run-or-brief.md)).

---

## 5. HTTP API

Serves `127.0.0.1` only. Default port `4320` (prompt-lab holds 4319).

| Method | Route | Does |
| --- | --- | --- |
| GET | `/` | the UI |
| GET | `/api/state` | everything: features (with derived status), descriptions, gate state |
| GET | `/api/features/:id` | one feature, with resolved dependencies (§6) |
| POST | `/api/features` | create/update a record — **approval-gated** |
| POST | `/api/features/:id/reconcile` | re-record freshness — **approval-gated** |
| GET | `/api/descriptions` | every description |
| POST | `/api/descriptions` | create/update a description — **approval-gated** |
| POST | `/api/descriptions/:id/ready` | user-only transition to `ready` |
| POST | `/api/descriptions/:id/draft` | user-only transition back to `draft` |
| DELETE | `/api/descriptions/:id` | remove a description — **approval-gated** |
| POST | `/api/connection/apply` | commit a chosen profile to the workspace (§4.2) — **approval-gated** |
| POST | `/api/connection/clear` | clear this folder's connection so another can be chosen (§4.2) — **approval-gated** |
| GET | `/api/events` | SSE: gate state, description changes, file-watch invalidation |

**Approval-gated** means the write happens only on an explicit user action in
the UI. No route mutates on GET. No route touches git.

---

## 6. Dependency resolution

For a feature, from its `entryFiles`:

1. **Direct + transitive importers** and **fan-out** — from the engine's own
   index, `engine/core/dist/knowledge/graph.js`, imported the way
   `bigpicture.mjs` does it.
2. **Untyped `app/` reach** — which `app/` files reach these, where `tsc` gives
   no protection.
3. **Frame seams** — protocol frame strings the files emit or handle. This is the
   seam `tsc` cannot see at all: rename one and everything still compiles.
4. **Mirrored constants** — the app/engine literal pairs listed in BIG-PICTURE §16.

Call the existing `.claude/skills/bigboycoding/blast-radius.mjs` for 2–4 rather
than growing a second graph reader. If `engine/core/dist/` is absent, degrade to
a "needs `npm run build`" notice — never a silent empty dependency set, which
would tell an agent a feature depends on nothing.

**As built (2026-09-09).** All four come from `blast-radius.mjs`, through a
`--json` mode added to it, because parsing its human output would have BECOME
the second reader the first time a label moved. Two consequences worth recording:

- **The `dist` caveat does not arise.** blast-radius reads source off disk and
  needs no compiled index, so dependencies resolve with a broken build — the
  same property [0002](0002-the-gateway-is-typescript-in-process.md) wanted for
  the gateway itself. The unavailable path is kept for the script going missing,
  and still never returns an empty set as an answer.
- **Item 4 is answered from the inventory, not from a copy of BIG-PICTURE §16.**
  Seven records carry section `Mirrored constants`; a feature whose entry files
  overlap one of them sits on a pair `tsc` cannot compare, and that record
  already states what must agree. A second list would have been a second thing
  to keep in step.

Resolution is lazy and cached per feature **and per freshness hash**, so the
cache invalidates on exactly the event that could make an answer wrong.

---

## 7. Running tests — not here

The gateway does not run tests
([0006](0006-the-gateway-does-not-run-or-brief.md)). The coding agent that
implements a description runs them as the mandatory last step of that work, and
CI runs them the same way: `node --test tests/`, standalone, no gateway.

---

## 8. Handing work to an agent — not here

There is no brief route and no `brief` command
([0006](0006-the-gateway-does-not-run-or-brief.md)). The user writes a
description in the gateway and then tells their coding agent to implement it.
The agent reads the record from `tests/gateway/descriptions/<id>.json`, the
feature from `tests/gateway/features/<feature-id>.json`, and — if it wants the
dependency report — `GET /api/features/:id` or `blast-radius.mjs --json`.

---

## 9. UI

Single page, vanilla JS, no framework and no CDN. The design is organised around
the gate, because the gate is what makes a result trustworthy.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ MAGENTRA GATEWAY   ◉ FRESHNESS ◉ CONNECTION   164 · 155 untested           │
├──────────┬──────────────────┬──────────────────────────┬───────────────────┤
│ DESCRIPT.│ FEATURES         │ THE ONE YOU CLICKED      │ GATE              │
│ draft    │ ───────────────  │ ──────────────────────   │ ───────────       │
│ ready    │ name             │ TEST DESCRIPTION [edit]  │ 3 stale:          │
│ missing  │  draft/ready     │  what · why · where      │  turn-loop        │
│ AREAS    │  kinds · status  │  test checklist 1. 2. 3. │   ↳ session.ts    │
│ engine 94│  fresh/STALE     │ invariant · prose        │ blocked: all      │
│ app    33│                  │ entry files              │ [reconcile]       │
│ …        │  ← 164 of these, │ dependencies (§6)        │ ─────────         │
│ filters: │    scrolls on    │ tests + whyItExists      │ pointed at: …     │
│ kind ▾   │    its own       │ READY ▸ (folded)         │ SWITCH TO / [x]   │
│ status ▾ │                  │  ← title stays put       │                   │
└──────────┴──────────────────┴──────────────────────────┴───────────────────┘
```

Rules the layout must enforce:

- **The gate reads BLOCKED, not merely warned**, unless both lamps are green. There
  is no run button ([0006](0006-the-gateway-does-not-run-or-brief.md)); what the
  red lamp withholds is trust in the inventory, and nothing in the UI reads
  green while it is red.
- The gate panel names the **specific drifted file** per stale feature, not just
  the feature.
- `untested` is visually equal to `failing`, never neutral. 155 untested
  testable features is the current truth and the UI must not make it comfortable.
- Every test row shows its `whyItExists`. If it cannot, that is a finding.
- The connection panel shows what the folder is **pointed at** before offering
  to change it, and every state it can reach has a way out. A gate you can enter
  and not leave gets worked around outside the tool.
- **The feature you clicked is BESIDE the list, never below it** (fixed
  2026-09-09). Stacked, clicking row 140 of 164 rendered the detail off-screen
  and you had to scroll back up to read what you had just selected — which made
  the list the thing you used and the detail the thing you skipped. Four columns,
  each scrolling independently, the detail title sticky, `↑`/`↓` to walk the
  filtered list and `Esc` to close. Under 1240px the list and the detail share
  one column with a way back, rather than compressing to unreadable.
- **A description is written where the feature is read, and it comes first.**
  The detail opens on the TEST DESCRIPTION; prose, invariant, files and
  dependencies follow as reference. Free text, saved to
  `tests/gateway/descriptions/`, where a coding agent reads it (§8). `save`
  and `mark ready` are separate buttons, and saving an edit can never change
  `status` — §2.2's rule made structural rather than remembered.
- **Ready is set apart, in three places that agree.** The nav counts
  `draft / ready / missing` and each is a filter; a ready description is folded
  shut at the bottom of the detail, never mixed with the draft; and the file
  itself sits in `descriptions/ready/` (§2.2).

---

## 10. Deferred, explicitly

Not in v1. Recorded so they are not mistaken for oversights.

| Deferred | Note |
| --- | --- |
| PR-style diff review | v2. Needs hunk anchoring that survives moving lines. |
| Git mutation | No stage/commit/revert. Two writers on one workspace. |
| Run history / trends | Would justify a DB; would be its own decision. |
| MCP server | The committed JSON records are the agent-facing surface ([0006](0006-the-gateway-does-not-run-or-brief.md)). |
| Auto-registration of features from code | A feature is a human concept; the gateway asks, it does not guess. |

---

## 11. Implementation order

1. ~~`schema.ts` + `registry.ts` — records load and validate~~ — **DONE 2026-09-09**: all 164 load; a malformed record names its file and stops the load.
2. ~~Seed inventory in `tests/gateway/features/`~~ — **DONE 2026-09-09**: 164 records written, entry files validated, freshness hashes computed. See `INVENTORY.md`.
3. ~~`freshness.ts` + the gate; assert it hard-blocks~~ — **DONE 2026-09-09**: `hashFiles()` verified digest-identical to `bigpicture.mjs` over all 96 entry files; a one-character edit blocks all 164, a `touch` does not.
4. ~~`connection.ts` over `tui/src/profiles.ts`; all four branches of §4.2~~ — **DONE 2026-09-09**: all four branches exercised; the module imports nothing but that file.
5. ~~`server.ts` + UI read-only. Gate visible, RUN disabled~~ — **DONE 2026-09-09**; `RUN` itself removed later the same day ([0006](0006-the-gateway-does-not-run-or-brief.md)).
6. `tests/lib/` hierarchy; then the first real test end to end.
7. ~~`deps.ts` + `brief.ts`~~ — **DONE 2026-09-09**: `blast-radius.mjs --json` for §6 items 1–3, the inventory for item 4. `brief.ts` removed the same day ([0006](0006-the-gateway-does-not-run-or-brief.md)); `deps.ts` stays, read in the UI.
8. ~~`runner.ts`; RUN enabled~~ — **WITHDRAWN 2026-09-09** ([0006](0006-the-gateway-does-not-run-or-brief.md)): the implementing agent runs the tests, outside the gateway.
9. ~~Descriptions: write, edit, user-only `done`~~ — **DONE 2026-09-09**: saving an edit provably cannot change `status`. Later the same day the states were renamed `draft` / `ready` (§2.2): "done" had read as "the test was done", which a description can never know.

Steps 1–5 are useful before a single test exists — which is the point: the
gateway makes the absence of tests visible and specific.

Steps 7 and 9 were pulled forward out of order on 2026-09-09, on the grounds
that a description with no dependencies attached is the wish §Ability 4 exists
to replace: you can write "test the profile store" in either order, but it is
only worth writing once the dependency panel shows the store's importers, its
untyped `app/` reach and the frame strings it crosses. What remains is step 6
(the class hierarchy, and with it `whyItExists`).
