import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write-then-rename so a concurrent reader (another Magentra process on the
 * same workspace, or a crash mid-write) never observes a half-written file.
 * On Windows rename-over-existing can throw EPERM/EEXIST; fall back to
 * remove-then-rename, which narrows the race to a missing-file window that
 * every caller already treats as "absent".
 *
 * `mode` is applied to the temporary file, so the renamed result carries it even
 * when the destination already existed — unlike writeFileSync's mode, which is
 * create-only. A file that may hold a secret (settings.json, with its optional
 * `apiKey`) therefore ends up 0600 on every write rather than only the first.
 * The trailing chmod fixes up a destination that was already looser.
 */
export function writeFileAtomic(file: string, data: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  try {
    renameSync(tmp, file);
  } catch {
    rmSync(file, { force: true });
    renameSync(tmp, file);
  }
  if (mode !== undefined) {
    try {
      chmodSync(file, mode);
    } catch {
      // best-effort — never fail a write over permissions polish (no-op on Windows)
    }
  }
}
