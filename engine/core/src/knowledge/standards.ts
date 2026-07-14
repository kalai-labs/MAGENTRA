import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Candidate paths (relative to the workspace cwd) for user-provided coding standards, root first. */
export const STANDARDS_FILENAMES = ["STANDARDS.md", ".magentra/STANDARDS.md"];

const MAX_STANDARDS_BYTES = 16_384;
const TRUNCATION_NOTICE = "\n[standards truncated at 16KB — condense the file]";

/** Reads the workspace's user-provided coding standards, truncating oversized content at a line boundary. */
export function loadStandards(cwd: string): string | undefined {
  for (const name of STANDARDS_FILENAMES) {
    let content: string;
    try {
      content = readFileSync(join(cwd, name), "utf8");
    } catch {
      continue;
    }
    if (!content.trim()) continue;

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes <= MAX_STANDARDS_BYTES) return content;

    const buf = Buffer.from(content, "utf8");
    const head = buf.subarray(0, MAX_STANDARDS_BYTES).toString("utf8");
    const cut = head.lastIndexOf("\n");
    const truncated = cut >= 0 ? head.slice(0, cut) : head;
    return truncated + TRUNCATION_NOTICE;
  }
  return undefined;
}
