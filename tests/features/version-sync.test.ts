/**
 * `version-sync`.
 *
 * `VERSION` is the truth; eight `package.json` files hold a copy, because npm
 * and electron-builder read the copy and nothing else. `syncTargets` writes the
 * released version into every target `version.config.json` names — the root,
 * the five engine packages, `app` and `tui` — replacing only the VALUE of the
 * first `"version"` field with a regex, so field order, indentation and line
 * endings survive untouched, and reporting per file what it was, what it is and
 * whether anything changed.
 *
 * `fs`, as the record declares. Item 1 reads the real `version.config.json` and
 * the eight real manifests in this repository; every other item builds a temp
 * root that mirrors those paths and runs the real `syncTargets` against real
 * files, so "the bytes stayed as they were" and "nothing was written" are read
 * off the disk rather than off a return value.
 *
 * `tools/version/lib/*.mjs` is plain JavaScript outside the TypeScript build, so
 * it is reached the way `version-plan` reaches it: a dynamic `import()` of a
 * `pathToFileURL` under `tools/version/lib/`.
 *
 * `next` is a PARSED version object (`version.mjs` `parse`), not a string —
 * `syncTargets` formats it itself.
 */

import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";

const FEATURE = "version-sync";

/** Verbatim from the record. */
const INVARIANT = "syncTargets writes the same version into all eight configured package.json files.";

interface Version {
  major: number;
  minor: number;
  patch: number;
}

interface SyncResult {
  path: string;
  from: string;
  to: string;
  changed: boolean;
}

interface Target {
  path: string;
}

interface Config {
  tagPrefix: string;
  targets: Target[];
  types: Record<string, { bump: string; section: string }>;
}

const LIB = join(repoRoot(), "tools", "version", "lib");

async function tool(): Promise<{
  syncTargets(root: string, config: Config, next: Version, options?: { dryRun?: boolean }): SyncResult[];
  parse(text: string): Version;
  loadConfig(root: string): Config;
}> {
  const { syncTargets } = (await import(pathToFileURL(join(LIB, "sync.mjs")).href)) as {
    syncTargets(root: string, config: Config, next: Version, options?: { dryRun?: boolean }): SyncResult[];
  };
  const { parse } = (await import(pathToFileURL(join(LIB, "version.mjs")).href)) as { parse(text: string): Version };
  const { loadConfig } = (await import(pathToFileURL(join(LIB, "config.mjs")).href)) as { loadConfig(root: string): Config };
  return { syncTargets, parse, loadConfig };
}

/** The eight manifests the release has to reach, in the order the config lists them. */
const EIGHT = [
  "package.json",
  "engine/protocol/package.json",
  "engine/providers/package.json",
  "engine/core/package.json",
  "engine/tools/package.json",
  "engine/host/package.json",
  "app/package.json",
  "tui/package.json",
] as const;

abstract class SyncTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A temp root holding the eight manifests, each at a version of its own. */
  protected mirrorRoot(): string {
    const root = this.tempDir("magentra-sync-");
    EIGHT.forEach((relative, i) => {
      const path = join(root, ...relative.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ name: `pkg-${i}`, version: `0.0.${i}` }, null, 2)}\n`, "utf8");
    });
    return root;
  }
}

/* ---- checklist 1 ------------------------------------------------------ */

class TheConfigNamesTheEightRealManifests extends SyncTest {
  readonly id = "the-config-lists-the-eight-manifests-and-each-one-exists-with-a-version";
  readonly whyItExists =
    "a package added to the workspace but never added to version.config.json was left at whatever version it was born with, and shipped inside a build whose other seven parts called themselves something else";

  override async run(t: TestRun): Promise<void> {
    const { loadConfig } = await tool();
    const config = loadConfig(repoRoot());

    t.assert.equal(config.targets.length, 8, "version.config.json names exactly eight targets");
    t.assert.deepEqual(
      config.targets.map((target) => target.path),
      [...EIGHT],
      "the root, the five engine packages, app and tui",
    );

    for (const relative of EIGHT) {
      const path = join(repoRoot(), ...relative.split("/"));
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
      t.assert.equal(typeof parsed.version, "string", `${relative} carries a string "version" field`);
    }
  }
}

/* ---- checklist 2 ------------------------------------------------------ */

class OneVersionReachesAllEight extends SyncTest {
  readonly id = "one-call-writes-the-same-version-into-every-one-of-the-eight-manifests";
  readonly whyItExists =
    "a sync that stopped at the first target left engine/core announcing the old version to the updater while the root package.json announced the new one";

  override async run(t: TestRun): Promise<void> {
    const { syncTargets, parse, loadConfig } = await tool();
    const config = loadConfig(repoRoot());
    const root = this.mirrorRoot();

    const results = syncTargets(root, config, parse("1.2.3"));

    t.assert.equal(results.length, 8, "one result per target");
    t.assert.deepEqual(
      [...results].map((r) => r.path).sort(),
      [...EIGHT].sort(),
      "every configured target reported",
    );
    for (const result of results) {
      t.assert.equal(result.to, "1.2.3", `${result.path} reports the new version`);
      t.assert.equal(result.changed, true, `${result.path} reports that it changed`);
    }

    for (const relative of EIGHT) {
      const parsed = JSON.parse(readFileSync(join(root, ...relative.split("/")), "utf8")) as { version: string };
      t.assert.equal(parsed.version, "1.2.3", `${relative} on disk`);
    }
  }
}

/* ---- checklist 3 ------------------------------------------------------ */

class OnlyTheValueMoves extends SyncTest {
  readonly id = "a-crlf-four-space-manifest-keeps-every-byte-but-the-version-value";
  readonly whyItExists =
    "rewriting the manifest through JSON.stringify reordered its fields and rewrote its line endings, so a one-character release turned into a whole-file diff nobody could review";

  override async run(t: TestRun): Promise<void> {
    const { syncTargets, parse } = await tool();
    const root = this.tempDir("magentra-sync-bytes-");
    const path = join(root, "package.json");
    // Four-space indent, CRLF throughout, and "version" as the THIRD key.
    const original = ['{', '    "name": "byte-layout",', '    "private": true,', '    "version": "0.0.1",', '    "scripts": {', '        "build": "tsc -b"', '    }', '}', ''].join("\r\n");
    writeFileSync(path, original, "utf8");

    const config: Config = { tagPrefix: "v", targets: [{ path: "package.json" }], types: {} };
    const first = syncTargets(root, config, parse("2.0.0"));

    t.assert.equal(first.length, 1);
    t.assert.equal(first[0]!.from, "0.0.1");
    t.assert.equal(first[0]!.to, "2.0.0");
    t.assert.equal(first[0]!.changed, true);

    const after = readFileSync(path, "utf8");
    t.assert.equal(after, original.replace('"version": "0.0.1"', '"version": "2.0.0"'), "only the version value moved");
    t.assert.equal(after.includes("\r\n"), true, "CRLF survived");
    t.assert.equal(after.split("\r\n")[1], '    "name": "byte-layout",', "the field order and the four-space indent survived");

    // Push the file back in time so "nothing was written" is a real assertion
    // rather than a comparison of two stamps a fast machine cannot tell apart.
    const past = new Date(Date.now() - 60_000);
    utimesSync(path, past, past);
    const before = statSync(path).mtimeMs;

    const second = syncTargets(root, config, parse("2.0.0"));
    t.assert.equal(second.length, 1);
    t.assert.equal(second[0]!.changed, false, "a second run reports no change");
    t.assert.equal(statSync(path).mtimeMs, before, "and wrote nothing");
    t.assert.equal(readFileSync(path, "utf8"), after, "the bytes are the ones the first run left");
  }
}

/* ---- checklist 4 ------------------------------------------------------ */

class DryRunSkipAndRefusal extends SyncTest {
  readonly id = "a-dry-run-writes-nothing-a-missing-target-is-skipped-and-broken-json-names-itself";
  readonly whyItExists =
    "the release plan's preview wrote the manifests before anyone had approved the plan, and a target whose directory did not exist yet aborted a release that had nothing wrong with it";

  override async run(t: TestRun): Promise<void> {
    const { syncTargets, parse } = await tool();
    const root = this.tempDir("magentra-sync-dry-");

    const present = join(root, "package.json");
    writeFileSync(present, `${JSON.stringify({ name: "present", version: "0.1.0" }, null, 2)}\n`, "utf8");
    const noVersion = join(root, "noversion.json");
    writeFileSync(noVersion, `${JSON.stringify({ name: "no-version-here" }, null, 2)}\n`, "utf8");
    const broken = join(root, "broken.json");
    writeFileSync(broken, "{ not json at all", "utf8");

    const dry = syncTargets(
      root,
      { tagPrefix: "v", targets: [{ path: "package.json" }, { path: "nowhere/package.json" }, { path: "noversion.json" }], types: {} },
      parse("3.4.5"),
      { dryRun: true },
    );

    t.assert.deepEqual(dry.map((r) => r.path), ["package.json"], "the missing target is skipped, the version-less file yields no entry");
    t.assert.equal(dry[0]!.from, "0.1.0");
    t.assert.equal(dry[0]!.to, "3.4.5");
    t.assert.equal(dry[0]!.changed, true, "a dry run still reports what it WOULD do");
    t.assert.equal((JSON.parse(readFileSync(present, "utf8")) as { version: string }).version, "0.1.0", "and changed nothing on disk");
    t.assert.equal(
      (JSON.parse(readFileSync(noVersion, "utf8")) as { version?: unknown }).version,
      undefined,
      "no version field was invented in a file that had none",
    );

    t.assert.throws(
      () => syncTargets(root, { tagPrefix: "v", targets: [{ path: "broken.json" }], types: {} }, parse("3.4.5")),
      (err: unknown) => err instanceof Error && err.message.includes("broken.json") && err.message.includes("not valid JSON"),
      "an unparseable target names itself in the error",
    );
  }
}

/* ---- checklist 5 ------------------------------------------------------ */

class AStarExpandsToVisibleDirectoriesInOrder extends SyncTest {
  readonly id = "a-star-segment-expands-to-the-visible-subdirectories-sorted";
  readonly whyItExists =
    "a `*` that also matched dot-directories swept .git and node_modules caches into the release, rewriting files nobody configured as a version target";

  override async run(t: TestRun): Promise<void> {
    const { syncTargets, parse } = await tool();
    const root = this.tempDir("magentra-sync-star-");
    for (const name of ["b", "a", ".hidden"]) {
      mkdirSync(join(root, "pkgs", name), { recursive: true });
      writeFileSync(join(root, "pkgs", name, "package.json"), `${JSON.stringify({ name, version: "0.0.0" }, null, 2)}\n`, "utf8");
    }

    const results = syncTargets(root, { tagPrefix: "v", targets: [{ path: "pkgs/*/package.json" }], types: {} }, parse("9.9.9"));

    t.assert.deepEqual(
      results.map((r) => r.path),
      ["pkgs/a/package.json", "pkgs/b/package.json"],
      "a and b, in sorted order, and never .hidden",
    );
    t.assert.equal(
      (JSON.parse(readFileSync(join(root, "pkgs", ".hidden", "package.json"), "utf8")) as { version: string }).version,
      "0.0.0",
      "the dot-directory's manifest was not touched",
    );
  }
}

registerFeatureTests(
  new TheConfigNamesTheEightRealManifests(),
  new OneVersionReachesAllEight(),
  new OnlyTheValueMoves(),
  new DryRunSkipAndRefusal(),
  new AStarExpandsToVisibleDirectoriesInOrder(),
);
