/**
 * `UiTest` — the kind that runs the real desktop app. SPEC §3, decisions/0004.
 *
 * WHAT THIS KIND IS FOR. A feature that only exists once Electron is running:
 * the main process's window and tab state, an ipcMain handler reached through
 * the real preload bridge, an engine child spawned by the app rather than by a
 * test. If a feature can be proved without a window, it is a cheaper kind and
 * this one is the wrong answer — Electron costs seconds per test and a display.
 *
 * WHAT IT OWNS: the Electron process and the isolated profile it runs on.
 * `--user-data-dir` is not a nicety. `app/main.js` takes a single-instance lock
 * (line 48), and that lock is keyed on the user-data directory — so without an
 * isolated one, a test run on a machine where the developer has MAGENTRA open
 * quits instantly and the failure looks like a product bug. The isolation also
 * keeps `config.json`, the recent-workspace list and the fallback log out of
 * the developer's real profile.
 *
 * `--smoke` is deliberately NOT passed: it makes the app exit five seconds
 * after the first paint (main.js:968), which is a CI boot check, not a test
 * harness.
 *
 * WHAT IT DOES NOT DO: it never adds anything to the product to make itself
 * possible. `tests/lib/appHarness.cjs` hosts `app/main.js` unchanged and drives
 * the renderer that already exists; the note at the top of that file records
 * what went wrong the last time a suite did otherwise.
 *
 * REQUIREMENTS: a built engine (`npm run build`) for anything that spawns one,
 * and a display. macOS and Windows have one; Linux CI needs `xvfb-run`, exactly
 * as the app's own smoke job already does.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildProcesses, type ProcHandle } from "./childProcesses.ts";
import { FeatureTest } from "./featureTest.ts";
import { repoRoot } from "./inventory.ts";

const requireFromHere = createRequire(import.meta.url);

/** Electron's package entry is the path to its binary, not a module. */
function electronBinary(): string {
  const resolved: unknown = requireFromHere("electron");
  if (typeof resolved !== "string" || resolved === "") {
    throw new Error("the electron package did not resolve to a binary path — run `npm ci`");
  }
  return resolved;
}

const HARNESS = "tests/lib/appHarness.cjs";

/** Electron boots, paints, and on a cold profile does it slowly. */
const LAUNCH_TIMEOUT_MS = 90_000;

/** A single renderer evaluation. Generous, because it may spawn an engine. */
const EVAL_TIMEOUT_MS = 30_000;

/** Long enough for a killed engine grandchild to finish its last write. See tearDownKind. */
const GRANDCHILD_SETTLE_MS = 300;

export interface AppHandle {
  /** The Electron process, for the kind's own bookkeeping. */
  readonly process: ProcHandle;
  /** The isolated profile this app ran on. Removed at teardown. */
  readonly userDataDir: string;
  /**
   * Run JavaScript in the app's renderer and return its value.
   *
   * This is the product's own surface: the JS runs in the real page, against
   * the real `window.magentra` preload bridge, and reaches the real ipcMain
   * handler. A returned promise is awaited before the value comes back, so
   * `magentra.applyProfile(...)` resolves to what the main process returned.
   */
  evaluate<T>(js: string): Promise<T>;
}

export abstract class UiTest extends FeatureTest {
  readonly kind = "ui" as const;

  /** Launching Electron, opening a workspace and spawning an engine is not a 30-second affair. */
  override readonly timeoutMs: number = 180_000;

  readonly #processes = new ChildProcesses(this.constructor.name);
  #tempDirs: string[] = [];
  #nextEvalId = 1;

  /**
   * Remove `dir` at teardown, AFTER the app is dead.
   *
   * A test's own `tearDown()` runs before the kind's, so a workspace removed
   * there would be pulled out from under a running Electron — which POSIX
   * tolerates and Windows does not. Anything the app holds open goes here.
   */
  protected removeAfterApp(dir: string): string {
    this.#tempDirs.push(dir);
    return dir;
  }

  /**
   * Launch the app and wait until its window has painted.
   *
   * @param env extra environment for the Electron process (`DISPLAY`, say).
   */
  protected async launchApp(env: Readonly<Record<string, string | undefined>> = {}): Promise<AppHandle> {
    const userDataDir = mkdtempSync(join(tmpdir(), "magentra-ui-"));
    this.#tempDirs.push(userDataDir);

    const child = this.#processes.spawn(
      electronBinary(),
      [join(repoRoot(), HARNESS), `--user-data-dir=${userDataDir}`],
      { label: "magentra (electron)", env },
    );

    const ready = await this.#nextHarnessLine(child, (m) => m["event"] === "ready" || m["event"] === "failed", LAUNCH_TIMEOUT_MS);
    if (ready["event"] === "failed") {
      throw new Error(`the app did not come up: ${String(ready["error"])}`);
    }

    return {
      process: child,
      userDataDir,
      evaluate: async <T,>(js: string): Promise<T> => {
        const id = this.#nextEvalId++;
        child.send(JSON.stringify({ id, cmd: "eval", js }));
        const result = await this.#nextHarnessLine(child, (m) => m["event"] === "result" && m["id"] === id, EVAL_TIMEOUT_MS);
        if (result["ok"] !== true) throw new Error(`renderer evaluation failed: ${String(result["error"])}`);
        return result["value"] as T;
      },
    };
  }

  /**
   * The next harness line matching `predicate`.
   *
   * Electron writes a great deal to this stream that is not ours — GPU notices,
   * Chromium warnings, anything the app logs — so a line that is not JSON, or
   * not ours, is skipped rather than treated as a protocol error.
   */
  async #nextHarnessLine(child: ProcHandle, predicate: (message: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = await child.nextLine(undefined, Math.max(1, deadline - Date.now()));
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message["type"] !== "harness") continue;
      if (predicate(message)) return message;
    }
  }

  /**
   * Kill the app, then remove what it ran on — in that order, because Windows
   * cannot delete an open file.
   *
   * Removed TWICE, with a settle in between. `stopAll` waits for the Electron
   * process, but the engine the app spawned is a grandchild: killing the group
   * ends it, and on its way out it can still write its session and task files,
   * recreating the `.magentra/` directory a moment after the first removal.
   * Observed once, on a run where the test had already failed and the engine
   * was mid-write. A cleanup that only works on the happy path is not one.
   */
  protected override async tearDownKind(): Promise<void> {
    try {
      await this.#processes.stopAll();
    } finally {
      const dirs = this.#tempDirs;
      this.#tempDirs = [];
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, GRANDCHILD_SETTLE_MS));
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  }
}
