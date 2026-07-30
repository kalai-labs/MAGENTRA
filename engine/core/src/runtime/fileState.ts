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
