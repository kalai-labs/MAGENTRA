/**
 * `packaged-boot` — how the terminal UI finds the engine it should run.
 *
 * `tui/src/config.ts` decides between two engines with one filesystem check:
 * a sibling `engine.cjs` next to the running bundle means "packaged" (spawn
 * it through Electron's own Node, `ELECTRON_RUN_AS_NODE=1`, because an
 * installed machine has neither a system Node nor a checkout); its absence
 * means "dev" (spawn `~/.magentra-tui.json`'s `engineHome` through system
 * `node`). `tui/src/engine/host.ts` then owns the spawned process end to end.
 *
 * TWO KINDS IN ONE FILE. Re-declared `["fs", "proc"]` from the record's
 * `["proc"]` (2026-09-20): checklist 1-4 are about `config.ts` and are proved
 * by calling its exported functions against real files under a real,
 * redirectable `HOME` — a temp directory and files are the whole cost, which
 * is `fs` (decisions/0004's own test: "a record whose checklist … boots an
 * engine on a workspace … was never pure"; the same reasoning makes this one
 * not `proc` either — nothing is spawned for 1-4). Checklist 5 spawns a real
 * child process end to end and owns its lifecycle, which is `proc`.
 *
 * WHY EVERY `config.ts` TEST IMPORTS A FRESH COPY, NEVER THE REAL FILE. Two
 * of its exports are frozen at MODULE LOAD, not read fresh per call:
 *   - `bundleDir` (`dirname(fileURLToPath(import.meta.url))`) is wherever the
 *     imported file physically sits. The real `tui/src/config.ts` sits in the
 *     real `tui/src/`, which this suite may not touch (BRIEF) — so there is
 *     no way to fabricate a sibling `engine.cjs` next to the real file to
 *     drive the packaged branch (checklist 1).
 *   - `CONFIG_PATH` (`join(homedir(), '.magentra-tui.json')`) is computed
 *     once, at import time, from whatever `HOME`/`USERPROFILE` were THEN —
 *     which for a statically-imported module is before any test in this file
 *     has redirected them. `loadConfig()` reads that frozen `CONFIG_PATH`,
 *     not a fresh `homedir()` call, so a static import here would test
 *     against the real developer's `~/.magentra-tui.json` regardless of what
 *     `redirectHome()` does afterwards.
 * The fix used throughout: copy the real, unedited `tui/src/config.ts` source
 * into this test's own temp directory and `import()` THAT path — a fresh
 * module instance, in a directory this test owns, whose frozen constants are
 * computed from whatever this test set up first. It is the real code,
 * unmodified, merely given a filesystem location it can be tested at — the
 * same shape as the `node_modules` junction the Prompt Lab tests use to run
 * `server.mjs` untouched from a sandbox (`promptlab-promote.test.ts`).
 *
 * `tui/src/engine/host.ts` needs no such trick for checklist 5: its only
 * runtime import is `node:child_process` (its other two imports are
 * `import type`, erased before Node ever sees them), and none of its exports
 * read a path relative to its own file, so the real file is imported
 * directly, per this track's rule for a `tui/src` file whose imports are all
 * `node:`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";
import { startHost, type EngineHost } from "../../tui/src/engine/host.ts";

const FEATURE = "packaged-boot";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT = "A packaged TUI resolves its engine as the sibling engine.cjs and runs through Electron's own Node.";

/** The real, unedited source this suite copies rather than edits or reimplements. */
const REAL_CONFIG_SOURCE = readFileSync(join(repoRoot(), "tui", "src", "config.ts"), "utf8");

/** What `config.ts` actually exports — declared locally because a dynamic, non-literal `import()` types as `any`. */
interface ConfigModule {
  isPackagedRun(): boolean;
  resolveEngineSpawn(workspace: string): { command: string; args: string[]; env: NodeJS.ProcessEnv };
  loadConfig(): { engineHome: string };
  hostEntry(engineHome: string): string;
}

/**
 * Shared setup for the four `config.ts` checklist items: a fresh copy of the
 * real source, in a directory this test owns, imported once trust and any
 * sibling files are in place.
 */
abstract class ConfigModuleTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Copy the real source into a fresh temp dir and import that copy. `bundleDir` becomes this directory. */
  protected async freshConfig(): Promise<{ mod: ConfigModule; dir: string }> {
    const dir = this.tempDir("tui-config-");
    const copy = join(dir, "config.ts");
    this.writeFile(copy, REAL_CONFIG_SOURCE);
    const mod = (await import(pathToFileURL(copy).href)) as ConfigModule;
    return { mod, dir };
  }
}

/* ---- checklist 1 ------------------------------------------------------ */

class PackagedBranchResolvesTheSiblingEngine extends ConfigModuleTest {
  readonly id = "the-packaged-branch-resolves-the-sibling-engine-through-electrons-node";
  readonly whyItExists =
    "if the packaged branch ever shelled out to a system node or read a dev config file instead of the sibling bundle, an installed machine — no repo checkout, no system Node — would fail to start the TUI at all; this proves the packaged path spawns THAT sibling through the running binary itself, under ELECTRON_RUN_AS_NODE";

  override async run(t: TestRun): Promise<void> {
    const { mod, dir } = await this.freshConfig();
    // The sibling that flips isPackagedRun() — nothing more is needed for it to be true.
    this.writeFile(join(dir, "engine.cjs"), "// stand-in bundled engine — existence is the only thing checked\n");

    t.assert.equal(mod.isPackagedRun(), true, "a sibling engine.cjs must be read as a packaged run");

    const workspace = join(dir, "some", "workspace");
    const spawn = mod.resolveEngineSpawn(workspace);

    t.assert.equal(spawn.command, process.execPath, "packaged must spawn itself (Electron-as-Node), never a system node");
    t.assert.deepEqual(spawn.args, [join(dir, "engine.cjs"), "--cwd", workspace]);
    t.assert.equal(spawn.env["ELECTRON_RUN_AS_NODE"], "1", "without this flag the Electron binary would try to open a window, not run as Node");
  }
}

/* ---- checklist 2 ------------------------------------------------------ */

class DevBranchUsesTheConfiguredEngineHome extends ConfigModuleTest {
  readonly id = "the-dev-branch-spawns-the-configured-engine-home-through-system-node";
  readonly whyItExists =
    "if the dev branch stopped reading ~/.magentra-tui.json — reusing, say, the packaged sibling logic — a developer's checkout would spawn nothing or the wrong build; this proves resolveEngineSpawn's fallback still spawns the configured checkout's built host through system node";

  override async run(t: TestRun): Promise<void> {
    const home = this.redirectHome();
    const { mod } = await this.freshConfig();
    t.assert.equal(mod.isPackagedRun(), false, "this copy has no sibling engine.cjs — the fixture must exercise the dev branch");

    // A real, built engine checkout: resolveEngineSpawn's dev branch calls
    // loadConfig(), which throws unless engineHome actually has a built host.
    const engineHome = repoRoot();
    const builtHost = join(engineHome, "engine", "host", "dist", "main.js");
    if (!existsSync(builtHost)) {
      throw new Error(`${builtHost} does not exist. Run \`npm run build\` — this test resolves against a real built host.`);
    }
    this.writeJson(join(home, ".magentra-tui.json"), { engineHome });

    const workspace = join(home, "ws");
    const spawn = mod.resolveEngineSpawn(workspace);

    t.assert.equal(spawn.command, "node");
    t.assert.deepEqual(spawn.args, [builtHost, "--cwd", workspace]);
  }
}

/* ---- checklist 3 ------------------------------------------------------ */

class DevConfigWithNoBuiltHostThrowsNamingBothPaths extends ConfigModuleTest {
  readonly id = "a-dev-config-pointing-at-an-unbuilt-checkout-throws-naming-both-paths";
  readonly whyItExists =
    "an engineHome with no built host used to fail wherever spawn() first choked on a missing file, naming neither the host it wanted nor the config that pointed there — leaving a user with nothing to fix; this proves loadConfig's own error names both, before anything is spawned";

  override async run(t: TestRun): Promise<void> {
    const home = this.redirectHome();
    const { mod } = await this.freshConfig();

    const emptyEngineHome = this.tempDir("unbuilt-checkout-");
    const configPath = join(home, ".magentra-tui.json");
    this.writeJson(configPath, { engineHome: emptyEngineHome });

    t.assert.throws(
      () => mod.loadConfig(),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return message.includes(mod.hostEntry(emptyEngineHome)) && message.includes(configPath);
      },
      "the thrown message must name both the missing host file and the config file that pointed at it",
    );
  }
}

/* ---- checklist 4 ------------------------------------------------------ */

class MissingConfigIsCreatedWithABestGuess extends ConfigModuleTest {
  readonly id = "a-missing-config-is-created-with-a-best-guess-engine-home-not-left-absent";
  readonly whyItExists =
    "a first run with no ~/.magentra-tui.json used to fail with nothing to open or edit; this proves loadConfig writes one, with an engineHome a user can find and correct, instead of failing silently against nothing";

  override async run(t: TestRun): Promise<void> {
    const home = this.redirectHome();
    const { mod, dir } = await this.freshConfig();
    const configPath = join(home, ".magentra-tui.json");
    t.assert.equal(existsSync(configPath), false, "the fixture must start with no config file");

    // engineHome may or may not have a built host on this machine; either way
    // the file must be written before loadConfig() can possibly throw on that.
    try {
      mod.loadConfig();
    } catch {
      /* the best-guess repo may not be built here — the write already happened by then */
    }

    t.assert.equal(existsSync(configPath), true, "loadConfig() must create the file rather than fail against nothing");
    const written = JSON.parse(readFileSync(configPath, "utf8")) as { engineHome?: string };
    // guessEngineHome() is dirname(resolve(bundleDir, '..')) — two levels above
    // bundleDir, which is this copy's own directory (`dir`): dir/tui/src → repo.
    t.assert.equal(written.engineHome, join(dir, "..", ".."), "the best guess must be two levels above the config module's own directory");
  }
}

/* ---- checklist 5 -------------------------------------------------------- */

class ClosingStdinEndsTheEngineWithoutTheBackstop extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "kill-ends-the-engine-by-closing-stdin-well-under-the-1500ms-backstop";
  readonly whyItExists =
    "if kill() stopped closing stdin and fell straight to its 1500ms hard-kill timer, every /exit or app quit would hang the terminal for a second and a half instead of ending at once — this proves the graceful stdin-close path alone ends the child, fast";

  #workspace: string | undefined;
  #host: EngineHost | undefined;

  /** No temp dir is removed until this host's child has actually exited — Windows will not remove a directory a live process holds. */
  override async tearDown(): Promise<void> {
    this.#host?.kill();
    if (this.#workspace !== undefined) {
      rmSync(this.#workspace, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }

  override async run(t: TestRun): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "magentra-tui-host-"));
    this.#workspace = dir;
    const scriptPath = join(dir, "fake-engine.cjs");
    // A stand-in for the real engine: the only two things host.ts's contract
    // requires of the process on the other end of the pipe — announce itself,
    // then end when stdin ends. Real files, a real spawned process; the
    // engine's own turn loop is not what this file is proving.
    writeFileSync(
      scriptPath,
      "process.stdout.write(JSON.stringify({type:'session_started',pid:process.pid})+'\\n');\n" +
        "process.stdin.resume();\n" +
        "process.stdin.on('end', () => process.exit(0));\n",
      "utf8",
    );

    const events: Record<string, unknown>[] = [];
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });

    this.#host = startHost({ command: process.execPath, args: [scriptPath], env: process.env }, dir, {
      onEvent: (e) => events.push(e as Record<string, unknown>),
      onStderr: () => {},
      onExit: (code) => resolveExit(code),
    });

    const announced = Date.now() + 5_000;
    while (events.length === 0) {
      if (Date.now() > announced) throw new Error("the fake engine never announced session_started");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    t.assert.equal(events[0]?.["type"], "session_started");

    const killedAt = Date.now();
    this.#host.kill();
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("the child did not exit within 2000ms of kill()")), 2_000);
      }),
    ]);
    const elapsed = Date.now() - killedAt;

    t.assert.equal(code, 0, "the fake engine exits 0 when it sees its stdin end — a code from the 1500ms backstop kill would not be 0");
    t.assert.ok(elapsed < 1_000, `kill() took ${elapsed}ms to end the child — closing stdin should be near-instant, well under the 1500ms hard-kill backstop`);
  }
}

registerFeatureTests(
  new PackagedBranchResolvesTheSiblingEngine(),
  new DevBranchUsesTheConfiguredEngineHome(),
  new DevConfigWithNoBuiltHostThrowsNamingBothPaths(),
  new MissingConfigIsCreatedWithABestGuess(),
  new ClosingStdinEndsTheEngineWithoutTheBackstop(),
);
