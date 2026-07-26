---
name: bigboycoding
description: Read before you write. Use when changing, refactoring, renaming, deleting, or extending MAGENTRA code — especially anything in engine/protocol, engine/core/src/runtime, or app/renderer. Maps the blast radius of a change before editing so a local fix does not break the whole app. Trigger words - refactor, rename, change, big picture, what breaks, safe to change, blast radius, don't break.
---

# bigboycoding

Think in whole-system terms before touching a line. This repo has a trap:

```
engine/   87 .ts files   — typechecked by `npm run build` (tsc -b)
app/      39 .js/.html   — typechecked by NOTHING
```

`tsc -b` covers **only `engine/*`**. All of `app/` — the Electron main process,
the preload bridge, and every renderer module — is plain JavaScript outside the
compiler. And `engine/*` has **no unit test suite at all**; tsc is its only
automated gate.

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
emitted / declared (3)
  engine/core/src/runtime/session.ts:806  type: "agent_spawned" as const,
  engine/protocol/src/types.ts:158        type: "agent_spawned";
  app/tests/ui.e2e.js:363                 await emit({ type: "agent_spawned", ...
matched / handled (1)
! app/renderer/modules/landing.js:1016    case "agent_spawned":

2 of these live in app/ — untyped. Rename this string and the build still passes.
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

## Verification gates (all four exist and were run)

```bash
npm run build                        # tsc -b, engine/* only. ~fast. exit 0 = clean
npm run test:ui                      # app/tests/run-ui-tests.js
npm run test:main --workspace app    # changes / window / connection / reasoning
npm run test:version                 # tools/version
```

`npm run build` passing means **nothing** about `app/`. If your change touched a
frame type, a field name on a frame, or anything in `engine/protocol/`, the
build is not evidence — you must exercise the UI path.

Two traps in the gates themselves:

- **`app/tests/changes.test.js` fails on a Windows checkout** — a CRLF/LF
  assertion (`'const theme = 'old';\r\n'` vs `\n`), unrelated to any change you
  make. Both `test:main` and root `test:ui` chain with `&&`, so this one failure
  silently prevents the other four suites from running. Run them directly:
  `node app/tests/run-ui-tests.js` (25 Electron scenarios), plus
  `node app/tests/{window,connection}.test.js` and `reasoning.test.mjs`.
- **Always confirm a red test is yours**: `git stash push -- engine/`, re-run,
  `git stash pop`. This repo has pre-existing failures.

`engine/*` has no unit test suite, so behavior changes there need a purpose-built
check against the built output. See `permission-check.mjs` in this directory for
the pattern — it imports from `engine/core/dist/` and asserts the permission
invariants directly:

```bash
npm run build && node .claude/skills/bigboycoding/permission-check.mjs
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
