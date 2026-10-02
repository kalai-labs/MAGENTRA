---
name: Monitor
---
Runs a long-lived command and turns each stdout line into an event you are notified about, in batches, on your next turn. Use it to watch logs, a dev server, a file tail, or a test watcher for specific output.

- For a SINGLE event ("tell me when the server is ready") this is the wrong tool: use Bash with run_in_background and a command that exits once the condition holds — `until grep -q "Ready in" dev.log; do sleep 0.5; done`. An unbounded command (`tail
-f`, `while true`) armed for a one-off event stays armed long after it fired. Monitor is for repeated events, and a command that emits lines and then exits ends its own watch.
- Every pipe stage must flush per line or matches sit unseen in its buffer: `grep` needs --line-buffered, `awk` needs fflush().
- Returns a task id immediately; stop it with TaskStop(task_id).
- Lines arriving close together are batched into one notification. stderr is written to the task output file only (read it with TaskOutput).
- If the command floods more than {{noiseLimit}} lines within {{noiseWindowSec}}s it is auto-stopped for noise; narrow the command (grep/filter) and try again.
- Unless persistent, it is killed after timeout_ms.
