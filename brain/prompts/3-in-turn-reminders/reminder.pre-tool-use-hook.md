---
id: reminder.pre-tool-use-hook
group: 3 · In-turn reminders
label: PreToolUse hook block
channel: reminder
where: Returned as the RESULT of a tool call a PreToolUse hook blocked (exit 2); the call did not run. `{{reason}}` is the hook's stderr. When switched off, the reason is returned alone.
placeholders: reason
---
PreToolUse hook blocked this call: {{reason}}
