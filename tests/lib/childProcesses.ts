/**
 * Child-process lifecycle, owned by whichever kind needs one.
 *
 * WHY THIS IS NOT INSIDE `ProcTest`. Two kinds spawn: `proc` spawns whatever a
 * test names, and `ui` spawns Electron. decisions/0004 makes the six kinds
 * SIBLINGS under `FeatureTest` — `ui` is not a special `proc` — so the choice
 * was a second copy of "kill the tree, escalate, wait, report an orphan" or one
 * copy both kinds hold. A second copy of a teardown guarantee is how one of
 * them quietly stops being kept.
 *
 * The contract is the whole of it: every process spawned through here is dead
 * before the test is over, its whole tree with it, and a survivor is reported
 * rather than ignored. `procTest.ts` and `uiTest.ts` each own an instance and
 * expose only what their kind should.
 */

import { spawn as spawnChild, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { repoRoot } from "./inventory.ts";

/** Default ceiling on a single wait for a line of output. */
const LINE_TIMEOUT_MS = 10_000;

/** How long a child gets to honour SIGTERM before SIGKILL. */
const GRACE_MS = 2_000;

/** How long SIGKILL gets before the child is reported as an orphan. */
const KILL_MS = 2_000;

/** Tail of stderr included in a failure message — enough to see the cause, not the whole log. */
const STDERR_TAIL = 2_000;

export interface SpawnOptions {
  /** Defaults to the repository root, which is what a repo-relative command expects. */
  readonly cwd?: string;
  /** Merged onto `process.env`. Set a key to `undefined` to remove it from the child's environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Shown in failure messages instead of the raw command line. */
  readonly label?: string;
}

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * A spawned child, seen the way a test needs to see one: what it has said, what
 * it says next, and what it did when it stopped.
 */
export interface ProcHandle {
  readonly label: string;
  readonly pid: number;
  /** Everything the child has written to stdout so far. */
  stdout(): string;
  /** Everything the child has written to stderr so far. */
  stderr(): string;
  /**
   * The next stdout line matching `predicate`, consuming it.
   *
   * Lines already received but not yet consumed count — so a child that answers
   * before the test asks is not a race. Rejects, naming the child and the tail
   * of its stderr, if it exits first or the wait times out.
   */
  nextLine(predicate?: (line: string) => boolean, timeoutMs?: number): Promise<string>;
  /** Write one line to the child's stdin. Throws if stdin has closed — which is itself a thing worth asserting. */
  send(line: string): void;
  /** Close the child's stdin, the ordinary way to ask a stdio protocol to finish. */
  endInput(): void;
  /** Resolves when the child exits. Never rejects. */
  exited(): Promise<Exit>;
  /** True once the child has exited. */
  hasExited(): boolean;
  /** Ask this child to stop now. Teardown does it anyway; call it when the test is ABOUT the stopping. */
  kill(signal?: NodeJS.Signals): void;
}

interface Tracked extends ProcHandle {
  readonly child: ChildProcessWithoutNullStreams;
}

/** SIGTERM/SIGKILL to the child's whole group, with the per-platform difference in one place. */
function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // No process groups and no signals: taskkill /T is the tree, /F is the kill.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    // Negative pid = the group, which `detached: true` made this child the leader of.
    process.kill(-pid, signal);
  } catch {
    // The group is gone, or was never created; the child itself may still be there.
    try {
      child.kill(signal);
    } catch {
      /* already reaped */
    }
  }
}

/** A promise that settles when `p` does, or resolves `false` after `ms`. Never leaves a timer holding the loop open. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}


/** Spawn one tracked child. `owner` names the test in every message this child can produce. */
function spawnTracked(owner: string, command: string, args: readonly string[], options: SpawnOptions): Tracked {
  const label = options.label ?? [command, ...args].join(" ");
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  const child = spawnChild(command, [...args], {
    cwd: options.cwd ?? repoRoot(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so teardown can kill the tree. Not on Windows,
    // where `detached` opens a console window instead.
    detached: process.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;

  let out = "";
  let err = "";
  const lines: string[] = [];
  let cursor = 0;
  let pending = "";
  /** Woken on every new line and on exit, so a waiter re-checks exactly when there is something to re-check. */
  let wake: (() => void) | undefined;

  const absorb = (chunk: string): void => {
    pending += chunk;
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      lines.push(pending.slice(0, nl).replace(/\r$/, ""));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
    wake?.();
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    out += c;
    absorb(c);
  });
  child.stderr.on("data", (c: string) => {
    err += c;
  });

  let exit: Exit | undefined;
  let spawnError: Error | undefined;
  const exitPromise = new Promise<Exit>((resolve) => {
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      resolve(exit);
      wake?.();
    });
    child.on("error", (e) => {
      // ENOENT and friends: there is no process, and no "exit" will ever come.
      spawnError = e;
      if (exit === undefined) {
        exit = { code: null, signal: null };
        resolve(exit);
      }
      wake?.();
    });
  });

  const context = (): string => {
    const tail = err.length > STDERR_TAIL ? `…${err.slice(-STDERR_TAIL)}` : err;
    const state = spawnError !== undefined ? `failed to spawn — ${spawnError.message}` : exit !== undefined ? `exited code=${exit.code} signal=${exit.signal}` : "still running";
    return `${label} (${state})${tail.trim() === "" ? "" : `\n--- stderr ---\n${tail.trimEnd()}\n--------------`}`;
  };

  const handle: Tracked = {
    child,
    label,
    pid: child.pid ?? -1,
    stdout: () => out,
    stderr: () => err,
    hasExited: () => exit !== undefined,
    exited: () => exitPromise,
    kill: (signal: NodeJS.Signals = "SIGTERM") => killTree(child, signal),
    send: (line: string) => {
      if (!child.stdin.writable) throw new Error(`${owner}: cannot write to ${context()} — its stdin has closed`);
      child.stdin.write(`${line}\n`);
    },
    endInput: () => {
      if (child.stdin.writable) child.stdin.end();
    },
    nextLine: async (predicate?: (line: string) => boolean, timeoutMs: number = LINE_TIMEOUT_MS): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (cursor < lines.length) {
          const line = lines[cursor]!;
          cursor += 1;
          if (predicate === undefined || predicate(line)) return line;
        }
        if (exit !== undefined) {
          throw new Error(`${owner}: waited for a line from ${context()}, but it produced no further output`);
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(`${owner}: waited ${timeoutMs}ms for a line from ${context()} and it said nothing more`);
        }
        const woken = new Promise<void>((resolve) => {
          wake = resolve;
        });
        await within(woken, left);
        wake = undefined;
      }
    },
  };
  return handle;
}

/**
 * The processes one test owns. Constructed by a kind class, never by a test.
 */
export class ChildProcesses {
  readonly #owner: string;
  #children: Tracked[] = [];
  #stopped = false;

  constructor(owner: string) {
    this.#owner = owner;
  }

  get all(): readonly ProcHandle[] {
    return this.#children;
  }

  spawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ProcHandle {
    if (this.#stopped) {
      throw new Error(`${this.#owner}: spawn() after teardown — the test is over, and this child would be an orphan by construction`);
    }
    const handle = spawnTracked(this.#owner, command, args, options);
    this.#children.push(handle);
    return handle;
  }

  /**
   * Kill everything, in reverse order of spawning — a child spawned second is
   * the one likelier to be a client of the first, and killing the server first
   * turns an orderly shutdown into a crash log.
   *
   * @throws Error naming any process that survived SIGKILL.
   */
  async stopAll(): Promise<void> {
    this.#stopped = true;
    const orphans: string[] = [];

    for (const handle of [...this.#children].reverse()) {
      if (handle.hasExited()) continue;
      killTree((handle as Tracked).child, "SIGTERM");
      if (await within(handle.exited(), GRACE_MS)) continue;
      killTree((handle as Tracked).child, "SIGKILL");
      if (await within(handle.exited(), KILL_MS)) continue;
      orphans.push(`${handle.label} (pid ${handle.pid})`);
    }

    this.#children = [];
    if (orphans.length > 0) {
      throw new Error(
        `${this.#owner}: ${orphans.length} process${orphans.length === 1 ? "" : "es"} survived SIGKILL and ${orphans.length === 1 ? "is" : "are"} now an orphan: ${orphans.join(", ")}. ` +
          `A test owns the lifecycle of what it spawns; a leaked child holds ports and locks that make an unrelated later test fail.`,
      );
    }
  }
}
