/**
 * `a-connection-change-re-points-the-live-session` — the engine half.
 *
 * The feature is that moving from one API to another MID-TASK costs nothing:
 * one `set_connection` frame rebuilds the provider inside the running engine,
 * and the conversation, the session id, the task list and the stance carry on.
 * Restarting the engine to change endpoint used to kill the whole conversation.
 *
 * These tests spawn the real engine as a child process and speak the real
 * NDJSON protocol to it (`tests/lib/engineHarness.ts` says why a child rather
 * than an in-process Engine, and what the fake provider does and does not
 * stand in for). Only the Provider is a double.
 *
 * TWO KINDS IN ONE FILE, because the feature has two halves and the layout is
 * one file per feature id (decisions/0004). The `proc` tests below drive the
 * engine; the `ui` tests at the bottom drive the real desktop app, because
 * `app/main.js` destructures `electron` at line 3 and runs
 * `app.requestSingleInstanceLock()` at line 48 — it cannot be loaded by a plain
 * Node process, so its half of the feature is only reachable with Electron
 * actually running.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyProfile, logLines, openWorkspace, saveProfile, waitForLog } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "a-connection-change-re-points-the-live-session";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT =
  "Saving a connection rebuilds the provider in place via set_connection, so the conversation, session id, task list and stance all survive.";

const HARNESS = "tests/lib/engineHarness.ts";

/** The engine is spawned from its built entry points, as the app spawns it. */
const BUILT_ENGINE = "engine/host/dist/index.js";

/** Nothing listens on these. The provider is fake; a URL here is only a value to carry. */
const SECOND_ENDPOINT = "http://127.0.0.1:9911/v1";
const THIRD_ENDPOINT = "http://127.0.0.1:9913/v1";
const VISION_ENDPOINT = "http://127.0.0.1:9912/v1";

/** The four variables a keyless connection must clear — engine.ts's own list. */
const KEY_VARS = ["MAGENTRA_API_KEY", "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"] as const;

interface Frame {
  readonly type?: string;
  readonly [key: string]: unknown;
}

interface HarnessMessage {
  readonly role?: string;
  readonly text?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function messagesOf(frame: Frame): HarnessMessage[] {
  return Array.isArray(frame["messages"]) ? (frame["messages"] as HarnessMessage[]) : [];
}

function isHarness(frame: Frame, event: string): boolean {
  return frame.type === "harness" && frame["event"] === event;
}

/**
 * Shared setup for every test that drives a live engine over its stdio.
 *
 * `abstract`, so the gateway's discovery reads it as scaffolding and the four
 * concrete classes below as the tests — `featureId` and `invariant` are
 * declared once here and inherited.
 */
abstract class EngineFrameTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #workspaces: string[] = [];

  /**
   * A fresh engine on a throwaway workspace.
   *
   * `HOME` and `USERPROFILE` point INTO that workspace, because `loadSettings`
   * merges `~/.magentra/settings.json` over the project layer
   * (`globalSettingsPath()` is `homedir()`-relative). Without this the test
   * would read whatever endpoint the developer's own machine is configured for
   * and pass or fail accordingly, and `/settings` would write into their real
   * settings file.
   */
  protected startEngine(env: Readonly<Record<string, string | undefined>> = {}): ProcHandle {
    const built = join(repoRoot(), BUILT_ENGINE);
    if (!existsSync(built)) {
      throw new Error(
        `${BUILT_ENGINE} does not exist, so the engine cannot be spawned. Run \`npm run build\` — ` +
          `this test drives the built engine, which is what the desktop app spawns, and dist/ is gitignored.`,
      );
    }
    const workspace = mkdtempSync(join(tmpdir(), "magentra-conn-"));
    this.#workspaces.push(workspace);
    return this.spawn(process.execPath, [join(repoRoot(), HARNESS), workspace], {
      label: `engine harness on ${workspace}`,
      env: { HOME: workspace, USERPROFILE: workspace, ...env },
    });
  }

  /**
   * The children are stopped HERE rather than left to the kind's teardown,
   * because the workspace cannot be removed from under a running engine on
   * Windows — deleting an open file is a POSIX-only liberty. `tearDownKind`
   * then finds them already gone and still guarantees no orphan.
   */
  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const workspace of this.#workspaces) rmSync(workspace, { recursive: true, force: true });
    this.#workspaces = [];
  }

  protected sendFrame(child: ProcHandle, frame: Record<string, unknown>): void {
    child.send(JSON.stringify(frame));
  }

  /** The next frame satisfying `predicate`, consuming what it passes over. A non-JSON line is not a frame. */
  protected async nextFrame(child: ProcHandle, predicate: (frame: Frame) => boolean, timeoutMs = 25_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = await child.nextLine(undefined, Math.max(1, deadline - Date.now()));
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        continue;
      }
      if (predicate(frame)) return frame;
    }
  }

  /** Every frame the child has written, without consuming anything — for counting and for looking back. */
  protected framesSoFar(child: ProcHandle): Frame[] {
    const out: Frame[] = [];
    for (const line of child.stdout().split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as Frame);
      } catch {
        /* not a frame */
      }
    }
    return out;
  }

  /** Boot the engine and hand back its `session_started`. */
  protected async awaitSession(child: ProcHandle): Promise<Frame> {
    return this.nextFrame(child, (f) => f.type === "session_started");
  }

  /** One user turn, start to finish; returns the assistant text that streamed. */
  protected async runTurn(child: ProcHandle, text: string): Promise<string> {
    this.sendFrame(child, { type: "user_message", text });
    let streamed = "";
    for (;;) {
      const frame = await this.nextFrame(child, (f) => f.type === "text_delta" || f.type === "turn_finished");
      if (frame.type === "turn_finished") return streamed;
      streamed += typeof frame["text"] === "string" ? frame["text"] : "";
    }
  }

  /** The next real provider rebuild. Only the factory reports these, so one line = one rebuild. */
  protected async awaitRebuild(child: ProcHandle): Promise<Frame> {
    return this.nextFrame(child, (f) => isHarness(f, "provider_built"));
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class SwapsInPlace extends EngineFrameTest {
  readonly id = "swaps-the-provider-without-restarting-the-session";
  readonly whyItExists =
    "changing the endpoint respawned the engine, which started a new session and threw away the conversation — so trying another provider mid-task cost the task";

  override async run(t: TestRun): Promise<void> {
    const engine = this.startEngine();
    const started = await this.awaitSession(engine);
    const sessionId = started["sessionId"];
    t.assert.equal(typeof sessionId, "string");

    const before = await this.runTurn(engine, "one");
    t.assert.match(before, /answer-from-provider-1/);

    this.sendFrame(engine, {
      type: "set_connection",
      connection: {
        provider: "openai-compatible",
        // Sent with a trailing slash on purpose: the engine is specified to strip it.
        baseUrl: `${SECOND_ENDPOINT}/`,
        apiKey: "sk-second",
        model: "model-two",
      },
    });

    const rebuild = await this.awaitRebuild(engine);
    const spec = record(rebuild["spec"]);
    t.assert.equal(rebuild["generation"], 2, "the frame must rebuild the provider exactly once");
    t.assert.equal(spec["baseUrl"], SECOND_ENDPOINT);
    t.assert.equal(spec["apiKey"], "sk-second");
    t.assert.equal(record(record(rebuild["settings"])["watched"])["model"], "model-two");

    // The live session now answers from the NEW provider. This is the claim —
    // not that a factory was called, but that the session in flight uses what
    // it returned.
    const after = await this.runTurn(engine, "two");
    t.assert.match(after, /answer-from-provider-2/);

    const frames = this.framesSoFar(engine);

    // Nothing restarted: one session_started for the life of the process, so
    // the session id and the stance it carries are the ones we started with.
    const starts = frames.filter((f) => f.type === "session_started");
    t.assert.equal(starts.length, 1, "a second session_started would mean the engine was restarted");
    t.assert.equal(starts[0]?.["sessionId"], sessionId);

    // The previous provider is not merely superseded, it is unused.
    const rebuiltAt = frames.findIndex((f) => isHarness(f, "provider_built"));
    const staleCalls = frames.slice(rebuiltAt).filter((f) => isHarness(f, "stream") && f["generation"] === 1);
    t.assert.deepEqual(staleCalls, [], "the old provider answered a call after the swap");

    // The conversation crossed the swap: the new provider's first sight of the
    // session already contains the exchange that happened on the old one.
    const carried = frames
      .filter((f) => isHarness(f, "stream") && f["generation"] === 2)
      .some((f) => {
        const messages = messagesOf(f);
        return (
          messages.some((m) => m.role === "user" && (m.text ?? "").includes("one")) &&
          messages.some((m) => m.role === "assistant" && (m.text ?? "").includes("answer-from-provider-1"))
        );
      });
    t.assert.ok(carried, "the new provider never saw the pre-swap conversation, so history did not survive");

    // The task list was not reset — a restart re-announces it at boot.
    const listUpdates = frames.slice(rebuiltAt).filter((f) => f.type === "task_list_updated");
    t.assert.deepEqual(listUpdates, [], "the task list was re-announced, which only a fresh session does");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class KeyLandsInTheEnvironment extends EngineFrameTest {
  readonly id = "moves-the-api-key-into-the-environment";
  readonly whyItExists =
    "a keyless local endpoint kept sending the previous API's key, because the old key stayed in the environment and in settings where resolveApiKeySource still found it";

  override async run(t: TestRun): Promise<void> {
    // Seeded, so the keyless step below proves an INHERITED key is cleared too.
    const engine = this.startEngine({ MAGENTRA_API_KEY: "inherited-key" });
    await this.awaitSession(engine);

    this.sendFrame(engine, {
      type: "set_connection",
      connection: { provider: "openai-compatible", baseUrl: SECOND_ENDPOINT, apiKey: "sk-live" },
    });
    const keyed = await this.awaitRebuild(engine);
    const keyedEnv = record(keyed["env"]);
    const keyedSettings = record(keyed["settings"]);
    t.assert.equal(keyedEnv["MAGENTRA_API_KEY"], "sk-live", "the key must reach the environment, which is where it is resolved from");
    const keyedKeys = Array.isArray(keyedSettings["keys"]) ? (keyedSettings["keys"] as string[]) : [];
    t.assert.equal(keyedKeys.includes("apiKey"), false, "settings.apiKey must be deleted, not left as a second copy of the key");
    t.assert.equal(keyedKeys.includes("apiKeyEnv"), false, "a stale apiKeyEnv pin names a variable this connection does not use");

    this.sendFrame(engine, {
      type: "set_connection",
      connection: { provider: "anthropic", apiKey: "sk-ant" },
    });
    const anthropic = await this.awaitRebuild(engine);
    t.assert.equal(record(anthropic["env"])["ANTHROPIC_API_KEY"], "sk-ant", "an anthropic connection keys ANTHROPIC_API_KEY");

    this.sendFrame(engine, {
      type: "set_connection",
      connection: { provider: "openai-compatible", baseUrl: SECOND_ENDPOINT, apiKey: "" },
    });
    const keyless = await this.awaitRebuild(engine);
    const keylessEnv = record(keyless["env"]);
    for (const name of KEY_VARS) {
      t.assert.equal(keylessEnv[name], null, `${name} must be gone for a keyless endpoint — including the key an earlier connection set`);
    }
    t.assert.equal(record(keyless["spec"])["apiKey"], "", "a keyless endpoint is built with an empty key, not the previous one");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AbsentVisionClears extends EngineFrameTest {
  readonly id = "an-absent-vision-block-clears-the-vision-endpoint";
  readonly whyItExists =
    "removing the vision endpoint left the previous one in settings with vision still switched on, so images kept being described through an endpoint the user had deleted";

  override async run(t: TestRun): Promise<void> {
    const engine = this.startEngine();
    await this.awaitSession(engine);

    this.sendFrame(engine, {
      type: "set_connection",
      connection: {
        provider: "openai-compatible",
        baseUrl: SECOND_ENDPOINT,
        apiKey: "sk-second",
        vision: { provider: "openai-compatible", model: "vision-1", baseUrl: VISION_ENDPOINT, enabled: true },
      },
    });
    const withVision = record(record(await this.awaitRebuild(engine))["settings"]);
    const seen = record(record(withVision["watched"])["visionConnection"]);
    t.assert.equal(seen["model"], "vision-1");
    t.assert.equal(seen["baseUrl"], VISION_ENDPOINT);
    t.assert.equal(record(withVision["watched"])["vision"], true, "vision.enabled must switch the feature on");

    this.sendFrame(engine, {
      type: "set_connection",
      connection: { provider: "openai-compatible", baseUrl: SECOND_ENDPOINT, apiKey: "sk-second" },
    });
    const without = record(record(await this.awaitRebuild(engine))["settings"]);
    const keys = Array.isArray(without["keys"]) ? (without["keys"] as string[]) : [];
    t.assert.equal(keys.includes("visionConnection"), false, "an absent vision block means CLEARED, not unchanged");
    t.assert.equal(record(without["watched"])["vision"], false, "vision must not stay on with no endpoint behind it");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class SettingsTakesTheSameDoor extends EngineFrameTest {
  readonly id = "settings-on-a-connection-key-rebuilds-the-provider";
  readonly whyItExists =
    "SETTING_TIMING said these keys needed a restart while the code applied them live, and that note is the only thing telling the user whether their change took effect";

  override async run(t: TestRun): Promise<void> {
    const engine = this.startEngine();
    await this.awaitSession(engine);

    this.sendFrame(engine, { type: "slash_command", command: "settings", args: `baseUrl ${THIRD_ENDPOINT}` });
    const connectionKey = await this.nextFrame(
      engine,
      (f) => f.type === "command_output" && typeof f["text"] === "string" && f["text"].includes("Set baseUrl"),
    );
    t.assert.match(String(connectionKey["text"]), /Applied to the current session\./);

    // The rebuild is looked up in what has already arrived rather than awaited:
    // applySettingLive rebuilds the provider and THEN returns the note this
    // command_output carries, so by now it is behind us in the stream. Awaiting
    // it here would wait for a second rebuild that must never happen.
    const afterConnectionKey = this.framesSoFar(engine).filter((f) => isHarness(f, "provider_built"));
    t.assert.equal(afterConnectionKey.length, 1, "/settings baseUrl must rebuild the provider exactly once");
    // The frame and the command are two doors into the same swap.
    t.assert.equal(record(afterConnectionKey[0]?.["spec"])["baseUrl"], THIRD_ENDPOINT);

    this.sendFrame(engine, { type: "slash_command", command: "settings", args: "model model-nine" });
    const plainKey = await this.nextFrame(
      engine,
      (f) => f.type === "command_output" && typeof f["text"] === "string" && f["text"].includes("Set model"),
    );
    t.assert.match(String(plainKey["text"]), /Takes effect on the next turn\./);

    // Same reasoning in the negative: a rebuild would already be in the stream
    // by the time this note arrived, so an unchanged count is proof of none.
    const afterPlainKey = this.framesSoFar(engine).filter((f) => isHarness(f, "provider_built"));
    t.assert.equal(afterPlainKey.length, afterConnectionKey.length, "/settings model must not rebuild the provider");
  }
}

/* ---- checklist 5 — the app half, in a real Electron process -------------- */

/** A keyless local endpoint: enough for the app to consider a workspace configured. */
const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

abstract class AppConnectionTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /**
   * The app, on a profile of its own.
   *
   * `HOME` is redirected because connection profiles live in
   * `os.homedir()/.magentra/profiles.json` (app/main/profiles.js) — which
   * `--user-data-dir` does NOT isolate. Without this the test would write its
   * throwaway profiles into the developer's real ones.
   */
  protected async startApp(): Promise<AppHandle> {
    const home = this.makeTempDir("magentra-home-");
    return this.launchApp({ HOME: home, USERPROFILE: home });
  }

  /** A workspace. `configured` decides whether the app will start an engine for it. */
  protected makeWorkspace(configured: boolean): string {
    const workspace = this.makeTempDir("magentra-ws-");
    if (configured) {
      // A LOCAL endpoint needs no key, so this is a complete connection —
      // which is what workspaceConfigured() asks before spawning an engine.
      this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
        provider: "openai-compatible",
        baseUrl: LOCAL_ENDPOINT,
        model: "model-one",
      });
    }
    return workspace;
  }

  /** A saved profile pointing at the second endpoint, by name. */
  protected async saveSecondEndpoint(app: AppHandle, name: string, model: string): Promise<string> {
    return saveProfile(app, { name, provider: "openai-compat", baseUrl: SECOND_ENDPOINT, model, apiKey: "sk-from-the-ui" });
  }
}

class LiveEngineIsRePointed extends AppConnectionTest {
  readonly id = "a-live-engine-is-re-pointed-not-respawned";
  readonly whyItExists =
    "applying a profile to a workspace with a running engine used to respawn it, and the previous suite never caught that because it stubbed this whole call and returned live:true from a fake";

  override async run(t: TestRun): Promise<void> {
    const app = await this.startApp();
    const workspace = this.makeWorkspace(true);
    await openWorkspace(app, workspace);
    // The app starts an engine for a configured workspace; everything below is
    // about what happens while that engine is alive.
    const spawned = await waitForLog(workspace, (l) => l.ch === "sys" && l.data?.["ev"] === "spawn", "the engine to spawn");
    t.assert.equal(typeof spawned.data?.["pid"], "number");

    const id = await this.saveSecondEndpoint(app, "second", "model-two");
    const result = await applyProfile(app, id);

    t.assert.equal(result.ok, true);
    t.assert.equal(result.live, true, "a workspace with a live engine must be re-pointed, not respawned");

    // The frame really went down the engine's stdin — writeToEngine logs what it wrote.
    const frame = await waitForLog(
      workspace,
      (l) => l.ch === "ui" && l.data?.["type"] === "set_connection",
      "the set_connection frame to be written to the engine",
    );
    const connection = frame.data?.["connection"];
    t.assert.equal(typeof connection, "object");
    t.assert.equal((connection as Record<string, unknown>)["model"], "model-two");

    const swapped = await waitForLog(workspace, (l) => l.data?.["ev"] === "connection-swapped", "the swap to be recorded");
    t.assert.equal(swapped.data?.["live"], true);

    // And nothing respawned: one spawn for the life of this workspace.
    const spawns = logLines(workspace).filter((l) => l.data?.["ev"] === "spawn" || l.data?.["ev"] === "restart");
    t.assert.equal(spawns.length, 1, "the engine was respawned, which is the whole thing this feature removed");
  }
}

class NoEngineMeansSpawn extends AppConnectionTest {
  readonly id = "with-no-engine-running-the-connection-spawns-one";
  readonly whyItExists =
    "the other half of the same decision: with no live child there is nothing to re-point, and returning live:true there would leave the UI waiting for a session that never starts";

  override async run(t: TestRun): Promise<void> {
    const app = await this.startApp();
    // NOT configured: the app opens it and shows the setup wizard instead of
    // starting an engine, which is the state this test needs.
    const workspace = this.makeWorkspace(false);
    await openWorkspace(app, workspace);

    const id = await this.saveSecondEndpoint(app, "first", "model-one");
    const result = await applyProfile(app, id);

    t.assert.equal(result.ok, true);
    t.assert.equal(result.live, false, "with no engine running the app must spawn one and say so");

    // `live: false` is a claim that it spawned. Check that it did.
    const spawned = await waitForLog(workspace, (l) => l.data?.["ev"] === "spawn", "the engine to be spawned by applying the profile");
    t.assert.equal(typeof spawned.data?.["pid"], "number");
    const wrote = logLines(workspace).filter((l) => l.ch === "ui" && l.data?.["type"] === "set_connection");
    t.assert.deepEqual(wrote, [], "nothing should have been written to an engine that was not running");
  }
}

class DroppedFrameIsReported extends AppConnectionTest {
  readonly id = "a-set-connection-frame-to-a-dead-engine-is-reported";
  readonly whyItExists =
    "set_connection is in USER_ACTION_FRAMES precisely so a dropped one surfaces; a connection the user just saved silently not applying is the confusion that set exists to prevent";

  override async run(t: TestRun): Promise<void> {
    const app = await this.startApp();
    const workspace = this.makeWorkspace(true);
    await openWorkspace(app, workspace);
    const spawned = await waitForLog(workspace, (l) => l.data?.["ev"] === "spawn", "the engine to spawn");
    const pid = spawned.data?.["pid"];
    t.assert.equal(typeof pid, "number");

    // Collect what the renderer is told, through the product's own listener.
    await app.evaluate(`window.__dropped = []; window.magentra.onEvent((e) => window.__dropped.push(e)); true`);

    // The engine dies — the case the frame's presence in USER_ACTION_FRAMES is for.
    process.kill(pid as number, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    await app.evaluate(`window.magentra.send({ type: "set_connection", connection: { provider: "openai-compatible", apiKey: "", model: "model-two" } }); true`);
    await waitForLog(workspace, (l) => l.data?.["ev"] === "engine-write-dropped", "the dropped frame to be recorded");

    const seen = await app.evaluate<{ type?: string; message?: string }[]>(
      `new Promise((r) => setTimeout(() => r(window.__dropped.filter((e) => e && e.type === "error")), 500))`,
    );
    const told = seen.some((e) => typeof e.message === "string" && e.message.includes("The engine is not running"));
    t.assert.ok(told, `the user was never told the frame was dropped; the renderer saw ${JSON.stringify(seen)}`);
  }
}

registerFeatureTests(
  new SwapsInPlace(),
  new KeyLandsInTheEnvironment(),
  new AbsentVisionClears(),
  new SettingsTakesTheSameDoor(),
  new LiveEngineIsRePointed(),
  new NoEngineMeansSpawn(),
  new DroppedFrameIsReported(),
);
