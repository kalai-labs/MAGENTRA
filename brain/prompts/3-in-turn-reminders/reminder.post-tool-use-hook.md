---
id: reminder.post-tool-use-hook
group: 3 · In-turn reminders
label: PostToolUse hook feedback
channel: reminder
where: Appended on a new line to a tool's text result when a PostToolUse hook exits 2. `{{reason}}` is the hook's stderr. When switched off, the reason is appended alone.
placeholders: reason
---
<system-reminder>PostToolUse hook: {{reason}}</system-reminder>
