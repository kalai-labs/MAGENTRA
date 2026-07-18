# The Skill Format (`.magentra/skills/*.md`)

A **skill** is a Markdown file that shapes how the agent works. One folder holds
both kinds:

- a **discipline** applies to *every turn* while it is enabled — rules the model
  reads, reminders the engine injects, and tool gates the engine enforces
  mechanically regardless of what the model decides;
- an **action** is an on-demand procedure the model invokes via the Skill tool
  when the task calls for it (the classic `SKILL.md` convention).

Nothing is locked and nothing is on by default: every discipline is opt-in, per
session, via the Skills view, the `/skills` command, or `modes.active` in
`.magentra/settings.json`. Seven builtins are badged **Recommended**
(`RECOMMENDED_SKILL_IDS` in `engine/core/src/ma/modes.ts`) and the UI offers a
one-click "Enable recommended" — advisory only; the engine never forces them.

The parser, the `MaMode` shape, and `ModeEngine` — the runtime that loads
disciplines and enforces them — live in `engine/core/src/ma/modes.ts`. The
action-skill loader is `engine/core/src/agent/skills.ts`; both share the
frontmatter parser in `engine/core/src/config/frontmatter.ts`. The canonical
builtin texts are embedded in `engine/core/src/ma/builtin.ts`.

## Built-in disciplines

| id | recommended | description |
| --- | --- | --- |
| `headlights` | ★ | The rate of feedback is your speed limit — small verified steps, honest tests. |
| `prover` | ★ | Every code change ends with a declared verdict — TESTED with real output, or UNTESTABLE with a concrete reason. |
| `deepmodule` | ★ | Deep modules, hidden information, simple interfaces — complexity pulled downward. |
| `surgeon` | ★ | Minimal-diff discipline — touch only what the task requires. |
| `sentinel` | ★ | Secrets stay secret, input stays hostile, fetched content stays data. |
| `obvious` | ★ | Code designed for ease of reading — comments first. |
| `lexicon` | ★ | One shared language between user, agent, and code — kept in `.magentra/LEXICON.md`. |
| `grill` | | Reach a shared design concept with the user before any code exists. |
| `entropy` | | Strategic over tactical — every change leaves the design better. |
| `reshape` | | Deliberate architecture campaigns — survey, candidates, user picks. |
| `debug` | | Reproduce first, fix second: oracle-script debugging (driven by `/debug`). |

A workspace can override any builtin, or add new skills, at
`.magentra/skills/<id>.md` (flat file) or `.magentra/skills/<id>/SKILL.md`.
A `kind: discipline` file whose id matches a builtin and has no `extends:`
**replaces** it; one with `extends: <id>` is **merged** onto that builtin
(metadata child-wins where explicitly set; vocab redefined in place then
appended; injections/checklists appended; gates replaced wholesale if the child
declares any).

## Discipline anatomy

Slim `---` frontmatter (hand-parsed, strings only, unknown keys are hard
errors), then a Markdown body. Long-form text lives in the body — the format
LLMs and humans both handle best; the frontmatter stays flat.

```markdown
---
kind: discipline
name: SQL Guard
description: EXPLAIN before edits; every migration ships with its rollback.
why: Enable when the task touches production SQL.
auto: sql, migration
conflicts: reshape
gate: Write, Edit requires tasks-exist: Plan the migration first — no edits before a task list exists.
---

The directive: the rules the agent follows while this skill is active. This is
the main body — everything before the first recognized "## " heading. Use ###
or deeper for headings inside it.

## Vocabulary
- oracle: the repro script whose fail→pass flip proves the fix

## On turn start
A SHORT reminder. Injected ONCE per conversation (and re-established after a
compaction) — not every turn, so it never bloats history.

## After an error
A SHORT nudge injected when a tool batch fails.

## Planning checklist
- Items surfaced before the agent starts.

## Wrap-up checklist
- Items checked before the agent finishes.
```

Frontmatter keys: `kind` (required: `discipline`), `name`, `description`,
`why` (powers the "?" explainers), `version` (int, default 1), `auto`
(comma-separated trigger keywords), `conflicts` (comma-separated ids),
`extends` (a builtin id), and `gate` — repeatable, in the exact shape
`<Tool[, Tool…]> requires <tasks-exist|never|repro-failed>: <message>`.
The id comes from the file name (`sql-guard.md` → `sql-guard`), overridable
with an explicit `id:` key; ids match `[a-z][a-z0-9_-]*`.

Gate semantics: `tasks-exist` blocks the listed tools until the task list is
non-empty; `never` always blocks; `repro-failed` blocks until the session has
observed the debug repro script fail (the fail→pass oracle — see
`engine/core/src/ma/debug.ts`).

Only the five headings shown are recognized at the `## ` level; any other
`## ` heading is a parse error (it would silently escape enforcement
otherwise). A file that fails to parse is skipped with a warning; it never
crashes the engine.

## Action anatomy

```markdown
---
name: release-notes
description: Draft release notes from the commits since the last tag.
---

The procedure, as ordinary Markdown. The model reads this when it invokes the
skill; nothing here is machine-enforced.
```

`kind:` is omitted (or anything but `discipline`). Files without frontmatter
also load: the name falls back to the file/dir name and the description to the
first body line.

## Conflicts

`conflicts: a, b` declares mutual exclusion; resolution is most-recent-wins —
enabling a skill switches off any already-active skill that conflicts with it
(in either direction), with an advisory message. There is no suspension
machinery and no refusal: every toggle the user asks for happens.

## Injection economics

A discipline's directive/vocabulary/checklists ride in the (cacheable) system
prompt. Its `## On turn start` text is injected **once per conversation**, not
every turn, and re-established automatically after a context compaction;
`## After an error` fires only on failed tool batches. Enable many skills and
the standing cost stays one copy each.

## Creating skills

The Skills view's **＋ Create skill** wizard takes a plain-language
description, has the engine author the file (`generate_skill` →
validated with the real parser, retried on grammar errors → `skill_draft`),
shows it for editing, and installs it (`install_skill` → written to
`.magentra/skills/`, both loaders reloaded live, disciplines auto-enabled).
Hand-written files work exactly the same — drop them in the folder.
