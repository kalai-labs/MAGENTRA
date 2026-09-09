/**
 * Stage 1 of the gate — SPEC §4.1, decisions/0005.
 *
 * Every record stores the files that implement it plus a hash of their
 * CONTENTS. Before anything runs, rehash and compare. Drift is not a bug in the
 * code: it means a human has not yet confirmed that the record still describes
 * the feature.
 *
 * ANY stale record hard-blocks the WHOLE run. Not the affected feature's tests
 * — all of them. A gate you can get a partial green out of is a gate you learn
 * to read past, and there is no flag that bypasses this one.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Feature, FeatureRecord, FreshnessStamp } from "./schema.js";

/**
 * Copied EXACTLY from `.claude/skills/bigpicture/bigpicture.mjs`, which has
 * been doing this for the architecture document since 2026-08-01: digest
 * `path + NUL + content` per file, roll them into one sha256, truncate to 16
 * hex. A missing file contributes the literal `MISSING`, so a deleted entry
 * file drifts rather than silently hashing the same as an empty one.
 *
 * CONTENT, NEVER MTIME. Two mtime schemes were tried in that file and both
 * failed: `tsc -b` never re-emits an unchanged file, so comparing against one
 * build output reported a 53-hour-stale build seconds after a successful one;
 * and `git checkout` rewrites mtimes with identical content, so the guard fired
 * on a clean tree and no build could clear it. Ask the content, never the clock.
 *
 * The path goes into the digest before the bytes, which is why the rollup is
 * order-sensitive and why `entryFiles` order is part of a record's identity.
 */
export function hashFiles(root: string, files: readonly string[]): string {
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    try {
      h.update(readFileSync(join(root, f)));
    } catch {
      h.update("MISSING");
    }
  }
  return h.digest("hex").slice(0, 16);
}

/** Recompute a record's stamp from what is on disk right now. */
export function stamp(root: string, entryFiles: readonly string[], recordedAt = new Date().toISOString().slice(0, 10)): FreshnessStamp {
  const fileHashes: Record<string, string> = {};
  for (const f of entryFiles) fileHashes[f] = hashFiles(root, [f]);
  return { hash: hashFiles(root, entryFiles), fileHashes, recordedAt };
}

export interface FeatureFreshness {
  readonly id: string;
  readonly name: string;
  readonly fresh: boolean;
  /** Recorded rollup vs the one just computed. */
  readonly recordedHash: string;
  readonly currentHash: string;
  readonly recordedAt: string;
  /** The specific files whose contents no longer match — §9 requires naming these, not just the feature. */
  readonly drifted: readonly string[];
  /** Drifted files that are gone from disk entirely. A subset of `drifted`. */
  readonly deleted: readonly string[];
}

export function checkFeature(root: string, feature: Feature): FeatureFreshness {
  const currentHash = hashFiles(root, feature.entryFiles);
  const drifted: string[] = [];
  const deleted: string[] = [];
  for (const f of feature.entryFiles) {
    const recorded = feature.freshness.fileHashes[f];
    // An unrecorded file counts as drifted: nothing vouched for its contents.
    if (recorded === undefined || recorded !== hashFiles(root, [f])) {
      drifted.push(f);
      if (!existsSync(join(root, f))) deleted.push(f);
    }
  }
  return {
    id: feature.id,
    name: feature.name,
    fresh: currentHash === feature.freshness.hash,
    recordedHash: feature.freshness.hash,
    currentHash,
    recordedAt: feature.freshness.recordedAt,
    drifted,
    deleted,
  };
}

export interface FreshnessReport {
  readonly checked: number;
  readonly stale: readonly FeatureFreshness[];
  /** True only when NOTHING is stale. There is no partial pass. */
  readonly ok: boolean;
}

export function checkFreshness(root: string, features: readonly Feature[]): FreshnessReport {
  const stale: FeatureFreshness[] = [];
  for (const f of features) {
    const result = checkFeature(root, f);
    if (!result.fresh) stale.push(result);
  }
  return { checked: features.length, stale, ok: stale.length === 0 };
}

/**
 * Re-record a feature's freshness — the write behind
 * `POST /api/features/:id/reconcile`.
 *
 * Reconciling is a HUMAN REVIEW followed by a re-record. This function performs
 * only the second half; nothing in it can tell whether the first half happened,
 * which is why the route is approval-gated and the UI states the obligation
 * where the button is. Re-recording without reviewing defeats the mechanism.
 *
 * Takes a loaded `Feature` and returns a bare `FeatureRecord`: the derived
 * `status` is DROPPED here, on the way to disk, because §2.1 says it is never
 * written. `tsc` cannot catch that on its own — `Feature extends FeatureRecord`,
 * so a Feature is assignable wherever a record is wanted and the extra key
 * travels silently. The strict schema catches it on the write, and this is
 * where it is removed.
 */
export function reRecord(root: string, feature: Feature): FeatureRecord {
  const { status: _derived, ...record } = feature;
  return { ...record, freshness: stamp(root, feature.entryFiles) };
}
