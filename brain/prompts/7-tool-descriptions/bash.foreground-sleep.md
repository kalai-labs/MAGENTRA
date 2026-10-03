---
id: bash.foreground-sleep
group: 7 · Tool descriptions
label: Bash — foreground sleep refused
channel: tool
where: Bash's error result when the whole command is a bare `sleep N`; the sleep does not run. Steers the agent to wait in the background instead of blocking the turn. When switched off, the bare fact "Foreground sleep is blocked." is returned (still an error).
---
Foreground sleep is blocked. If you are waiting for something, run the wait in the background (run_in_background with an until-loop) so you keep working meanwhile.
