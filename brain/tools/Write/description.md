---
name: Write
---
Writes a file to the local filesystem, overwriting if one exists.
## When To Use:
- Create a new files or fully replace one you have already Read this session.
## When Not To Use:
- Prefer Edit for partial changes. Parent directories are created automatically.
## Note that:
- Overwriting an existing file you have not Read (or that changed on disk since) fails.
