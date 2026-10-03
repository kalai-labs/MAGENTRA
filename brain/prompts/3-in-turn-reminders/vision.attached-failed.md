---
id: vision.attached-failed
group: 3 · In-turn reminders
label: Attached image — vision failed
channel: reminder
where: Put ahead of the user's message for an attached image the vision model failed to describe. `{{label}}` is the image's name, or "attached image" when it has none; `{{error}}` is the error message. The user also sees the error. When switched off, the note is dropped; if nothing else is left in the message, a bare one-line fact is sent instead.
placeholders: label, error
---
[The user attached "{{label}}", but the vision model could not look at it: {{error}}. You have NOT seen it — do not describe it or draw conclusions from it.]
