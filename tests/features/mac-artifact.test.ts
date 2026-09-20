/**
 * `mac-artifact`.
 *
 * KIND, RE-DECLARED 2026-09-20: the record said `["pure","fs","proc"]`. Nothing
 * here needs `FsTest`'s temp-workspace-plus-redirectable-HOME service — every
 * checklist item either spawns a real process (the bundler, electron-builder,
 * the packaged app, `codesign`, `hdiutil`) or reads config/source that needs no
 * fixture at all. Re-declared honestly to `["pure","proc"]`.
 *
 * PLATFORM DIVERGENCE (product owner, 2026-09-20 — overrides the ready
 * description's CROSS-OS sentence for items 1-4). electron-builder cannot
 * produce a dmg anywhere but macOS, so the description's own text says a
 * non-Mac run should "fail loudly". The owner's ruling instead applies
 * tests/README's platform section here (the Linux-launcher-wrapper precedent:
 * "each platform-specific fact is asserted as what THAT platform can express,
 * never skipped where it cannot"): on a Mac, items 1-4 build and inspect the
 * real dmg and .app exactly as described below. ON THIS MACHINE (Windows),
 * they instead assert the WINDOWS TRUTH — what `build.mac` in
 * `app/package.json` actually declares, and that packaging for mac on Windows
 * produces no dmg and no `.app`, for the concrete, verifiable reason that npm
 * never installs a darwin ripgrep package on a non-mac checkout (root
 * `package.json` pins only `@vscode/ripgrep-win32-x64`; the darwin packages
 * are optionalDependencies of `@vscode/ripgrep` gated on `os`/`cpu`, and
 * `node_modules/@vscode/` on THIS machine holds no `ripgrep-darwin-*` at all).
 * `bundle-engine.js --target mac` hits exactly that gate before
 * electron-builder is ever invoked — `dist:mac`'s two steps are joined with
 * `&&`, so the packager step never runs. Every class below branches on
 * `process.platform === "darwin"`, so the same file is correct read on either
 * platform; only the Windows branch is exercised, and verified, from here.
 *
 * ARTIFACT OPT-IN. Items 1-4 are `artifact = true` (decisions/0010): withheld
 * under plain `npm test`, named on stderr, and run only under
 * `npm run test:artifacts` — this holds even for the Windows-truth branch,
 * per the brief for this session, though that branch alone is fast (no
 * electron-builder invocation ever happens on Windows). Items 5 and 6 need no
 * packager and run every time.
 *
 * ITEM 6 IS EXPECTED TO STAY RED (product owner, 2026-09-20), for the same
 * reason as `windows-artifact`'s: `.github/workflows/release.yml` contains
 * the string "smoke" zero times, so no leg — mac included — launches the
 * artifact it just built. Left failing on purpose.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { withExclusiveLock } from "../lib/exclusive.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "mac-artifact";

/** Verbatim from the record. */
const INVARIANT =
  "The macOS build produces the arm64 dmg with the documented name, and its app launches for a non-admin user with the engine and rg bundled.";

const requireFromHere = createRequire(import.meta.url);

interface AppPackage {
  readonly version: string;
  readonly build: {
    readonly appId: string;
    readonly productName: string;
    readonly mac: {
      readonly target: { readonly target: string; readonly arch: string[] }[];
      readonly artifactName: string;
      readonly identity: unknown;
      readonly extraResources: { readonly filter: string[] }[];
    };
  };
}

function appPackage(): AppPackage {
  return JSON.parse(readFileSync(join(repoRoot(), "app", "package.json"), "utf8")) as AppPackage;
}

function dmgName(version: string): string {
  return `MAGENTRA-${version}-mac-arm64.dmg`;
}
function distDir(): string {
  return join(repoRoot(), "app", "dist");
}
function appDir(): string {
  return join(distDir(), "mac-arm64", "MAGENTRA.app");
}
function darwinRipgrepDir(): string {
  return join(repoRoot(), "node_modules", "@vscode", `ripgrep-darwin-${process.arch}`);
}

abstract class MacArtifactTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  override readonly artifact = true;
  // The SUBJECT is the mac artifact, so `npm run test:mac` selects these. It
  // does not stop them running elsewhere: each one below still asserts the
  // non-mac truth on a non-mac machine, which is the contract tests/README's
  // platform section sets and this tag deliberately does not touch.
  override readonly platform = "darwin" as const;
  override readonly timeoutMs: number = 900_000;
}

/* ---- checklist 1 — BUILD ------------------------------------------------- */

class ThePackagerProducesTheDmgOrNothingElsewhere extends MacArtifactTest {
  readonly id = "the-packager-produces-the-dmg-on-a-mac-or-nothing-anywhere-else";
  readonly whyItExists =
    "if a non-Mac machine ever produced something claiming to be the mac artifact — or silently proceeded past a missing darwin ripgrep — the gate every real mac release depends on would be unproven on the platform most contributors actually use";

  override async run(t: TestRun): Promise<void> {
    const version = appPackage().version;
    const dist = distDir();

    if (process.platform === "darwin") {
      rmSync(dist, { recursive: true, force: true });

      await withExclusiveLock("bundle-engine", async () => {
        const bundler = this.spawn(process.execPath, [join(repoRoot(), "app", "scripts", "bundle-engine.js"), "--target", "mac"]);
        const exit = await bundler.exited();
        t.assert.equal(exit.code, 0, `bundle-engine.js --target mac must succeed:\n${bundler.stderr()}`);
      });
      await withExclusiveLock("dist", async () => {
        const dist2 = this.spawn(process.execPath, [join(repoRoot(), "app", "scripts", "dist.js"), "--mac"]);
        const exit = await dist2.exited();
        t.assert.equal(exit.code, 0, `dist.js --mac must succeed:\n${dist2.stderr()}`);
      });

      t.assert.equal(existsSync(join(dist, dmgName(version))), true, `the dmg must be named ${dmgName(version)}`);
      const app = appDir();
      t.assert.equal(existsSync(join(app, "Contents", "MacOS", "MAGENTRA")), true);
      t.assert.equal(existsSync(join(app, "Contents", "Resources", "bin", "magentra")), true);
      for (const name of ["engine.cjs", "doc-extract.mjs", "tui.mjs", "rg"]) {
        t.assert.equal(existsSync(join(app, "Contents", "Resources", "engine", name)), true, `Contents/Resources/engine must contain ${name}`);
      }
      return;
    }

    // WINDOWS TRUTH (see header). No darwin ripgrep package exists on this
    // checkout, so the mac bundle step must fail before electron-builder is
    // ever invoked, and packaging must leave no dmg and no .app anywhere.
    t.assert.equal(
      existsSync(darwinRipgrepDir()),
      false,
      "this test is meant to prove the gate that fires when a darwin ripgrep package is absent — one is installed here, so that gate cannot be exercised",
    );

    await withExclusiveLock("bundle-engine", async () => {
      const bundler = this.spawn(process.execPath, [join(repoRoot(), "app", "scripts", "bundle-engine.js"), "--target", "mac"]);
      const exit = await bundler.exited();
      t.assert.notEqual(exit.code, 0, "packaging for mac without its ripgrep must fail here, before electron-builder ever runs");
      t.assert.match(`${bundler.stdout()}${bundler.stderr()}`, /ripgrep|rg/i, "and must say what is missing");
    });

    if (existsSync(dist)) {
      const entries = readdirSync(dist);
      t.assert.deepEqual(entries.filter((e) => e.endsWith(".dmg")), [], "packaging on Windows must produce no dmg");
      t.assert.equal(existsSync(join(dist, "mac-arm64")), false, "packaging on Windows must produce no MAGENTRA.app");
    } else {
      t.diagnostic("app/dist does not exist in this run — trivially no dmg and no .app either");
    }
  }
}

/* ---- checklist 2 — NON-ADMIN READY --------------------------------------- */

interface PlistModule {
  parse(text: string): Record<string, unknown>;
}

class TheDeclaredMacConfigIsUnsignedAndNonAdmin extends MacArtifactTest {
  readonly id = "the-mac-build-declares-an-unsigned-non-admin-app";
  readonly whyItExists =
    "an app owned by root, missing an exec bit that git cannot record on a Windows checkout, or a signature that demands a provisioning profile would all leave a standard macOS account unable to open what electron-builder just made";

  override async run(t: TestRun): Promise<void> {
    const pkg = appPackage();
    const version = pkg.version;

    // What the recipe declares — always checkable, on any OS, from source.
    t.assert.equal(pkg.build.mac.identity, null, "an unsigned build is the documented first-open path (right-click -> Open), not an admin requirement");
    t.assert.deepEqual(
      pkg.build.mac.target.map((entry) => ({ target: entry.target, arch: entry.arch })),
      [{ target: "dmg", arch: ["arm64"] }],
    );
    t.assert.equal(pkg.build.mac.artifactName, "MAGENTRA-${version}-mac-${arch}.${ext}");
    t.assert.equal(pkg.build.appId, "com.magentra.app");
    t.assert.equal(pkg.build.productName, "MAGENTRA");
    t.assert.ok(pkg.build.mac.extraResources[0]?.filter.includes("rg"), "the mac package must carry the Grep tool's binary");

    if (process.platform !== "darwin") {
      t.diagnostic("no .app was built on this OS (see item 1) — the declared build.mac config above is the whole of item 2 here");
      return;
    }

    const app = appDir();
    if (!existsSync(app)) {
      t.assert.fail("run item 1 first: the .app is missing");
      return;
    }

    const stack = [join(app, "Contents")];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        t.assert.notEqual(st.uid, 0, `${full} must not be owned by root`);
        t.assert.equal(st.mode & 0o4000, 0, `${full} must not carry the setuid bit`);
        t.assert.equal(st.mode & 0o2000, 0, `${full} must not carry the setgid bit`);
      }
    }
    for (const rel of ["Contents/MacOS/MAGENTRA", "Contents/Resources/bin/magentra", "Contents/Resources/engine/rg"]) {
      t.assert.notEqual(statSync(join(app, rel)).mode & 0o111, 0, `${rel} must have its exec bit set`);
    }

    const plist = requireFromHere("plist") as PlistModule;
    const info = plist.parse(readFileSync(join(app, "Contents", "Info.plist"), "utf8"));
    t.assert.equal(info["CFBundleExecutable"], "MAGENTRA");
    t.assert.equal(info["CFBundleIdentifier"], "com.magentra.app");
    t.assert.equal(info["CFBundleShortVersionString"], version);

    const codesign = this.spawn("codesign", ["-dv", app]);
    await codesign.exited();
    const output = `${codesign.stdout()}${codesign.stderr()}`;
    t.assert.ok(!/provisioning profile/i.test(output), `an unsigned/ad-hoc build must never require a provisioning profile:\n${output}`);
  }
}

/* ---- checklist 3 — LAUNCHES ------------------------------------------------ */

class TheAppLaunchesOrCannotBeMountedElsewhere extends MacArtifactTest {
  readonly id = "the-app-launches-for-a-non-admin-user-or-cannot-be-mounted-elsewhere";
  readonly whyItExists =
    "a renderer that crashes at boot fails silently for a user who just double-clicked the dmg's app, and on a platform with no dmg-mounting tool at all that whole path must be provably unreachable rather than quietly assumed";

  #tempDirs: string[] = [];

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const dir of this.#tempDirs) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }

  override async run(t: TestRun): Promise<void> {
    if (process.platform === "darwin") {
      const app = appDir();
      if (!existsSync(app)) {
        t.assert.fail("run item 1 first: the .app is missing");
        return;
      }
      const tmp = mkdtempSync(join(tmpdir(), "magentra-mac-smoke-"));
      this.#tempDirs.push(tmp);
      const started = Date.now();
      const child = this.spawn(join(app, "Contents", "MacOS", "MAGENTRA"), ["--smoke", `--user-data-dir=${tmp}`], {
        env: {
          HOME: tmp,
          MAGENTRA_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          DEEPINFRA_API_KEY: undefined,
          ANTHROPIC_API_KEY: undefined,
        },
      });
      const exit = await child.exited();
      const elapsed = Date.now() - started;
      t.assert.equal(exit.code, 0, `the app must exit 0 under --smoke:\n${child.stderr()}`);
      t.assert.ok(elapsed <= 65_000, `took ${elapsed}ms — the checklist's 60s budget has no meaningful slack left`);

      const version = appPackage().version;
      const dmg = join(distDir(), dmgName(version));
      const mount = this.spawn("hdiutil", ["attach", "-nobrowse", "-readonly", dmg]);
      const mountOut = await mount.exited();
      t.assert.equal(mountOut.code, 0, `hdiutil attach must succeed:\n${mount.stderr()}`);
      const volumeLine = mount.stdout().split("\n").find((line) => line.includes("/Volumes/"));
      t.assert.notEqual(volumeLine, undefined, "hdiutil must report the mounted volume");
      // The mount point is the REST OF THE LINE, not its last whitespace-run
      // token. hdiutil prints tab-separated columns and electron-builder titles
      // the volume `${productName} ${version}-${arch}` — "MAGENTRA 0.17.4-arm64"
      // — so splitting on /\s+/ and taking `.pop()` yielded "0.17.4-arm64" and
      // both checks below then stat'd a path that never existed. The dmg was
      // correct the whole time; only this line could not read its name.
      const volume = (volumeLine as string).slice((volumeLine as string).indexOf("/Volumes/")).trimEnd();
      t.assert.equal(existsSync(join(volume, "MAGENTRA.app")), true, "the mounted dmg must contain MAGENTRA.app");
      t.assert.equal(existsSync(join(volume, "Applications")), true, "the mounted dmg must contain the Applications symlink — the drag-to-install affordance");
      const detach = this.spawn("hdiutil", ["detach", volume]);
      await detach.exited();
      return;
    }

    // WINDOWS TRUTH: there is no tool here to mount a dmg or run a Mach-O
    // binary at all — the same shape as the Linux-launcher-wrapper precedent
    // in tests/README ("Windows has neither and ships no wrapper").
    const attempt = this.spawn("hdiutil", ["attach", "-nobrowse", "-readonly", "nonexistent.dmg"]);
    const exit = await attempt.exited();
    t.assert.equal(exit.code, null, "hdiutil must not exist as a runnable command on this platform");
    t.assert.equal(exit.signal, null, "a real exit (even a failing one) would carry a numeric code, not null/null — null/null is this kind's ENOENT signature");
    t.assert.equal(existsSync(appDir()), false, "no .app was built to launch on this OS (see item 1)");
  }
}

/* ---- checklist 4 — TOOLS READY --------------------------------------------- */

class TheBundledToolsRunStandaloneOrTheDarwinRgIsAbsentHere extends MacArtifactTest {
  readonly id = "the-bundled-rg-and-engine-run-standalone-or-the-darwin-rg-is-absent-here";
  readonly whyItExists =
    "a Grep tool that cannot execute, an engine bundle that still reaches for node_modules, or a terminal launcher that baked in the build machine's own path would all pass a config check and fail on a user's Mac";

  override async run(t: TestRun): Promise<void> {
    if (process.platform === "darwin") {
      const app = appDir();
      if (!existsSync(app)) {
        t.assert.fail("run item 1 first: the .app is missing");
        return;
      }
      const rg = this.spawn(join(app, "Contents", "Resources", "engine", "rg"), ["--version"]);
      const rgExit = await rg.exited();
      t.assert.equal(rgExit.code, 0, `the bundled rg must run:\n${rg.stderr()}`);
      t.assert.match(rg.stdout(), /^ripgrep/, "rg --version must identify itself");

      const engine = this.spawn(join(app, "Contents", "MacOS", "MAGENTRA"), [join(app, "Contents", "Resources", "engine", "engine.cjs"), "--bogus"], {
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
      const engineExit = await engine.exited();
      t.assert.equal(engineExit.code, 1, `an unknown flag must be fatal:\n${engine.stderr()}`);
      const lines = engine.stdout().split(/\r?\n/).filter((line) => line.trim() !== "");
      t.assert.equal(lines.length, 1, `exactly one frame belongs on a failed boot; got ${JSON.stringify(lines)}`);
      const frame = JSON.parse(lines[0] as string) as { type?: string; fatal?: boolean };
      t.assert.equal(frame.type, "error");
      t.assert.equal(frame.fatal, true);

      const launcherPath = join(app, "Contents", "Resources", "bin", "magentra");
      const launcher = readFileSync(launcherPath, "utf8");
      const afterPackSource = readFileSync(join(repoRoot(), "app", "scripts", "afterPack.js"), "utf8");
      const templateMatch = afterPackSource.match(/const MAC_LAUNCHER = `([\s\S]*?)`;/);
      t.assert.notEqual(templateMatch, null, "afterPack.js must still define MAC_LAUNCHER as a template literal");
      t.assert.equal(launcher, (templateMatch as RegExpMatchArray)[1], "the shipped launcher must be exactly the source template — no build-machine path was interpolated into it");
      t.assert.match(launcher, /MacOS\/MAGENTRA/, "the launcher must resolve its GUI binary relative to itself");
      t.assert.match(launcher, /engine\/tui\.mjs/, "the launcher must resolve the terminal UI relative to itself");
      t.assert.ok(!launcher.includes(repoRoot()), "the launcher must not carry an absolute build-machine path");
      return;
    }

    // WINDOWS TRUTH: tie the absence back to the exact source line that needs it.
    t.assert.equal(existsSync(darwinRipgrepDir()), false, "no darwin ripgrep package is installed here");
    const bundleSource = readFileSync(join(repoRoot(), "app", "scripts", "bundle-engine.js"), "utf8");
    t.assert.match(
      bundleSource,
      /ripgrep-darwin-\$\{process\.arch\}/,
      "bundle-engine.js's mac ripgrep entry must still read from the darwin package this checkout does not have",
    );
  }
}

/* ---- checklist 5 — NAMES AGREE (pure) -------------------------------------- */

interface UpdatesModule {
  assetName(version: string): string | null;
}

class TheUpdaterNamesAgreeWithTheBuild extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-updater-dmg-name-agrees-with-the-build-and-x64-mac-publishes-nothing";
  readonly whyItExists =
    "updates.js guesses the dmg name independently of app/package.json's own artifactName template, and offering an Intel Mac a file name that was never built sends an update click to a 404 instead of the release page";

  override run(t: TestRun): void {
    const pkg = appPackage();
    const version = pkg.version;
    t.assert.equal(
      pkg.build.mac.artifactName.replace("${version}", version).replace("${arch}", "arm64").replace("${ext}", "dmg"),
      dmgName(version),
    );

    const updates = requireFromHere(join(repoRoot(), "app", "main", "updates.js")) as UpdatesModule;
    const realPlatform = process.platform;
    const realArch = process.arch;
    const pretend = (platform: string, arch: string): void => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      Object.defineProperty(process, "arch", { value: arch, configurable: true });
    };
    try {
      pretend("darwin", "arm64");
      t.assert.equal(updates.assetName(version), dmgName(version), "the arm64 dmg is the only mac artifact published, and must be named exactly");

      pretend("darwin", "x64");
      t.assert.equal(updates.assetName(version), null, "no Intel mac dmg is built, so no file name may be guessed for one");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      Object.defineProperty(process, "arch", { value: realArch, configurable: true });
    }
    t.assert.equal(process.platform, realPlatform, "the platform must be put back before anything else runs");
    t.assert.equal(process.arch, realArch, "the arch must be put back before anything else runs");
  }
}

/* ---- checklist 6 — CI IS THE OTHER OS (pure) -------------------------------- */

class CiSmokeLaunchesThePackagedMacApp extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "ci-smoke-launches-the-packaged-mac-app-and-fails-the-job-otherwise";
  readonly whyItExists =
    "a packaging break that only shows up once the .app actually launches would ship silently forever if no CI leg ever launches what it just built — a config-only check proves the argv, never that a window opened";

  override run(t: TestRun): void {
    const workflow = readFileSync(join(repoRoot(), ".github", "workflows", "release.yml"), "utf8");

    t.assert.match(workflow, /dist:mac|npm run dist\b/, "the mac leg must package the app");
    // DECISION (product owner, 2026-09-20): this stays red until the workflow
    // gains the step. Do not weaken this assertion to match today's workflow.
    t.assert.match(
      workflow,
      /--smoke/,
      "the mac leg must have a step that launches the packaged MAGENTRA.app with --smoke and fails the job on a non-zero exit — " +
        '.github/workflows/release.yml contains the string "smoke" zero times, so no leg does this yet',
    );
  }
}

registerFeatureTests(
  new ThePackagerProducesTheDmgOrNothingElsewhere(),
  new TheDeclaredMacConfigIsUnsignedAndNonAdmin(),
  new TheAppLaunchesOrCannotBeMountedElsewhere(),
  new TheBundledToolsRunStandaloneOrTheDarwinRgIsAbsentHere(),
  new TheUpdaterNamesAgreeWithTheBuild(),
  new CiSmokeLaunchesThePackagedMacApp(),
);
