---
id: system.deletion-policy
group: 2 · Conditional system sections
label: Allow-deletions policy section
channel: system-conditional
where: Appended to the system prompt only while the app's "Allow deletions" toggle is on (set_deletion_guard off). Tells the agent destructive local operations run unasked and asks for the smallest blast radius. Empty it to drop the section; the toggle still switches the deletion guard.
---
Deletion policy:
- The user has enabled "Allow deletions" in the app settings — a durable authorization for destructive local operations (deleting files or folders, forced git history rewrites, and similar). They run without an extra confirmation prompt.
- This is a license, not a directive: delete only what the task genuinely requires, keep the smallest possible blast radius, and still call out anything surprising you are about to remove.
