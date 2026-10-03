---
id: reminder.overdrive-protected-edit-refused
group: 3 · In-turn reminders
label: OVERDRIVE — protected-path edit refused by policy
channel: reminder
where: Returned as the RESULT of a Write/Edit into `.magentra/**` or a `.env*` file in OVERDRIVE when brain/behavior.json sets overdrive.guards.protectedEdits to "refuse". Covers the Write and Edit tools only, not a shell redirect. Never sent with the shipped value ("run"). `{{path}}` is the absolute path. When switched off, the result is "Permission denied.".
placeholders: path
---
Refused by policy: in OVERDRIVE this workspace refuses edits to .magentra state and .env files, and this edit targets one ({{path}}). The file was not changed and nobody was asked. Do not retry it, and do not change the file another way. Reach the goal without editing it; if the change is truly needed, say in your answer what it is so the user can make it.
