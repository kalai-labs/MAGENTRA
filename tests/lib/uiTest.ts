/**
 * `UiTest` — the kind that runs the real desktop app. SPEC §3, decisions/0004.
 *
 * WHAT THIS KIND IS FOR. A feature that only exists once Electron is running:
 * the main process's window and tab state, an ipcMain handler reached through
 * the real preload bridge, an engine child spawned by the app rather than by a
 * test. If a feature can be proved without a window, it is a cheaper kind and
 * this one is the wrong answer — Electron costs seconds per test and a display.
 *
 * WHAT IT OWNS: the Electron process, the command channel it answers on, and
 * the isolated profile it runs on. `--user-data-dir` is not a nicety.
 * `app/main.js` takes a single-instance lock (line 48), and that lock is keyed
 * on the user-data directory — so without an isolated one, a test run on a
 * machine where the developer has MAGENTRA open quits instantly and the failure
 * looks like a product bug. The isolation also keeps `config.json`, the
 * recent-workspace list and the fallback log out of the developer's real
 * profile.
 *
 * `--smoke` is deliberately NOT passed: it makes the app exit five seconds
 * after the first paint (main.js:968), which is a CI boot check, not a test
 * harness. (A test whose subject IS that check passes it explicitly.)
 *
 * WHAT IT DOES NOT DO: it never adds anything to the product to make itself
 * possible. `tests/lib/appHarness.cjs` hosts `app/main.js` unchanged and drives
 * the renderer that already exists; the note at the top of that file records
 * what went wrong the last time a suite did otherwise, and why the channel is a
 * loopback socket rather than the child's stdin — Electron's main process has
 * no usable `process.stdin` on Windows, which is the whole of why this suite
 * passed on macOS and failed on Windows with every `evaluate` timing out.
 *
 * ONE APP AT A TIME. Electron is the most expensive thing this suite starts,
 * and `node --test` runs test FILES in parallel processes — with 18 of the 28
 * files holding `ui` tests, the default concurrency opened as many real desktop
 * apps at once as the machine had cores. That is a design fault, not a platform
 * one: it fights for the display, the GPU and the disk on every OS. The fix is
 * the runner flag in `npm test` (`--test-concurrency=1`), so files run one at a
 * time and `node:test` already runs the tests inside a file sequentially. See
 * `tests/README.md`.
 *
 * REQUIREMENTS: a built engine (`npm run build`) for anything that spawns one,
 * and a display. macOS and Windows have one; Linux CI needs `xvfb-run`, exactly
 * as the app's own smoke job already does.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

/** Tail of the app's stderr quoted in a channel failure — enough to see the cause, not the whole log. */
const STDERR_TAIL = 2_000;

/**
 * Windows keeps a directory open a moment after the process that held it is
 * gone — an antivirus scanner, the GPU process's last write, a handle Chromium
 * has not released yet — and `force: true` only forgives ENOENT. `rmSync`'s own
 * retry loop forgives EPERM/EBUSY, which is the error that turned three passing
 * tests into failures on this platform and none on macOS.
 */
const RM_RETRIES = { recursive: true, force: true, maxRetries: 12, retryDelay: 100 } as const;

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
  /**
   * Run JavaScript in the MAIN process, with `win` (the app's window) and
   * `electron` in scope.
   *
   * For what the renderer cannot see: whether the window is full screen, a key
   * event delivered to its webContents, an ipcMain round trip. The product is
   * never asked to expose any of it — this is the harness's own door, and it is
   * why `appHarness.cjs` hosts `app/main.js` rather than being hosted by it.
   */
  evaluateInMain<T>(js: string): Promise<T>;
}

/**
 * The loopback socket a launched app answers on.
 *
 * One server, one connection, one app. It listens before the app is spawned —
 * the port has to exist to be passed in the environment — and the harness
 * connects back as its first act, so a boot that fails can still say why.
 *
 * Lines are buffered the same way `childProcesses.ts` buffers a child's stdout:
 * a reply that arrives before the test asks for it is not a race, and a waiter
 * is woken exactly when there is something new to look at.
 */
class CommandChannel {
  readonly #server: Server;
  readonly port: number;
  #socket: Socket | undefined;
  #outbox: string[] = [];
  #lines: string[] = [];
  #cursor = 0;
  #pending = "";
  /** Everyone currently waiting for something to change. A set, because a channel may be read from more than one place. */
  readonly #waiters = new Set<() => void>();

  private constructor(server: Server, port: number) {
    this.#server = server;
    this.port = port;
    server.on("connection", (socket) => {
      // One app per channel. A second connection is not something this harness
      // can produce, and quietly serving it would hide the day it does.
      if (this.#socket !== undefined) {
        socket.destroy();
        return;
      }
      this.#socket = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => this.#absorb(chunk));
      socket.on("error", () => this.notify());
      socket.on("close", () => this.notify());
      const queued = this.#outbox;
      this.#outbox = [];
      for (const line of queued) socket.write(line);
    });
  }

  /** Listen on a port the OS picks, on the loopback interface only. */
  static async open(): Promise<CommandChannel> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("the harness channel did not bind to a TCP port");
    }
    return new CommandChannel(server, address.port);
  }

  #absorb(chunk: string): void {
    this.#pending += chunk;
    let nl = this.#pending.indexOf("\n");
    while (nl !== -1) {
      this.#lines.push(this.#pending.slice(0, nl).replace(/\r$/, ""));
      this.#pending = this.#pending.slice(nl + 1);
      nl = this.#pending.indexOf("\n");
    }
    this.notify();
  }

  /** Wake everyone waiting. Called on a new line, on the socket closing, and by the app's exit. */
  notify(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  /** Queue a command. Held until the app connects, so a send cannot race the handshake. */
  send(line: string): void {
    const payload = `${line}\n`;
    if (this.#socket !== undefined && !this.#socket.destroyed) this.#socket.write(payload);
    else this.#outbox.push(payload);
  }

  /** The next unconsumed line, or undefined if there is none yet. */
  take(): string | undefined {
    if (this.#cursor >= this.#lines.length) return undefined;
    const line = this.#lines[this.#cursor]!;
    this.#cursor += 1;
    return line;
  }

  /** Resolves when a line arrives, the socket ends, the app exits, or `ms` passes. */
  async waitForChange(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.#waiters.add(wake);
    });
  }

  async close(): Promise<void> {
    this.notify();
    this.#socket?.destroy();
    this.#socket = undefined;
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

export abstract class UiTest extends FeatureTest {
  readonly kind = "ui" as const;

  /** Launching Electron, opening a workspace and spawning an engine is not a 30-second affair. */
  override readonly timeoutMs: number = 180_000;

  readonly #processes = new ChildProcesses(this.constructor.name);
  #channels: CommandChannel[] = [];
  #tempDirs: string[] = [];
  #nextEvalId = 1;

  /** A fresh directory, removed after the app is dead. See {@link removeAfterApp}. */
  protected makeTempDir(prefix = "magentra-ui-"): string {
    return this.removeAfterApp(mkdtempSync(join(tmpdir(), prefix)));
  }

  /** Write a JSON file, creating its directory — for the fixture a workspace needs before it is opened. */
  protected writeJsonFile(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

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
  protected async launchApp(
    env: Readonly<Record<string, string | undefined>> = {},
    extraArgs: readonly string[] = [],
  ): Promise<AppHandle> {
    const userDataDir = mkdtempSync(join(tmpdir(), "magentra-ui-"));
    this.#tempDirs.push(userDataDir);

    // The channel first: the port has to exist before the app that connects to
    // it is spawned, and the harness reports a failed boot down the same socket.
    const channel = await CommandChannel.open();
    this.#channels.push(channel);

    const child = this.#processes.spawn(
      electronBinary(),
      [join(repoRoot(), HARNESS), `--user-data-dir=${userDataDir}`, ...extraArgs],
      { label: "magentra (electron)", env: { ...env, MAGENTRA_HARNESS_PORT: String(channel.port) } },
    );
    // A dead app wakes every reader at once, so a crash during boot is reported
    // as a crash instead of as ninety seconds of silence.
    void child.exited().then(() => channel.notify());

    const ready = await this.#nextHarnessLine(child, channel, (m) => m["event"] === "ready" || m["event"] === "failed", LAUNCH_TIMEOUT_MS);
    if (ready["event"] === "failed") {
      throw new Error(`the app did not come up: ${String(ready["error"])}`);
    }

    return {
      process: child,
      userDataDir,
      evaluate: async <T,>(js: string): Promise<T> => this.#run(child, channel, "eval", js),
      evaluateInMain: async <T,>(js: string): Promise<T> => this.#run(child, channel, "main", js),
    };
  }

  async #run<T>(child: ProcHandle, channel: CommandChannel, cmd: "eval" | "main", js: string): Promise<T> {
    const id = this.#nextEvalId++;
    channel.send(JSON.stringify({ id, cmd, js }));
    const result = await this.#nextHarnessLine(child, channel, (m) => m["event"] === "result" && m["id"] === id, EVAL_TIMEOUT_MS);
    if (result["ok"] !== true) throw new Error(`${cmd === "eval" ? "renderer" : "main-process"} evaluation failed: ${String(result["error"])}`);
    return result["value"] as T;
  }

  /**
   * The next harness line matching `predicate`.
   *
   * A line that is not JSON, or not ours, is skipped rather than treated as a
   * protocol error — the socket carries only this protocol today, and a wrong
   * line should not be the thing that decides a test.
   *
   * An app that has EXITED is reported at once, with the tail of its stderr,
   * instead of waiting out the timeout: a crash during boot is the failure, and
   * ninety seconds of silence is a worse way to say it.
   */
  async #nextHarnessLine(
    child: ProcHandle,
    channel: CommandChannel,
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let line = channel.take(); line !== undefined; line = channel.take()) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message["type"] !== "harness") continue;
        if (predicate(message)) return message;
      }
      if (child.hasExited()) {
        throw new Error(`${this.constructor.name}: ${this.#context(child)} produced no further output on its command channel`);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`${this.constructor.name}: waited ${timeoutMs}ms for a reply from ${this.#context(child)} and it said nothing more`);
      }
      await channel.waitForChange(Math.min(left, 250));
    }
  }

  #context(child: ProcHandle): string {
    const err = child.stderr();
    const tail = err.length > STDERR_TAIL ? `…${err.slice(-STDERR_TAIL)}` : err;
    const state = child.hasExited() ? "exited" : "still running";
    return `${child.label} (${state})${tail.trim() === "" ? "" : `\n--- stderr ---\n${tail.trimEnd()}\n--------------`}`;
  }

  /**
   * Kill the app, close its channel, then remove what it ran on — in that
   * order, because Windows cannot delete an open file.
   *
   * Removed TWICE, with a settle in between. `stopAll` waits for the Electron
   * process, but the engine the app spawned is a grandchild: killing the group
   * ends it, and on its way out it can still write its session and task files,
   * recreating the `.magentra/` directory a moment after the first removal.
   * Observed once, on a run where the test had already failed and the engine
   * was mid-write. A cleanup that only works on the happy path is not one.
   *
   * Removal is retried and then allowed to fail. A temp directory Windows will
   * not let go of is a handle the operating system is still closing, not a
   * defect in the feature under test, and failing a passing test over one is
   * the kind of noise that teaches people to re-run instead of read — it is
   * what turned three green `ui` tests red here with EPERM. `rmSync`'s own
   * backoff does the waiting. The guarantee that still THROWS is the one worth
   * throwing over: `stopAll` reports any process that outlived the test, and it
   * runs first.
   */
  protected override async tearDownKind(): Promise<void> {
    try {
      await this.#processes.stopAll();
    } finally {
      const channels = this.#channels;
      this.#channels = [];
      for (const channel of channels) await channel.close();

      const dirs = this.#tempDirs;
      this.#tempDirs = [];
      for (const dir of dirs) this.#remove(dir);
      await new Promise((resolve) => setTimeout(resolve, GRANDCHILD_SETTLE_MS));
      for (const dir of dirs) this.#remove(dir);
    }
  }

  #remove(dir: string): void {
    try {
      rmSync(dir, RM_RETRIES);
    } catch {
      /* the OS still holds it, or the engine is mid-write; see tearDownKind */
    }
  }
}
