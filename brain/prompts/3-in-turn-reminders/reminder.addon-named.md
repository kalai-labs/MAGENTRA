---
id: reminder.addon-named
group: 3 · In-turn reminders
label: The user named an addon
channel: reminder
where: Injected at turn start when the user's message names an installed addon with a leading slash (anywhere in the message, not only at the start). `{{name}}` is the addon. Also suppresses the clarify pre-layer for that turn.
placeholders: name
---
The user named the "{{name}}" addon in their message. Load it with the Addon tool now and follow it — the rest of their message is the task to apply it to, so pass it along as the addon's arguments where that fits. Its procedure is the answer to what to do here; do not ask them to define it.
