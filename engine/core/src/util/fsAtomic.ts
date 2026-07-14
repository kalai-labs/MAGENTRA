import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write-then-rename so a concurrent reader (another Magentra process on the
 * same workspace, or a crash mid-write) never observes a half-written file.
 * On Windows rename-over-existing can throw EPERM/EEXIST; fall back to
 * remove-then-rename, which narrows the race to a missing-file window that
 * every caller already treats as "absent".
 */
export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, file);
  } catch {
    rmSync(file, { force: true });
    renameSync(tmp, file);
  }
}
