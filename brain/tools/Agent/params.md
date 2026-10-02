## description
A short (3-5 word) description of the task

## prompt
The full task for the subagent. It runs autonomously and cannot ask you questions, so include every detail it needs and state exactly what to return.

## subagent_type
The type of subagent to use, named exactly as listed in this tool's description (default general-purpose).

## run_in_background
Run the subagent in the background and return a task id immediately; its result lands in the task output file. Use TaskOutput to collect it.
