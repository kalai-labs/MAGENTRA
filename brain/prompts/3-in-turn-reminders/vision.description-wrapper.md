---
id: vision.description-wrapper
group: 3 · In-turn reminders
label: Image description wrapper
channel: reminder
where: Wraps a vision model's description before it enters the conversation. `{{label}}` names the image, `{{description}}` is what the vision model returned. The wrapper is what stops the main model from claiming it looked at the picture itself.
placeholders: label, description
---
<image-description source="{{label}}">
A separate vision model looked at this image and wrote the description below. You did NOT see the image and cannot see it — this text is all you have. Work from it, quote it if you need to, and never claim to have viewed the image yourself. If the description is missing something you need, say so and ask.

{{description}}
</image-description>
