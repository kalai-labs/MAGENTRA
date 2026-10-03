---
id: reminder.reuse-check
group: 3 · In-turn reminders
label: Reuse check — similar code may exist
channel: reminder
where: Rides along with a Write that created a new source file when existing code scores at or above settings.reuseCheck.remindThreshold (but below blockThreshold) and no related search or read happened this session. The Write still runs. `{{target}}` is the new file (workspace-relative), `{{hits}}` the closest matches, one `- <file> — <symbol> (<score>)` line each. When switched off, no reminder is sent.
placeholders: target, hits
---
Reuse check: {{target}} was just created, but similar code may already exist:
{{hits}}
If one of these already covers it, extend that with Edit and remove the new file rather than keeping a parallel implementation.
