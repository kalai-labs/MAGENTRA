# tests/

All MAGENTRA tests live here, permanently. Nothing else in the repository holds
tests.

```
tests/
├── lib/                          the test class hierarchy (not yet written)
├── features/<feature-id>.test.ts one file per feature (not yet written)
└── gateway/
    └── features/<feature-id>.json  the inventory — 164 records, committed
```

## Status

**There are no tests yet.** The previous suite was deleted on 2026-09-09 (21
files, 6,366 lines) because 28 of its ticked boxes had no assertion behind them.
The inventory in `gateway/features/` is the backlog, and it is verified against
the source rather than against `FEATURES.md`.

## Why the inventory comes first

A test that cannot say which feature it proves, and why it exists, is the
scaffold this reset removed. So a feature record exists before its test, and the
record carries the dependency information an agent needs in order to write that
test without guessing what else it touches.

Design and rationale: [`../decisions/`](../decisions/). Read
`decisions/SPEC.md` before adding anything here.

## The rules that are not negotiable

1. **A feature is in the inventory before its code is written.** The gateway is
   the single source of truth; code implementing an unregistered feature cannot
   be reasoned about.
2. **Tests inherit on kind**, not on area. `pure` / `fs` / `proc` / `net` /
   `llm` / `ui` decide setup, teardown, and whether the test can run at all.
3. **Every test states `whyItExists`** — the failure it would have caught.
4. **A failing test stays failing until the feature is fixed correctly.** No
   skip, no soft assertion, no expected-failure state.
5. **`node --test tests/` must work without the gateway.** A broken tool must
   never mean no tests.
6. **Stale blocks everything.** If any record's entry files have changed since
   the record was last reviewed, no test runs until it is reconciled.
7. **No connection, no run** — whether or not the test involves a model.

## The 164 records

| Section | Records |
| --- | --- |
| Tools | 31 |
| Desktop app | 26 |
| Runtime — the turn loop | 23 |
| Tooling | 13 |
| Addons | 10 |
| Protocol & host | 10 |
| Scheduling | 8 |
| Packaging | 7 |
| Mirrored constants | 7 |
| Terminal UI | 6 |
| OVERDRIVE · Finishing rungs · Agent · Knowledge · Config | 4 each |
| State | 3 |

155 are testable now. 9 are `deferred: true` — renderer-only features, excluded
at this stage by decision, not by oversight.
