---
id: compaction.wrapper
group: 3 · In-turn reminders
label: Compaction summary wrapper
channel: reminder
where: Replaces the compacted messages in the conversation. `{{summary}}` is the summarizer's output; the wrapper text around it is what stops the agent treating compaction as a signal to wrap up.
placeholders: summary
---
<system-reminder>Earlier conversation was compacted. Summary of the compacted span:

{{summary}}

Continue the work; do not wrap up early on account of the compaction.</system-reminder>
