/**
 * Dependency resolution — SPEC §6.
 *
 * This is the file that makes ability 4 real (decisions/0001): a description
 * saying "write an fs test for the profile store" is a wish; the same
 * description delivered with the store's importers, the untyped `app/` files
 * that reach it, and the frame strings it crosses is a brief an agent can
 * execute without guessing.
 *
 * ONE GRAPH READER. §6 says to call `.claude/skills/bigboycoding/blast-radius.mjs`
 * rather than grow a second one, so that is what happens here — through the
 * `--json` mode added to it on 2026-09-09, because parsing its human output
 * would have BECOME a second reader the first time a label moved.
 *
 * §6 anticipated degrading to a "needs npm run build" notice when
 * `engine/core/dist/` is absent. That case does not arise: blast-radius reads
 * source off disk and needs no compiled index at all, so dependencies resolve
 * with a broken build — which is the same property decisions/0002 wanted from
 * the gateway itself. The unavailable path is kept for the script going missing.
 *
 * What is NEVER returned is a silent empty dependency set. "This feature
 * depends on nothing" is a claim, and a wrong one would send an agent to change
 * a hub as if it were a leaf.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Feature } from "./schema.js";

const run = promisify(execFile);

const SCRIPT = join(".claude", "skills", "bigboycoding", "blast-radius.mjs");

/** One entry file's reach, as blast-radius reports it. */
export interface FileDependencies {
  readonly risk: string;
  readonly exports: readonly string[];
  readonly fanOut: readonly string[];
  readonly directImporters: readonly string[];
  readonly transitiveImporters: readonly string[];
  /** Untyped `app/` files that import this transitively — where `tsc` gives no protection. */
  readonly untypedAppReach: readonly string[];
  /** Exports named in `app/` by string, which a rename would not fail the build on. */
  readonly untypedSeam: readonly { readonly name: string; readonly files: readonly string[] }[];
  /** Protocol frame strings this file emits or handles, and the other side of each. */
  readonly frames: readonly {
    readonly type: string;
    readonly emitted: readonly { readonly file: string; readonly line: number; readonly untyped: boolean }[];
    readonly handled: readonly { readonly file: string; readonly line: number; readonly untyped: boolean }[];
    readonly crossesIntoApp: boolean;
  }[];
}

/** A mirrored app/engine literal pair (§6 item 4) that this feature's files sit on. */
export interface MirroredConstant {
  readonly id: string;
  readonly name: string;
  readonly invariant: string;
  readonly sharedFiles: readonly string[];
}

export type DependencyReport =
  | {
      readonly available: false;
      /** Always populated. Never an empty set presented as an answer. */
      readonly reason: string;
    }
  | {
      readonly available: true;
      readonly files: Readonly<Record<string, FileDependencies>>;
      /** Entry files blast-radius does not index (dist/, node_modules/, or a path that moved). */
      readonly unindexed: readonly string[];
      readonly mirroredConstants: readonly MirroredConstant[];
      readonly summary: {
        readonly directImporters: number;
        readonly transitiveImporters: number;
        readonly untypedAppReach: number;
        readonly frameSeams: number;
        /** True when anything here crosses into the half `tsc` does not check. */
        readonly crossesUntypedSeam: boolean;
      };
    };

/**
 * §6 item 4, answered from the inventory rather than from a second copy of
 * BIG-PICTURE §16's list. Seven records carry section "Mirrored constants";
 * a feature whose entry files overlap one of them sits on a pair `tsc` cannot
 * compare, and the record already says what must agree.
 */
export const MIRRORED_SECTION = "Mirrored constants";

function mirroredFor(feature: Feature, all: readonly Feature[]): MirroredConstant[] {
  const mine = new Set(feature.entryFiles);
  const out: MirroredConstant[] = [];
  for (const other of all) {
    if (other.id === feature.id || other.section !== MIRRORED_SECTION) continue;
    const shared = other.entryFiles.filter((f) => mine.has(f));
    if (shared.length > 0) {
      out.push({ id: other.id, name: other.name, invariant: other.invariant, sharedFiles: shared });
    }
  }
  return out;
}

/**
 * Cached per feature id AND per freshness hash: when an entry file's contents
 * change the hash changes, so the cache invalidates itself on exactly the event
 * that could make a stale answer wrong. Indexing 151 files costs about a second.
 */
const cache = new Map<string, DependencyReport>();

export function clearDependencyCache(): void {
  cache.clear();
}

export async function resolveDependencies(
  root: string,
  feature: Feature,
  all: readonly Feature[],
): Promise<DependencyReport> {
  const key = `${feature.id}@${feature.freshness.hash}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const script = join(root, SCRIPT);
  if (!existsSync(script)) {
    return {
      available: false,
      reason: `${SCRIPT} is missing — dependency resolution needs it (SPEC §6 calls it rather than growing a second graph reader). This is NOT an empty dependency set.`,
    };
  }

  let parsed: {
    files: Record<string, FileDependencies>;
    unknown: string[];
  };
  try {
    // The script's own node, no shell: the lesson tools/prompt-lab/server.mjs
    // records about `npx` on Windows applies to every child process here.
    const { stdout } = await run(process.execPath, [script, "--json", ...feature.entryFiles], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch (err) {
    return {
      available: false,
      reason: `blast-radius could not answer — ${err instanceof Error ? err.message : String(err)}. This is NOT an empty dependency set.`,
    };
  }

  const files = parsed.files ?? {};
  const direct = new Set<string>();
  const transitive = new Set<string>();
  const untyped = new Set<string>();
  let frameSeams = 0;
  let crosses = false;
  for (const d of Object.values(files)) {
    for (const f of d.directImporters) direct.add(f);
    for (const f of d.transitiveImporters) transitive.add(f);
    for (const f of d.untypedAppReach) untyped.add(f);
    frameSeams += d.frames.length;
    if (d.untypedSeam.length > 0 || d.frames.some((f) => f.crossesIntoApp) || d.untypedAppReach.length > 0) {
      crosses = true;
    }
  }

  const report: DependencyReport = {
    available: true,
    files,
    unindexed: parsed.unknown ?? [],
    mirroredConstants: mirroredFor(feature, all),
    summary: {
      directImporters: direct.size,
      transitiveImporters: transitive.size,
      untypedAppReach: untyped.size,
      frameSeams,
      crossesUntypedSeam: crosses,
    },
  };
  cache.set(key, report);
  return report;
}
