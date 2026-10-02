---
id: reminder.stop-hook
group: 3 · In-turn reminders
label: Stop hook blocked the stop
channel: reminder
where: Injected when a Stop hook exits 2 as the turn is about to end; the turn continues. `{{reason}}` is the hook's stderr. When switched off, the reason is sent alone.
placeholders: reason
---
<system-reminder>Stop hook: {{reason}}</system-reminder>
