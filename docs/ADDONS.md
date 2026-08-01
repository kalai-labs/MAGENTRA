# Addons (`.magentra/addons/`)

An **addon** is a procedure the agent loads on demand: a Markdown file whose
frontmatter says *when* to reach for it, and whose body is *what to do* once it
has. Release checklists, migration recipes, review disciplines, house rules for
one weird subsystem — anything you would otherwise have to re-explain every
session.

Two properties define the mechanism:

- **Always available.** There is nothing to enable. Every installed addon is
  invocable from the moment it exists.
- **Cheap until used.** Only the `name` and `description` ride in the system
  prompt. The body is loaded exactly once, when the addon is actually invoked.

Those two together are the point: you can install a dozen addons and pay a line
each for them standing by.

## Anatomy

```markdown
---
name: release-notes
description: Draft release notes from the commits since the last tag. Use when cutting a release or when asked what changed.
---

The procedure, as ordinary Markdown. The agent reads this when it invokes the
addon. Use $ARGUMENTS anywhere in the body to accept an argument.
```

Exactly two frontmatter keys, `name` and `description`, **each on one physical
line**. The parser (`engine/core/src/config/frontmatter.ts`) is line-based and
hand-rolled: no YAML block scalars, no multi-line values.

It splits each line at its **first** colon, so punctuation inside a value —
colons included — is safe: `description: Use when X happens: then do Y` parses
as one `description`. What is *not* safe is a value that wraps onto a second
line; the remainder is dropped.

Both keys have fallbacks — the name falls back to the file or directory name, the
description to the first non-empty body line — so a bare `.md` file with no
frontmatter still loads. A file with an empty body does not.

### The description is the router

The description is the *only* text the agent sees before deciding to invoke. It
is not a summary; it is a trigger condition. Write it as "use when …", name the
trigger words, and say plainly if following the addon costs noticeably more
tokens than not following it. A vague description means the addon never fires, or
fires when it shouldn't.

Name each **distinct** situation once. Two phrasings of the same situation
("build features test-first … when the user asks for TDD") are one trigger
written twice: they cost double and sharpen nothing.

### Writing a body that is worth loading

An addon exists to buy **predictability** — the same *process* every run, not the
same output. Four rules carry most of that:

- **End every step on a checkable condition.** "Run the suite and report the
  actual output" beats "test it"; "every call site listed" beats "review the call
  sites". An agent that cannot tell done from not-done stops early — and the
  stopping looks like success.
- **State the target behaviour rather than the ban.** *Don't think of an
  elephant* names the elephant. "Prefer X" steers where "never do Y" advertises
  Y. Keep a prohibition only as a hard guardrail, paired with what to do instead.
- **Reach for a word the model already knows.** One vivid, familiar term —
  *reconnaissance pass*, *smoke test*, *dry run*, *blast radius* — anchors a whole
  behaviour in a token or two, because the model already holds the concept. It
  beats three sentences describing the same thing.
- **Cut anything the agent already does.** "Be thorough" is a line you pay for
  and get nothing back. The test: does it change behaviour versus the default? If
  not, delete the sentence rather than rewording it.

The failure these prevent is a body that reads well and runs differently every
time.

> These authoring principles are MAGENTRA's adaptation of Mat Pocock's "writing
> great skills" reference. The vocabulary there — predictability, completion
> criteria, progressive disclosure, leading words, no-ops, negation — maps onto
> addons directly, since an addon *is* a skill in that sense.

## Layouts

| Layout | Use it for |
| --- | --- |
| `.magentra/addons/<name>.md` | A self-contained procedure. |
| `.magentra/addons/<name>/ADDON.md` | An addon that bundles other files. |

A directory needs an `ADDON.md` to count; a directory without one is skipped
rather than guessed at.

Everything else in that directory — reference notes, scripts, one level of
subfolders such as `references/` or `scripts/` — is listed to the agent when the
addon is invoked, as paths, not contents. The body says which ones matter and the
agent spends a `Read` or a `Bash` call only on those. So a long checklist lives
in a sibling `.md`, and a real driver lives in a sibling script:

```
.magentra/addons/release/
  ADDON.md            ← "follow CHECKLIST.md, then run scripts/tag.sh"
  CHECKLIST.md
  scripts/tag.sh
```

Up to 24 bundled files are advertised; beyond that the agent can list the rest
itself.

## Where addons come from

Loaded in increasing precedence, so a later tier **replaces** an earlier addon of
the same name:

1. **Built-ins** shipped with the app (`engine/core/src/agent/builtinAddons.ts`).
2. **`~/.magentra/addons/`** — yours, in every workspace.
3. **`<cwd>/.magentra/addons/`** — this project's, checked in with the code.

That ordering is what lets a workspace override a built-in by name: drop
`magentron.md` in the project and the project's version wins.

An unreadable or empty-bodied file is skipped, never fatal — one malformed addon
must not stop a session from starting.

## Invoking one

**The agent** invokes an addon with the `Addon` tool when a task matches a
description. This is the normal path.

**You** invoke one by typing `/<name>` — every installed addon appears in the
slash palette next to the built-in commands, and `/<name> some argument` passes
that argument through `$ARGUMENTS`. Typing it runs a turn with the addon's
instructions already loaded, which is the same state the agent reaches on its
own.

`/addons` lists what is installed, where each came from, and how many files each
one bundles.

## The built-in: `magentron`

One addon ships with the app. It is the read-before-you-write discipline: map
what a change touches, reuse what already exists instead of writing a second
copy, and delete superseded code in the same change — with a coherence audit at
the end. It leans on `GraphQuery blast`/`deps`/`structure` to find the real fan-in
before the first edit.

Its description says outright that it costs extra tokens, because it does: it
front-loads a reconnaissance pass. That warning is deliberate — since addons are
always discoverable rather than toggled, the cost has to be visible to the agent
at the moment it decides.

Override it per project with `.magentra/addons/magentron.md`, or export it from
the Addons view (⇩ Export) and edit from there.

## Creating one

The Addons view's **＋ BUILD NEW ADDON** wizard takes a plain-language
description, has the engine author the file (`generate_addon` → validated with
the real parser, retried on grammar errors → `addon_draft`), shows it for
editing, and installs it (`install_addon` → written to `.magentra/addons/`,
roster reloaded live so the current session can invoke it immediately).

Hand-written files work exactly the same — drop them in the folder. They are
picked up on the next session start (or `/clear`).

## Where the code lives

| Concern | File |
| --- | --- |
| Loader, precedence, resource listing | `engine/core/src/agent/addons.ts` |
| The shipped built-ins | `engine/core/src/agent/builtinAddons.ts` |
| The `Addon` tool | `engine/tools/src/addon.ts` |
| The always-on roster block | `addonsBlock` in `engine/core/src/agent/prompts.ts` |
| Wizard, `/addons`, `/<name>` dispatch | `engine/core/src/runtime/engine.ts` |
| Frontmatter parsing | `engine/core/src/config/frontmatter.ts` |
| The view and wizard UI | `app/renderer/modules/addons.js` |

Invariants are asserted by `.claude/skills/bigboycoding/addon-check.mjs`
(`npm run build && node .claude/skills/bigboycoding/addon-check.mjs`) — discovery,
both layouts, precedence, that no addon body ever leaks into the standing system
prompt, and the on-invoke load.
