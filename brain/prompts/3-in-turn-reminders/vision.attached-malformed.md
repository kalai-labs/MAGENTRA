---
id: vision.attached-malformed
group: 3 · In-turn reminders
label: Attached image — malformed
channel: reminder
where: Put ahead of the user's message for an attached image that arrived without data or a media type, so it was never sent to the vision model. `{{label}}` is the image's name, or "attached image" when it has none. When switched off, the note is dropped; if nothing else is left in the message, a bare one-line fact is sent instead.
placeholders: label
---
[The user attached "{{label}}", but it arrived malformed and was not read. You have NOT seen it.]
