---
name: bigboycoding
description: Read before you write. Use when changing, refactoring, renaming, deleting, or extending MAGENTRA code — especially anything in engine/protocol, engine/core/src/runtime, or app/renderer. Maps the blast radius of a change before editing so a local fix does not break the whole app. Trigger words - refactor, rename, change, big picture, what breaks, safe to change, blast radius, don't break.
---

# bigboycoding

Think in whole-system terms before touching a line. This repo has a trap:

```
engine/   75 .ts files   — typechecked by `npm run build` (tsc -b)
tui/      24 .ts/.tsx    — typechecked by `npm run build` (tsc -b)
app/      34 .js/.html   — typechecked by NOTHING
```

`tsc -b` covers `engine/*` and `tui/*`. All of `app/` — the Electron main
process, the preload bridge, and every renderer module — is plain JavaScript
outside the compiler. And as of the 2026-09-09 test reset, **no part of this
repo has a test suite**: `tsc -b` is the only automated gate that exists
anywhere in it.

So the two halves are joined by bare string literals over NDJSON frames. Rename
one and **everything still compiles, every test still passes, and the app breaks
at runtime.** That is the failure this skill exists to prevent.

Paths below are relative to the repo root.

## The rule

Before the first `Edit`, know three things about your target:

1. **Who depends on it** — fan-in, direct and transitive.
2. **Whether it crosses into `app/`** — if yes, the compiler will not protect you.
3. **What proves it still works** — name the exact command before you write code.

Run the driver. Do not skip it because the change "looks like a one-liner" —
a one-line string change is exactly the change this repo punishes.

## Run the driver

```bash
node .claude/skills/bigboycoding/blast-radius.mjs --entrypoints
node .claude/skills/bigboycoding/blast-radius.mjs <file> [file...]
node .claude/skills/bigboycoding/blast-radius.mjs --symbol <Name>
node .claude/skills/bigboycoding/blast-radius.mjs --frame <frame-type>
```

No build, no deps, no args needed to start — it reads source off disk and
indexes 139 files in about a second.

**`<file>`** — risk verdict, exported symbols, fan-out, direct + transitive
importers, which untyped `app/` files reach it, and any export named in `app/`
where tsc cannot see it.

```
$ node .claude/skills/bigboycoding/blast-radius.mjs engine/core/src/agent/prompts.ts
FILE  engine/core/src/agent/prompts.ts
risk        HIGH — 29 files downstream
exports     SECTION_IDENTITY, SECTION_HARNESS, ..., buildSystemPrompt
fan-in      2 direct importer(s), 29 transitive
```

**`--frame <type>`** — the one that matters most. Splits every mention of a
frame string into *emitted* vs *handled*, and flags the `app/` side:

```
$ node .claude/skills/bigboycoding/blast-radius.mjs --frame agent_spawned
emitted / declared (2)
  engine/core/src/runtime/session.ts:806  type: "agent_spawned" as const,
  engine/protocol/src/types.ts:158        type: "agent_spawned";
matched / handled (1)
! app/renderer/modules/landing.js:1016    case "agent_spawned":

1 of these lives in app/ — untyped. Rename this string and the build still passes.
```

Two files, connected by nothing but the characters `agent_spawned`.

**`--symbol <Name>`** — definition site plus every reference, split into
"tsc will catch a break" and "tsc will NOT catch a break."

## Order of work

1. `--entrypoints` if you don't know the repo yet.
2. Run the driver on every file you intend to edit.
3. **Read the fan-in files, not just the target.** The driver names them; open
   them. A caller's assumption is the thing you are about to violate.
4. If anything shows up under `app reach` or `UNTYPED SEAM`, open those
   renderer files and read the handler by hand. Grep the string literal both
   ways — emitter and consumer — and change both in the same edit.
5. Only now write. State what you expect to break and what you expect to hold.
6. Verify with the gates below and report the actual output.

## Verification gates — there is exactly ONE left

```bash
npm run build                        # tsc -b, engine/* + tui/* only. exit 0 = clean
```

That is the whole list. On **2026-09-09 the test suite was reset to zero**:
`app/tests/` (the Electron UI suite and every main-process suite),
`tools/version/test/`, and all seven `*-check.mjs` invariant checks in this
directory were deleted deliberately, to be rebuilt from scratch. `npm run
test:ui`, `test:main` and `test:version` no longer exist as scripts, and the CI
steps that ran them are commented out with `TODO(tests)` markers.

**This makes the skill's rule more important, not less.** `npm run build`
passing means **nothing** about `app/` — 34 untyped `.js`/`.html` files — and
nothing about any invariant tsc cannot see. Until the new suite lands, the
`blast-radius.mjs` reading step below is not a preliminary to verification; it
*is* the verification. Read the fan-in files by hand and say what you checked.

Also still available, and now doing more work than before:

```bash
npm run smoke --workspace app        # boots the real app; nonzero if the renderer crashes
node .claude/skills/bigboycoding/blast-radius.mjs <file>
```

`smoke` catches a window that will not come up. It catches nothing below that.

### What the deleted checks covered — the spec for the rebuild

These are gone, but each one names a real invariant that nothing guards today.
The pattern is worth repeating exactly: import from `engine/*/dist/`, assert the
invariant directly, and confirm the key assertion FAILS when the invariant is
deliberately broken.

| Deleted check | The invariant it held |
|---|---|
| `permission-check.mjs` (23) | Permission-class decisions per tool. |
| `tools-check.mjs` (61 / 27 tools) | Every registered tool has a name, description, real zod schema, valid permission class and `execute` — and the read-only ones (Read, Glob, Grep, TaskList, GraphQuery) are actually RUN against a temp workspace, so "registered" is never mistaken for "working". |
| `addon-check.mjs` (19–28) | Both addon layouts, workspace-over-builtin precedence, `$ARGUMENTS`, the frontmatter parser's real contract, and the load-bearing one: **no addon body ever reaches the standing system prompt** — verified by passing full addons, bodies included, through `buildSystemPrompt`, because handing it summaries proves nothing. Also failed if either call site re-inlined the user-above-addon clause. |
| `glob-state-dir-check.mjs` | `Glob` keeps `.magentra/` out of results unless the pattern or `path` names it. |
| `tui-layout-check.mjs` (61) | The TUI layout core wraps and right-aligns in display CELLS (Ink lays `<Static>` out as an absolutely positioned content-sized box where `flexGrow` never reaches the right edge); folder trust is global, inherited, and matched on path SEGMENTS so `/home/me/work` never trusts `/home/me/workspace`; and the no-reflow guarantee — the live streaming line and the committed line laid out by the same function at the same width. |
| `reasoning-effort-check.mjs` (16) | The context-ceiling probes and effort clamping, over a stub server. |
| `compaction-check.mjs` | The compaction summarizer's sizing against the context window. |

One more invariant was never covered at all: `connection-check.mjs` is cited by
`app/main/config.js`, `engine/core/src/config/providerFactory.ts` and ADR 0007,
but **no such file has ever existed in this repo's history**. The `isLocalBaseUrl`
mirror between app and engine is a pair of literals tsc cannot compare, and the
one test that did compare them (`app/tests/connection.test.js`) is also gone.
`FEATURES.md` is the full backlog; every box in it is empty by design.

Trap that survives the reset:

- **Always confirm a red result is yours**: `git stash push -- engine/`, re-run,
  `git stash pop`. This repo has pre-existing breakage, and the BIG-PICTURE
  freshness `check` in particular reports staleness from other people's work.

## The system map

`bigpicture` is the companion skill: `docs/big-picture/MAP.md` is a generated
per-file skeleton (exports, members with line numbers, import edges) and
`BIG-PICTURE.pdf` is the narrative. Read the map to find where something already
lives before adding a second one; run `bigpicture.mjs check` after your edit so
the architecture doc does not silently rot.

```bash
node .claude/skills/bigpicture/bigpicture.mjs impact <file>   # before editing
node .claude/skills/bigpicture/bigpicture.mjs check           # after editing
```

## Gotchas

- **`engine/protocol/src/types.ts` has 55 transitive importers and one direct
  one.** The fan-in number understates it: everything goes through
  `engine/protocol/src/index.ts` as a barrel re-export, so the graph looks
  narrow and the real reach is the whole engine.
- **A type-only export cannot break `app/` by name** — `app/` never imports it.
  It breaks by *shape*. `--symbol` on an interface name is the wrong query;
  `--frame` on the wire string is the right one.
- **NodeNext import specifiers say `.js` but the file on disk is `.ts`.** Any
  grep for `from "./foo.ts"` finds nothing. The driver resolves this; a naive
  search won't.
- **`engine/core/src/index.ts` is a barrel.** Adding an export there quietly
  widens the public surface of `@magentra/core`. Check whether you meant to.
- **Session is the hub.** `engine/core/src/runtime/session.ts` is ~2200 lines
  and imports most of the engine. Changes there have the widest reach of any
  single file; read the specific method and its callers, never skim the file.
- **`engine/*/dist/` is committed and stale-able.** The driver skips `dist/`
  deliberately — if you grep and get hits in `dist/`, you are reading build
  output, not source.
- **The system prompt is one file.** `engine/core/src/agent/prompts.ts` — every
  behavior section is a `SECTION_*` export composed by `behaviorCore()`.
  Editing prose there changes every session's system prompt; there is no test
  that catches a regression in it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `!! <path> — not in the scanned graph` | Path typo, or you pointed at `dist/`/`node_modules/`. Use the `src/` path. |
| `fan-in 0 direct importers` on a file you know is used | It's reached dynamically (skills, team `.md` loaders) or it's an entrypoint. Grep the bare filename before concluding it's dead. |
| Driver prints a symbol found in `index.html` | Renderer HTML is English prose; type names word-match UI labels. The `<file>` seam scan already skips `.html` for this reason — `--symbol` does not, so read those hits with suspicion. |
| `npm run build` clean but the app misbehaves | Expected. The build does not see `app/`. Re-check with `--frame`. |
