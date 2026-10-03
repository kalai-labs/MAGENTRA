---
id: reminder.monitor-noise-stop
group: 3 · In-turn reminders
label: Monitor stopped — too noisy
channel: reminder
where: Queued as a `<task-notification>` when a Monitor floods past its noise limit and is stopped automatically, so the agent narrows the command instead of waiting on it. `{{id}}` is the task id. Known residual: the engine fills only `{{id}}`, so `{{noiseLimit}}` and `{{noiseWindowSec}}` reach the model as written, exactly as they did before the move (fixing that is a separate approved change). When switched off, the bare fact that the monitor was stopped is sent instead.
placeholders: id, noiseLimit, noiseWindowSec
---
<task-notification>Monitor {{id}} was stopped automatically: more than {{noiseLimit}} events within {{noiseWindowSec}}s (too noisy). Narrow the command and restart if you still need it.</task-notification>
