import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import { z } from "zod";
import { extractDocumentText, type ToolDefinition } from "@magentra/core";

const MAX_LINES_DEFAULT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_DOC_BYTES = 20 * 1024 * 1024; // 20 MB cap for document extraction

const DOC_EXTS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".rtf", ".odt", ".epub"]);

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Render text in cat -n format for a line window, with a continuation notice. */
function numberLines(text: string, start: number, limit: number): { numbered: string; notice: string } {
  const lines = text.split("\n");
  const slice = lines.slice(start, start + limit);
  const numbered = slice
    .map((line, idx) => {
      const clipped =
        line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + " [truncated — line continues]" : line;
      return `${String(start + idx + 1).padStart(6)}\t${clipped}`;
    })
    .join("\n");
  const shownEnd = start + slice.length;
  const notice =
    lines.length > shownEnd
      ? `\n\n[truncated — ${lines.length - shownEnd} more lines; call Read with offset=${shownEnd} to continue]`
      : "";
  return { numbered, notice };
}

const inputSchema = z.object({
  file_path: z.string().describe("The absolute path to the file to read"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("The line number to start reading from. Only provide if the file is too large to read at once"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The number of lines to read. Only provide if the file is too large to read at once."),
});

export const readTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Read",
  description: `Reads a file from the local filesystem.

- file_path must be an absolute path.
- Reads up to ${MAX_LINES_DEFAULT} lines by default; use offset/limit for larger files, and read only the part you need when you already know where it is.
- Output uses cat -n format: line number, a tab, then the line content, starting at line 1.
- Image files (png/jpg/gif/webp) are returned visually.
- Document files (PDF, DOCX, PPTX, XLSX, RTF, ODT, EPUB) are text-extracted (best-effort, for text-based documents); the output is line-numbered and prefixed with an extraction header. Scanned or encrypted documents are not supported and return an error.
- Reading a directory, a missing file, or an empty file returns an explanatory error instead of content.
- Do not re-read a file you just edited to verify the change — Edit/Write fail loudly when they cannot apply.`,
  permissionClass: "read",
  permissionSubject: (input) => input.file_path,
  outputByteLimit: 250_000,
  execute: async (input, ctx) => {
    const path = input.file_path;
    if (!isAbsolute(path)) {
      return { content: `file_path must be absolute, got: ${path}`, isError: true };
    }
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return { content: `File does not exist: ${path}`, isError: true };
    }
    if (stat.isDirectory()) {
      return { content: `${path} is a directory, not a file. Use Glob to list its contents.`, isError: true };
    }

    const imageType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (imageType) {
      const data = readFileSync(path).toString("base64");
      ctx.session.fileState.recordRead(path);
      return { content: [{ type: "image", data, mediaType: imageType }] };
    }

    const ext = extname(path).toLowerCase();
    if (DOC_EXTS.has(ext)) {
      if (stat.size > MAX_DOC_BYTES) {
        return {
          content: `File too large for document extraction: ${stat.size} bytes (cap ${MAX_DOC_BYTES}).`,
          isError: true,
        };
      }
      let extracted: { text: string; kind: string } | undefined;
      try {
        extracted = extractDocumentText(path, readFileSync(path));
      } catch (err) {
        return {
          content: `Could not extract text from ${basename(path)}: ${(err as Error).message}`,
          isError: true,
        };
      }
      if (extracted) {
        const header = `[extracted from ${extracted.kind}, ${extracted.text.length} chars]`;
        const { numbered, notice } = numberLines(extracted.text, input.offset ?? 0, input.limit ?? MAX_LINES_DEFAULT);
        ctx.session.fileState.recordRead(path);
        return { content: `${header}\n${numbered}${notice}` };
      }
    }

    // Binary detection: a NUL byte in the head means this is not text — say so
    // honestly instead of returning a page of mojibake.
    const headBuf = readFileSync(path).subarray(0, 8192);
    if (headBuf.includes(0)) {
      return {
        content: `${basename(path)} looks like a binary file (${stat.size} bytes). Read handles text, images (${Object.keys(IMAGE_TYPES).join("/")}), and documents (${[...DOC_EXTS].join("/")}) — use Bash tooling (file, strings, unzip -l …) to inspect other binaries.`,
        isError: true,
      };
    }

    const raw = readFileSync(path, "utf8");
    if (raw.length === 0) {
      ctx.session.fileState.recordRead(path);
      return { content: "(the file exists but is empty)" };
    }

    const { numbered, notice } = numberLines(raw, input.offset ?? 0, input.limit ?? MAX_LINES_DEFAULT);
    ctx.session.fileState.recordRead(path);
    return { content: numbered + notice };
  },
  inputSchema,
};
