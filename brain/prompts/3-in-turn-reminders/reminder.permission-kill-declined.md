---
id: reminder.permission-kill-declined
group: 3 · In-turn reminders
label: Permission — kill by name declined
channel: reminder
where: Returned as the RESULT of a kill-by-name command the user declined on its approval card. `{{detail}}` is ": " plus the user's note, or "." when there is none (no space before it). When switched off, the result is "Permission denied.".
placeholders: detail
---
The user declined this process kill{{detail}} It stops processes by name — every matching process on this computer. To stop a background command you started, use TaskStop with its task id, or kill its pid; do not retry the same call.
