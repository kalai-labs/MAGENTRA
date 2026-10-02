---
name: Edit
---
Performs exact string replacement in a file.

- You must Read the file in this session before editing; the call fails otherwise.
- old_string must match the file contents exactly, including whitespace and indentation, and must be unique in the file — otherwise the edit fails. Never include the Read line-number prefix (number + tab) in old_string.
- Keep old_string short: the smallest unique anchor — a few lines at most — copied from your latest Read of the file, never retyped from memory. A long old_string written from memory fails on one missing character.
- Set replace_all: true to replace every occurrence instead of requiring uniqueness.
