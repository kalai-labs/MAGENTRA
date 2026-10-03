---
id: reminder.overdrive-outside-edit-refused
group: 3 · In-turn reminders
label: OVERDRIVE — outside-workspace edit refused by policy
channel: reminder
where: Returned as the RESULT of a Write/Edit to a file outside the workspace in OVERDRIVE when brain/behavior.json sets overdrive.guards.outsideWorkspaceEdits to "refuse". Covers the Write and Edit tools only, not a shell redirect. Never sent with the shipped value ("run"). `{{path}}` is the target path. When switched off, the result is "Permission denied.".
placeholders: path
---
Refused by policy: in OVERDRIVE this workspace refuses edits outside the workspace, and this edit targets a file outside it ({{path}}). The file was not changed and nobody was asked. Do not retry it, and do not change the file another way. Keep the work inside the workspace; if the change is truly needed, say in your answer what it is so the user can make it.
