---
id: reminder.background-exit
group: 3 · In-turn reminders
label: Background task finished
channel: reminder
where: Queued as a `<task-notification>` when a background Bash job, Monitor or background agent exits on its own (not when it is stopped), so the agent learns it ended and where its output is. `{{kind}}` is bash/monitor/agent, `{{code}}` the exit code (`null` when killed by a signal), `{{file}}` the output file. When switched off, the bare fact that the task finished is sent instead.
placeholders: kind, id, description, code, file
---
<task-notification>Background {{kind}} task {{id}} ("{{description}}") finished with exit code {{code}}. Output file: {{file}}</task-notification>
