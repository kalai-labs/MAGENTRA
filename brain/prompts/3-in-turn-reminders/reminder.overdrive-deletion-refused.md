---
id: reminder.overdrive-deletion-refused
group: 3 · In-turn reminders
label: OVERDRIVE — deletion refused by policy
channel: reminder
where: Returned as the RESULT of a deleting call in OVERDRIVE when brain/behavior.json sets overdrive.guards.deletions (or protectedDeletions, for a `.magentra` state dir) to "refuse". Never sent with the shipped values ("run"). `{{what}}` is what the call would delete (the command, or the worktree removal). When switched off, the result is "Permission denied.".
placeholders: what
---
Refused by policy: in OVERDRIVE this workspace refuses calls that delete, and this one would delete ({{what}}). Nothing ran and nobody was asked. Do not retry it, and do not delete the same thing another way. Reach the goal without deleting; if the deletion is truly needed, say so in your answer so the user can do it.
