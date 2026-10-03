---
id: read.image-unseen
group: 7 · Tool descriptions
label: Read — image with no vision
channel: tool
where: Read's error result for an image file when this workspace has no vision model (or vision is off), so the agent does not pretend to have seen it. `{{file}}` is the file's base name, `{{reason}}` says why it cannot be seen. When switched off, only the fact that the image cannot be seen, and why, is returned.
placeholders: file, reason
---
{{file}} is an image and you cannot see it — {{reason}}. Do not describe or draw conclusions from it. Verify this change some other way, or say plainly that it stays unverified.
