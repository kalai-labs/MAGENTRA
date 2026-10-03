# Brain editor

The control center for `brain/`: everything MAGENTRA tells the model, and every
rule for when it tells it. One tool with two front doors over the same core:

- **a page for people**: `npm run brain-editor` opens it in your browser;
- **a command line for agents and scripts**: `npm run -s brain-editor -- <command> --json`.

Both send the same change objects to the same functions
(`src/model.ts`), so a person and an agent change a brain through one path,
with the same checks. Dev tooling only: it never enters the app bundle.

## What a save does

A save is a list of changes, applied in order as one unit:

1. The changes are applied to a **staged copy** of the brain folder.
2. `tools/brain/compile.mjs` compiles the copy exactly as `npm run build` would
   (`complete: true`). The editor has no rules of its own; the compiler is the
   judge, and its words are the ones you see.
3. The **built engine** loads the copy (`src/engine.ts` → `src/probe.mjs`): every
   `brainPrompt`, `toolParam` and `assertToolParamStates` runs, and the standing
   system prompt and the tools' wire text are rendered, so the plan can say
   whether either changes. This catches what the compiler cannot, such as a
   removed parameter text the tool still reads.
4. Every edited prompt, tool text, knob and tool list must **compile back to
   exactly what was asked**, byte for byte.
5. The folder must still be the **revision** the change was planned against.
   Otherwise someone else (the page, an agent, `git checkout`) changed it in
   between.
6. In the **shipped** `brain/`, a change to tool access (`availability.json`) or
   a knob value (`behavior.json`) is refused until the caller **acknowledges**
   the test that checks the shipped value. That test then fails until the owner
   updates what it expects. Prompt and tool texts are held by no test.

Only then are the files written, each atomically. If one write fails, the
files already written are put back. When any check fails, nothing on disk
changes and the refusal says why.

The engine check needs a built engine (`npm run build` once) and Node 22.18 or
newer. Without them, saves are checked by the compiler alone, and the result
says so.

## For people: the page

```bash
npm run brain-editor                      # opens http://127.0.0.1:4321
npm run brain-editor -- --brain ../my-profile
npm run brain-editor -- --no-open --port 4400
```

- **The brain map** on the home page draws every prompt, tool, knob and tool
  switch as one dot in the lobe of its section. Click a lobe to open the section.
- Edits become **unsaved changes** (the amber bar at the bottom). They are kept in
  the browser per brain folder, so a reload loses nothing. **Review and save**
  (or Ctrl/Cmd+S) shows the diff, the tests the change moves, and the engine's
  answer, before anything is written.
- If the folder changes on disk while you edit, the page reloads it and marks
  any field you were editing as a conflict, with *Keep my version* or *Use the
  version on disk*.
- **Build** runs `npm run build` (shipped brain only). The top bar says whether
  the engine was built from the brain on disk.
- **What the model reads** shows the system prompt as the built engine assembles
  it from the saved brain.
- The folder menu copies the brain into a **new profile folder** or opens another one.

The server binds `127.0.0.1` only, checks the `Host` header, and accepts writes
only with its `x-magentra-brain-action: 1` header from its own origin, the
gateway's model (`docs/decisions/0002`).

## For agents: the command line

Use `npm run -s` (silent), or npm prints its banner on stdout before the JSON.

```bash
npm run -s brain-editor -- help changes --json        # every change type, its fields, an example
npm run -s brain-editor -- show --json                # the whole brain, with its "revision"
npm run -s brain-editor -- show prompt reminder.stall-ask
npm run -s brain-editor -- show knobs --json          # every knob with its rule (type, range, doc)
npm run -s brain-editor -- check --json               # compiles? engine loads it?
npm run -s brain-editor -- plan changes.json --expect <revision> --json
npm run -s brain-editor -- apply changes.json --expect <revision> --json [--acknowledge a,b]
npm run -s brain-editor -- new-profile ../brains/reviewer --json
```

Exit codes: `0` ok, `1` refused or problems, `2` usage error. `-` reads the
changes from stdin.

A changes file is a JSON list (or `{ "changes": [...] }`):

```json
[
  { "op": "prompt.update", "id": "reminder.wrapup-nudge", "text": "Before you stop, say what changed and how you checked it." },
  { "op": "behavior.set", "key": "finishing.nudgeBudget", "value": 2 },
  { "op": "behavior.override", "key": "stall.pivots", "value": 1 },
  { "op": "availability.update", "tool": "Agent", "main": true }
]
```

The ops are `prompt.update`, `prompt.create`, `prompt.delete`, `tool.update`,
`availability.update`, `behavior.set`, `behavior.override` and `file.write`.
`help changes` (from `src/guide.ts`) is the reference. The test
`the-change-guide-names-exactly-the-ops-and-fields-the-editor-accepts` keeps it
equal to what the editor accepts.

### Building a new profile, carefully

1. `new-profile <dir>` copies a complete brain into a new, empty folder. It never
   overwrites one.
2. Pass `--brain <dir>` to every later command. A profile folder is held by no
   test, so no acknowledgement is needed, but every other check still applies.
3. `show --json` gives the `revision`. Pass it as `--expect` to `plan` and `apply`.
4. Always `plan` first, and read `newWarnings` (prose that states an old knob
   value) and `summary`.
5. `check --json` at the end: `ok: true`, and `engine.ok: true`.

The engine is built from `brain/` only. Choosing a profile at run time is a
later phase; until then a profile is a brain you can check, compare and copy
over `brain/` on purpose.

## The HTTP API (what the page uses)

| Route | Does |
| --- | --- |
| `GET /api/brain` | The snapshot (`loadBrain`), plus `engineState`, this machine's prompt overrides, and the last build |
| `GET /api/engine` | The engine's answer for the saved brain, with the system prompt |
| `GET /api/guide` | The change guide |
| `GET /api/events` | Server-sent events: `brain` (the folder changed), `build` (progress) |
| `POST /api/plan` | `{ changes, expectRevision?, acknowledge? }` → plan; writes nothing |
| `POST /api/apply` | The same body → the plan plus `applied`, `newRevision` (409 when refused) |
| `POST /api/build` | Runs `npm run build` (shipped brain only) |
| `POST /api/profile` | `{ to }` → a new profile folder |
| `POST /api/open` | `{ dir }` → edit another brain folder (`""` for `brain/`) |

## Files

| File | What it is |
| --- | --- |
| `src/cli.ts` | The entry point: the page by default, or a command |
| `src/model.ts` | The core: `loadBrain`, `planChanges`, `applyChanges`, `newProfile`, the change vocabulary |
| `src/format.ts` | Writes brain files: the inverse of the compiler's readers, checked by it on every save |
| `src/compiler.ts` | The one typed import of `tools/brain/compile.mjs` |
| `src/engine.ts`, `src/probe.mjs` | The engine check (a child process per brain, cached by its compiled text) |
| `src/project.ts` | The repository around a brain: holder tests, engine users, overrides, build state, the build |
| `src/guide.ts` | The change vocabulary, for agents |
| `src/server.ts` | The local HTTP server |
| `src/ui/` | The page: `index.html`, `app.js`, `brain.js` (the brain map), `style.css`. The fonts are served from `app/renderer/fonts` |

Typecheck: `npm run typecheck:brain-editor`. Tests:
`tests/features/brain-editor.test.ts` (gateway record `brain-editor`).
