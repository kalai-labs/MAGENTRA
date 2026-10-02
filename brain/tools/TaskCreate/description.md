---
name: TaskCreate
---
Adds a task to the session task list so the user can follow progress.

## When To Use:
- Use it for multi-step work (3+ distinct steps), when the user lists several things to do, or when new requirements arrive mid-task.
- TaskCreate must build tasks in logically feasible order, i.e. what must be done in which order has to be carefully decided.
- Skip it for a single trivial action — just do the work.
- After completing a task, add any follow-up work you found while doing it.

## Note that:
- Tasks start as pending; use TaskUpdate to move them through in_progress to completed, and check TaskList first to avoid duplicates.
