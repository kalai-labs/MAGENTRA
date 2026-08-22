---
name: bigpicture
description: The system map, and the contract that keeps it true. Use before writing, changing, refactoring, extending or deleting MAGENTRA code to find where something already lives, and after the edit to update the architecture doc so it never rots. Trigger words - big picture, architecture, system map, where does this live, how does this work, orient, onboard, update the docs, is the doc still right, structure, overview, MAP.md, BIG-PICTURE.
---

# bigpicture

Two artifacts, one rule.

| Artifact | What it is | Who writes it |
|---|---|---|
| `docs/big-picture/MAP.md` | Per-file skeleton — exports, members **with line numbers**, import edges | **Generated.** Never hand-edit. |
| `BIG-PICTURE.pdf` | The narrative: why it is built this way, invariants, drift | **You.** Source is `docs/big-picture/big-picture.html`. |

**The rule: read the map before you write, run `check` after you write.**
A change that makes the doc wrong and leaves it wrong is how a repo stops being
understandable. `check` is what makes that failure loud.

Paths below are relative to the repo root.

## Run the driver

```bash
node .claude/skills/bigpicture/bigpicture.mjs impact <file> [file...]   # before editing
node .claude/skills/bigpicture/bigpicture.mjs check                     # after editing
node .claude/skills/bigpicture/bigpicture.mjs map                       # regenerate MAP.md
node .claude/skills/bigpicture/bigpicture.mjs sync                      # re-record after updating the doc
node .claude/skills/bigpicture/bigpicture.mjs render                    # rebuild the PDF
```

`map` and `impact` need `npm run build` first — they read the engine's compiled
index. `check` and `sync` do not.

### Order of work

1. **Orient.** Grep `docs/big-picture/MAP.md` for the thing you are about to
   write. If it already exists, you are editing, not adding. This is the step
   that prevents a second implementation of something.
2. **`impact <file>`** on every file you intend to edit. It names the reach, the
   untyped `app/` files downstream, and **which BIG-PICTURE sections document
   this file**.
3. **`blast-radius.mjs`** (the `bigboycoding` skill) for importer-level detail
   and the frame/symbol seams. `impact` prints the exact command.
4. Write the code. Verify with the gates in `bigboycoding`.
5. **`check`.** Exit 1 and a section list means the doc now claims something
   untrue. Fix `docs/big-picture/big-picture.html`, then `render`, then `sync`.
   If the change genuinely did not alter what a section claims, `sync` alone is
   the right answer — say so in your report.

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
BIG-PICTURE freshness — 14 sections tracked

3 section(s) document code that has changed:

  §6  The finishing ladder
      backed by: engine/core/src/runtime/finishing.ts
      changed:   engine/core/src/runtime/finishing.ts

  §9  Token algebra and context
      backed by: engine/protocol/src/tokens.ts, .../sessionStats.ts, app/renderer/modules/tokens.js
      changed:   app/renderer/modules/tokens.js
```

Exit 0 clean, 1 stale, 2 broken setup — usable in a chain.

## The map's shape

`MAP.md` is 131 files in ~400 lines: 22 hubs in full, then one line each.

```
### `engine/core/src/runtime/session.ts`
*2802L · ↓26 transitive · ←2 direct*

**exports** `isSelfVerifyDone` `SessionOptions` `Session`
**members** `remind:607 runInference:720 describeImage:822 spawnAgent:910
             runTurn:1238 streamAssistantTurn:1737 executeToolCalls:1872 …`
```

The line numbers are the point: jump to `runTurn:1238` instead of reading 2800
lines. Regenerate with `map` whenever you add or move a top-level symbol.

## Adding a section to BIG-PICTURE

Add it to `docs/big-picture/coverage.json` with the paths that back it, then
`sync`. **A section that is not in `coverage.json` never goes stale** — it is
silently exempt from the whole contract, which is worse than not having it.

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
- **Bump `GraphData.version` with any extraction change.** Graph entries are
  reused whenever a file's mtime+size are unchanged, so a scanner fix is
  invisible on every workspace that already has a `.magentra/graph.json`. Two
  scanner defects were fixed on 2026-08-01 (multi-line braced imports produced
  no edge; workspace packages resolved to `pkg:` nodes) and the version went
  1 → 2 precisely so existing caches are rejected and rebuilt. A fix without the
  bump ships as a no-op. The driver's own re-scan workaround was deleted in the
  same change — verified byte-identical edges, so there is one scanner again.
- **`app/renderer/modules/*` have zero import edges.** They are classic scripts
  sharing one global scope, loaded in `index.html` order. Graph reach can never
  find them, so hub ranking gives `app/` a reserved quota — without it the hub
  list came back 22/22 engine files, hiding the half `tsc` does not check. For
  the same reason a protocol change shows no `app reach`: that seam is bare
  frame strings, and only `blast-radius.mjs --frame` sees it.
- **Fan-in alone is the wrong hub score.** It put `util/fsAtomic.ts` (35 lines,
  one export) at #1 and left `session.ts` out entirely. Leaf utilities always
  win a pure-fan-in race and are exactly the files you least need indexed.
  The score is reach + coordination + size, tests excluded.
- **Overlapping coverage is intended.** `app/renderer/modules/tokens.js` is
  tracked by both §9 and §14, so one edit flags both. Read both; usually only
  one is actually wrong.
- **`sync` without editing the doc defeats the point.** It records "I looked at
  this and it is still true." Only run it after you have actually re-read the
  flagged sections.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `!! engine/core is not compiled — run npm run build first` | Real. `map`/`impact` need the compiled index. `check`/`sync` still work. |
| `!! engine/core/dist is missing entirely` | Never built. `npm run build`. |
| `!! <path> — not in the scanned graph` | Typo, or you pointed at `dist/`. Use the `src/` path. |
| `check` flags a section you did not touch | A glob section (`app/main/**/*.js`) caught a sibling edit. Compare the `changed:` list against your diff. |
| `reach 0 direct · 0 transitive` on a renderer module | Expected — classic scripts have no import edges. Not dead code. |
| `render` fails | Needs Electron: `npx electron docs/big-picture/render.mjs`. Takes ~10s. |

## Verified

Every command above was run on 2026-08-01, Windows 11 / Node 24.14, repo at
`655326f`, version 0.16.0:

- `map` → 131 files, 22 hubs, 406 lines
- `sync` → 14 sections recorded
- `check` → clean (exit 0); then with two files edited → 3 sections flagged
  (exit 1), naming the exact changed file in each; reverted → clean again
- `impact` → on `engine/protocol/src/types.ts` (53 transitive, wire-seam
  warning, §4), `app/renderer/modules/tabs.js` (0 edges, §13 + §14),
  `app/main/config.js` (5 untyped `app/` files downstream, §10 + §14)
- `render` → `BIG-PICTURE.pdf`, 36 pages, 587 KB
