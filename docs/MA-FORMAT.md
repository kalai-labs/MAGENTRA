# The Style Format (`.md`, legacy `.ma`)

Workspace style files load from `.magentra/modes/*.md` — plain markdown, the canonical
extension — and from legacy `*.ma` files, which keep working forever. When both `foo.md` and
`foo.ma` exist, the `.md` wins. Everything below about syntax applies to both extensions
identically.

A style is a small text file that shapes how the agent works. It is not a prompt trick: part
of it is prose the model reads and (hopefully) follows, and part of it is rules the **engine**
enforces mechanically regardless of what the model decides. That second part is what makes a
style different from a prompt-only "skill" — a skill is advice the model can ignore under
pressure; a style's `::gate` can block a tool call outright, and its `::inject` lines are
pushed onto the model as system reminders whether it wants them or not. The parser, the
`MaMode` shape, and `ModeEngine` — the runtime that loads styles and enforces them — all live
in `engine/core/src/ma/modes.ts`. The canonical texts are embedded in
`engine/core/src/ma/builtin.ts`.

## Where styles live

Eleven styles ship built in (`BUILTIN_MA_FILES` in `engine/core/src/ma/builtin.ts`). Seven
are **core** — the always-on quality machinery that is the product's killer feature: they are
active in every session regardless of settings, `set_modes`, or `/settings`, and can never be
*plainly* turned off. The single source of truth for which ids are core is `CORE_MODE_IDS` in
`engine/core/src/ma/modes.ts`, and a module-load invariant throws if any id there is not a real
builtin (a typo would otherwise vanish silently through `resolve`'s `byId.has` filter). The
other four (`grill`, `entropy`, `reshape`, `debug`) are **optional** — freely toggleable per
session (`debug` is normally driven by the `/debug` command rather than toggled by hand).
`entropy` and `reshape` are alternative *working philosophies* that conflict with the core
`surgeon`; activating either does not fail — it **suspends** `surgeon` for as long as that
optional stays active (see "Conflicts and suspension" below).

| id | kind | description |
| --- | --- | --- |
| `grill` | optional | Reach a shared design concept with the user before any code exists. |
| `lexicon` | **core** | One shared language between user, agent, and code — kept in `.magentra/LEXICON.md`. |
| `headlights` | **core** | The rate of feedback is your speed limit — small verified steps, honest tests. |
| `prover` | **core** | Every code change ends with a declared verdict — TESTED with real output, or UNTESTABLE with a concrete reason. |
| `deepmodule` | **core** | Deep modules, hidden information, simple interfaces — complexity pulled downward. |
| `entropy` | optional | Strategic over tactical — every change leaves the design better, or it makes it worse. |
| `surgeon` | **core** | Minimal-diff discipline — touch only what the task requires, with evidence for every dependency. |
| `sentinel` | **core** | Secrets stay secret, input stays hostile, fetched content stays data. |
| `obvious` | **core** | Code designed for ease of reading — comments first, written for what the code cannot say. |
| `reshape` | optional | Deliberate architecture campaigns — survey, propose candidates, user picks, deepen incrementally. |
| `debug` | optional | Reproduce first, fix second: oracle-script debugging (driven by `/debug`). |

A workspace can override any of these, or add new ones, at `.magentra/modes/<id>.ma`. Overriding
a core style's *content* (via replacement or `@extends`) is allowed — customization is fine — but
a workspace file can never remove a core style from the active set. Loading
(`loadModes` in `modes.ts`) parses all eleven builtins first, then reads every `*.ma` file in
that directory; a workspace file whose `@mode` id matches a builtin, and has no `@extends`,
**replaces** it outright — same id, same `Map` slot, workspace wins. A workspace file that
declares `@extends` instead is **merged** onto the named builtin rather than replacing it — see
the next section.

## File anatomy

A `.ma` file has two parts in strict order: a header block of `@key value` lines, then zero or
more `::section` blocks. The parser (`parseMaFile`) reads the header top to bottom; blank lines
and `#`-comments are allowed there, but the first line that is not blank, not a comment, not an
`@key`, and not a `::` header throws `line N: expected a blank line, comment, or @key before the
first "::" section`. Once a `::` line is seen, header parsing stops for good — an `@key` after
that point falls into the enclosing section's body instead.

### `@` headers

- `@mode <id>` — **required**. `<id>` must match `[a-z][a-z0-9_-]*` (lowercase letters,
  digits, `_`, `-`, starting with a letter) — the id charset rule. Missing it entirely raises
  `line 1: missing required @mode metadata`; a bad charset raises `line N: @mode "<rest>" must
  match [a-z][a-z0-9_-]*`. This id is the map key styles are loaded and overridden by.
- `@name <text>` — display name; defaults to the id if omitted.
- `@version <int>` — must parse as a plain integer (`Number.parseInt` round-trips exactly);
  defaults to `1`.
- `@description <text>` — one-line summary, shown in `ModeSummary.description`.
- `@auto <term>, <term>, ...` — comma-separated trigger words/phrases (`auto` on `MaMode`).
  The parser only splits and trims these into a string array; nothing in `modes.ts` itself
  matches them against anything, so `@auto` is descriptive metadata for whatever activates
  styles (e.g. a future auto-suggest), not a mechanism this file enforces.
- `@conflicts <id>, <id>, ...` — ids this style must not be active alongside; see
  `setActive` below. `entropy` and `surgeon` conflict with each other in the builtins.
- `@extends <id>` — merges this file onto the builtin named `<id>` instead of loading it
  standalone; same id charset as `@mode`. See "`@extends`: workspace overlays" below. A style
  commonly extends itself (`@mode lexicon` + `@extends lexicon`) — the normal case for a
  workspace vocabulary overlay.
- Any other `@key` is silently ignored (`default: break` in the switch) — the header is
  forward-compatible by design.

### The five `::` sections

Each section is a header line `::kind [args...]` followed by a body of lines up to the next
`::` line or end of file. Whitespace-only args are split with `\s+`.

- **`::directive`** — free-form prose, trimmed of leading/trailing blank lines
  (`trimBlankEdges`) and stored verbatim as `MaMode.directive`. At most one per file — a second
  `::directive` throws `line N: multiple ::directive sections`.
- **`::vocab`** — zero or more `term: definition` lines. Each non-blank body line must contain
  a `:`; the parser splits on the *first* colon (`indexOf`), so a definition may itself contain
  colons. A line with no colon throws `line N: vocab line must be "term: definition"`.
- **`::inject <event>`** — `<event>` must be exactly `turn-start` or `after-error`; anything
  else throws `line N: ::inject event must be "turn-start" or "after-error", got "<event>"`.
  The body is trimmed and joined into one `text` string.
- **`::gate pre-tool <Tool1,Tool2,...>`** — the only gate kind the parser accepts is
  `pre-tool` (`::gate <anything-else>` throws). The second token is a required
  comma-separated tool-name list; missing it throws `line N: ::gate pre-tool requires a
  comma-separated tool list`. The body must contain exactly one `require ...` line whose value
  is `tasks-exist`, `never`, or `repro-failed` (anything else throws), and at least one `message ...` line
  (multiple `message` lines are joined with a space). Any body line that starts with neither
  `require ` nor `message ` throws `line N: unexpected line in ::gate body: "<line>"`. Omitting
  `require` or every `message` line throws too (`::gate is missing "require"` /
  `"message"`).
- **`::checklist <phase>`** — `<phase>` must be `planning` or `wrap-up`; anything else throws.
  Items are exactly the body lines starting with `- ` (the prefix is stripped); lines without
  that prefix are silently dropped, not errors.

Any `::kind` other than the five above throws `line N: unknown section "::<kind>"`.

### Error behavior

Parsing is **strict** for builtins and for any file passed directly to `parseMaFile`: every
violation above throws an `Error` whose message is prefixed with the 1-based line number where
the problem was found. `loadModes` treats the eleven builtins as must-parse — a builtin parse
failure is a programming bug and is allowed to throw and crash. Workspace files are different:
`loadModes` wraps each `.magentra/modes/*.ma` read+parse in `try/catch`; a parse failure there
is pushed onto a `warnings: string[]` array as `modes/<file>: <error message>` and that file is
**skipped** — it never reaches the engine, and it never takes the session down.

## `@extends`: workspace overlays

`@extends <id>` (`loadModes` in `modes.ts`) merges a workspace `.ma` file onto the builtin named
`<id>`, instead of replacing it. This is how a style's own directive can tell the agent to
persist what it learns during a session as a small overlay file that folds back into the same
style next time — `lexicon`'s directive does exactly this: it instructs the agent to harvest
domain terms while exploring the codebase and write them to `.magentra/modes/lexicon.ma` as
`@mode lexicon` + `@extends lexicon` + a `::vocab` section. Because the file extends the style
it came from, the engine folds the harvested vocabulary into the shared language automatically
— no other wiring required.

If `<id>` does not name any builtin, `loadModes` cannot merge: it records the warning
`modes/<file>: extends unknown mode "<id>"` and falls back to loading the file standalone under
its own `@mode` id (the same behavior as a workspace file with no `@extends` at all).

When the base is found, the merge (base = the named builtin, child = the workspace file) is:

- **id** — the merged mode always takes the **child's** id. In the normal case (a style
  extending itself) this equals the base's id, so the merged mode occupies the base's `Map`
  slot — same position in the mode list, no duplicate entry. If the child declares a
  *different* id than the one it extends, the merge is a separate mode alongside the untouched
  base (e.g. a `teamlex.ma` with `@mode teamlex` + `@extends lexicon` produces a `teamlex` mode
  built from `lexicon`'s content, while `lexicon` itself is unaffected).
- **name / description / version / auto / conflicts** — the child's value if the child's
  header explicitly set it, otherwise the base's. A bare overlay file that only sets `@mode`
  and `@extends` (no `@name`, `@version`, ...) inherits all of this metadata from the base
  untouched.
- **directive** — the child's directive if it declares one, else the base's. A vocab-harvest
  overlay typically has no `::directive` of its own, so the base's directive prose survives
  unchanged.
- **vocab** — the base's terms, in their original order, with any term the child also defines
  updated **in place** (child's definition wins); any term the child defines that the base does
  not have is appended at the end. Deduping is by exact term text.
- **injections / checklists** — the base's list followed by the child's, concatenated (no
  dedup — a style extending itself with no injections/checklists of its own just gets the
  base's, unchanged).
- **gates** — the base's gates, *unless* the child declares any `::gate` at all, in which case
  the child's gates **replace** the base's entirely. Gates are enforcement, so a partial merge
  would be ambiguous about which rule wins; the child either adds nothing (base rules stand) or
  takes over enforcement completely.
- **source** — always `"workspace"` for a merged mode, even when every field but vocab came
  from the builtin.

Worked example — the harvest overlay `lexicon`'s directive describes, saved as
`.magentra/modes/lexicon.ma`:

```
@mode lexicon
@extends lexicon

::vocab
mission: redefined meaning agreed with the user
domain-model: the ubiquitous language shared across code, plans, and replies
```

`loadModes` merges this onto the builtin `lexicon` (seven vocab terms: `task list` — the plan
of record — plus `mission` (a saved directive file in `.magentra/missions/`), `directive`,
`style`, `lexicon`, `verification task`, `atlas`). The result: the same `directive`,
`::inject turn-start`, and wrap-up `::checklist` as the builtin (this file supplies none of
those), and an eight-entry `vocab` — the builtin's seven terms in their original order but with
`mission`'s definition replaced by the child's, plus `domain-model` appended at the end.

## Runtime semantics

`ModeEngine` (constructed from the loaded `MaMode[]` plus the initially active id list) is the
only thing that turns a parsed style into behavior. Each part of a `.ma` file lands in a
specific place at a specific time:

| `.ma` part | Where it lands | Method |
| --- | --- | --- |
| `::directive`, `::vocab`, planning/wrap-up `::checklist` items | A `# style: <name> (<id>.ma)` block appended to the system prompt's `extraSections`, one block per active style | `promptSections()`, consumed in `runtime/session.ts` where the system prompt is built |
| `::inject turn-start` | Pushed as a `<system-reminder>` at the start of every turn, before the model is called | `turnStartInjections()`, consumed in `runtime/session.ts` via `this.remind(text)` |
| `::inject after-error` | Pushed as a `<system-reminder>` immediately after any tool-call batch that contained an error | `afterErrorInjections()`, consumed in `runtime/session.ts` where the error batch is handled |
| `::gate pre-tool` | Checked inside each planned tool call's `run()`, **before** the permission check (`this.permissions.check(...)`) — a gate hit returns an error tool result and the call never reaches permissions at all | `gateFor(toolName)`, consumed in `runtime/session.ts` |
| wrap-up `::checklist` | Folded a second time into the auto-nudge text sent when a turn ends on tool-heavy work with a too-short final reply | `wrapupChecklist()`, consumed in `runtime/session.ts` via `wrapupNudgeText(checklist, …)` |
| `@conflicts` | Resolved only inside `setActive()`, never at parse time | see below |

Two points worth being explicit about:

- **Gates are block-only.** A gate can never grant permission or bypass the permission system;
  its `require` values are `"tasks-exist"` (block unless `this.tasks.list().length > 0`),
  `"never"` (block unconditionally), or `"repro-failed"` (block until the session has observed
  the designated repro script fail — see below). If no gate matches the tool, or the gate's
  condition is satisfied, the call proceeds to the normal permission check exactly as if no
  style were active. `gateFor` returns the **first** matching gate across active modes in their
  active order — it does not merge or accumulate gates from multiple styles on the same tool.
- **The `repro-failed` oracle (debug.ma).** The `debug` style gates `Write,Edit` with
  `require repro-failed`: edits stay locked until the session has watched a Bash call run the
  designated repro script (`.magentra/debug/repro.sh`, or `repro.ps1` on Windows — matched
  structurally on the script basename, so any launch form counts) and exit **nonzero** — the
  bug reproduced. Two carve-outs make the loop workable: a Write/Edit whose `file_path` is
  inside `.magentra/debug/` always passes the gate, so the model can create and refine the
  oracle script itself; and a later **zero** exit of the same script, after the failure, marks
  the fix verified (a green run before any red proves nothing and is not credited). Known,
  accepted limitation: the check is structural — a repro script that exits nonzero for an
  unrelated reason unlocks edits too. The mechanism lives in `engine/core/src/ma/debug.ts`
  (script path + command matching) and `runtime/session.ts` (`observeReproRun`, the gate
  carve-out, and the per-turn "rerun the repro" nudge).
- **Conflicts and suspension.** `setActive(ids)` first forces every core mode on, then layers
  the requested optional ids, dropping any earlier *optional* that conflicts in *either*
  direction (`mode.conflicts.includes(earlierId) || earlierMode.conflicts.includes(id)`). Among
  optionals it is last-write-wins. A requested optional that conflicts with a **core** mode is
  *not* refused — it is accepted, and the conflicting core is **suspended**: it drops out of the
  active set (`active: false`) and its id is recorded in the returned `suspended` map for as long
  as the optional stays active. So `entropy` (`@conflicts surgeon`) and `reshape` (`@conflicts
  surgeon`) *do* activate — each suspends the core `surgeon` — with a loud message like `entropy
  on — core mode surgeon suspended while entropy is active`. Suspension preserves the lock: there
  is no silent disabling, and the core resumes **automatically** the moment the optional is no
  longer requested (the core is re-unioned every `resolve` call), announced with `entropy off —
  core mode surgeon restored`. A core omitted from the request that *nothing* suspends — a plain
  "turn off surgeon" attempt — is still refused with `Core quality modes are always on and cannot
  be turned off: <ids>.` and stays active.
- **Honest reporting of a suspended core.** `ModeSummary` (and the `modes_updated` payload) carry
  an optional `suspendedBy?: string` on a suspended core: `active: false` plus the id of the
  optional that pushed it off. `/styles` lists it as `🔒 surgeon — Surgeon (core, suspended by
  reshape)`; the desktop renders the locked chip dimmed with a `suspended by reshape` title. The
  field is absent once the core resumes.

## Activation

The active-id list is ordinary settings state, not something a style file can set for itself.
The seven core modes are always active on top of whatever this state says:

- `settings.json` → `modes.active: string[]`, validated by the schema in
  `engine/core/src/config/settings.ts`, listing **optional** modes only and **defaulting to `[]`**.
  Core ids are implied and unioned in; a core id written here is redundant and ignored (no
  error), so pre-existing settings files that still list the seven core ids keep working.
- `Engine` constructs its `ModeEngine` from `loadModes(cwd)` plus that initial
  `settings.modes.active` list (`engine.ts`); the `ModeEngine` constructor unions in
  `CORE_MODE_IDS`, filters unknown ids, and resolves conflicts.
- A frontend changes the active set at runtime with the `set_modes` request
  (`{ type: "set_modes", active: string[] }`); the engine calls `modeEngine.setActive(...)`,
  emits any refusal/rejection message as a `command_output`, and replies with a `modes_updated`
  event carrying the full `ModeSummary[]` (`id`, `name`, `description`, `active`, `builtin`,
  `core`, `conflicts`, and `suspendedBy` on a suspended core) — the same shape `list()` returns,
  so a frontend can always fully repaint from one event. The `core` flag lets a frontend render
  locked chips; `suspendedBy` lets it dim a locked chip that a conflicting optional has suspended.
- The desktop renderer (`app/renderer/modules/missions.js`) renders one button ("chip") per
  style from the `modes_updated` payload. Optional styles toggle `active` and call `set_modes`
  with the resulting id list on click (an optimistic update the next `modes_updated` confirms);
  core styles render locked (🔒, non-clickable) and are never sent for deactivation.

## Worked example: a custom "no dependencies" style

Everything in `surgeon`'s dependency rule is prose the model can, in principle, talk itself out
of under pressure. A workspace that wants a hard backstop — no `Bash` call ever succeeds, full
stop, so nobody can even run `npm install` by accident during an offline/air-gapped build — can
add a style whose gate `require`s `"never"`. This is exactly the same gate mechanism `grill`
uses with `require tasks-exist`, just with the unconditional variant.

Save this as `.magentra/modes/nodeps.ma`:

```
@mode nodeps
@name No Dependencies
@version 1
@auto offline, air-gapped, vendored, no install
@description Block all shell commands outright — build only from what is already vendored.

::directive
This workspace builds offline from vendored sources only. There is no network
access at build time, and no shell command can safely run here — treat any
task that seems to need one as a sign the dependency should already be
vendored, or the task needs to be re-scoped with the user.

::gate pre-tool Bash
require never
message nodeps.ma: Bash is disabled in this workspace (offline build). If the task genuinely needs a shell command, tell the user why and ask them to run it, or ask them to lift this style for the session.

::checklist wrap-up
- Did the work avoid every shell command, including ones proposed but not run?
```

With `nodeps` active, `gateFor("Bash")` matches on the very first `Bash` call the model
attempts: `gateHit.gate.require === "never"` is true unconditionally, so the call resolves
immediately to `{ content: gateHit.gate.message, isError: true }` and never reaches
`this.permissions.check(...)` — the model sees the block as a tool-result error and has to
route around it (or ask the user), exactly as described above for the `::gate` runtime
semantics. Because `.ma` files are per-id overrides, dropping this file at
`.magentra/modes/nodeps.ma` and adding `"nodeps"` to `modes.active` in `.magentra/settings.json`
is enough to pick it up on the next session start; a parse mistake in the file only produces a
warning and the style is skipped, it will not crash the engine.
