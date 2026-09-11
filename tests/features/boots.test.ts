/**
 * `boots`.
 *
 * The lowest bar there is: Electron starts, the window opens, the renderer page
 * loads, nothing crashes. Without a check at this level a broken renderer
 * script or a module missing from the packaged build goes unnoticed until a
 * user double-clicks the icon — which is the one moment nobody is watching a
 * log.
 *
 * `--smoke` is the shape that makes it checkable: the app exits 0 about five
 * seconds after the renderer finishes loading, or 1 if the renderer process
 * died. These tests run the real `npm run smoke` path.
 *
 * CHECKLIST 5 IS NOT HERE. The Windows sandbox-rescue relaunch — one retry with
 * `--no-sandbox` after a renderer death before the first paint — is guarded by
 * `process.platform === "win32"`, and the condition it rescues is a Chromium
 * sandbox that cannot start. Neither can be produced on another platform, and
 * faking `process.platform` inside a running Electron main process does not
 * change what Chromium already did. It needs a Windows runner.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "boots";

/** Verbatim from the record. */
const INVARIANT = "The app boots and the window comes up clean; --smoke exits nonzero when the renderer crashes.";

const requireFromHere = createRequire(import.meta.url);

function electronBinary(): string {
  return requireFromHere("electron") as string;
}

/**
 * `boots` is a `ui` feature tested as `proc`, deliberately: what is being
 * proved is the EXIT CODE of a whole app launch, and the harness a `UiTest`
 * uses would have to keep the app alive to talk to it — which is the one thing
 * `--smoke` exists to not do.
 */
abstract class SmokeTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Electron's first cold start on a fresh profile is not a five-second affair. */
  override readonly timeoutMs: number = 180_000;

  #dirs: string[] = [];

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true });
    this.#dirs = [];
  }

  protected temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /** The app, launched exactly as `npm run smoke` launches it. */
  protected smoke(extraArgs: readonly string[] = [], env: Record<string, string | undefined> = {}) {
    const userData = this.temp("magentra-smoke-");
    const home = this.temp("magentra-home-");
    return this.spawn(electronBinary(), [join(repoRoot(), "app"), "--smoke", `--user-data-dir=${userData}`, ...extraArgs], {
      env: { HOME: home, USERPROFILE: home, ...env },
      label: "magentra --smoke",
    });
  }

  /** The app's own log for this run — written under userData when no workspace is open. */
  protected fallbackLog(userData: string): string {
    const dir = join(userData, "logs");
    if (!existsSync(dir)) return "";
    return readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
  }
}

/* ---- checklist 1 and 3 ------------------------------------------------- */

class ACleanBootExitsZero extends SmokeTest {
  readonly id = "a-clean-boot-paints-the-landing-page-and-exits-zero";
  readonly whyItExists =
    "a renderer that fails to load leaves a window that is blank rather than a process that fails, so nothing short of launching it notices";

  override async run(t: TestRun): Promise<void> {
    const userData = this.temp("magentra-smoke-ud-");
    const home = this.temp("magentra-smoke-home-");
    const app = this.spawn(electronBinary(), [join(repoRoot(), "app"), "--smoke", `--user-data-dir=${userData}`], {
      env: { HOME: home, USERPROFILE: home },
      label: "magentra --smoke (clean)",
    });

    // Checklist 3, started WHILE the first is still up. The single-instance
    // lock is keyed on the user-data directory, so the second run shares it —
    // and it must still boot, because --smoke skips the lock. Awaiting the
    // first run before starting this one left nothing to collide with, and a
    // mutation that applied the lock to smoke runs passed unnoticed.
    const secondStartedAt = Date.now();
    const second = this.spawn(electronBinary(), [join(repoRoot(), "app"), "--smoke", `--user-data-dir=${userData}`], {
      env: { HOME: home, USERPROFILE: home },
      label: "magentra --smoke (concurrent)",
    });

    const exit = await app.exited();
    t.assert.equal(exit.code, 0, `a clean boot must exit 0; stderr:\n${app.stderr().slice(-1500)}`);

    // Exit 0 alone would also be what a window that never painted produces, so
    // the log has to show the renderer actually got as far as its landing page.
    t.assert.match(
      this.fallbackLog(userData),
      /landing-shown/,
      "the renderer must have finished loading and been handed its recent-workspace list",
    );

    const secondExit = await second.exited();
    const secondLivedMs = Date.now() - secondStartedAt;
    t.assert.equal(secondExit.code, 0, "a smoke run must start beside a running instance, or CI cannot run one on a developer's machine");
    // An instance turned away by the lock ALSO exits 0 — it calls app.quit()
    // and is gone in well under a second. So the exit code cannot tell the two
    // apart, and a mutation that applied the lock to smoke runs passed until
    // this was measured: a run that really booted waits out its own five-second
    // smoke timer.
    t.assert.ok(
      secondLivedMs > 3_000,
      `the second instance exited after ${secondLivedMs}ms — too fast to have booted, so the single-instance lock turned it away`,
    );
  }
}

/* ---- checklist 2 ------------------------------------------------------- */

class ADeadRendererFailsTheBoot extends UiTest {
  readonly featureId = FEATURE;
  readonly id = "a-renderer-that-dies-fails-the-boot";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the whole point of the check is the failing case: an exit code that is 0 whatever the renderer did would have caught nothing, ever";

  override async run(t: TestRun): Promise<void> {
    // A page script that THROWS does not do it: an uncaught error leaves the
    // renderer process alive, the boot is genuinely clean, and --smoke
    // correctly exits 0. Asserting on such a run proved nothing, and did not
    // say so. What this feature is about is the renderer process DYING, so
    // that is what is staged — through the harness's main-process door, with
    // --smoke passed to the app exactly as `npm run smoke` passes it.
    const home = this.makeTempDir("magentra-crash-home-");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home }, ["--smoke"]);

    const crashedAt = Date.now();
    await app.evaluateInMain("win.webContents.forcefullyCrashRenderer(); return true;");

    const exit = await app.process.exited();
    const tookMs = Date.now() - crashedAt;
    t.assert.equal(exit.code, 1, `a smoke run whose renderer died must exit nonzero; stderr:\n${app.process.stderr().slice(-800)}`);
    // AND it must be the death that ended it, not the five-second timer that
    // would have exited anyway — with `rendererCrashed` set, that timer also
    // exits 1, so the code alone cannot tell the two apart. Removing the
    // render-process-gone handler passed this test until the clock was checked.
    t.assert.ok(tookMs < 3_500, `the crash must end the run at once, not five seconds later; it took ${tookMs}ms`);
  }
}

/* ---- checklist 4 ------------------------------------------------------- */

class WithoutSmokeTheAppStaysUp extends UiTest {
  readonly featureId = FEATURE;
  readonly id = "without-smoke-the-app-keeps-running";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the five-second exit is a CI affordance; if it fired without --smoke the product would close itself while someone was using it";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-stay-home-");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });

    // Well past the smoke timer, the window must still be there to answer.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    t.assert.equal(app.process.hasExited(), false, "the app must not exit on its own without --smoke");
    t.assert.equal(await app.evaluateInMain("return win.isDestroyed() === false;"), true, "and its window must still be open");
  }
}

registerFeatureTests(new ACleanBootExitsZero(), new ADeadRendererFailsTheBoot(), new WithoutSmokeTheAppStaysUp());
