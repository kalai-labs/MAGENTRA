import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { FileStateStore } from "../agent/tool.js";

interface Entry {
  mtimeMs: number;
  size: number;
}

/**
 * Tracks which files the model has Read this session and whether they changed
 * on disk since. Edit/Write freshness checks depend on this.
 */
export class FileState implements FileStateStore {
  private readonly entries = new Map<string, Entry>();

  recordRead(path: string): void {
    const key = resolve(path);
    try {
      const stat = statSync(key);
      this.entries.set(key, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      this.entries.delete(key);
    }
  }

  wasRead(path: string): boolean {
    return this.entries.has(resolve(path));
  }

  /**
   * Absolute paths read this session whose bytes are unchanged on disk since.
   *
   * The same mtime+size the freshness check uses, asked the other way round:
   * not "may I edit this?" but "is what was read still true?". A later CAREFUL
   * turn uses it to avoid re-opening files it already read earlier in the
   * conversation — on the second or third proposal of a session, most of the
   * scout's reading is otherwise a repeat of the first.
   */
  unchangedSinceRead(): string[] {
    const paths: string[] = [];
    for (const [key, entry] of this.entries) {
      try {
        const stat = statSync(key);
        if (stat.mtimeMs === entry.mtimeMs && stat.size === entry.size) paths.push(key);
      } catch {
        // deleted since it was read — nothing to reuse
      }
    }
    return paths;
  }

  checkFresh(path: string): string | undefined {
    const key = resolve(path);
    const entry = this.entries.get(key);
    if (!entry) {
      return `File has not been read in this session. Use Read on ${path} first.`;
    }
    try {
      const stat = statSync(key);
      if (stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) {
        return `File has been modified on disk since it was last read. Re-Read ${path} before editing.`;
      }
    } catch {
      return undefined; // deleted since read; Write may recreate it
    }
    return undefined;
  }
}
