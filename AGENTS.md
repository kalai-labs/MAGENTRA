# AGENTS.md

Orientation and working rules for coding agents (and people) changing MAGENTRA.
Read this first; it is short on purpose and points at the documents that hold
the detail.

## What this repo is

MAGENTRA is an agentic coding assistant. Two frontends — an Electron desktop app
(`app/`) and an Ink terminal UI (`tui/`) — each spawn the same headless engine
(`engine/host`) per workspace and talk to it in NDJSON over stdio. The engine
(`engine/*`) owns everything an agent does: the turn loop, tools, permissions,
providers, and the state it keeps in a workspace's `.magentra/`.

## Read before you change anything

| Read | For |
| --- | --- |
| [`docs/big-picture/BIG-PICTURE.md`](docs/big-picture/BIG-PICTURE.md) | How every part works and why — §17 is a concept → file index, §16 the invariants and mirrored constants |
| [`docs/big-picture/MAP.md`](docs/big-picture/MAP.md) | Generated per-file index: exports, members with line numbers, import edges. Grep it before adding anything, so you do not write a second one |
| [`CONTEXT.md`](CONTEXT.md) | The glossary — the words the code assumes you know |
| [`tests/README.md`](tests/README.md) | The feature suite: kinds, opt-in runs, the rules a test must follow |
| [`docs/adr/`](docs/adr/README.md), [`docs/decisions/`](docs/decisions/README.md) | Why product and test-suite decisions were made |

## Layout

```
brain/            model-facing prose: prompts, tool and parameter descriptions,
                  tool availability — compiled into engine/protocol by npm run build
engine/protocol   the wire contract (events, requests, NDJSON), token algebra, prompt registry
engine/providers  model providers (OpenAI-compatible, Anthropic, Ollama)
engine/core       the engine: runtime (Session, Engine), agent, config, knowledge,
                  scheduling, state, integrations (MCP)
engine/tools      the tools an agent calls
engine/host       the headless process both frontends spawn
brain/            model-facing prose and behaviour knobs (behavior.json), compiled into the engine
app/              desktop app — main process, preload bridge, renderer (plain JS)
tui/              terminal UI (TypeScript, Ink)
tests/            feature suite (features/, lib/), gateway records (gateway/), approved artifacts
tools/            dev tooling: magentra-gateway, version, approvals, brain compiler — never shipped
docs/             big-picture/, adr/, decisions/
```

## Commands

```bash
npm install
npm run build              # compile brain/, then tsc -b: engine/* and tui/ — REQUIRED before any test
npm test                   # feature suite (pure, fs, proc, net kinds)
npm run test:ui            # the ui kind ALONE — the only run that launches the app
npm run test:llm           # the llm kind alone; needs a real model connection
npm run test:mac           # tests whose subject is macOS (test:windows likewise)
npm run typecheck:tests    # plus typecheck:gateway, typecheck:version
npm run smoke --workspace app
npm run gateway            # feature inventory UI at http://127.0.0.1:4320
npm run brain-editor       # brain editor at http://127.0.0.1:4321; agents: npm run -s brain-editor -- help

node .claude/skills/bigboycoding/blast-radius.mjs <file> | --symbol <Name> | --frame <type>
node .claude/skills/bigpicture/bigpicture.mjs impact <file> | check | sync | map
```

## Rules

1. **Know the blast radius before the first edit.** Run `blast-radius.mjs` on
   every file you will touch and read its importers. `app/` is plain JavaScript
   that no compiler checks, and it matches engine events by bare frame-type
   strings: rename one and the build stays green while the app breaks. For any
   frame you touch, run `--frame <type>` and change emitter and handler together.
2. **Build before you test.** Tests import `engine/*/dist/`, which is gitignored
   and never rebuilt by `npm test` or `npm run app`. A test run without a build
   tests the previous build.
3. **Fix the code, never the test.** A red test means find the real cause. Never
   weaken an assertion, add a skip, or write a scaffold test to get green. Tests
   are OS-aware: they assert what the running OS can express.
4. **A feature enters the inventory before its code.** New features, changed
   features and bug fixes get a record in `tests/gateway/features/<id>.json` and
   an approved description first; the test lives in
   `tests/features/<id>.test.ts` (one file per feature — extend it). Editing a
   record's entry files makes it stale; re-recording it is a person's review in
   the gateway UI, never a way through the gate.
5. **Pinned bytes move only by a person.** Model-facing prose lives in
   `brain/` (see `brain/README.md`), not in code. Change it with the brain
   editor (`tools/brain-editor/README.md`), which checks every save against the
   compiler and the built engine and names the tests it moves. The system prompt and every
   tool's wire schema are pinned in `tests/approved/`. Rewording them fails
   those tests by design. Never run `npm run approve`; show the owner the
   before and after.
6. **State keys are additive only.** Never rename or repurpose a settings or
   state key — there is no migration machinery, on purpose.
7. **Keep the big picture true.** After an edit, run `bigpicture.mjs check`. If a
   section it names now claims something false, fix
   `docs/big-picture/BIG-PICTURE.md` and `sync`. Run `map` when you add or move
   files or top-level symbols.
8. **Commits are conventional** (`type(scope): subject`, checked by
   `.githooks/commit-msg`). Every push to `main` cuts a release, so nothing lands
   on `main` by accident.

MAGENTRA ships Windows and macOS only (`docs/decisions/0014`). Node 20 or newer.
