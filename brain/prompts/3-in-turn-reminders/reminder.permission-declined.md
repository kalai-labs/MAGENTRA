---
id: reminder.permission-declined
group: 3 · In-turn reminders
label: Permission — call declined
channel: reminder
where: Returned as the RESULT of any other tool call the user declined on its approval card (today only a Write/Edit outside the workspace asks this way). `{{detail}}` is ": " plus the user's note, or "." when there is none (no space before it). When switched off, the result is "Permission denied.".
placeholders: detail
---
The user declined this tool call{{detail}} Adjust your approach instead of retrying the same call.
