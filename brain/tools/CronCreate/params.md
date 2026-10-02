## cron
Standard 5-field cron (minute hour day-of-month month day-of-week), local time. Supports *, */N, N, N-M, and comma lists. For one-shot "remind me at X" jobs, pin the exact fields; avoid round times like :00/:30 when the time is only approximate.

## prompt
The instruction to inject as a user message when the job fires while the REPL is idle.

## recurring
If false, the job fires once at the next matching minute and is then removed.

## durable
If true, the job persists to disk and survives restarts. Otherwise it is session-only.
