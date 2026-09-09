import { writeSync } from "node:fs";
import { encodeFrame } from "@magentra/protocol";

/**
 * NDJSON frame writers for the host's stdout.
 *
 * NOTE: reconstructed — the original file was missing from the branch.
 */

/** Buffered write, for the normal event pump. */
export function writeFrame(frame: unknown): void {
  process.stdout.write(encodeFrame(frame));
}

/**
 * Synchronous write, for fatal errors emitted immediately before exit.
 * stdout to a pipe is async, so a buffered write followed by process.exit()
 * discards the frame it exists to deliver.
 */
export function writeFrameSync(frame: unknown): void {
  writeSync(1, encodeFrame(frame));
}
