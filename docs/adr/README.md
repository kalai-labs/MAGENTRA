# Product decisions

Architecture decisions about what MAGENTRA the product does — the import graph,
the version scheme, how updates work. Each one records the context, the choice,
and what it costs.

| ADR | Decision |
| --- | --- |
| [0004](0004-the-import-graph-has-two-tiers.md) | The import graph has two tiers: real edges where an import names a file, nodes only where it cannot |
| [0008](0008-the-version-is-semver.md) | The version is semver, and every push to `main` releases |
| [0009](0009-updates-have-two-tiers.md) | Updates have two tiers, decided by install format |

The numbers have gaps on purpose. The ADRs that held the other numbers were
retired when the code they described changed; git history has them. A new
decision takes the next number after the highest one ever used (0010), never a
gap.

Decisions about how MAGENTRA is **tested** — the feature gateway and the test
suite — are a separate series in [`docs/decisions/`](../decisions/README.md).
