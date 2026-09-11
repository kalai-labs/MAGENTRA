/**
 * `linux-artifact`.
 *
 * A Linux package without ripgrep ships a broken Grep tool, and an artifact
 * whose name does not match what the updater looks for breaks every download
 * link. Both failures are silent at build time and only visible to a user.
 *
 * `pure` + `proc`, and the record said `ui`. Nothing in this feature involves a
 * window: it is a packaging manifest, a bundler that refuses to stage a broken
 * tool, and the argv a release script hands electron-builder. Re-declared
 * 2026-09-11 — a kind is a claim about what proving the feature requires.
 *
 * ELECTRON-BUILDER IS NOT RUN. Packaging takes minutes and downloads a runtime;
 * what this asserts is the argv it would be given, through a stand-in on PATH
 * that records how it was called. The build itself is the release workflow's
 * job, and item 5 checks that workflow's own upload globs agree with the names
 * configured here.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { withExclusiveLock } from "../lib/exclusive.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "linux-artifact";

/** Verbatim from the record. */
const INVARIANT = "The Linux build produces AppImage, tar.gz and deb with the documented artifact names.";

interface AppPackage {
  readonly build: {
    readonly linux: {
      readonly target: { readonly target: string; readonly arch: string[] }[];
      readonly artifactName: string;
      readonly executableName: string;
      readonly extraResources: { readonly filter: string[] }[];
    };
  };
}

function appPackage(): AppPackage {
  return JSON.parse(readFileSync(join(repoRoot(), "app", "package.json"), "utf8")) as AppPackage;
}

/* ---- checklist 1 and 5 — pure ------------------------------------------ */

class TheArtifactNamesArePinned extends PureTest {
  readonly featureId = FEATURE;
  readonly id = "the-linux-targets-and-artifact-names-are-pinned";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the updater downloads by exact file name, so a renamed artifact or a dropped target is a broken download link for everyone already running the app";

  override run(t: TestRun): void {
    const linux = appPackage().build.linux;

    t.assert.deepEqual(
      linux.target.map((entry) => entry.target).sort(),
      ["AppImage", "deb", "tar.gz"],
      "the three Linux artifacts are what the release workflow uploads and the updater expects",
    );
    for (const entry of linux.target) {
      t.assert.deepEqual(entry.arch, ["x64"], `${entry.target} must be built for x64`);
    }
    t.assert.equal(linux.artifactName, "MAGENTRA-${version}-linux-${arch}.${ext}");
    t.assert.equal(linux.executableName, "magentra", "the wrapper afterPack writes takes this name");
    t.assert.ok(linux.extraResources[0]?.filter.includes("rg"), "the Linux package must carry the Grep tool's binary");

    // Checklist 5: the release workflow uploads exactly what is configured here.
    const workflow = readFileSync(join(repoRoot(), ".github", "workflows", "release.yml"), "utf8");
    for (const glob of ["*.AppImage", "*.tar.gz", "*.deb", "latest-linux.yml"]) {
      t.assert.ok(workflow.includes(glob), `the release workflow must upload ${glob}, or the artifact is built and never published`);
    }
    // And the updater's own arch renaming still matches the names above.
    const updates = readFileSync(join(repoRoot(), "app", "main", "updates.js"), "utf8");
    for (const arch of ["x86_64", "amd64"]) {
      t.assert.ok(updates.includes(arch), `the updater must know the ${arch} spelling electron-builder produces`);
    }
  }
}

/* ---- checklist 2 and 3 — proc ------------------------------------------ */

class AMissingRipgrepFailsTheBuild extends ProcTest {
  readonly featureId = FEATURE;
  readonly id = "a-missing-ripgrep-fails-a-linux-package-but-not-a-local-build";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "shipping an artifact whose Grep tool cannot run must never happen silently, while a developer staging one OS on another machine must still be able to build";

  override readonly timeoutMs: number = 120_000;

  override async run(t: TestRun): Promise<void> {
    const bundler = join(repoRoot(), "app", "scripts", "bundle-engine.js");

    // WHICH TARGET IS MISSING ITS RIPGREP DEPENDS ON THE MACHINE. The per-OS
    // ripgrep packages are optional and only the running platform's is
    // installed — so a test that hard-coded "linux" proved the guard on a Mac
    // and asserted something false on a Linux runner. The absent one is found,
    // not assumed.
    const absent = ([
      ["win", join(repoRoot(), "node_modules", "@vscode", "ripgrep-win32-x64", "bin", "rg.exe")],
      ["linux", join(repoRoot(), "node_modules", "@vscode", "ripgrep-linux-x64", "bin", "rg")],
      ["mac", join(repoRoot(), "node_modules", "@vscode", `ripgrep-darwin-${process.arch}`, "bin", "rg")],
    ] as const).find(([, src]) => !existsSync(src));
    t.assert.notEqual(
      absent,
      undefined,
      "every platform's ripgrep is installed here, so the refusal this test is about cannot be produced",
    );

    const targeted = this.spawn(process.execPath, [bundler, "--target", String(absent?.[0])]);
    const targetedExit = await withExclusiveLock("bundle-engine", async () => targeted.exited());
    t.assert.notEqual(targetedExit.code, 0, `packaging for ${String(absent?.[0])} without its ripgrep must fail`);
    t.assert.match(`${targeted.stdout()}${targeted.stderr()}`, /rg|ripgrep/i, "and must say what is missing");

    // Without naming Linux as a target, the same absence is not fatal.
    // The run and its assertions are one critical section: the output directory
    // is shared with two other features, and each run removes it first.
    await withExclusiveLock("bundle-engine", async () => {
      const local = this.spawn(process.execPath, [bundler]);
      const localExit = await local.exited();
      t.assert.equal(localExit.code, 0, `a local build must not be blocked by another OS's binary:\n${local.stderr()}`);

      // Checklist 3: what a successful bundle leaves behind.
      //
      // THE RIPGREP IS NAMED FOR THE PLATFORM WHOSE PACKAGE IS INSTALLED, and
      // only the running one is (that is the premise of `absent` above). Windows
      // stages `rg.exe` and the other two stage `rg` — bundle-engine.js:48-55 —
      // so asserting "rg" everywhere asserted a POSIX fact on a Windows machine
      // and failed for a reason that had nothing to do with the build.
      const out = join(repoRoot(), "app", "build-resources", "engine");
      const ripgrep = process.platform === "win32" ? "rg.exe" : "rg";
      for (const name of ["engine.cjs", "doc-extract.mjs", "tui.mjs", ripgrep]) {
        t.assert.equal(existsSync(join(out, name)), true, `the bundle must include ${name}`);
      }
      if (process.platform !== "win32") {
        t.assert.equal(statSync(join(out, "rg")).mode & 0o111, 0o111, "a ripgrep nobody can execute is a broken Grep tool");
      }
    });
  }
}

/* ---- checklist 4 — proc ------------------------------------------------ */

class PublishingIsNeverImplicit extends ProcTest {
  readonly featureId = FEATURE;
  readonly id = "publishing-is-never-implicit-and-the-runtime-is-pinned";
  readonly invariant = INVARIANT;

  readonly whyItExists =
    "electron-builder turns on GitHub publishing by itself when it detects CI, so a build run for any other reason could push a release nobody meant to make";

  #dir: string | undefined;

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    if (this.#dir !== undefined) rmSync(this.#dir, { recursive: true, force: true });
  }

  override async run(t: TestRun): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "magentra-builder-"));
    this.#dir = dir;
    const record = join(dir, "argv.txt");

    // A stand-in for electron-builder, first on PATH: it records how it was
    // called and succeeds. Running the real one would package the app.
    //
    // `dist.js` spawns it with `shell: true`, so the shell is the platform's:
    // cmd.exe wants a `.cmd`, everything else an executable script. Both write
    // one argument per line.
    if (process.platform === "win32") {
      // A BATCH FILE CANNOT READ ITS OWN ARGUMENTS FAITHFULLY, and a stand-in
      // that mangles them tests the stand-in. cmd splits a batch file's `%1`,
      // `%2`, … on `=` and `,` as well as on whitespace, and `for %%a in (%*)`
      // splits the same way — so `-c.electronVersion=33.4.11` was recorded as
      // two lines and the pin this test exists to check read as absent. Nothing
      // was wrong with `dist.js`: only `%*`, the raw remainder of the command
      // line, is intact, and forwarding it to a program with real argument
      // parsing is how the REAL `electron-builder.cmd` npm shim works too
      // (`"%_prog%" "…\cli.js" %*`). So the stand-in is that shim — one line
      // that hands `%*` to node — and node reports what any such tool receives.
      const recorder = join(dir, "record-argv.cjs");
      writeFileSync(
        recorder,
        `require("node:fs").writeFileSync(${JSON.stringify(record)}, process.argv.slice(2).map((a) => a + "\\n").join(""), "utf8");\n`,
        "utf8",
      );
      writeFileSync(
        join(dir, "electron-builder.cmd"),
        ["@echo off", `"${process.execPath}" "${recorder}" %*`, "exit /b %errorlevel%", ""].join("\r\n"),
        "utf8",
      );
    } else {
      const stub = join(dir, "electron-builder");
      writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nexit 0\n`, { encoding: "utf8", mode: 0o755 });
      chmodSync(stub, 0o755);
    }

    const dist = this.spawn(process.execPath, [join(repoRoot(), "app", "scripts", "dist.js"), "--linux"], {
      env: { PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env["PATH"] ?? ""}` },
    });
    const exit = await dist.exited();
    t.assert.equal(exit.code, 0, `dist.js failed:\n${dist.stderr()}`);

    // One argument per line, in the line terminator the stand-in's own shell
    // writes: cmd.exe's `echo` ends every line CRLF, so splitting on "\n" alone
    // left a carriage return glued to each value and `--publish` compared unequal
    // to '--publish\r'. The file is text written by the platform; read it as such.
    const argv = readFileSync(record, "utf8").split(/\r?\n/).filter((line) => line !== "");
    t.assert.equal(argv[0], "--publish", "publishing must be settled before anything the caller passed");
    t.assert.equal(argv[1], "never");
    t.assert.ok(argv.includes("--linux"), "the caller's own arguments must still reach electron-builder");
    t.assert.ok(argv.indexOf("--linux") > argv.indexOf("never"), "a user flag must be able to override --publish, so it comes after");

    const electronVersion = argv.find((a) => a.startsWith("-c.electronVersion="));
    t.assert.equal(typeof electronVersion, "string", "the runtime version must be pinned explicitly");
    const installed = JSON.parse(readFileSync(join(repoRoot(), "node_modules", "electron", "package.json"), "utf8")) as { version: string };
    t.assert.equal(electronVersion, `-c.electronVersion=${installed.version}`, "the pin must be the version actually installed");
  }
}

registerFeatureTests(new TheArtifactNamesArePinned(), new AMissingRipgrepFailsTheBuild(), new PublishingIsNeverImplicit());
