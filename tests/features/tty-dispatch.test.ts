/**
 * `tty-dispatch` — the fallback the Windows `.cmd` shim cannot provide itself.
 *
 * `tui/src/cli.tsx` decides, once, whether this launch gets the terminal UI or
 * the desktop GUI: `isPackagedRun() && (wantsGui || !hasTty)` hands off to the
 * GUI, detached, with `ELECTRON_RUN_AS_NODE` scrubbed and no argv forwarded,
 * and exits 0 before Ink ever renders a frame. The Linux and macOS launchers
 * can test for a TTY in shell before Node starts; the Windows `.cmd` shim
 * cannot, so this in-process fallback is the only thing that saves a desktop
 * shortcut, or `magentra < NUL`, from starting an unusable ink UI.
 *
 * WHY A SANDBOX, NOT THE REAL `tui/dist/`. `cli.tsx`'s static
 * `import { App } from './app.js'` runs at MODULE LOAD, before any of the
 * handoff logic — so even the pure "hand off and exit" path requires the
 * whole built bundle (ink, react, every component) to resolve and load
 * without error. And the packaged branch (`isPackagedRun()`) needs a sibling
 * `engine.cjs`, which cannot be planted next to the real, gitignored-but-real
 * `tui/dist/cli.js` without writing into `tui/` — forbidden for this track.
 * So each test in `PackagedCliTest` below copies the real, built,
 * UNEDITED `tui/dist/` byte-for-byte into a temp directory of its own — a
 * throwaway "install" — and gives it what a real install has: its own copy of
 * the exact Node binary running this suite (so `process.execPath` and its
 * `dirname()` are OURS to plant a sibling `MAGENTRA.exe` beside), a
 * `node_modules` JUNCTION back to this repo's own (so `ink`/`react` resolve
 * exactly as they do for the real build — the same technique, verified on
 * this machine, that `promptlab-promote.test.ts` uses to run `server.mjs`
 * unedited from a sandbox), and a stand-in `engine.cjs` (existence is the
 * only thing `isPackagedRun()` checks).
 *
 * HOW "WHICH BINARY ACTUALLY RAN" IS PROVEN WITHOUT STUBBING `spawn`.
 * Stubbing `node:child_process` would be doubling the code under test, which
 * this track forbids outside the model. Instead, `NODE_OPTIONS=--require
 * <marker.cjs>` is set on the CLI's own env — inherited unedited by whatever
 * it spawns, since the product's own handoff does `env: {...process.env}`.
 * `marker.cjs` tells the CLI apart from a spawned GUI without any test-only
 * branch in the product: the CLI always has an entry script
 * (`process.argv.length >= 2`); `spawn(gui, [], …)` never passes one
 * (`process.argv.length === 1`, since node started with a bare exe and no
 * script starts a REPL instead). Only in that second shape does the marker
 * write anything, so it is a no-op for the CLI process it also preloads into,
 * and a factual report — `process.execPath`, `process.argv`,
 * `process.env.ELECTRON_RUN_AS_NODE` — of whatever really got spawned.
 *
 * WHAT WINDOWS CANNOT SHOW, stated rather than faked (tests/README's platform
 * section): checklist 2's TTY-present arm and checklist 3's `linux` sibling
 * preference both need a fact this OS cannot supply to an automated test —
 * a real interactive terminal, or `process.platform === 'linux'`. Checklist 2
 * is proven only in its buildable half: `--gui` still produces the identical,
 * scrubbed handoff that the no-tty default does. Checklist 4's dev-layout
 * half needs no sandbox at all — the real `tui/dist/` has no sibling
 * `engine.cjs` by construction, so it is driven directly.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";

const FEATURE = "tty-dispatch";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT =
  "--gui or the absence of an interactive TTY hands over to the desktop app and exits, which is the universal fallback the Windows cmd shim cannot provide.";

const BUILT_TUI_DIR = join("tui", "dist");

/**
 * Preloaded (via `NODE_OPTIONS`) into every node process this file spawns,
 * including grandchildren the CLI itself spawns. It reports on the GUI
 * hand-off shape (`argv.length === 1`, see file header) and is inert for the
 * CLI, which always has an entry script.
 */
const MARKER_SOURCE = [
  "const fs = require('node:fs');",
  "if (process.argv.length === 1) {",
  "  fs.appendFileSync(process.env.MAGENTRA_TEST_MARKER, JSON.stringify({",
  "    execPath: process.execPath,",
  "    argv: process.argv,",
  "    electron: process.env.ELECTRON_RUN_AS_NODE ?? null,",
  "  }) + '\\n');",
  "  process.exit(0);",
  "}",
].join("\n");

interface MarkerEntry {
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly electron: string | null;
}

interface Sandbox {
  readonly dir: string;
  readonly cliPath: string;
  readonly nodePath: string;
  readonly markerPath: string;
}

abstract class PackagedCliTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #dirs: string[] = [];

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#dirs = [];
  }

  /** A fresh directory this test owns — a workspace to open, not part of the sandbox itself. */
  protected tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /** A throwaway "install": the real built TUI, its own node.exe, a junction for its deps, and (unless declined) a stand-in bundled engine. */
  protected buildSandbox(opts: { withEngine?: boolean; withMagentraExe?: boolean } = {}): Sandbox {
    const { withEngine = true, withMagentraExe = false } = opts;
    const builtDir = join(repoRoot(), BUILT_TUI_DIR);
    if (!existsSync(join(builtDir, "cli.js"))) {
      throw new Error(`${BUILT_TUI_DIR}/cli.js does not exist. Run \`npm run build\` — this test drives the built TUI, and dist/ is gitignored.`);
    }
    const dir = mkdtempSync(join(tmpdir(), "magentra-tui-pkg-"));
    this.#dirs.push(dir);
    cpSync(builtDir, dir, { recursive: true });
    symlinkSync(join(repoRoot(), "node_modules"), join(dir, "node_modules"), "junction");
    if (withEngine) writeFileSync(join(dir, "engine.cjs"), "// stand-in bundled engine — existence is the only thing isPackagedRun() checks\n");

    const nodePath = join(dir, "node.exe");
    copyFileSync(process.execPath, nodePath);
    if (withMagentraExe) copyFileSync(process.execPath, join(dir, "MAGENTRA.exe"));

    const markerPath = join(dir, "gui-marker.ndjson");
    writeFileSync(join(dir, "marker.cjs"), MARKER_SOURCE);

    return { dir, cliPath: join(dir, "cli.js"), nodePath, markerPath };
  }

  /** Run the sandboxed CLI, piped (never a TTY — see the header on what that means for checklist 2). */
  protected runSandboxed(sandbox: Sandbox, args: readonly string[], cwd: string): ProcHandle {
    return this.spawn(sandbox.nodePath, [sandbox.cliPath, ...args], {
      cwd,
      env: { NODE_OPTIONS: `--require ${join(sandbox.dir, "marker.cjs")}`, MAGENTRA_TEST_MARKER: sandbox.markerPath },
      label: `sandboxed tui in ${sandbox.dir}`,
    });
  }

  /** The marker's lines, parsed, waiting up to `timeoutMs` for at least one. */
  protected async readMarker(sandbox: Sandbox, timeoutMs = 5_000): Promise<MarkerEntry[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (existsSync(sandbox.markerPath)) {
        const text = readFileSync(sandbox.markerPath, "utf8");
        const lines = text.split("\n").filter((l) => l.trim() !== "");
        if (lines.length > 0) return lines.map((l) => JSON.parse(l) as MarkerEntry);
      }
      if (Date.now() > deadline) return [];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/* ---- checklist 1 & 5 --------------------------------------------------- */

class NoTtyHandsOffCleanlyAndExitsBeforeRendering extends PackagedCliTest {
  readonly id = "no-tty-hands-off-detached-with-a-scrubbed-env-and-no-forwarded-args";
  readonly whyItExists =
    "if the handoff ever forwarded this process's own argv, leaked ELECTRON_RUN_AS_NODE into the desktop process, or rendered a frame of ink before handing off, a desktop shortcut or a piped launch would pin a console to the GUI or hand it flags meant for the terminal — this proves none of that happens";

  override async run(t: TestRun): Promise<void> {
    const sandbox = this.buildSandbox({ withMagentraExe: false });
    const workspace = this.tempDir("magentra-tty-ws-");
    // Extra flags that must never reach the GUI process — proving args:[].
    const child = this.runSandboxed(sandbox, [workspace, "--resume", "should-not-be-forwarded"], workspace);

    const exit = await child.exited();
    t.assert.equal(exit.code, 0, "the handoff branch must exit 0 itself");
    t.assert.equal(child.stdout(), "", "nothing must render before the handoff — the CLI never reaches Ink's render()");

    const entries = await this.readMarker(sandbox);
    t.assert.equal(entries.length, 1, "exactly one process must be handed the GUI role");
    const [entry] = entries;
    t.assert.equal(entry?.execPath, sandbox.nodePath, "with no sibling MAGENTRA.exe, the fallback is this process's own execPath");
    t.assert.deepEqual(entry?.argv, [sandbox.nodePath], "spawn args must be [] — the CLI's own argv must never reach the GUI");
    t.assert.equal(entry?.electron, null, "ELECTRON_RUN_AS_NODE must be scrubbed before the GUI is spawned");
  }
}

/* ---- checklist 2 (buildable half — see header) -------------------------- */

class GuiFlagProducesTheIdenticalHandoff extends PackagedCliTest {
  readonly id = "the-gui-flag-produces-the-same-clean-handoff-as-the-no-tty-default";
  readonly whyItExists =
    "if --gui's arm of the condition took a different path than the no-tty default and skipped the environment scrub or the empty-args contract, a user who explicitly typed --gui from a terminal would get a leakier handoff than an unattended launch gets for free — this proves they are identical";

  override async run(t: TestRun): Promise<void> {
    const sandbox = this.buildSandbox({ withMagentraExe: false });
    const workspace = this.tempDir("magentra-tty-ws-");
    const child = this.runSandboxed(sandbox, ["--gui"], workspace);

    const exit = await child.exited();
    t.assert.equal(exit.code, 0);
    t.assert.equal(child.stdout(), "");

    const entries = await this.readMarker(sandbox);
    t.assert.equal(entries.length, 1, "--gui must still hand off exactly once");
    t.assert.equal(entries[0]?.electron, null, "--gui's handoff must scrub ELECTRON_RUN_AS_NODE exactly as the no-tty default does");
    t.assert.deepEqual(entries[0]?.argv, [sandbox.nodePath], "--gui must not forward argv either");
  }
}

/* ---- checklist 3 (win32 half — see header) ------------------------------ */

class WindowsPrefersASiblingMagentraExe extends PackagedCliTest {
  readonly id = "windows-prefers-a-sibling-magentra-exe-over-its-own-execpath";
  readonly whyItExists =
    "if the sibling MAGENTRA.exe preference broke on Windows, the handoff would run the console-subsystem copy instead — pinning a console window to the desktop app on every single launch from a shortcut";

  override readonly platform = "win32" as const;

  override async run(t: TestRun): Promise<void> {
    const sandbox = this.buildSandbox({ withMagentraExe: true });
    const workspace = this.tempDir("magentra-tty-ws-");
    const child = this.runSandboxed(sandbox, [], workspace);

    await child.exited();
    const entries = await this.readMarker(sandbox);
    t.assert.equal(entries.length, 1);

    // The product's branch is `process.platform === 'win32' && existsSync(…)`,
    // so a sibling MAGENTRA.exe means two DIFFERENT things and both are facts
    // about this code. Asserting only the win32 half would leave the other two
    // platforms proving nothing here; asserting `process.platform === 'win32'`
    // outright — which this test used to do — makes it permanently red on the
    // machines most of this repo is developed on, which is not a gap being
    // stated, only a result nobody can act on. tests/README: each
    // platform-specific fact is asserted as what THAT platform can express.
    if (process.platform === "win32") {
      t.assert.equal(
        entries[0]?.execPath,
        join(sandbox.dir, "MAGENTRA.exe"),
        "with a sibling MAGENTRA.exe present, it must be preferred over process.execPath",
      );
    } else {
      t.assert.equal(
        entries[0]?.execPath,
        sandbox.nodePath,
        "off Windows the sibling MAGENTRA.exe must be IGNORED — the guard is the platform test, and a handoff that ran a .exe here would be running a binary this OS cannot execute",
      );
    }
  }
}

/* ---- checklist 4 (dev half) ---------------------------------------------- */

class DevLayoutNeverHandsOffAndSelfExitsWithoutATty extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-dev-layout-never-hands-off-the-app-exits-itself-without-a-tty";
  readonly whyItExists =
    "if a dev checkout's non-interactive launch hung instead of noticing the missing tty and exiting, a CI job or any piped invocation of the dev build would hang forever waiting for input nobody can give it";

  #dirs: string[] = [];

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#dirs = [];
  }

  override async run(t: TestRun): Promise<void> {
    const builtCli = join(repoRoot(), "tui", "dist", "cli.js");
    if (!existsSync(builtCli)) {
      throw new Error("tui/dist/cli.js does not exist. Run `npm run build` — this test drives the built TUI.");
    }
    t.assert.equal(existsSync(join(repoRoot(), "tui", "dist", "engine.cjs")), false, "the premise of this test is a dev layout — no sibling engine.cjs");

    const home = mkdtempSync(join(tmpdir(), "magentra-tty-home-"));
    const engineHome = mkdtempSync(join(tmpdir(), "magentra-tty-enginehome-"));
    const workspace = mkdtempSync(join(tmpdir(), "magentra-tty-ws-"));
    this.#dirs.push(home, engineHome, workspace);

    writeFileSync(join(home, ".magentra-tui.json"), JSON.stringify({ engineHome }));
    mkdirSync(join(engineHome, "engine", "host", "dist"), { recursive: true });
    writeFileSync(
      join(engineHome, "engine", "host", "dist", "main.js"),
      "process.stdout.write(JSON.stringify({type:'session_started',sessionId:'s1',model:'m',overdrive:false,commands:[],v:1,cwd:process.cwd()})+'\\n');\n" +
        "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n",
    );
    // Pre-trust so the trust gate (which also has no way to be answered
    // without a tty) is not what this test is about.
    mkdirSync(join(home, ".magentra"), { recursive: true });
    writeFileSync(
      join(home, ".magentra", "trusted-folders.json"),
      JSON.stringify({ version: 1, folders: { [workspace]: { trustedAt: new Date().toISOString() } } }),
    );

    const child = this.spawn(process.execPath, [builtCli], {
      cwd: workspace,
      env: { HOME: home, USERPROFILE: home, INIT_CWD: workspace },
      label: "dev-layout tui, no tty",
    });

    const exit = await child.exited();
    t.assert.equal(exit.code, 0, "the dev build must exit on its own without a tty, not hang");
    t.assert.match(
      child.stdout(),
      /no tty - run in a terminal to type/,
      "app.tsx's own non-interactive notice must be what ends this run, proving the cli-level handoff never fired",
    );
  }
}

registerFeatureTests(
  new NoTtyHandsOffCleanlyAndExitsBeforeRendering(),
  new GuiFlagProducesTheIdenticalHandoff(),
  new WindowsPrefersASiblingMagentraExe(),
  new DevLayoutNeverHandsOffAndSelfExitsWithoutATty(),
);
