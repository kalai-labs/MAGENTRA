/**
 * `mirror-token-algebra`.
 *
 * `estimateTokens` (characters ÷ 3.5, rounded up) and `formatTokens` ("9.9k",
 * "10k", "1.5M") live in the protocol package and are repeated in the
 * renderer, which cannot import them. A drift makes the on-screen meter and
 * the /session report disagree about the same session — two numbers for one
 * quantity, and the user has no way to tell which one is lying.
 *
 * `pure`. Both copies are functions of a number or a string. The renderer's
 * copy is a classic script (`app/renderer/modules/tokens.js`, loaded first in
 * index.html so every later module can use it) with no DOM dependency at all,
 * so it is run as source in a fresh `vm` context and the functions it defines
 * are read back. No stub, no shim — the real file, evaluated the way the page
 * evaluates it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { CHARS_PER_TOKEN, estimateTokens, formatTokens } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "mirror-token-algebra";

/** Verbatim from the record. */
const INVARIANT = "estimateTokens and formatTokens produce identical output in the renderer and the protocol.";

interface RendererTokens {
  readonly CHARS_PER_TOKEN: number;
  estimateTokens(input: unknown): number;
  formatTokens(n: unknown): string;
}

/** The renderer's copy, evaluated as the classic script it is, in a context of its own. */
function rendererTokens(): RendererTokens {
  const source = readFileSync(join(repoRoot(), "app", "renderer", "modules", "tokens.js"), "utf8");
  return runInNewContext(`${source}\n;({ CHARS_PER_TOKEN, estimateTokens, formatTokens });`, {}) as RendererTokens;
}

abstract class TokenAlgebraTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class EstimatesAgree extends TokenAlgebraTest {
  readonly id = "estimatetokens-agrees-on-numbers-and-strings";
  readonly whyItExists =
    "the composer's live estimate and the engine's pre-response estimate of the same text differed by one, so the meter jumped when the exact count arrived";

  override run(t: TestRun): void {
    const renderer = rendererTokens();
    const inputs: (number | string)[] = [0, 1, 3, 4, 7, 3500, "hello world", ""];
    for (const input of inputs) {
      t.assert.equal(renderer.estimateTokens(input), estimateTokens(input), `estimateTokens(${JSON.stringify(input)}) differs between renderer and protocol`);
    }
    // The values the description pins, so an identical drift on BOTH sides
    // (a changed constant copied faithfully) still fails here.
    t.assert.equal(estimateTokens(4), 2);
    t.assert.equal(estimateTokens(7), 2);
    t.assert.equal(estimateTokens(3500), 1000);
    t.assert.equal(estimateTokens(""), 0);
    t.assert.equal(estimateTokens("hello world"), 4);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class FormatsAgree extends TokenAlgebraTest {
  readonly id = "formattokens-agrees-across-every-band";
  readonly whyItExists =
    "the meter printed '10.0k' where the report printed '10k' for the same count, and a reader compared the two as if they were different numbers";

  override run(t: TestRun): void {
    const renderer = rendererTokens();
    const cases: [number, string][] = [
      [0, "0"],
      [999, "999"],
      [1000, "1.0k"],
      [1049, "1.0k"],
      [9949, "9.9k"],
      [9950, "10k"],
      [10000, "10k"],
      [999499, "999k"],
      [999500, "1.0M"],
      [1500000, "1.5M"],
    ];
    for (const [n, expected] of cases) {
      t.assert.equal(formatTokens(n), expected, `protocol formatTokens(${n})`);
      t.assert.equal(renderer.formatTokens(n), expected, `renderer formatTokens(${n})`);
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class NegativeAndMissingInputs extends TokenAlgebraTest {
  readonly id = "negative-input-is-zero-on-both-sides-and-the-undefined-guard-is-the-renderers";
  readonly whyItExists =
    "a negative or missing count rendered as '-5' or 'NaN' in the meter, and the two copies handled the missing case differently without anyone having decided that";

  override run(t: TestRun): void {
    const renderer = rendererTokens();
    t.assert.equal(formatTokens(-5), "0", "protocol: a negative count is shown as 0");
    t.assert.equal(renderer.formatTokens(-5), "0", "renderer: a negative count is shown as 0");
    for (const n of [-1, -0.4, 0.4]) {
      t.assert.equal(renderer.formatTokens(n), formatTokens(n), `formatTokens(${n}) differs`);
    }

    // The one documented difference. The protocol is typed `number` and has no
    // guard for a missing value; the renderer receives fields off the wire that
    // may be absent and guards with `n || 0`. Where the protocol accepts the
    // input (a number), the two agree — asserted above. For `undefined` only the
    // renderer has an answer, and it is "0", never "NaN".
    t.assert.equal(renderer.formatTokens(undefined), "0", "renderer: a missing count reads as 0");
    t.assert.equal(renderer.formatTokens(Number.NaN), "0", "renderer: NaN reads as 0");
    t.assert.equal(renderer.estimateTokens(undefined), 0, "renderer: a missing text estimates to 0 tokens");
    t.diagnostic(
      `documented difference: protocol formatTokens(undefined as never) = ${JSON.stringify(formatTokens(undefined as never))} — the protocol is typed number and never receives a missing value`,
    );
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheConstantIsThreeAndAHalf extends TokenAlgebraTest {
  readonly id = "chars-per-token-is-3-5-on-both-sides";
  readonly whyItExists =
    "the constant is deliberately below real English so estimates over-count; a side that moved to 4 would under-count and let the window overflow before compaction fired";

  override run(t: TestRun): void {
    t.assert.equal(CHARS_PER_TOKEN, 3.5, "protocol CHARS_PER_TOKEN");
    t.assert.equal(rendererTokens().CHARS_PER_TOKEN, 3.5, "renderer CHARS_PER_TOKEN");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheBandBoundaryNeverReadsBackwards extends TokenAlgebraTest {
  readonly id = "the-9950-boundary-goes-straight-from-9-9k-to-10k";
  readonly whyItExists =
    "a naive 10,000 cutoff printed '10.0k' between 9,950 and 9,999, so the meter read backwards ('9.9k' → '10.0k' → '10k') across a few dozen tokens";

  override run(t: TestRun): void {
    const renderer = rendererTokens();
    for (const impl of [formatTokens, renderer.formatTokens.bind(renderer)]) {
      t.assert.equal(impl(9949), "9.9k");
      t.assert.equal(impl(9950), "10k");
      for (let n = 9950; n < 10_000; n++) {
        t.assert.notEqual(impl(n), "10.0k", `formatTokens(${n}) must never print 10.0k`);
      }
    }
    // The same rule at the next band: 999,499 is still "999k" and 999,500
    // becomes "1.0M", with no "1000k" in between.
    t.assert.equal(formatTokens(999499), "999k");
    t.assert.equal(renderer.formatTokens(999500), "1.0M");
    t.assert.notEqual(formatTokens(999600), "1000k");
    t.assert.notEqual(renderer.formatTokens(999600), "1000k");
  }
}

registerFeatureTests(
  new EstimatesAgree(),
  new FormatsAgree(),
  new NegativeAndMissingInputs(),
  new TheConstantIsThreeAndAHalf(),
  new TheBandBoundaryNeverReadsBackwards(),
);
