---
id: reminder.permission-deletion-declined
group: 3 · In-turn reminders
label: Permission — deletion declined
channel: reminder
where: Returned as the RESULT of a deleting call (a file, folder or worktree) the user declined on the deletion guard's approval card. `{{detail}}` is ": " plus the user's note, or "." when there is none (no space before it). When switched off, the result is "Permission denied.".
placeholders: detail
---
The user declined this destructive tool call{{detail}} Deletion calls always require approval; adjust your approach instead of retrying the same call.
