/**
 * `PureTest` — the kind that touches nothing. SPEC §3, decisions/0004.
 *
 * WHAT THIS KIND IS FOR. A feature that is a function of its inputs: a parser,
 * a normalizer, a decision table, a walk over candidates — anything provable by
 * calling it and looking at what comes back. It is the CHEAPEST kind and
 * therefore the right one whenever it is honest: a test that spawns a process
 * to reach a function that was already reachable buys nothing and costs
 * seconds, and a suite of those is a suite nobody runs before pushing.
 *
 * A function that takes its I/O as a parameter is still pure to test. The
 * connection wizard's `testEndpoint` is the example: it accepts `opts.fetchImpl`
 * precisely so the network can be handed to it, and driving it with a scripted
 * fetch exercises every branch of its candidate walk without a socket.
 *
 * WHAT IT OWNS: proof that the test really was pure.
 *
 * SPEC §3 says this class "owns nothing", which is true of setup and untrue of
 * the guarantee. "No I/O permitted" enforced by nothing is a comment, and the
 * cheapest kind is exactly the one a leak hides in longest — so the process
 * state a pure test must not change is snapshotted and compared: the
 * environment and the working directory. `app/main/connection.js` sets
 * `NODE_TLS_REJECT_UNAUTHORIZED` around a request and restores it in a
 * `finally`; that restore is the kind of thing this catches when it stops
 * happening, in the test that happened to run next rather than in a bug report.
 *
 * It cannot catch a file written or a socket opened. Those belong to `fs` and
 * `net`, and a test that needs them has picked the wrong kind — which is a
 * judgement, not something a base class can decide.
 */

import { FeatureTest } from "./featureTest.ts";

export abstract class PureTest extends FeatureTest {
  readonly kind = "pure" as const;

  #env: string | undefined;
  #cwd: string | undefined;

  protected override setUpKind(): void {
    this.#env = JSON.stringify(process.env, Object.keys(process.env).sort());
    this.#cwd = process.cwd();
  }

  protected override tearDownKind(): void {
    const env = JSON.stringify(process.env, Object.keys(process.env).sort());
    if (this.#env !== undefined && env !== this.#env) {
      throw new Error(
        `${this.id}: a "pure" test changed this process's environment and did not put it back. ` +
          `The next test in the same process inherits that, so the failure lands somewhere else — ` +
          `restore what you set, or this is not a pure test.`,
      );
    }
    if (this.#cwd !== undefined && process.cwd() !== this.#cwd) {
      throw new Error(`${this.id}: a "pure" test changed the working directory from ${this.#cwd} to ${process.cwd()}`);
    }
  }
}
