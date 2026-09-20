# Tests inherit on kind; area is metadata

`FEATURES.md` already classifies every feature by what a real test for it would
need: `pure`, `fs`, `proc`, `net`, `llm`, `ui`. That vocabulary is three years
of judgement already made, and it is the right axis for a class hierarchy —
because kind decides two things nothing else decides: what setup and teardown a
test needs, and **whether the test can run at all**.

Area (engine / app / tui / protocol / tooling) decides nothing at runtime. It is
a filter, so it is a field.

## The hierarchy

```
FeatureTest                     abstract base
├─ PureTest                     no I/O; assert on inputs and outputs
├─ FsTest                       temp workspace, created and removed per test
├─ ProcTest                     spawns a real process; owns its lifecycle
├─ NetTest                      network, no model
├─ LlmTest                      needs a resolved connection profile
└─ UiTest                       spawns Electron
```

The base carries what every test must declare and cannot omit:

| Member | Meaning |
| --- | --- |
| `featureId` | the inventory record this test proves. Required. |
| `invariant` | one sentence: what is true while this feature works |
| `whyItExists` | the failure this test would have caught. Required — ability 2 of the gateway is *why*, and a test that cannot say why it exists is the scaffold this whole effort was reset to remove |
| `kind` | fixed by the subclass |
| `run()` | the assertion |

## The rule that makes it worth having

**A failing feature test stays failing until the feature is fixed correctly.**
Not until it is made to pass. There is no skip, no soft assertion, and no
"expected failure" state. `FEATURES.md` already states the standard this comes
from — *a test that asserts a mock returned what the mock was told to return is
not a test* — and the 28 boxes unticked on 2026-09-09 are what ignoring it
costs.

## Layout

All tests live under `tests/`, at the repository root, permanently.

```
tests/
├── lib/                      the class hierarchy and shared helpers
├── features/<feature-id>.test.ts    one file per feature
└── gateway/                  the inventory (see 0003)
    ├── features/<feature-id>.json
    └── descriptions/<id>.json
```

One file per feature id, rather than a tree by kind or by area. Three reasons:
the gateway-to-test mapping is mechanical with no path convention to infer; a
feature needing two kinds (`pure` + `llm`, which 22 features do) is not split
across two trees; and per-file granularity keeps merges conflict-free for the
same reason the inventory is per-file.

Kind lives inside the file, as the class it extends.
