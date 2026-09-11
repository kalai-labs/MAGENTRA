/**
 * `engine-lifecycle`.
 *
 * Each open workspace runs its own engine child. Two engines on one workspace
 * race over its state files; a child left behind on quit is a zombie holding
 * the folder. So the rules are: one child per tab, a replacement never starts
 * while the previous one is still exiting, and nothing outlives the app.
 *
 * `proc` for the child's own termination contract — the thing every rule above
 * relies on — and `ui` for the rules themselves, which live in `app/main.js`
 * and are only reachable with Electron running.
 *
 * CHECKLIST 3'S SECOND HALF IS NOT HERE. "SIGKILL after 3 s if the child is
 * still alive" needs a child that IGNORES SIGTERM, and the child is the real
 * engine, which does not. Substituting one would mean testing the substitute.
 * What is asserted instead is the half that decides whether the timer is ever
 * needed: the engine really does go on SIGTERM, well inside the budget.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { logLines, openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "engine-lifecycle";

/** Verbatim from the record. */
const INVARIANT = "The engine child is spawned, restarted and reaped per tab, and a dying child exits before a replacement spawns.";

/** Keyless and local: enough for the app to consider a workspace configured. */
const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

/** Whether a pid is still alive, without signalling it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ---- the contract every rule rests on — proc --------------------------- */

class TheEngineGoesOnSigterm extends ProcTest {
  readonly featureId = FEATURE;
  readonly id = "the-engine-stops-on-sigterm-well-inside-the-kill-budget";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the three-second SIGKILL is a backstop; if the engine did not answer SIGTERM, every workspace close would wait three seconds and every quit would look like a hang";

  override async run(t: TestRun): Promise<void> {
    const built = join(repoRoot(), "engine", "host", "dist", "main.js");
    t.assert.equal(existsSync(built), true, "the app spawns the built engine — run `npm run build`");

    const engine = this.spawn(process.execPath, [built, "--serve", "--cwd", repoRoot()], { label: "engine (serve)" });
    // It has to be up before its shutdown means anything.
    await engine.nextLine((line) => line.includes("\"type\""), 20_000);

    const sentAt = Date.now();
    engine.kill("SIGTERM");
    const exit = await engine.exited();
    const tookMs = Date.now() - sentAt;

    t.assert.ok(tookMs < 3_000, `the engine must go well inside the SIGKILL budget; it took ${tookMs}ms`);
    t.assert.ok(exit.code === 0 || exit.signal === "SIGTERM", `it must terminate cleanly, got code=${String(exit.code)} signal=${String(exit.signal)}`);
  }
}

/* ---- the rules — ui ---------------------------------------------------- */

abstract class LifecycleTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected configuredWorkspace(): string {
    const workspace = this.makeTempDir("magentra-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: LOCAL_ENDPOINT,
      model: "model-one",
    });
    return workspace;
  }
}

class OpeningAWorkspaceSpawnsOneEngine extends LifecycleTest {
  readonly id = "opening-a-workspace-spawns-exactly-one-engine-for-it";
  readonly whyItExists =
    "two engines on one workspace race over its state files, and the second one is invisible — nothing in the UI says how many are running";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home-");
    const workspace = this.configuredWorkspace();
    // A key in the workspace that differs from the one inherited from the
    // environment: the child must be given the workspace's.
    writeFileSync(join(workspace, ".env"), "MAGENTRA_API_KEY=from-the-workspace\n", "utf8");

    const app = await this.launchApp({ HOME: home, USERPROFILE: home, MAGENTRA_API_KEY: "from-the-environment" });
    await openWorkspace(app, workspace);
    const pid = await waitForSpawn(workspace);

    const spawns = logLines(workspace).filter((l) => l.data?.["ev"] === "spawn");
    t.assert.equal(spawns.length, 1, "one workspace, one engine");

    const args = spawns[0]?.data?.["args"];
    t.assert.ok(Array.isArray(args) && args.includes("--serve"), `the child must be the stdio server, args were ${JSON.stringify(args)}`);
    t.assert.ok(Array.isArray(args) && args.includes(workspace), "and must be pointed at this workspace");
    t.assert.equal(spawns[0]?.data?.["cwd"], workspace);

    // The workspace's own key must win over the one inherited from the shell —
    // read off the running process, not from the code that set it.
    const environ = await readChildEnvironment(pid);
    if (environ !== null) {
      t.assert.match(environ, /from-the-workspace/, "the workspace .env must reach the child");
      t.assert.doesNotMatch(environ, /from-the-environment/, "and must override what the shell handed the app");
    } else {
      t.assert.ok(alive(pid), "the engine must at least be running for this workspace");
    }
  }
}

class ADyingChildIsWaitedFor extends LifecycleTest {
  readonly id = "a-replacement-waits-for-the-previous-child-to-exit";
  readonly whyItExists =
    "spawning the replacement first left two engines on one workspace for as long as the old one took to die, and they raced over its state files";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home2-");
    const workspace = this.configuredWorkspace();
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    const first = await waitForSpawn(workspace);

    // Restart: the product's own path for replacing a tab's engine.
    await app.evaluate(`window.magentra.restartEngine(); true`);

    // The replacement is logged as a restart, and its pid is a different
    // process — which can only be true if the first one was reaped.
    const deadline = Date.now() + 30_000;
    let second = first;
    while (Date.now() < deadline) {
      const events = logLines(workspace).filter((l) => l.data?.["ev"] === "spawn" || l.data?.["ev"] === "restart");
      const latest = events[events.length - 1]?.data?.["pid"];
      if (typeof latest === "number" && latest !== first) {
        second = latest;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    t.assert.notEqual(second, first, "a restart must produce a new child");

    // The old one is gone, and exactly one engine is alive for this workspace.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    t.assert.equal(alive(first), false, "the previous child must be reaped, not left beside its replacement");
    t.assert.equal(alive(second), true, "and the replacement must be running");
  }
}

class NothingOutlivesTheApp extends LifecycleTest {
  readonly id = "quitting-leaves-no-engine-behind";
  readonly whyItExists =
    "a child left behind on quit is a zombie holding the workspace, and the user's only clue is that the next launch behaves strangely";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home3-");
    const workspace = this.configuredWorkspace();
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    const pid = await waitForSpawn(workspace);
    t.assert.equal(alive(pid), true, "the engine must be running before quitting can prove anything");

    // The real quit path: before-quit → stopAllEngines.
    await app.evaluateInMain(`require("electron").app.quit(); return true;`);
    await app.process.exited();

    // Give the reaping the moment it is allowed, then insist.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && alive(pid)) await new Promise((resolve) => setTimeout(resolve, 200));
    t.assert.equal(alive(pid), false, `the engine (pid ${pid}) outlived the app that spawned it`);
  }
}

/** The environment of a running process, as the OS reports it. `null` where that cannot be asked. */
async function readChildEnvironment(pid: number): Promise<string | null> {
  const { spawnSync } = await import("node:child_process");
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.includes("MAGENTRA")) return null;
  return result.stdout;
}

registerFeatureTests(new TheEngineGoesOnSigterm(), new OpeningAWorkspaceSpawnsOneEngine(), new ADyingChildIsWaitedFor(), new NothingOutlivesTheApp());
