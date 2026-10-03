---
id: read.image-failed
group: 7 · Tool descriptions
label: Read — image description failed
channel: tool
where: Read's error result when the vision model could not describe an image file. `{{file}}` is the file's base name, `{{error}}` the failure. When switched off, only the fact that the image could not be looked at, and why, is returned.
placeholders: file, error
---
Could not look at {{file}}: {{error}}. You have NOT seen this image — do not describe it or draw conclusions from it.
