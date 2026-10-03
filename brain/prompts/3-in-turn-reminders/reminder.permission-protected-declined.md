---
id: reminder.permission-protected-declined
group: 3 · In-turn reminders
label: Permission — protected-path edit declined
channel: reminder
where: Returned as the RESULT of a Write/Edit into `.magentra/**` or a `.env*` file the user declined on its approval card. `{{path}}` is the absolute path; `{{detail}}` is ": " plus the user's note, or "." when there is none (no space before it). When switched off, the result is "Permission denied.".
placeholders: path, detail
---
The user declined this edit to a protected path ({{path}}){{detail}} Edits to .magentra state and .env files always require approval; do not retry the same call.
