---
id: reminder.incomplete-tasks
group: 3 · In-turn reminders
label: Tasks still open
channel: reminder
where: Fires at the end of a clean turn while ANY task is still pending or in_progress, and at most once per turn. Costs one full round trip when it fires, so the real lever on its cost is how many tasks get opened in the first place — see tool.TaskCreate.
placeholders: tasks
---
<system-reminder>The turn is ending but these tasks are not completed:
{{tasks}}
Finish them (marking each completed via TaskUpdate only when actually done), or explicitly state why they cannot be completed.</system-reminder>
