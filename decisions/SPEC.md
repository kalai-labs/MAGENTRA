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
│   ├── runner.ts           node:test programmatic run() (§7)
│   ├── brief.ts            agent briefing assembly (§8) — JSON and Markdown
│   └── ui/
│       ├── index.html      single page, no framework, no CDN
│       ├── app.js          vanilla; SSE consumer
│       └── style.css
tests/
├── lib/                    the class hierarchy (§3)
├── features/               <feature-id>.test.ts, one per feature
└── gateway/
    ├── features/           <feature-id>.json     committed
    └── descriptions/       <id>.json             committed
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
  status: "pending" | "done",
  createdAt: string,
  updatedAt: string
}
```

`status` moves to `done` **only by explicit user action, after verification.**
The gateway may *suggest* it ("a test for this feature now exists — mark done?")
and must never apply it. Auto-closing on file existence is how a scaffold test
silently satisfies a real directive.

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

**Any stale record hard-blocks the whole run.** No flag bypasses it.

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

### 4.3 Outcomes

`PASS` · `FAIL` · `BLOCKED`. `BLOCKED` is not a pass, exits non-zero, and names
what could not be verified. **A summary may never read green while anything is
blocked.**

---

## 5. HTTP API

Serves `127.0.0.1` only. Default port `4320` (prompt-lab holds 4319).

| Method | Route | Does |
| --- | --- | --- |
| GET | `/` | the UI |
| GET | `/api/state` | everything: features (with derived status), descriptions, gate state |
| GET | `/api/features/:id` | one feature, with resolved dependencies (§6) |
| GET | `/api/features/:id/brief` | the agent briefing (§8); `?format=md` for the Markdown an agent is handed |
| POST | `/api/features` | create/update a record — **approval-gated** |
| POST | `/api/features/:id/reconcile` | re-record freshness — **approval-gated** |
| GET | `/api/descriptions` | every description |
| POST | `/api/descriptions` | create/update a description — **approval-gated** |
| POST | `/api/descriptions/:id/done` | user-only transition to `done` |
| POST | `/api/descriptions/:id/reopen` | user-only transition back to `pending` |
| DELETE | `/api/descriptions/:id` | remove a description — **approval-gated** |
| POST | `/api/connection/apply` | commit a chosen profile to the workspace (§4.2) — **approval-gated** |
| POST | `/api/connection/clear` | clear this folder's connection so another can be chosen (§4.2) — **approval-gated** |
| POST | `/api/run` | run tests — **approval-gated**, refuses if gate red |
| GET | `/api/events` | SSE: gate state, run progress, file-watch invalidation |

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

## 7. Runner

`node:test`'s programmatic `run()` (available on Node 24; confirmed). Structured
results, no TAP parsing. Runs `tests/features/*.test.ts` through `tsx`. Streams
progress over SSE. Results live in memory for the life of the run and are not
persisted ([0003](0003-storage-is-committed-json-per-feature.md)).

`node --test tests/` must work standalone, without the gateway. CI uses that.

---

## 8. Agent briefing

`GET /api/features/:id/brief` and `npm run gateway -- brief <feature-id>` return
one document containing: the feature's prose, kinds, invariant, `entryFiles`,
resolved dependencies (§6), existing tests with their `whyItExists`, and every
`pending` description targeting it.

This is the payload that makes ability 4 real: an agent asked to write tests
gets told what else to check, without guessing. Keep it stable — it is a
contract other tools consume.

---

## 9. UI

Single page, vanilla JS, no framework and no CDN. The design is organised around
the gate, because the gate is what makes a result trustworthy.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ MAGENTRA GATEWAY   ◉ FRESHNESS ◉ CONNECTION   164 · 155 untested  [ RUN ]  │
├──────────┬──────────────────┬──────────────────────────┬───────────────────┤
│ AREAS    │ FEATURES         │ THE ONE YOU CLICKED      │ GATE              │
│ engine 94│ ───────────────  │ ──────────────────────   │ ───────────       │
│ app    33│ name             │ prose · invariant        │ 3 stale:          │
│ protocol │  kinds · status  │ entry files              │  turn-loop        │
│ tooling  │  fresh/STALE     │ dependencies (§6)        │   ↳ session.ts    │
│ tui      │                  │ tests + whyItExists      │ blocked: all      │
│ providers│  ← 164 of these, │ WHAT TO TEST  [editable] │ [reconcile]       │
│          │    scrolls on    │ [ hand to an agent ]     │ ─────────         │
│ filters: │    its own       │                          │ pointed at: …     │
│ kind ▾   │                  │  ← scrolls on its own,   │ SWITCH TO / [x]   │
│ status ▾ │                  │    title stays put       │                   │
└──────────┴──────────────────┴──────────────────────────┴───────────────────┘
```

Rules the layout must enforce:

- **RUN is disabled, not merely warned**, unless both lamps are green. You cannot
  reach a green result by not looking at the red one.
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
- **A description is written where the feature is read.** Free text, saved to
  `tests/gateway/descriptions/`, delivered to an agent inside the brief. `save`
  and `mark done` are separate buttons, and saving an edit can never change
  `status` — §2.2's rule made structural rather than remembered.

---

## 10. Deferred, explicitly

Not in v1. Recorded so they are not mistaken for oversights.

| Deferred | Note |
| --- | --- |
| PR-style diff review | v2. Needs hunk anchoring that survives moving lines. |
| Git mutation | No stage/commit/revert. Two writers on one workspace. |
| Run history / trends | Would justify a DB; would be its own decision. |
| MCP server | The JSON export + CLI brief cover agent consumption first. |
| Auto-registration of features from code | A feature is a human concept; the gateway asks, it does not guess. |

---

## 11. Implementation order

1. ~~`schema.ts` + `registry.ts` — records load and validate~~ — **DONE 2026-09-09**: all 164 load; a malformed record names its file and stops the load.
2. ~~Seed inventory in `tests/gateway/features/`~~ — **DONE 2026-09-09**: 164 records written, entry files validated, freshness hashes computed. See `INVENTORY.md`.
3. ~~`freshness.ts` + the gate; assert it hard-blocks~~ — **DONE 2026-09-09**: `hashFiles()` verified digest-identical to `bigpicture.mjs` over all 96 entry files; a one-character edit blocks all 164, a `touch` does not.
4. ~~`connection.ts` over `tui/src/profiles.ts`; all four branches of §4.2~~ — **DONE 2026-09-09**: all four branches exercised; the module imports nothing but that file.
5. ~~`server.ts` + UI read-only. Gate visible, RUN disabled~~ — **DONE 2026-09-09**: `RUN` carries the `disabled` attribute and is bound to `gate.runAllowed`.
6. `tests/lib/` hierarchy; then the first real test end to end.
7. ~~`deps.ts` + `brief.ts`~~ — **DONE 2026-09-09**: `blast-radius.mjs --json` for §6 items 1–3, the inventory for item 4; the brief renders as JSON and as Markdown from one assembly, over HTTP and from `npm run gateway -- brief <id>`.
8. `runner.ts`; RUN enabled.
9. ~~Descriptions: write, edit, user-only `done`~~ — **DONE 2026-09-09**: saving an edit provably cannot change `status`; a `done` description drops out of the brief.

Steps 1–5 are useful before a single test exists — which is the point: the
gateway makes the absence of tests visible and specific.

Steps 7 and 9 were pulled forward out of order on 2026-09-09, on the grounds
that a description with no dependencies attached is the wish §Ability 4 exists
to replace: you can write "test the profile store" in either order, but it is
only worth handing to an agent once the brief carries the store's importers, its
untyped `app/` reach and the frame strings it crosses. What remains is step 6
(the class hierarchy, and with it `whyItExists`) and step 8 (the runner).
