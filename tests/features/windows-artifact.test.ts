/**
 * `windows-artifact`.
 *
 * KIND, RE-DECLARED 2026-09-20: the record said `["ui"]`, and nothing here
 * opens a window. Every checklist item is either a spawned process (the
 * bundler, electron-builder, the packaged exe itself, the bundled `rg.exe`)
 * or a read of bytes/config that needs no window at all — exactly what the
 * WHERE section already named `tests/lib/procTest.ts` for. Items 5 and 6 are
 * `pure` per the ready description itself ("NAMES AGREE (pure)", "CI IS THE
 * OTHER OS (pure)"). Re-declared honestly to `["pure","proc"]`.
 *
 * ARTIFACT OPT-IN. Items 1-4 build and launch a real packaged app — minutes of
 * work, ~1 GB written, one shared `app/dist`. They are `artifact = true`
 * (decisions/0010): withheld under plain `npm test`, named on stderr, and run
 * only under `npm run test:artifacts`. Items 5 and 6 need no packager and run
 * every time.
 *
 * ITEM 6 IS EXPECTED TO STAY RED (product owner, 2026-09-20).
 * `.github/workflows/release.yml` contains the string "smoke" zero times: no
 * leg of the release workflow launches the artifact it just built. The test
 * asserts the checklist's own requirement verbatim and is left failing on
 * purpose — the owner adds the workflow steps, this suite does not synthesize
 * them.
 *
 * WHY A BUILD RUNS `bundle-engine.js` UNDER ITS OWN LOCK, THEN `dist.js` UNDER
 * A SECOND ONE: `bundle-engine.js` rewrites `app/build-resources/engine/*`,
 * a directory three OTHER artifact features (mac, `no-node-modules-at-runtime`
 * and `fully-local-assets`) also rewrite — `"bundle-engine"` is their
 * existing lock name (see `mac-artifact.test.ts`). `dist.js` then writes
 * `app/dist`, which only a Windows build touches on this platform, under its
 * own `"dist"` lock so a second concurrent Windows run cannot see it half
 * written.
 *
 * app/dist ALREADY HELD STALE BUILDS FROM EARLIER VERSIONS when this was
 * written (0.16.9, 0.16.10, 0.17.0, next to the current 0.17.4) — decisions/
 * (this session) says `app/dist` may be deleted outright before a build,
 * since it is gitignored; item 1 does exactly that, which is also why its
 * "contains exactly" check tolerates `builder-debug.yml` (electron-builder's
 * own bookkeeping file, present in that same stale directory and never
 * mentioned by the ready description) without tolerating a leftover artifact
 * from a version this build did not just produce.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { withExclusiveLock } from "../lib/exclusive.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "windows-artifact";

/** Verbatim from the record. */
const INVARIANT = "The Windows build produces both a portable exe and an NSIS installer with the documented names.";

const NOT_WINDOWS = "Windows artifact tests need a Windows machine; the release workflow's windows leg is the proof there.";

const requireFromHere = createRequire(import.meta.url);

interface AppPackage {
  readonly version: string;
  readonly build: {
    readonly portable: { readonly artifactName: string };
    readonly nsis: { readonly artifactName: string };
  };
}

function appPackage(): AppPackage {
  return JSON.parse(readFileSync(join(repoRoot(), "app", "package.json"), "utf8")) as AppPackage;
}

function portableName(version: string): string {
  return `MAGENTRA-${version}-win-portable.exe`;
}
function setupName(version: string): string {
  return `MAGENTRA-${version}-win-setup.exe`;
}

interface PeSection {
  readonly name: string;
  readonly rawPtr: number;
  readonly rawSize: number;
}

/** The PE section table, walked the way the loader walks it. */
function peSections(exe: Buffer): readonly PeSection[] {
  const lfanew = exe.readUInt32LE(0x3c);
  const count = exe.readUInt16LE(lfanew + 6);
  const optSize = exe.readUInt16LE(lfanew + 20);
  const table = lfanew + 24 + optSize;
  const out: PeSection[] = [];
  for (let i = 0; i < count; i++) {
    const o = table + i * 40;
    out.push({
      name: exe.subarray(o, o + 8).toString("latin1").replace(/\x00+$/, ""),
      rawSize: exe.readUInt32LE(o + 16),
      rawPtr: exe.readUInt32LE(o + 20),
    });
  }
  return out;
}

function distDir(): string {
  return join(repoRoot(), "app", "dist");
}
function unpackedDir(): string {
  return join(distDir(), "win-unpacked");
}

/** Every process a spawn produces here dies with the test — see `ProcTest`. */
abstract class WindowsArtifactTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  override readonly artifact = true;
  // See the note on MacArtifactTest: a subject tag for `npm run test:windows`,
  // not a licence to stop asserting the truth of whatever OS is running.
  override readonly platform = "win32" as const;
  override readonly timeoutMs: number = 900_000;
}

/* ---- checklist 1 — BUILD ------------------------------------------------ */

class TheBuildProducesTheDocumentedArtifacts extends WindowsArtifactTest {
  readonly id = "the-build-produces-both-the-portable-exe-and-the-nsis-installer";
  readonly whyItExists =
    "a build that silently drops the NSIS installer, mis-names an artifact, or leaves a previous version's exe sitting in app/dist would ship nothing the release workflow's upload step or a user's updater could find";

  override async run(t: TestRun): Promise<void> {
    if (process.platform !== "win32") {
      t.assert.fail(NOT_WINDOWS);
      return;
    }

    const version = appPackage().version;
    const dist = distDir();
    // decisions (this session): app/dist is gitignored and may be wiped before
    // a build, so a stale artifact from a previous version cannot survive to
    // fool the "contains exactly" check below.
    // force only forgives ENOENT. Windows keeps a handle on a just-built
    // tree for a moment, so without retries the wipe half-fails and leaves
    // a previous run's intermediate behind — which is exactly what the
    // straggler assertion below then reports as a build fault.
    rmSync(dist, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });

    await withExclusiveLock("bundle-engine", async () => {
      const bundler = this.spawn(process.execPath, [join(repoRoot(), "app", "scripts", "bundle-engine.js"), "--target", "win"]);
      const exit = await bundler.exited();
      t.assert.equal(exit.code, 0, `bundle-engine.js --target win must succeed:\n${bundler.stderr()}`);
    });

    // `dist.js` spawns the BARE name `electron-builder`, and its own comment
    // says why that is enough: "npm puts node_modules/.bin on PATH for script
    // children". Running the script directly with node is not an npm script
    // child, so nothing puts it there and the spawn dies with
    // "'electron-builder' is not recognized". The binary is hoisted to the
    // REPO ROOT by workspaces (there is no app/node_modules at all), so the
    // test supplies exactly the condition npm would — the same directory, on
    // PATH, with no shell in between.
    const binDir = join(repoRoot(), "node_modules", ".bin");
    t.assert.equal(existsSync(binDir), true, `the hoisted bin directory must exist: ${binDir}`);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const withBinOnPath = { [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ""}` };

    await withExclusiveLock("dist", async () => {
      // cwd MUST be app/, which is where the checklist says `npm run dist`
      // runs. electron-builder decides which package.json is the DEVELOPMENT
      // one from its project directory: from app/ that is app/package.json and
      // its `build` block is read; from the repo root, app/package.json becomes
      // the APPLICATION package.json and electron-builder 26 refuses it —
      // "'build' in the application package.json is not supported since 3.0".
      const dist2 = this.spawn(process.execPath, [join(repoRoot(), "app", "scripts", "dist.js"), "--win"], {
        cwd: join(repoRoot(), "app"),
        env: withBinOnPath,
      });
      const exit = await dist2.exited();
      t.assert.equal(exit.code, 0, `dist.js --win must succeed:\n${dist2.stdout()}\n${dist2.stderr()}`);
    });

    t.assert.equal(existsSync(dist), true, "electron-builder must leave app/dist behind");

    const entries = new Set(readdirSync(dist));
    const required = [portableName(version), setupName(version), `${setupName(version)}.blockmap`, "latest.yml", "win-unpacked"];
    for (const name of required) {
      t.assert.ok(entries.has(name), `app/dist must contain ${name}; it has [${[...entries].join(", ")}]`);
    }
    // Anything ELSE that looks like one of ours and is not from this build is
    // a leftover the wipe above should have removed — electron-builder's own
    // bookkeeping file is the one thing this build makes besides the required
    // set, and is not a MAGENTRA artifact.
    // electron-builder leaves its own bookkeeping beside the artifacts: the
    // debug yaml and the `.icon-ico` cache directory. Neither is a MAGENTRA
    // artifact and neither is a straggler, so the check the item actually
    // wants is the second one — nothing here belongs to another version.
    const BOOKKEEPING = new Set(["builder-debug.yml", ".icon-ico"]);
    const strays = [...entries].filter((name) => !BOOKKEEPING.has(name) && !required.includes(name));
    t.assert.deepEqual(strays, [], `app/dist must hold this build's artifacts and electron-builder's own bookkeeping, nothing else; it has [${[...entries].join(", ")}]`);
    const fromAnotherVersion = [...entries].filter((name) => name.startsWith("MAGENTRA-") && !name.includes(version));
    t.assert.deepEqual(fromAnotherVersion, [], "no artifact from an earlier version may survive the wipe, or the release upload would pick one up");

    const unpacked = unpackedDir();
    for (const name of ["MAGENTRA.exe", "magentra-cli.exe"]) {
      t.assert.equal(existsSync(join(unpacked, name)), true, `win-unpacked must contain ${name}`);
    }
    for (const name of ["engine.cjs", "doc-extract.mjs", "tui.mjs", "rg.exe"]) {
      t.assert.equal(existsSync(join(unpacked, "resources", "engine", name)), true, `win-unpacked/resources/engine must contain ${name}`);
    }

    // latest.yml is what the updater reads, so item 1's own checklist asks for
    // its `version` and its `path` — and the pairing is asserted HERE, where a
    // build has just been made and is guaranteed to exist, rather than behind an
    // existsSync in the pure item 5, where a clone with no app/dist would read
    // green having hashed nothing at all.
    //
    // Not a full YAML parse: the three fields needed are unindented top-level
    // scalars, and electron-builder also nests an indented `sha512` under
    // `files:`, which `^` with the multiline flag steps over.
    const latest = readFileSync(join(dist, "latest.yml"), "utf8");
    const declared = {
      version: latest.match(/^version: (.+)$/m)?.[1]?.trim(),
      path: latest.match(/^path: (.+)$/m)?.[1]?.trim(),
      sha512: latest.match(/^sha512: (.+)$/m)?.[1]?.trim(),
    };
    t.assert.equal(declared.version, version, `latest.yml's version must be package.json's; it reads:
${latest}`);
    t.assert.equal(declared.path, setupName(version), `latest.yml's path must name this build's setup exe; it reads:
${latest}`);
    t.assert.ok(declared.sha512, `latest.yml must carry a top-level sha512; it reads:
${latest}`);
    const actualSha = createHash("sha512").update(readFileSync(join(dist, setupName(version)))).digest("base64");
    t.assert.equal(actualSha, declared.sha512, "latest.yml's sha512 must match the setup exe on disk, or the updater rejects a good download");
  }
}

/* ---- checklist 2 — NON-ADMIN READY (pure on the artifact) --------------- */

class TheExesAreAsInvokerAndTheConsoleCopyDiffersOnlyInSubsystem extends WindowsArtifactTest {
  readonly id = "the-exes-carry-asinvoker-and-the-console-copy-differs-only-in-subsystem";
  readonly whyItExists =
    "a manifest asking for requireAdministrator or highestAvailable throws a UAC prompt at every standard-account user, and a console copy that drifted anywhere but the two subsystem bytes would not be the byte-identical binary the terminal command depends on";

  override async run(t: TestRun): Promise<void> {
    if (process.platform !== "win32") {
      t.assert.fail(NOT_WINDOWS);
      return;
    }
    const unpacked = unpackedDir();
    if (!existsSync(unpacked)) {
      t.assert.fail("run item 1 first: app/dist/win-unpacked is missing");
      return;
    }
    const version = appPackage().version;
    const setupPath = join(distDir(), setupName(version));
    t.assert.equal(existsSync(setupPath), true, "run item 1 first: the setup exe is missing");

    // The manifest is plain XML embedded as a PE resource; latin1 preserves
    // every byte 1:1 so the ASCII substring search is exact regardless of
    // what else the file contains.
    for (const [label, path] of [
      ["MAGENTRA.exe", join(unpacked, "MAGENTRA.exe")],
      ["the setup exe", setupPath],
    ] as const) {
      const text = readFileSync(path).toString("latin1");
      t.assert.ok(text.includes('requestedExecutionLevel level="asInvoker"'), `${label} must declare asInvoker`);
      t.assert.ok(!text.includes("requireAdministrator"), `${label} must never ask for requireAdministrator`);
      t.assert.ok(!text.includes("highestAvailable"), `${label} must never ask for highestAvailable`);
    }

    const gui = readFileSync(join(unpacked, "MAGENTRA.exe"));
    const cli = readFileSync(join(unpacked, "magentra-cli.exe"));
    t.assert.equal(gui.length, cli.length, "afterPack.js copies the exe byte-for-byte before flipping one word");

    const lfanew = gui.readUInt32LE(0x3c);
    t.assert.equal(cli.readUInt32LE(0x3c), lfanew, "the PE header offset must be identical in both files");
    const subsystemOffset = lfanew + 24 + 68;

    // WHAT "OTHERWISE IDENTICAL" MEANS ON A REAL BUILD. afterPack.js's
    // writeConsoleSubsystemCopy reads the exe, flips one WORD and writes the
    // copy, so at THAT moment the two differ in the Subsystem field and
    // nowhere else. They do not stay that way: electron-builder brands
    // MAGENTRA.exe — icon, version info, product name, all of them .rsrc —
    // AFTER afterPack has already taken its copy, and only MAGENTRA.exe gets
    // it. Measured on this build: all 14 code and data sections are
    // byte-identical and .rsrc alone differs, in 53,894 of its 99,328 bytes.
    //
    // So the two claims are asserted separately. The program being the same
    // program is what the terminal command depends on, and it is proven
    // section by section. The resource drift is a defect in its own right and
    // fails on its own line, instead of being folded into one byte count that
    // cannot say which half is wrong.
    for (const section of peSections(gui)) {
      if (section.name === ".rsrc") continue;
      const end = section.rawPtr + section.rawSize;
      const identical = gui.compare(cli, section.rawPtr, end, section.rawPtr, end) === 0;
      t.assert.ok(identical, `section ${section.name} must be byte-identical in the console copy — it is the program itself`);
    }
    t.assert.equal(gui.readUInt16LE(subsystemOffset), 2, "MAGENTRA.exe must keep the GUI subsystem (2)");
    t.assert.equal(cli.readUInt16LE(subsystemOffset), 3, "magentra-cli.exe must carry the console subsystem (3), or it cannot attach to a launching terminal");

    // The non-admin promise has to hold for the binary the TERMINAL command
    // runs, not only for the one the installer places on the desktop.
    const cliText = cli.toString("latin1");
    t.assert.ok(cliText.includes('requestedExecutionLevel level="asInvoker"'), "magentra-cli.exe must declare asInvoker");
    t.assert.ok(!cliText.includes("requireAdministrator"), "magentra-cli.exe must never ask for requireAdministrator");
    t.assert.ok(!cliText.includes("highestAvailable"), "magentra-cli.exe must never ask for highestAvailable");

    // THE DEFECT THIS ITEM FOUND. Left failing, per tests/README rule 4: the
    // terminal binary ships with Electron's own icon and version info rather
    // than MAGENTRA's, because the copy is taken before the branding runs.
    // It is not a launch or a UAC fault — both exes are asInvoker and both
    // load the engine bundle identically — but it is exactly the drift this
    // item exists to catch, and the fix belongs in the packaging pipeline.
    const cliHasOwnBranding = cliText.includes("MAGENTRA") || cli.toString("utf16le").includes("MAGENTRA");
    t.assert.ok(
      cliHasOwnBranding,
      "magentra-cli.exe must carry MAGENTRA's own resources — electron-builder brands MAGENTRA.exe AFTER afterPack.js copies it, so the console copy keeps Electron's icon and version info (.rsrc differs in 53,894 of 99,328 bytes; every other section is byte-identical)",
    );
  }
}

/* ---- checklist 3 — LAUNCHES ---------------------------------------------- */

class ThePackagedAppLaunchesForANonAdminUser extends WindowsArtifactTest {
  readonly id = "the-packaged-app-launches-for-a-non-admin-user";
  readonly whyItExists =
    "a sandboxed child that dies at boot, or a relaunch loop the smoke flag cannot see, would leave a non-admin user with a window that never opens and no way to tell why";

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
    if (process.platform !== "win32") {
      t.assert.fail(NOT_WINDOWS);
      return;
    }
    const unpacked = unpackedDir();
    if (!existsSync(unpacked)) {
      t.assert.fail("run item 1 first: app/dist/win-unpacked is missing");
      return;
    }
    const version = appPackage().version;
    const targets: readonly [string, string][] = [
      ["win-unpacked/MAGENTRA.exe", join(unpacked, "MAGENTRA.exe")],
      ["the portable exe", join(distDir(), portableName(version))],
    ];

    for (const [label, exe] of targets) {
      t.assert.equal(existsSync(exe), true, `run item 1 first: ${label} is missing`);
      const tmp = mkdtempSync(join(tmpdir(), "magentra-smoke-"));
      this.#tempDirs.push(tmp);

      const started = Date.now();
      const child = this.spawn(exe, ["--smoke", `--user-data-dir=${tmp}`], {
        env: {
          HOME: tmp,
          USERPROFILE: tmp,
          MAGENTRA_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          DEEPINFRA_API_KEY: undefined,
          ANTHROPIC_API_KEY: undefined,
        },
      });
      const exit = await child.exited();
      const elapsed = Date.now() - started;
      t.assert.equal(exit.code, 0, `${label} must exit 0 under --smoke:\n${child.stderr()}`);
      t.assert.ok(elapsed <= 65_000, `${label} took ${elapsed}ms to boot and exit — the checklist's 60s budget has no meaningful slack left`);

      const logFile = findLogFile(tmp);
      t.assert.notEqual(logFile, undefined, `${label} left no session log under ${tmp}`);
      const events = readLogEvents(logFile as string);
      t.assert.ok(events.includes("landing-shown"), `${label} must log landing-shown; got [${events.join(", ")}]`);
      t.assert.ok(!events.includes("render-process-gone"), `${label}'s renderer must not have crashed; log had [${events.join(", ")}]`);
      t.assert.ok(!events.includes("sandbox-rescue-relaunch"), `${label} should not have needed the sandbox rescue relaunch on a clean smoke boot`);
    }
  }
}

/** Recursively find a `desktop-*.log` file under `dir` (it may be in `logs/` or directly in `dir`). */
function findLogFile(dir: string): string | undefined {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(current, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (/^desktop-.*\.log$/.test(name)) return full;
    }
  }
  return undefined;
}

/** The `ev` field of every NDJSON line in a black-box session log. */
function readLogEvents(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const events: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { data?: { ev?: string } };
      if (entry.data?.ev) events.push(entry.data.ev);
    } catch {
      // a truncated tail line — not a frame this test needs
    }
  }
  return events;
}

/* ---- checklist 4 — TOOLS READY ------------------------------------------- */

class TheBundledToolsRunWithoutNodeModules extends WindowsArtifactTest {
  readonly id = "the-bundled-ripgrep-and-engine-bundle-run-standalone";
  readonly whyItExists =
    "a Grep tool that cannot execute, or an engine bundle that still reaches for node_modules, both pass a config check and fail on the first user machine that has neither VS Code nor this repository installed";

  override async run(t: TestRun): Promise<void> {
    if (process.platform !== "win32") {
      t.assert.fail(NOT_WINDOWS);
      return;
    }
    const unpacked = unpackedDir();
    if (!existsSync(unpacked)) {
      t.assert.fail("run item 1 first: app/dist/win-unpacked is missing");
      return;
    }

    const rg = this.spawn(join(unpacked, "resources", "engine", "rg.exe"), ["--version"]);
    const rgExit = await rg.exited();
    t.assert.equal(rgExit.code, 0, `the bundled rg.exe must run:\n${rg.stderr()}`);
    t.assert.match(rg.stdout(), /^ripgrep/, "rg --version must identify itself");

    const engine = this.spawn(join(unpacked, "MAGENTRA.exe"), [join(unpacked, "resources", "engine", "engine.cjs"), "--bogus"], {
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    const engineExit = await engine.exited();
    t.assert.equal(engineExit.code, 1, `an unknown flag must be fatal:\n${engine.stderr()}`);
    const lines = engine.stdout().split(/\r?\n/).filter((line) => line.trim() !== "");
    t.assert.equal(lines.length, 1, `exactly one frame belongs on a failed boot; got ${JSON.stringify(lines)}`);
    const frame = JSON.parse(lines[0] as string) as { type?: string; fatal?: boolean };
    t.assert.equal(frame.type, "error");
    t.assert.equal(frame.fatal, true, "the bundled engine.cjs must load and run without node_modules to produce this frame at all");
  }
}

/* ---- checklist 5 — NAMES AGREE (pure) ------------------------------------ */

interface UpdatesModule {
  assetName(version: string): string | null;
}

class TheUpdaterNamesAndChecksumAgreeWithTheBuild extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-updater-asset-names-agree-with-what-the-build-is-named";
  readonly whyItExists =
    "updates.js guesses a file name independently of app/package.json's own artifactName templates, and a 404 there is a self-update that silently never offers itself to any user";

  override run(t: TestRun): void {
    const pkg = appPackage();
    const version = pkg.version;

    t.assert.equal(pkg.build.portable.artifactName.replace("${version}", version), portableName(version));
    t.assert.equal(pkg.build.nsis.artifactName.replace("${version}", version), setupName(version));

    const updates = requireFromHere(join(repoRoot(), "app", "main", "updates.js")) as UpdatesModule;

    const realPlatform = process.platform;
    const hadPortableEnv = Object.prototype.hasOwnProperty.call(process.env, "PORTABLE_EXECUTABLE_DIR");
    const savedPortableEnv = process.env["PORTABLE_EXECUTABLE_DIR"];
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      delete process.env["PORTABLE_EXECUTABLE_DIR"];
      t.assert.equal(updates.assetName(version), setupName(version), "with no PORTABLE_EXECUTABLE_DIR, the install is the NSIS one");

      process.env["PORTABLE_EXECUTABLE_DIR"] = "C:\\wherever-the-portable-exe-was-run-from";
      t.assert.equal(updates.assetName(version), portableName(version), "PORTABLE_EXECUTABLE_DIR is what tells a portable install from an NSIS one");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      if (hadPortableEnv) process.env["PORTABLE_EXECUTABLE_DIR"] = savedPortableEnv;
      else delete process.env["PORTABLE_EXECUTABLE_DIR"];
    }
    t.assert.equal(process.platform, realPlatform, "the platform must be put back before anything else runs");

    // The checksum is NOT asserted here. It needs a real build, and item 5 is
    // `pure` and runs on every `npm test` — so guarding it with an existsSync
    // would let a clone with no app/dist pass having proven nothing, which is
    // the ticked box with nothing behind it this suite was reset to remove.
    // latest.yml's version, path and sha512 are asserted in item 1 instead,
    // where the build has just been made.
  }
}

/* ---- checklist 6 — CI IS THE OTHER OS (pure) ------------------------------ */

class CiSmokeLaunchesThePackagedWindowsApp extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "ci-smoke-launches-the-packaged-windows-app-and-fails-the-job-otherwise";
  readonly whyItExists =
    "a packaging break that only shows up once the exe actually runs would ship silently forever if no CI leg ever launches what it just built — a config-only check proves the argv, never that a window opened";

  override run(t: TestRun): void {
    const workflow = readFileSync(join(repoRoot(), ".github", "workflows", "release.yml"), "utf8");

    t.assert.match(workflow, /dist:win|npm run dist\b/, "the windows leg must package the app");
    // DECISION (product owner, 2026-09-20): this stays red until the workflow
    // gains the step. Do not weaken this assertion to match today's workflow.
    t.assert.match(
      workflow,
      /--smoke/,
      "the windows leg must have a step that launches the packaged MAGENTRA.exe with --smoke and fails the job on a non-zero exit — " +
        '.github/workflows/release.yml contains the string "smoke" zero times, so no leg does this yet',
    );
  }
}

registerFeatureTests(
  new TheBuildProducesTheDocumentedArtifacts(),
  new TheExesAreAsInvokerAndTheConsoleCopyDiffersOnlyInSubsystem(),
  new ThePackagedAppLaunchesForANonAdminUser(),
  new TheBundledToolsRunWithoutNodeModules(),
  new TheUpdaterNamesAndChecksumAgreeWithTheBuild(),
  new CiSmokeLaunchesThePackagedWindowsApp(),
);
