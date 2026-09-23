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
outside the compiler. The feature suite in `tests/` (see *Verification gates*)
reaches `app/` only where a `ui` test drives the real app, and those run only
under `npm run test:ui` — a plain `npm test` never launches the app.

So the two halves are joined by bare string literals over NDJSON frames. Rename
one and **everything still compiles, `npm test` can stay green, and the app
breaks at runtime** — unless a `ui` test happens to drive that exact frame.
That is the failure this skill exists to prevent.

Paths below are relative to the repo root.

## The rule

Before the first `Edit`, know three things about your target:

1. **Who depends on it** — fan-in, direct and transitive.
2. **Whether it crosses into `app/`** — if yes, the compiler will not protect you.
3. **What proves it still works** — name the exact command and the feature's
   own test file (`tests/features/<feature-id>.test.ts`) before you write code.

Run the driver. Do not skip it because the change "looks like a one-liner" —
a one-line string change is exactly the change this repo punishes.

## Run the driver

```bash
node .claude/skills/bigboycoding/blast-radius.mjs --entrypoints
node .claude/skills/bigboycoding/blast-radius.mjs <file> [file...]
node .claude/skills/bigboycoding/blast-radius.mjs --symbol <Name>
node .claude/skills/bigboycoding/blast-radius.mjs --frame <frame-type>
node .claude/skills/bigboycoding/blast-radius.mjs --json <file> [file...]
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

**`--json <file...>`** — the same facts as `<file>`, as one JSON object keyed by
path, for a tool rather than a human: `risk`, `exports`, `fanOut`,
`directImporters`, `transitiveImporters`, `untypedAppReach`, `untypedSeam`, and
`frames` (each frame string the file names, with where the other side of it
lives and whether that side is in `app/`). Added 2026-09-09 for
`tools/magentra-gateway`, whose SPEC §6 says to call this script rather than
grow a second graph reader — parsing the human output above would have become
exactly that the first time a label moved. No banner, no trailing newline.

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
6. Verify with the gates below and report the actual output — the counts, not
   "it passes".

## Verification gates

The feature suite in `tests/` is the gate. It was rebuilt after the 2026-09-09
reset and held 590 registered tests on 2026-09-23. `tests/README.md` is the
authority on it; where this section and that file disagree, the README wins.
Reading the fan-in (above) is still required — it is how you know which tests
to run and what they cannot see — but it is no longer the only check.

### 1. Build first

```bash
npm run build                        # tsc -b, engine/* + tui/* only. exit 0 = clean
```

The tests import `engine/*/dist/`, never `src/`. `dist/` is gitignored, and
neither `npm test` nor `npm run app` builds it. Skip this step and you test the
last build.

### 2. Run the command the test's kind selects

| The test is about | Kind / tag on the test class | Command |
|---|---|---|
| the desktop UI (launches the real app) | `ui` kind, or `desktop = true` | `npm run test:ui` |
| a real model on a real connection | `llm` kind | `npm run test:llm` |
| something only true on Windows | `platform = "win32"` | `npm run test:windows` |
| something only true on macOS | `platform = "darwin"` | `npm run test:mac` |
| a packaged installer, built and launched | `artifact = true` | `npm run test:artifacts` |
| everything else | `pure`, `fs`, `proc`, `net` | `npm test` |

```bash
npm run typecheck:tests              # tsc -p tests. Must stay clean. CI does not run it.
```

`test:ui`, `test:llm`, `test:mac` and `test:windows` SUBTRACT: each runs its
slice and nothing else, so `npm test` and a slice share no test, and a full
check is `npm test` plus every slice your change touches. `test:artifacts` is
the one that adds (the ordinary suite plus the 8 artifact tests). Asking for
`test:ui` and `test:llm` in one run is an error. The slice is chosen by the npm
script NAME (or `MAGENTRA_UI_TESTS=1` / `MAGENTRA_LLM_TESTS=1`); a withheld test
is reported as skipped with the command that runs it — never as passed.

2026-09-23, engine freshly built, Windows 11: `npm test` 590 registered, 505
passed, 0 failed, 85 withheld (51 ui, 26 llm, 8 artifact), ~124 s;
`npm run test:ui` 51 passed, 0 failed, ~159 s; `typecheck:tests` clean.

### 3. Count before, count after

Before the first edit: build, then `npm test` and the slices you touch. Write
down registered / run / passed / failed. After the change, run the same
commands and compare. A new red must be explained.

- **Confirm a red is yours**: `git stash push -- <paths>`, rebuild, re-run,
  `git stash pop`.
- **Known flake**: `tty-dispatch · no-tty-hands-off-detached-with-a-scrubbed-env-and-no-forwarded-args`
  fails now and then with `EPERM` in teardown (the detached grandchild it
  exists to spawn still holds the sandbox). Do not let it mask your result, and
  do not "fix" it by accident inside another change.

### 4. Revert-verify every regression test

Put the buggy code back, rebuild, and watch the test fail with the user's real
symptom. Restore the fix, rebuild, and watch it pass. Say that you did it. A
timing test asserts ratios or event order, never a wall-clock threshold that
passes on a slow machine and fails on a fast one.

### 5. The gateway comes first (decisions/0001, 0005)

A new feature, a change to one, or a bug fix is entered in the inventory before
its code:

- the record: `tests/gateway/features/<feature-id>.json` — `entryFiles`,
  `invariant`, `kinds`, `tests`, freshness hashes;
- the description: `tests/gateway/descriptions/*.json` (draft → approved);
- the UI: `npm run gateway` → http://127.0.0.1:4320.

The owner approves the description and the invariant before the test is
written. Then the test, by the rules in `tests/README.md`: one file per feature
(`tests/features/<feature-id>.test.ts`; extend it rather than add one), a class
extending its kind's base, the `invariant` copied verbatim from the record, a
real `whyItExists`, its id listed in the record's `tests`. No skip, no soft
assert, no scaffold. The only double is the scripted provider (`FakeProvider`,
`tests/lib/scriptedEngine.ts`, `tests/lib/engineHarness.ts`); everything else
is real — files, processes, the built engine, and the Electron app through
`tests/lib/appHarness.cjs`.

**Freshness.** A record hashes the CONTENT of its `entryFiles` (CRLF folded,
never mtimes). Editing an entry file makes the record stale, and one stale
record blocks the gateway's whole run, not just that feature's. `npm test` does
not check freshness, so a green `npm test` says nothing about it; the gateway's
start-up banner does (`npm run gateway -- --no-open`). Re-recording is a
review: a person confirms the record still describes the code, then uses the
gateway UI's reconcile action. It is never a way through the gate.

### 6. Approved artifacts move only when a person moves them (decisions/0015)

`tests/approved/system-prompt-is-pinned/system-prompt.txt` and
`tests/approved/tool-wire-contract-is-pinned/tools.json` hold the exact bytes
of the standing system prompt and of every tool's wire schema. Rewording a
`SECTION_*` in `engine/core/src/agent/prompts.ts`, or any tool description or
`.describe()` in `engine/tools/src/`, fails them by design. **Never run
`npm run approve`.** Show the owner the before and after wording, get approval,
and the owner runs it and reads the diff. Other model-facing wording — turn
reminders in `session.ts`, finishing rungs in `finishing.ts` — is not pinned,
and still needs the owner's approval before it changes.

### 7. Smoke, and what CI gates

```bash
npm run smoke --workspace app        # boots the real app; nonzero if the renderer crashes
```

`smoke` catches a window that will not come up, nothing below that (the `boots`
feature tests this path). CI (`.github/workflows/ci.yml`, windows-latest, Node
22 and 24) runs build → `npm test` → a floor of 550 registered tests (it
catches a collapsed suite, not one deleted test) → `npm run test:ui`, and a
separate job runs the smoke. It does not run `test:llm`, `test:mac`,
`test:artifacts` or `typecheck:tests`, and it does not check gateway freshness.

### Invariants still not covered — the backlog

The seven `*-check.mjs` scripts deleted on 2026-09-09 are no longer the spec
for a rebuild. Checked against `tests/features/` on 2026-09-23, most of what
they held is proven again:

| Deleted check | Now proven by |
|---|---|
| `permission-check.mjs` | `permission-stances`, `deletion-guard`, `allow-all-stance`, `command-shape-always-allow`, `protected-state-dir` |
| `tools-check.mjs` | `tool-registry-contract` (it also RUNS Read, Glob, Grep, TaskList, CronList and GraphQuery against a workspace), `tool-wire-contract-is-pinned` |
| `addon-check.mjs` | `discovery`, `precedence`, `on-invoke-load`, `name-invocation`, `cheap-until-used`, `bundled-files` |
| `glob-state-dir-check.mjs` | `tool-glob` |
| `reasoning-effort-check.mjs` | `reasoning-effort-clamp` (over a real 127.0.0.1 server), `mirror-reasoning-efforts` |
| `connection-check.mjs` — cited in source comments but never committed; the `isLocalBaseUrl` app ↔ engine mirror | `mirror-local-endpoint`, `local-means-the-lan-in-both-halves` |

What nothing guards yet:

| Invariant | Where | Status |
|---|---|---|
| The TUI layout core wraps and right-aligns in display CELLS (Ink lays `<Static>` out as a content-sized box where `flexGrow` never reaches the right edge) | `tui/src/markdown.ts` (`displayWidth`, `wrapSpans`, `layoutLine`) | no test |
| No reflow: the live streaming line and the committed line are laid out by the same function at the same width | `tui/src/markdown.ts`, `LiveLine.tsx`, `TranscriptLine.tsx` | no test |
| Folder trust is global, inherited, and matched on path SEGMENTS, so `/home/me/work` never trusts `/home/me/workspace` | `tui/src/trust.ts` (`isTrusted`) | no test — tests only pre-trust a folder to get past the gate |
| The compaction summarizer's own sizing against the context window, and the exact span boundary | `engine/core/src/runtime/session.ts` | `compaction` is `llm`-only; its header leaves checklist items 1, 2 and 6 blocked, because they need a scripted summarizer |

The rest of the backlog is the gateway inventory itself: on 2026-09-23, 38 of
166 records were `untested` and 2 `partial`.

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
- **`engine/*/dist/` is gitignored and stale-able.** The tests and the app both
  run it, and nothing rebuilds it for you — `npm run build` does. The driver
  skips `dist/` deliberately — if you grep and get hits in `dist/`, you are
  reading build output, not source.
- **The system prompt is one file.** `engine/core/src/agent/prompts.ts` — every
  behavior section is a `SECTION_*` export composed by `behaviorCore()`.
  Editing prose there changes every session's system prompt, and
  `system-prompt-is-pinned` fails on any changed byte of it. Only the owner
  re-approves it (Verification gates, step 6).
- **Never write a dollar sign followed by `ARGUMENTS`, a digit or a brace in
  this file.** Claude Code substitutes those in a skill body with the args the
  caller passed, even inside a code span. Until 2026-09-23 the old backlog
  table named MAGENTRA's addon placeholder that way, so every invocation with
  args read back with the caller's args in the middle of a table row. With no
  placeholder in the body, the args are appended at the end instead.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `!! <path> — not in the scanned graph` | Path typo, or you pointed at `dist/`/`node_modules/`. Use the `src/` path. |
| `fan-in 0 direct importers` on a file you know is used | It's reached dynamically (skills, team `.md` loaders) or it's an entrypoint. Grep the bare filename before concluding it's dead. |
| Driver prints a symbol found in `index.html` | Renderer HTML is English prose; type names word-match UI labels. The `<file>` seam scan already skips `.html` for this reason — `--symbol` does not, so read those hits with suspicion. |
| `npm run build` clean but the app misbehaves | Expected. The build does not see `app/`. Re-check with `--frame`, then run `npm run test:ui` — `npm test` never launches the app. |
