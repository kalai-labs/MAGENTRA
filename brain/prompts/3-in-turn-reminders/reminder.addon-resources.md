---
id: reminder.addon-resources
group: 3 · In-turn reminders
label: Addon bundled files
channel: reminder
where: Appended, after a blank line, to an addon's body when the Addon tool loads an addon that owns a folder of other files. `{{files}}` lists them, one `- <path>` per line. When switched off, the list is sent alone.
placeholders: files
---
<system-reminder>Files bundled with this addon — read the ones its instructions point at, and run its scripts with Bash:
{{files}}</system-reminder>
