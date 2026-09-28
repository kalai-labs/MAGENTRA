---
name: bigpicture
description: The system map, and the contract that keeps it true. Use before writing, changing, refactoring, extending or deleting MAGENTRA code to find where something already lives, and after the edit to update the architecture doc so it never rots. Trigger words - big picture, architecture, system map, where does this live, how does this work, orient, onboard, update the docs, is the doc still right, structure, overview, MAP.md, BIG-PICTURE.
---

# bigpicture

Two documents, one rule.

| Document | What it is | Who writes it |
|---|---|---|
| `docs/big-picture/MAP.md` | Per-file skeleton — exports, members **with line numbers**, import edges | **Generated.** Never hand-edit. |
| `docs/big-picture/BIG-PICTURE.md` | The narrative: how each part works, why it is built that way, invariants, drift | **You.** Plain Markdown, no build step. |

`docs/big-picture/coverage.json` binds them to the code: every `## §N · Title`
section of BIG-PICTURE.md lists the paths that back it, with a hash of their
content at the time the section was last known true.

**The rule: read the map before you write, run `check` after you write.**
A change that makes the doc wrong and leaves it wrong is how a repo stops being
understandable. `check` is what makes that failure loud.

Paths below are relative to the repo root.

## Run the driver

```bash
node .claude/skills/bigpicture/bigpicture.mjs impact <file> [file...]   # before editing
node .claude/skills/bigpicture/bigpicture.mjs check                     # after editing
node .claude/skills/bigpicture/bigpicture.mjs map                       # regenerate MAP.md
node .claude/skills/bigpicture/bigpicture.mjs sync [--section N]        # re-record after updating the doc
```

`map` and `impact` need `npm run build` first — they read the engine's compiled
index. `check` and `sync` do not.

### Order of work

1. **Orient.** Grep `docs/big-picture/MAP.md` for the thing you are about to
   write, and read the BIG-PICTURE section that owns the area (§17 is a
   concept → file index). If it already exists, you are editing, not adding.
   This is the step that prevents a second implementation of something.
2. **`impact <file>`** on every file you intend to edit. It names the reach, the
   untyped `app/` files downstream, and **which BIG-PICTURE sections document
   this file**.
3. **`blast-radius.mjs`** (the `bigboycoding` skill) for importer-level detail
   and the frame/symbol seams. `impact` prints the exact command.
4. Write the code. Verify with the gates in `bigboycoding`.
5. **`check`.** Exit 1 and a section list means the doc now claims something
   untrue. Fix that section of `docs/big-picture/BIG-PICTURE.md` (or the paths
   in `coverage.json`, if a file moved), then `sync`. If the change genuinely
   did not alter what a section claims, `sync --section N` alone is the right
   answer — say so in your report.
6. **`map`** if you added, removed or moved a top-level symbol or a file.

`check` is cheap and safe to run any time. Treat a non-empty result as a task,
not a warning.

## What `impact` gives you

```
$ node .claude/skills/bigpicture/bigpicture.mjs impact engine/protocol/src/types.ts
FILE  engine/protocol/src/types.ts
  reach       2 direct · 53 transitive importers
  exports     PROTOCOL_VERSION, TaskStatus, TaskItem, Usage, ...
  !! wire seam  app/ consumes this by frame STRING, not by import —
                graph reach cannot see it. For each frame you touch:
                node .claude/skills/bigboycoding/blast-radius.mjs --frame <type>
  documented in BIG-PICTURE:
      §4  The protocol — the seam
      → if your change alters what those sections claim, update them.
```

## What `check` gives you

```
$ node .claude/skills/bigpicture/bigpicture.mjs check
BIG-PICTURE freshness — 19 sections tracked

2 section(s) document code that has changed:

  §6  The finishing ladder
      backed by: engine/core/src/runtime/finishing.ts
      changed:   engine/core/src/runtime/finishing.ts
```

Besides changed files, `check` names a backing path that no longer exists
(`missing:`), a section heading in BIG-PICTURE.md that coverage.json does not
track (`NOT TRACKED`), and a coverage entry whose heading is gone. All of them
exit 1.

Exit 0 clean, 1 stale, 2 broken setup — usable in a chain.

## The map's shape

`MAP.md` lists every scanned file in one line each (325 files, 1117 lines on
2026-09-28), and 22 hubs in full:

```
### `engine/core/src/runtime/session.ts`
*3353L · ↓120 transitive · ←2 direct*

**exports** `isSelfVerifyDone` `addonNamedIn` `SessionOptions` `Session`
**members** `remind:695 runInference:808 describeImage:910 spawnAgent:1001 runTurn:1341 …`
```

The line numbers are the point: jump to `runTurn:1341` instead of reading 3353
lines. The transitive count includes the test files that import a module. They are only as fresh as the last `map`, which is why BIG-PICTURE.md
cites files and symbols, never line numbers.

## Adding a section to BIG-PICTURE

Write it as `## §N · Title` (the next unused number — never renumber: other
files cite sections by number, e.g. §16 "Mirrored constants"), add an entry to
`coverage.json` with the paths that back it, then `sync --section N`. `check`
refuses a heading with no coverage entry, because a section outside the
contract never goes stale — worse than not having it.

Paths in coverage.json are literal files, `dir/**`, or `dir/**/*.ext`. Nothing
else expands.

## Gotchas

- **`map`/`impact` read `engine/core/dist/`, not source.** They import the
  engine's own graph + symbol index — the same one `GraphQuery` serves at
  runtime — deliberately, so the map cannot disagree with what the agent sees.
  The driver runs `tsc -b --dry` first and refuses to emit from a stale build.
- **`tsc -b --dry`, not mtimes.** Two mtime schemes were tried and both were
  wrong. Comparing source against one `dist` file reports a 53-hour-stale build
  seconds after a successful one, because `tsc -b` never re-emits an unchanged
  file. Comparing newest-source against newest-`dist` breaks worse: `git
  checkout` rewrites mtimes with identical content, so the guard fires on a
  clean tree and `npm run build` **cannot** clear it — tsc correctly emits
  nothing. Ask the compiler.
- **Hashes fold CRLF to LF.** The repo has `core.autocrlf=true` and no
  `.gitattributes`, so the same commit is CRLF on Windows and LF on a Mac. Until
  2026-09-28 the hashes were raw bytes, and a coverage file recorded on one
  machine read 14 of 14 sections stale on the other with nothing changed. The
  gateway's `tools/magentra-gateway/src/freshness.ts` made the same fix first.
- **A `package.json` is hashed without its `version`.** Every release bumps
  eight manifests; a section backed by them must not go stale on every push to
  `main` when nothing it describes changed. For the same reason `VERSION` is
  never a backing path, and a gateway record is hashed without its `freshness`
  block, which every reconcile rewrites.
- **Bump `GraphData.version` with any extraction change.** Graph entries are
  reused whenever a file's mtime+size are unchanged, so a scanner fix is
  invisible on every workspace that already has a `.magentra/graph.json`. Two
  scanner defects were fixed on 2026-08-01 (multi-line braced imports produced
  no edge; workspace packages resolved to `pkg:` nodes) and the version went
  1 → 2 precisely so existing caches are rejected and rebuilt. A fix without the
  bump ships as a no-op.
- **`app/renderer/modules/*` have zero import edges.** They are classic scripts
  sharing one global scope, loaded in `index.html` order. Graph reach can never
  find them, so hub ranking gives `app/` a reserved quota — without it the hub
  list came back 22/22 engine files, hiding the half `tsc` does not check. For
  the same reason a protocol change shows no `app reach`: that seam is bare
  frame strings, and only `blast-radius.mjs --frame` sees it.
- **Fan-in alone is the wrong hub score.** It put `util/fsAtomic.ts` (35 lines,
  one export) at #1 and left `session.ts` out entirely. The score is reach +
  coordination + size, tests excluded.
- **Overlapping coverage is intended.** A file backing two sections flags both
  on one edit. Read both; usually only one is actually wrong.
- **`sync` without reading the doc defeats the point.** It records "I looked at
  this and it is still true." Only run it after you have actually re-read the
  flagged sections.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `!! engine/core is not compiled — run npm run build first` | Real. `map`/`impact` need the compiled index. `check`/`sync` still work. |
| `!! engine/core/dist is missing entirely` | Never built. `npm run build`. |
| `!! <path> — not in the scanned graph` | Typo, or you pointed at `dist/`. Use the `src/` path. |
| `check` flags a section you did not touch | A glob section (`app/main/**/*.js`) caught a sibling edit. Compare the `changed:` list against your diff. |
| `missing: <path>` | A backing file was moved or deleted. Point coverage.json at its new home (or drop it), re-read the section, `sync`. |
| `reach 0 direct · 0 transitive` on a renderer module | Expected — classic scripts have no import edges. Not dead code. |
