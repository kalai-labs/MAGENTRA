---
id: addon-author.instruction
group: 5 · Background inference calls
label: Addon author — instruction
channel: side-call-user
where: User-role instruction of the create-addon wizard's call (generate_addon), sent under addon-author.role. `{{description}}` is the user's description, `{{context}}` is addon-author.context-line (or empty), `{{taken}}` lists the installed addon names. When switched off, addon authoring is refused.
placeholders: description, context, taken
---
The user wants a new addon. Their description:
"""
{{description}}
"""{{context}}

Already-taken addon names (choose a DIFFERENT short kebab-case name): {{taken}}.

Produce a Markdown file in this exact shape — frontmatter with exactly these two
keys, then the procedure as the body:

---
name: <short-kebab-case-name>
description: <one line, on ONE physical line: the CONDITION for reaching for this addon — what kind of task, and what trigger words. This is the only text the agent sees before invoking, so it must be enough to decide. Name each DISTINCT situation once; two phrasings of the same situation are one trigger, not two. Say so plainly if following it costs noticeably more tokens.>
---

<the procedure the agent follows once this addon is loaded: concrete steps,
headings and bullet lists welcome. Write instructions to the agent, not prose
about the addon.>

Writing the body — these are what make an addon repeatable:
- **End every step on a checkable condition.** "Run the suite and report the
  actual output" beats "test it"; "every call site listed" beats "review the
  call sites". An agent that cannot tell done from not-done stops early.
- **State the target behaviour rather than the ban.** "Prefer X" steers; "don't
  do Y" names Y and makes it more available. Keep a prohibition only where it is
  a hard guardrail, and pair it with what to do instead.
- **Reach for a word the model already knows.** One vivid, familiar term
  ("reconnaissance pass", "smoke test", "dry run") anchors a whole behaviour more
  reliably than three sentences describing it.
- **Say each thing once.** The same instruction in two places is two places to
  fall out of step.

Hard rules:
- The frontmatter has ONLY `name:` and `description:`, and each value sits on
  ONE physical line. The parser is line-based: it splits a line at its FIRST
  colon, so punctuation inside a value — colons included — is safe, but a value
  that wraps onto a second line is lost.
- The body must be non-empty and must stand on its own: an agent reading only
  this file has to know what to do.
- Use `$ARGUMENTS` in the body if the addon should accept an argument from the
  user; it is substituted at invocation.
