/**
 * The gate — SPEC §4.3, decisions/0005, narrowed by decisions/0006.
 *
 * The gateway is named for what it does: it decides whether the inventory may
 * be believed. This file composes the two stages into one verdict and owns the
 * hard-block semantics.
 *
 * ORDER (decisions/0005): connection is checked at startup, as the TUI does;
 * freshness is checked on every read. Neither is bypassable by flag — if it
 * were, the flag would become the default in every hurry.
 *
 * WHAT THE VERDICT GATES (decisions/0006). Nothing runs from here. Tests are
 * run by the coding agent that implements a description, as a mandatory step
 * after the work, outside this tool. So `blocked` no longer means "no test may
 * run"; it means "no record here may be trusted" — a description written
 * against a stale record describes code that has moved, and a folder that is
 * not connected cannot be the one the agent works in.
 *
 * A separate file from `freshness.ts` and `connection.ts` because §4.3 is a
 * third thing: BLOCKED-is-not-passed is a rule about the pair, and putting it
 * inside stage 1 would make stage 1 import stage 2's semantics.
 */

import { checkConnection, describeConnection, type ConnectionState } from "./connection.js";
import { checkFreshness, type FreshnessReport } from "./freshness.js";
import type { Feature } from "./schema.js";

export interface GateState {
  readonly freshness: FreshnessReport;
  readonly connection: ConnectionState;
  /** True when anything at all stands between here and a believable inventory. */
  readonly blocked: boolean;
  /** What could not be verified, in words. Never empty when `blocked`. */
  readonly blockedReasons: readonly string[];
  readonly evaluatedAt: string;
}

export function evaluateGate(root: string, features: readonly Feature[]): GateState {
  const freshness = checkFreshness(root, features);
  const connection = checkConnection(root);

  const blockedReasons: string[] = [];

  // Stage 1. ANY stale record marks the WHOLE inventory untrusted — every
  // feature, not just the stale one. Partial credit is what teaches you to read
  // past a gate.
  if (!freshness.ok) {
    const names = freshness.stale.map((s) => s.id);
    blockedReasons.push(
      `${freshness.stale.length} of ${freshness.checked} records are stale, so none of the ${freshness.checked} can be trusted until they are reviewed and reconciled: ` +
        `${names.slice(0, 5).join(", ")}${names.length > 5 ? `, +${names.length - 5} more` : ""}`,
    );
  }

  // Stage 2. No connection, no trusted workspace — the descriptions written
  // here are for the folder this gateway is pointed at.
  if (connection.kind !== "connected") blockedReasons.push(describeConnection(connection));

  const blocked = blockedReasons.length > 0;
  return {
    freshness,
    connection,
    blocked,
    blockedReasons,
    evaluatedAt: new Date().toISOString(),
  };
}
