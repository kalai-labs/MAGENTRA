## taskId
The task id as reported by TaskCreate/TaskList — a number string like "3" ("#3" is also accepted)

## subject
New subject for the task

## description
New description for the task

## activeForm
Present continuous form shown in spinner when in_progress

## status
New status. Workflow: pending -> in_progress -> completed; deleted removes the task permanently.

## owner
New owner for the task

## metadata
Metadata keys to merge into the task. Set a key to null to delete it.

## addBlocks
Task IDs that this task blocks

## addBlockedBy
Task IDs that block this task
