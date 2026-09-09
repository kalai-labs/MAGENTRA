# magentra-gateway — implementation specification

Status: **design settled 2026-09-09, not implemented.**
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
│   ├── deps.ts             dependency resolution (§6)
│   ├── runner.ts           node:test programmatic run() (§7)
│   ├── brief.ts            agent briefing assembly (§8)
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
  area: "engine" | "app" | "tui" | "protocol" | "tooling",
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
if workspaceConnected(repoRoot):        proceed
else if readProfiles().length > 0:      offer the picker; applying writes
                                        <ws>/.env + <ws>/.magentra/settings.json
else:                                   refuse, with the TUI's message:
   "no credentials in this folder and no saved profiles (~/.magentra/profiles.json)
    — define one in the MAGENTRA UI first."
```

Presence, not reachability. No network probe: the suite still runs offline, and
a dead endpoint is a test failure, not a gate failure.

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
| GET | `/api/features/:id/brief` | the agent briefing (§8) |
| POST | `/api/features` | create/update a record — **approval-gated** |
| POST | `/api/features/:id/reconcile` | re-record freshness — **approval-gated** |
| POST | `/api/descriptions` | create/update a description — **approval-gated** |
| POST | `/api/descriptions/:id/done` | user-only transition to `done` |
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
┌────────────────────────────────────────────────────────────┐
│ MAGENTRA GATEWAY    ◉ FRESHNESS  ◉ CONNECTION   [ RUN ]    │  ← header
├──────────┬─────────────────────────────────┬───────────────┤
│ AREAS    │  feature list / feature detail  │ GATE          │
│ engine 62│  ─────────────────────────────  │ ─────────     │
│ app    26│  name · kinds · status · fresh  │ 3 stale:      │
│ tui     6│  prose                          │  turn-loop    │
│ protocol│  entry files                     │   ↳ session.ts│
│ tooling │  dependencies (§6)               │ blocked: all  │
│          │  tests + whyItExists            │               │
│ filters: │  descriptions                   │ [reconcile]   │
│ kind ▾   │                                 │               │
│ status ▾ │                                 │               │
└──────────┴─────────────────────────────────┴───────────────┘
```

Rules the layout must enforce:

- **RUN is disabled, not merely warned**, unless both lamps are green. You cannot
  reach a green result by not looking at the red one.
- The gate panel names the **specific drifted file** per stale feature, not just
  the feature.
- `untested` is visually equal to `failing`, never neutral. 112 untested
  features is the current truth and the UI must not make it comfortable.
- Every test row shows its `whyItExists`. If it cannot, that is a finding.

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

1. `schema.ts` + `registry.ts` — records load and validate.
2. ~~Seed inventory in `tests/gateway/features/`~~ — **DONE 2026-09-09**: 164 records written, entry files validated, freshness hashes computed. See `INVENTORY.md`.
3. `freshness.ts` + the gate; assert it hard-blocks.
4. `connection.ts` over `tui/src/profiles.ts`; all four branches of §4.2.
5. `server.ts` + UI read-only. Gate visible, RUN disabled.
6. `tests/lib/` hierarchy; then the first real test end to end.
7. `deps.ts` + `brief.ts`.
8. `runner.ts`; RUN enabled.
9. Descriptions: write, edit, user-only `done`.

Steps 1–5 are useful before a single test exists — which is the point: the
gateway makes the absence of tests visible and specific.
