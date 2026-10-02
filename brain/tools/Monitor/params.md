## command
The shell command to run and watch; each line it prints to stdout becomes an event.

## description
Clear, concise description of what is being monitored, shown to the user.

## timeout_ms
Kill the monitor after this many ms unless persistent (default 300000).

## persistent
If true, ignore timeout_ms and keep monitoring until stopped with TaskStop.
