---
id: reminder.recovery-nudge
group: 3 · In-turn reminders
label: Turn ended on a failed call
channel: reminder
where: Injected when the turn is about to end and the LAST tool call failed. Capped at 3 auto-nudges per turn.
---
<system-reminder>The last tool call in this turn failed and the turn is ending. Either fix the failure and re-verify, or state explicitly why this failure does not block success. Do not end with a failing command unaccounted for.</system-reminder>
