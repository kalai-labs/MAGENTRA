---
name: TaskUpdate
---
Updates a task in the session task list.

Mark a task in_progress before starting it and completed the moment it is fully done. Never mark completed while tests fail, the implementation is partial, or errors are unresolved — keep it in_progress and create a new task for the blocker. Read the task's current state (TaskGet) before updating it.

## Note that:
- After resolving a task, call TaskList and pick up the next one.
