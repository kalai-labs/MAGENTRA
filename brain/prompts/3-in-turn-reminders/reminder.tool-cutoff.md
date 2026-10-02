---
id: reminder.tool-cutoff
group: 3 · In-turn reminders
label: Output cut off mid tool call
channel: reminder
where: Returned as the RESULT of a tool call whose JSON arguments were truncated by the output-token wall, so the agent reissues it instead of assuming it ran.
---
This tool call was cut off by the output-token limit before it finished, so it was NOT executed. Reissue the complete call — do not assume it ran or had any effect.
