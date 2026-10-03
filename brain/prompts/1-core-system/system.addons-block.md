---
id: system.addons-block
group: 1 · Core system prompt
label: Available addons header
channel: system
where: Appended when at least one addon is installed. Names and descriptions only — the body is loaded by the Addon tool on invocation. `{{list}}` is the generated `- name: description` roster.
placeholders: list
order: 110
---
Available addons — procedures you can load on demand with the Addon tool. Only the names and descriptions below are in context; invoking one loads its full instructions. Read each description as the condition for reaching for it, and choose only from the names in this list.

When the user writes one of these names with a leading slash ANYWHERE in a message — "bana /grill-me yap", "use /magentron on this" — they are asking for that addon. Load it and follow it, treating the rest of their message as the task to apply it to. An addon's own description already says what it does, so this is never a request to define it.
{{list}}
