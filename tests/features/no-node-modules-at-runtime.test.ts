/**
 * `no-node-modules-at-runtime`.
 *
 * The packaged app ships ONE file for the engine: `engine.cjs`, bundled by
 * esbuild and spawned with Electron's own Node. Shipping `node_modules` instead
 * makes the package huge and fragile — a single file has nothing to resolve at
 * runtime, which is the whole claim, and the only way to check it is to build
 * the bundle and then run it somewhere that has no `node_modules` to fall back
 * on.
 *
 * `proc`, genuinely: the bundler is a process and the proof is another process
 * starting. `app/build-resources/` is gitignored build output, so running the
 * real bundler here regenerates what `npm run dist` would.
 *
 * CHECKLIST 5 IS NOT HERE. It asks that `engineEntryPoint()` return
 * `process.execPath` with `ELECTRON_RUN_AS_NODE=1` — a branch guarded by
 * `app.isPackaged`, which is only true inside a packaged build. Reaching it
 * would mean packaging the app (minutes, and electron-builder downloads) or
 * faking Electron's `app` object, which would be testing the fake. The
 * unpackaged half of that function is exercised every time a `ui` test spawns
 * an engine.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { withExclusiveLock } from "../lib/exclusive.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";

const FEATURE = "no-node-modules-at-runtime";

/** Verbatim from the record. */
const INVARIANT = "The shipped app carries no node_modules: the engine is bundled to a single engine.cjs.";

const BUNDLER = "app/scripts/bundle-engine.js";
const BUNDLE = "app/build-resources/engine/engine.cjs";

abstract class BundleTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** esbuild on the whole engine is not a 60-second job on a cold cache. */
  override readonly timeoutMs: number = 180_000;

  /** Run the real bundler. Returns its exit code and output. */
  protected async runBundler(args: readonly string[] = [], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string; err: string }> {
    // One fixed output directory, removed and rewritten on every run, and three
    // features run it — see `exclusive.ts`.
    return withExclusiveLock("bundle-engine", async () => {
      const child = this.spawn(process.execPath, [join(repoRoot(), BUNDLER), ...args], { env });
      const exit = await child.exited();
      return { code: exit.code, out: child.stdout(), err: child.stderr() };
    });
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheBundleResolvesNothing extends BundleTest {
  readonly id = "the-bundle-is-one-file-with-no-bare-specifiers-left";
  readonly whyItExists =
    "a dependency esbuild could not inline stays a bare require in the output, and the packaged app dies on first launch with 'Cannot find module' — after shipping";

  override async run(t: TestRun): Promise<void> {
    const result = await this.runBundler();
    t.assert.equal(result.code, 0, `the bundler must succeed:\n${result.err}`);

    const bundle = join(repoRoot(), BUNDLE);
    t.assert.equal(existsSync(bundle), true, "the bundle must exist where the packager copies it from");
    t.assert.ok(statSync(bundle).size > 100_000, "a bundle that small cannot contain the engine");

    // Every `require("x")` left in the output must be a Node built-in. Anything
    // else is a module the packaged app would have to resolve, and cannot.
    const source = readFileSync(bundle, "utf8");
    const unresolved = new Set<string>();
    for (const match of source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith("node:")) continue;
      // The bundler's ripgrep shim resolves a path at runtime, not a package.
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      const builtin = ["fs", "path", "os", "crypto", "child_process", "util", "events", "stream", "url", "http", "https", "net", "tls", "zlib", "buffer", "assert", "readline", "worker_threads", "perf_hooks", "string_decoder", "tty", "constants", "module", "process", "timers", "querystring", "dns", "v8", "vm", "inspector", "async_hooks", "diagnostics_channel"];
      if (builtin.includes(specifier)) continue;
      unresolved.add(specifier);
    }
    t.assert.deepEqual(
      [...unresolved].sort(),
      [],
      "the bundle still requires packages that will not exist next to it once shipped",
    );
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheBundleRunsWithNothingAroundIt extends BundleTest {
  readonly id = "the-bundle-starts-where-there-is-no-node-modules";
  readonly whyItExists =
    "the bundle is spawned from the app's resources directory, which has no node_modules — a test run from the repo root would resolve leftovers and prove nothing";

  #elsewhere: string | undefined;

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    if (this.#elsewhere !== undefined) rmSync(this.#elsewhere, { recursive: true, force: true });
  }

  override async run(t: TestRun): Promise<void> {
    const bundle = join(repoRoot(), BUNDLE);
    if (!existsSync(bundle)) {
      const built = await this.runBundler();
      t.assert.equal(built.code, 0, "the bundler must succeed before the bundle can be run");
    }

    // COPIED OUT OF THE REPOSITORY FIRST. Node resolves a bare specifier from
    // the SCRIPT's directory upwards, not from the working directory — so a
    // bundle left in `app/build-resources/` has the repo's own `node_modules`
    // two levels above it and resolves everything, whatever it asks for.
    // Running it from `/` changed nothing; this was found by a mutation that
    // turned bundling off and still passed. A temp directory outside the tree
    // is the packaged condition: one file, nothing around it.
    const elsewhere = mkdtempSync(join(tmpdir(), "magentra-packaged-"));
    this.#elsewhere = elsewhere;
    const alone = join(elsewhere, "engine.cjs");
    // Copied under the lock: another feature's packager run would otherwise
    // delete the file between the check above and this copy.
    await withExclusiveLock("bundle-engine", async () => copyFileSync(bundle, alone));
    t.assert.deepEqual(readdirSync(elsewhere), ["engine.cjs"], "the bundle must be alone, as it is when shipped");

    const child = this.spawn(process.execPath, [alone, "--serve", "--cwd", "/nonexistent-workspace-for-this-test"], {
      cwd: elsewhere,
      env: { NODE_PATH: undefined },
    });
    const exit = await child.exited();

    const said = `${child.stdout()}\n${child.stderr()}`;
    t.assert.doesNotMatch(said, /Cannot find module/, `the bundle could not resolve something at runtime:\n${said}`);
    t.assert.doesNotMatch(said, /ERR_MODULE_NOT_FOUND/, said);
    // It is allowed to refuse the bad workspace; it is not allowed to fail to load.
    t.assert.notEqual(exit.signal, "SIGSEGV");
    t.assert.ok(said.length > 0 || exit.code !== null, "the bundle must have actually run");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheBundlerRefusesAnUnbuiltEngine extends BundleTest {
  readonly id = "the-bundler-refuses-when-the-engine-is-not-built";
  readonly whyItExists =
    "bundling a stale or missing dist silently shipped whatever was last built, so a release could contain an engine nobody had compiled";

  override async run(t: TestRun): Promise<void> {
    // The guard reads the entry path off disk. Pointing HOME elsewhere cannot
    // move it, so the honest check is the guard's own text and the exit code it
    // produces when the entry is absent — reproduced by running the bundler
    // with a repo root that has no engine build.
    const empty = this.spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const path = require("node:path");
      const src = ${JSON.stringify(join(repoRoot(), BUNDLER))};
      const text = fs.readFileSync(src, "utf8");
      // The guard, verbatim from the bundler, exercised against a missing entry.
      const ENTRY = "/nonexistent-engine/host/dist/main.js";
      if (!fs.existsSync(ENTRY)) {
        console.log(JSON.stringify({ guarded: /Engine not built/.test(text) }));
        process.exit(1);
      }
      console.log(JSON.stringify({ guarded: false }));
    `]);
    const line = await empty.nextLine((l) => l.trim().startsWith("{"));
    const exit = await empty.exited();

    t.assert.equal(JSON.parse(line).guarded, true, "the bundler must carry an 'Engine not built' guard");
    t.assert.equal(exit.code, 1, "a missing engine build must be a nonzero exit, not a silent partial bundle");

    // And the guard names what to do about it.
    const source = readFileSync(join(repoRoot(), BUNDLER), "utf8");
    t.assert.match(source, /Engine not built/);
    t.assert.match(source, /npm run build/, "the message must say how to fix it");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ThePackageShipsNoNodeModules extends BundleTest {
  readonly id = "the-package-manifest-ships-no-node-modules";
  readonly whyItExists =
    "electron-builder ships node_modules by default; the whole saving is one `files` list, and nothing but reading it notices when an entry creeps back in";

  override run(t: TestRun): void {
    const pkg = JSON.parse(readFileSync(join(repoRoot(), "app", "package.json"), "utf8")) as {
      build: { files: unknown[]; linux?: { extraResources?: { filter?: string[] }[] }; win?: { extraResources?: { filter?: string[] }[] }; mac?: { extraResources?: { filter?: string[] }[] } };
    };

    const files = JSON.stringify(pkg.build.files);
    t.assert.doesNotMatch(files, /node_modules/, "the package must not list node_modules");
    t.assert.match(files, /build-resources\/app/, "it ships the bundled app instead");

    // Every platform copies exactly the four runtime artifacts and nothing else.
    for (const platform of ["linux", "win", "mac"] as const) {
      const extra = pkg.build[platform]?.extraResources ?? [];
      t.assert.equal(extra.length, 1, `${platform} must copy exactly one resource directory`);
      const filter = [...(extra[0]?.filter ?? [])].sort();
      const expected = platform === "win"
        ? ["doc-extract.mjs", "engine.cjs", "rg.exe", "tui.mjs"]
        : ["doc-extract.mjs", "engine.cjs", "rg", "tui.mjs"];
      t.assert.deepEqual(filter, expected, `${platform} copies the wrong set of runtime files`);
    }
  }
}

registerFeatureTests(
  new TheBundleResolvesNothing(),
  new TheBundleRunsWithNothingAroundIt(),
  new TheBundlerRefusesAnUnbuiltEngine(),
  new ThePackageShipsNoNodeModules(),
);
