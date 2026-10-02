---
name: TaskOutput
---
Reads the accumulated output of a background task (backgrounded Bash, Monitor, or Agent). With block:true (the default) it waits until the task finishes or the timeout elapses, then returns the output; with block:false it returns whatever output exists right now. Use it to collect a background Agent's report or check on a long-running command.
