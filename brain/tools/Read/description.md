---
name: Read
---
Reads a file from the local filesystem.

- file_path must be an absolute path.
- Reads up to {{maxLines}} lines by default; use offset/limit for larger files, and read only the part you need when you already know where it is.
- Output uses cat -n format: line number, a tab, then the line content, starting at line 1.
- Image files (png/jpg/gif/webp) come back as a written description produced by a separate vision model — you never see the image itself, so treat that text as your only account of it. When no vision model is configured, reading an image is refused rather than returning content you cannot see.
- Document files (PDF, DOCX, PPTX, XLSX, RTF, ODT, EPUB) are text-extracted (best-effort, for text-based documents); the output is line-numbered and prefixed with an extraction header. Scanned or encrypted documents are not supported and return an error.
- Reading a directory, a missing file, or an empty file returns an explanatory error instead of content.
- Do not re-read a file you just edited to verify the change — Edit/Write fail loudly when they cannot apply.
