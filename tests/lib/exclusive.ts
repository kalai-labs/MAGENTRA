/**
 * A lock for a resource the whole suite shares.
 *
 * `node --test` runs test FILES in parallel processes, so two tests in
 * different files can reach for the same thing at the same time. The packager
 * is the case that bit: `bundle-engine.js` writes one fixed output directory
 * and REMOVES it first, so a second run part-way through the first leaves the
 * first asserting about a directory that was deleted under it. Three features
 * run it, and the failure looked like a missing font.
 *
 * `mkdir` is the primitive: it is atomic on every platform this suite runs on,
 * which `existsSync` followed by a write is not. A lock whose holder died is
 * broken after `STALE_MS` — a crashed test must not wedge every later run.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Long enough for the slowest holder (the packager, ~1s) with room to spare. */
const STALE_MS = 120_000;
const POLL_MS = 50;

export async function withExclusiveLock<T>(name: string, body: () => Promise<T>, timeoutMs = 180_000): Promise<T> {
  const lock = join(tmpdir(), `magentra-lock-${name}`);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // Held. Break it if its holder is long gone, else wait.
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* it went away on its own */
      }
      if (Date.now() > deadline) throw new Error(`waited ${timeoutMs}ms for the "${name}" lock`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  try {
    return await body();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
