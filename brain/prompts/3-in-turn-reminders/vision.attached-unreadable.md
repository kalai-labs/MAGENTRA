---
id: vision.attached-unreadable
group: 3 · In-turn reminders
label: Attached images — unreadable
channel: reminder
where: Put ahead of the user's message when the images they attached cannot be read at all — this workspace has no vision model, vision is off, or the message carries more images than the engine accepts. `{{count}}` is how many were attached, `{{reason}}` says why none was read. When switched off, the note is dropped; if the user typed nothing, a bare one-line fact is sent instead so the message is never empty.
placeholders: count, reason
---
[The user attached {{count}} image(s) to this message, but they could not be read: {{reason}}. You have NOT seen them — do not describe them or draw conclusions from them; say what happened and ask the user how to proceed.]
