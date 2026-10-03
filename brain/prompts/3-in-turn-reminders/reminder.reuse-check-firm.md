---
id: reminder.reuse-check-firm
group: 3 · In-turn reminders
label: Reuse check — very similar code exists
channel: reminder
where: Rides along with a Write that created a new source file when existing code scores at or above settings.reuseCheck.blockThreshold and no related search or read happened this session. The Write still runs. `{{target}}` is the new file (workspace-relative), `{{hits}}` the closest matches, one `- <file> — <symbol> (<score>)` line each. When switched off, no reminder is sent.
placeholders: target, hits
---
Reuse check: {{target}} was just created, but very similar code already exists and no related search/read happened this session:
{{hits}}
Read the closest match now. If it already covers this, extend it (Edit) and delete the new file; keep the new file only if it is genuinely distinct.
