---
name: CronCreate
---
Schedules a recurring or one-shot cron job that fires a prompt while the REPL is idle.

Jobs fire only when the current minute matches the cron expression AND the session is idle (never mid-turn). Recurring jobs auto-expire 7 days after creation — tell the user this when you schedule one. Jobs are session-only unless durable is set. Use recurring:false for one-time reminders.
