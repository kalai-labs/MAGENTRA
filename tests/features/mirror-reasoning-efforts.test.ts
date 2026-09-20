/**
 * `mirror-reasoning-efforts`.
 *
 * The thinking-depth ladder a connection can choose — off, minimal, low,
 * medium, high, xhigh, max — is defined once in the protocol package and
 * repeated in the app, which cannot import it. The ORDER is the meaning:
 * `EffortClamp` picks the nearest level an endpoint accepts by index, so a
 * reordered copy clamps to the wrong level, and a missing level is one the
 * app refuses while the engine would accept it.
 *
 * `pure`. Three arrays and one mapping function, all values.
 *
 * `app/main/config.js` loads in plain Node with no stub: its
 * `require("electron")` resolves to the binary path and nothing read here
 * touches `app`.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { REASONING_EFFORTS, type ReasoningEffort } from "@magentra/protocol";
import { toWireEffort, WIRE_EFFORTS } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "mirror-reasoning-efforts";

/** Verbatim from the record. */
const INVARIANT = "REASONING_EFFORTS holds the same seven levels in the same order on both sides.";

const requireFromHere = createRequire(import.meta.url);

function appEfforts(): string[] {
  const config = requireFromHere(join(repoRoot(), "app", "main", "config.js")) as { REASONING_EFFORTS: string[] };
  return config.REASONING_EFFORTS;
}

/** The protocol's tuple as a plain array, so `deepEqual` compares values rather than tuple-ness. */
const ENGINE_EFFORTS: string[] = [...REASONING_EFFORTS];

abstract class ReasoningEffortsTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheLaddersAreIdentical extends ReasoningEffortsTest {
  readonly id = "both-ladders-hold-the-same-seven-levels-in-the-same-order";
  readonly whyItExists =
    "a level added to the protocol and not to the app is one the wizard refuses while the engine accepts it, and a reordered copy clamps to the wrong neighbour";

  override run(t: TestRun): void {
    t.assert.equal(ENGINE_EFFORTS.length, 7, "the protocol ladder has seven levels");
    t.assert.equal(appEfforts().length, 7, "the app's ladder has seven levels");
    t.assert.deepEqual(appEfforts(), ENGINE_EFFORTS, "app/main/config.js REASONING_EFFORTS has drifted from engine/protocol/src/types.ts");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheEndsAreFixed extends ReasoningEffortsTest {
  readonly id = "off-is-the-first-level-and-max-the-last-on-both-sides";
  readonly whyItExists =
    "the clamp treats index 0 as 'no reasoning' and the last index as the ceiling; a ladder that starts or ends anywhere else changes what 'over the maximum' means";

  override run(t: TestRun): void {
    for (const [side, ladder] of [
      ["engine", ENGINE_EFFORTS],
      ["app", appEfforts()],
    ] as const) {
      t.assert.equal(ladder[0], "off", `${side}: the first level must be "off"`);
      t.assert.equal(ladder[ladder.length - 1], "max", `${side}: the last level must be "max"`);
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheWireLadderMapsByIndex extends ReasoningEffortsTest {
  readonly id = "the-wire-ladder-maps-onto-the-protocol-ladder-index-for-index";
  readonly whyItExists =
    "EffortClamp walks WIRE_EFFORTS by index while the user's choice arrives as a REASONING_EFFORTS value, so an index that maps to a different level on the wire sends a depth the user did not choose";

  override run(t: TestRun): void {
    t.assert.equal(WIRE_EFFORTS.length, ENGINE_EFFORTS.length, "the two ladders must be the same length to map by index");
    const differing: string[] = [];
    for (let i = 0; i < ENGINE_EFFORTS.length; i++) {
      const level = ENGINE_EFFORTS[i] as ReasoningEffort;
      t.assert.equal(toWireEffort(level), WIRE_EFFORTS[i], `toWireEffort(${level}) must be the wire level at the same index`);
      if (level !== WIRE_EFFORTS[i]) differing.push(`${level}→${WIRE_EFFORTS[i]}`);
    }
    // Only "off" is spelled differently on the wire ("none"); every other
    // level travels verbatim.
    t.assert.deepEqual(differing, ["off→none"], "only 'off' may be respelled on the wire");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class NoLevelIsListedTwice extends ReasoningEffortsTest {
  readonly id = "neither-ladder-lists-a-level-twice";
  readonly whyItExists =
    "a duplicated level makes indexOf ambiguous, so the clamp's 'nearest level' and the app's validation would disagree about which rung a name means";

  override run(t: TestRun): void {
    t.assert.equal(new Set(ENGINE_EFFORTS).size, 7, "engine: seven distinct levels");
    t.assert.equal(new Set(appEfforts()).size, 7, "app: seven distinct levels");
    t.assert.equal(new Set(WIRE_EFFORTS).size, 7, "wire: seven distinct levels");
  }
}

registerFeatureTests(new TheLaddersAreIdentical(), new TheEndsAreFixed(), new TheWireLadderMapsByIndex(), new NoLevelIsListedTwice());
