---
name: ScheduleWakeup
---
Schedules a single delayed wakeup (60s–1h) that injects a prompt once the REPL is next idle.

Use this to revisit something after a short wait (e.g. "check the build in 5 minutes"). The delay is clamped to [60, 3600] seconds. It fires once and is then removed; it never interrupts a running turn.
