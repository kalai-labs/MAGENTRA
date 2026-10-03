---
id: reminder.permission-kill-overdrive
group: 3 · In-turn reminders
label: Permission — kill by name refused (OVERDRIVE)
channel: reminder
where: Returned as the RESULT of a command that stops processes by name (pkill, killall, taskkill /IM, Stop-Process -Name, kill -1, a kill fed by pgrep/ps) while OVERDRIVE is on. The refusal is a fixed floor; only a literal allow rule or a literal grant for that exact command lets it run. When switched off, the result is "Permission denied.".
---
Refused: this command stops processes by name, which stops every matching process on this computer, not only the ones this session started. In OVERDRIVE nothing asks, so a kill by name never runs. To stop a background command you started, use TaskStop with its task id; to stop one process, kill its pid. If the user wants every matching process stopped, say so in your answer: they can run it themselves or turn OVERDRIVE off.
