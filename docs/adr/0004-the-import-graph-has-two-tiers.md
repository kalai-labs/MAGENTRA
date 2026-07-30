# The import graph has two tiers

The import graph only parsed TypeScript, JavaScript and Python, so in a Go,
Rust, Java or C# repository it came back empty — and an empty graph means
`GraphQuery slice` returns nothing and a request has no source for where the work
lands. We widened it, but not uniformly, because languages genuinely differ in
whether an import names a file.

**Tier 1 — real edges.** C/C++/Obj-C, Ruby, PHP, Java, Kotlin, Go and Rust each
get an extractor and a resolver. Their imports resolve to files, either directly
(`#include "foo.h"`, `require_relative`) or by a well-known convention
(`com.example.Foo` → `**/com/example/Foo.java`, a Go import path → every `.go`
file in that package directory).

**Tier 2 — nodes only.** Every other source language is scanned into the graph
as a node with no imports. Swift and C# are here on purpose: Swift imports
modules rather than files, and a C# `using` names a namespace that need not
correspond to any path. Inventing edges for them would be guessing.

## Consequences

- A Tier 2 repository still gets a useful graph. `slice` seeds by matching the
  request against file paths and symbols, so files without edges are still
  found and ranked — which is the failure that mattered, since an empty graph
  returned nothing at all.
- The existing rule holds everywhere: **drop the edge when unsure.** A
  conservative miss is cheap; an invented edge poisons PageRank, the blast
  radius, and every consumer downstream.
- `SCAN_EXTS` is shared with `symbols.ts`, so widening the graph widens the
  symbol index too. Both files need the per-language switch — a Go file sent to
  the TypeScript symbol extractor yields nothing, silently.
- Resolution of Java/Kotlin/PHP namespaces and Go packages needs the whole file
  list, not just the file being scanned, so `buildGraph` collects paths first
  and resolves second. The incremental mtime+size cache is unaffected: cached
  entries keep their already-resolved imports.
