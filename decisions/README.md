# Decisions

Architecture decisions for **magentra-gateway** — the single source of truth for
every feature MAGENTRA ships, the tests that prove each one, and the reasons
those tests exist.

Records live here rather than in `docs/` because `docs/` is already dense with
reference material; these are *decisions*, and a decision is worth finding on
its own. `docs/adr/` remains where product-level decisions are recorded
(0004–0009). Gateway decisions are numbered independently in this folder.

## How to read this folder

Read in order. Each record states the constraint it is built on, the options
considered, the decision, and what it forecloses. A record is never edited to
change its meaning: it is superseded by a later record that names it.

| Record | Decides |
| --- | --- |
| [0001](0001-the-gateway-is-the-inventory.md) | What the gateway is, and that the inventory leads the code |
| [0002](0002-the-gateway-is-typescript-in-process.md) | Language and runtime, and why not Python |
| [0003](0003-storage-is-committed-json-per-feature.md) | Where records live, and why not SQLite |
| [0004](0004-tests-inherit-on-kind.md) | The test class hierarchy and `tests/` layout |
| [0005](0005-the-two-stage-gate.md) | Freshness and connection gating, and hard-block semantics |
| [SPEC.md](SPEC.md) | The implementation specification |
| [INVENTORY.md](INVENTORY.md) | Verified feature count, and the three gaps `FEATURES.md` has |
| [inventory-notes/](inventory-notes/) | Per-area reading notes the inventory was built from |

## Status

Design settled 2026-09-09 over four grilling rounds. **`SPEC.md` §11 steps 1–5,
7 and 9 are implemented** — the inventory loads and validates, the two-stage
gate is live and hard-blocking, dependencies resolve, descriptions are writable,
and `npm run gateway` serves the lot. What remains is step 6 (the test class
hierarchy, and with it `whyItExists`) and step 8 (the runner), so `RUN` reaches
a `501` rather than a result.

`SPEC.md` is the contract an implementer works from; if the implementation and
the spec disagree, that is a bug in one of them, not a matter of taste.

The seed inventory is verified against the source, not against `FEATURES.md`:
see `INVENTORY.md` for the count and the three gaps it found.
