/**
 * The gate — SPEC §4.3, decisions/0005.
 *
 * The gateway is named for what it does. It is not a viewer with a run button;
 * it is the thing that decides whether a test result may be believed. This file
 * composes the two stages into one verdict and owns the hard-block semantics.
 *
 * ORDER (decisions/0005): connection is checked at startup, as the TUI does;
 * freshness is checked before anything runs. Neither is bypassable by flag — if
 * it were, the flag would become the default in every hurry.
 *
 * A separate file from `freshness.ts` and `connection.ts` because §4.3 is a
 * third thing: BLOCKED-is-not-passed is a rule about the pair, and putting it
 * inside stage 1 would make stage 1 import stage 2's semantics.
 */

import { checkConnection, describeConnection, type ConnectionState } from "./connection.js";
import { checkFreshness, type FreshnessReport } from "./freshness.js";
import type { Feature } from "./schema.js";

/** §4.3. `BLOCKED` is not a pass: it exits non-zero and names what it could not verify. */
export type Outcome = "PASS" | "FAIL" | "BLOCKED";

export interface GateState {
  readonly freshness: FreshnessReport;
  readonly connection: ConnectionState;
  /** True when anything at all stands between here and a believable result. */
  readonly blocked: boolean;
  /** What could not be verified, in words. Never empty when `blocked`. */
  readonly blockedReasons: readonly string[];
  /** The single value the UI's RUN button is bound to. */
  readonly runAllowed: boolean;
  readonly evaluatedAt: string;
}

export function evaluateGate(root: string, features: readonly Feature[]): GateState {
  const freshness = checkFreshness(root, features);
  const connection = checkConnection(root);

  const blockedReasons: string[] = [];

  // Stage 1. ANY stale record stops the ENTIRE run — every feature's tests, not
  // just the stale one's. Partial credit is what teaches you to read past a gate.
  if (!freshness.ok) {
    const names = freshness.stale.map((s) => s.id);
    blockedReasons.push(
      `${freshness.stale.length} of ${freshness.checked} records are stale, so none of the ${freshness.checked} can be verified: ` +
        `${names.slice(0, 5).join(", ")}${names.length > 5 ? `, +${names.length - 5} more` : ""}`,
    );
  }

  // Stage 2. No connection, no run — whether or not the test involves a model.
  if (connection.kind !== "connected") blockedReasons.push(describeConnection(connection));

  const blocked = blockedReasons.length > 0;
  return {
    freshness,
    connection,
    blocked,
    blockedReasons,
    runAllowed: !blocked,
    evaluatedAt: new Date().toISOString(),
  };
}

/** Thrown by {@link assertRunnable}. Carries what could not be verified. */
export class GateBlocked extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`BLOCKED — nothing ran:\n${reasons.map((r) => `  · ${r}`).join("\n")}`);
    this.name = "GateBlocked";
    this.reasons = reasons;
  }
}

/**
 * The hard block itself. Every path to running a test goes through here, and
 * there is no argument that turns it off — no `force`, no `--only`, no
 * per-feature exemption. Stage 1 fails for one record and this throws for all
 * of them.
 */
export function assertRunnable(gate: GateState): void {
  if (gate.blocked) throw new GateBlocked(gate.blockedReasons);
}

/**
 * A run's outcome. `BLOCKED` wins over everything, because collapsing "cannot
 * run" into either "pass" or "fail" is a lie in one direction or the other. A
 * summary may never read green while anything is blocked.
 */
export function runOutcome(gate: GateState, failedTests: number): Outcome {
  if (gate.blocked) return "BLOCKED";
  return failedTests > 0 ? "FAIL" : "PASS";
}
