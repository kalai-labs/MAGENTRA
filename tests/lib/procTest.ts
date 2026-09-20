/**
 * `ProcTest` — the kind that spawns a real process and owns its lifecycle.
 * SPEC §3, decisions/0004.
 *
 * WHAT THIS KIND IS FOR. A feature whose behaviour only exists once something
 * is actually running: the engine answering frames on its stdio, a CLI's exit
 * code, a child that must survive one thing and die on another. If a feature
 * can be proved by calling a function and looking at what comes back, it is
 * `pure` or `fs` and this class is the wrong one — spawning a process to reach
 * a function that was already reachable buys nothing and costs seconds.
 *
 * WHAT IT OWNS: every process it spawned is dead before the test is over, its
 * whole tree with it, and a survivor FAILS the test even one that had passed.
 * The mechanism lives in `childProcesses.ts`, which `UiTest` holds too — see
 * that file for why the guarantee is one copy rather than one per kind.
 *
 * WHAT IT DELIBERATELY DOES NOT KNOW. Nothing here parses a MAGENTRA protocol
 * frame. Lines in, lines out, plus stdin — the kind stays generic, and the
 * NDJSON harness that knows what a `set_connection` frame looks like belongs
 * beside the test that needs it, not in the base class every spawning test
 * inherits.
 */

import { FeatureTest } from "./featureTest.ts";
import { ChildProcesses, type ProcHandle, type SpawnOptions } from "./childProcesses.ts";

export type { Exit, ProcHandle, SpawnOptions } from "./childProcesses.ts";

export abstract class ProcTest extends FeatureTest {
  readonly kind = "proc" as const;

  /** Spawning and waiting on real processes is slower than the 30s a `pure` test gets. */
  override readonly timeoutMs: number = 60_000;

  readonly #processes = new ChildProcesses(this.constructor.name);

  /**
   * Spawn a child this test owns. It is killed on teardown whether the test
   * passes, fails or throws.
   *
   * stdio is always piped: a test that cannot read what the child said cannot
   * assert on it, and a child inheriting the runner's stdout corrupts the
   * stream the test reporter is parsing.
   */
  protected spawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ProcHandle {
    return this.#processes.spawn(command, args, options);
  }

  /** Every child this test spawned, in the order it spawned them. */
  protected get children(): readonly ProcHandle[] {
    return this.#processes.all;
  }

  /** The kind's promise, kept. Always runs — `registerFeatureTests` calls it from the outermost `finally`. */
  protected override async tearDownKind(): Promise<void> {
    await this.#processes.stopAll();
  }
}
