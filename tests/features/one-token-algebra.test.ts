/**
 * `one-token-algebra`.
 *
 * Every token quantity the app computes — window occupancy, per-class sums,
 * estimates, display rounding, free space — has exactly one definition, in
 * `engine/protocol/src/tokens.ts`, mirrored for the renderer (which cannot
 * import it) in `app/renderer/modules/tokens.js`. The failure this exists to
 * prevent is two surfaces deriving "tokens" independently and drifting: the
 * meter, the `/session` report and compaction then disagree about the same
 * session and the user has no way to tell which one is lying.
 *
 * `pure`, as the record declares, and every item stays there. Items 1–4 are
 * the functions themselves, each a function of its arguments. Item 5 is a
 * STATIC check over committed source text: it reads `engine/core/src`,
 * `engine/providers/src` and `app/renderer/modules` as data and asserts no
 * second definition exists. That is the same shape as this suite's existing
 * `pure` source checks (`mirror-token-algebra` evaluates the renderer's copy
 * read off disk; `tui-protocol-parity` runs the compiler), so no kind is
 * re-declared: reading committed source is not the feature's own I/O, and
 * `FsTest`'s temp workspace and redirectable HOME would buy nothing here.
 * Checked 2026-09-20.
 *
 * WHAT ITEM 5 CAN AND CANNOT SEE. A grep proves absence of a SECOND copy, not
 * presence of the right one, so each pattern is also asserted to still match
 * inside the two sanctioned files — otherwise a renamed constant would make
 * the search vacuously green. `app/renderer/modules/util.js` formats BYTES
 * with `toFixed(1)` ("1.5 KB"); the description's literal pattern
 * `toFixed(1)}M` does not match it, and this test keeps that literal rather
 * than widening it into a false positive.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  CHARS_PER_TOKEN,
  addUsage,
  contextPercentOf,
  emptyUsage,
  estimateTokens,
  formatTokens,
  freeContextOf,
  inputTokensOf,
  type Usage,
} from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "one-token-algebra";

/** Verbatim from the record. */
const INVARIANT = "Every token quantity in the system is defined exactly once here; no surface computes its own.";

abstract class AlgebraTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class DisplayRoundingIsOneLadder extends AlgebraTest {
  readonly id = "formattokens-rounds-on-one-ladder-and-never-renders-a-negative";
  readonly whyItExists =
    "a surface that rounded its own way printed '10.0k' where the report printed '10k' for the same count, and a negative count (a figure momentarily below a subtracted reserve) rendered as '-5' in the meter";

  override run(t: TestRun): void {
    const cases: [number, string][] = [
      [999, "999"],
      [1000, "1.0k"],
      [9949, "9.9k"],
      [9950, "10k"],
      [210_000, "210k"],
      [999_500, "1.0M"],
    ];
    for (const [n, expected] of cases) {
      t.assert.equal(formatTokens(n), expected, `formatTokens(${n})`);
    }
    t.assert.equal(formatTokens(-5), "0", "a negative count renders as 0, never with a minus sign");
    t.assert.equal(formatTokens(-1_000_000), "0", "and however negative it is");
    t.assert.equal(formatTokens(0), "0");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheEstimateIsCharactersOverKappa extends AlgebraTest {
  readonly id = "estimatetokens-is-ceil-chars-over-3-5-and-clamps-a-negative-count-to-zero";
  readonly whyItExists =
    "a caller that divided by 4 of its own accord under-counted, so the window overflowed the provider before compaction fired; and a negative character count (a length subtracted past zero) produced a negative estimate that was then added to a total";

  override run(t: TestRun): void {
    // 7 / 3.5 = 2 exactly. The constant is what makes that true, so it is
    // asserted here too rather than assumed.
    t.assert.equal(CHARS_PER_TOKEN, 3.5, "the characters-per-token constant");
    t.assert.equal(estimateTokens("abcdefg"), 2, "7 characters at 3.5 per token is 2 tokens");
    t.assert.equal(estimateTokens(7), 2, "a character COUNT is the same input as the string");
    t.assert.equal(estimateTokens(-5), 0, "a negative character count estimates to 0, never a negative token count");
    t.assert.equal(estimateTokens(""), 0);
    t.assert.equal(estimateTokens(8), 3, "the estimate rounds UP, so it over-counts rather than under-counts");
    t.assert.equal(estimateTokens(3500), 1000);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class OccupancyAndFreeSpaceAreTotal extends AlgebraTest {
  readonly id = "contextpercentof-and-freecontextof-are-defined-for-an-unknown-window-and-an-overfull-one";
  readonly whyItExists =
    "an endpoint with no declared window made the meter render 'Infinity%' (or 'NaN%'), and a context already past its reserve reported negative free space that a later subtraction turned into a larger figure than the window";

  override run(t: TestRun): void {
    t.assert.equal(contextPercentOf(50, 0), 0, "an unknown window is 0%, never Infinity or NaN");
    t.assert.equal(contextPercentOf(50, -1), 0, "and a nonsensical negative window too");
    t.assert.equal(contextPercentOf(0, 0), 0);
    t.assert.equal(contextPercentOf(50, 200), 25, "otherwise it is exactly 100 · context / window");
    t.assert.equal(contextPercentOf(200, 200), 100);

    t.assert.equal(freeContextOf(100, 80, 30), 0, "80 used with 30 reserved out of 100 is over budget: clamped to 0, not -10");
    t.assert.equal(freeContextOf(100, 40), 60, "with no reserve stated, free space is window minus context");
    t.assert.equal(freeContextOf(100, 40, 10), 50, "and the reserve is subtracted on top");
    t.assert.equal(freeContextOf(0, 0), 0);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheFourClassesSumSeparately extends AlgebraTest {
  readonly id = "addusage-sums-each-class-into-its-target-and-emptyusage-is-the-identity";
  readonly whyItExists =
    "a caller that collapsed the classes into one total lost the price — a cache read is about a tenth of an input token and a cache write costs more than one — so every cached session was misbilled, and a ledger that copied instead of accumulating in place silently dropped the parent's running total";

  override run(t: TestRun): void {
    t.assert.deepEqual(
      emptyUsage(),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      "emptyUsage is all four classes at zero",
    );
    t.assert.notEqual(emptyUsage(), emptyUsage(), "and a fresh object each call, so two ledgers cannot share one");

    const target: Usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    const add: Usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 };
    const returned = addUsage(target, add);
    t.assert.equal(returned, target, "addUsage returns the very object it accumulated into");
    t.assert.deepEqual(
      target,
      { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 },
      "each class sums with its own kind only — no class leaks into another",
    );
    t.assert.deepEqual(add, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }, "the addend is untouched");
    t.assert.deepEqual(addUsage(emptyUsage(), add), add, "adding onto zero is the identity, field by field");

    // The one derived quantity, stated here so the four classes cannot be
    // re-partitioned without this failing: the window is the three INPUT
    // classes, and output is not one of them.
    t.assert.equal(inputTokensOf(target), 11 + 33 + 44, "the window is fresh input + cache read + cache write");
    t.assert.equal(inputTokensOf({ inputTokens: 100, outputTokens: 999, cacheReadTokens: 300, cacheWriteTokens: 20 }), 420);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

/** The protocol module, and the renderer's mirror of it — the only two files allowed to define these. */
const SANCTIONED = [
  join("engine", "protocol", "src", "tokens.ts"),
  join("app", "renderer", "modules", "tokens.js"),
];

/** Every source file under `dir`, recursively, as repo-relative paths. */
function sourcesUnder(dir: string, extensions: readonly string[]): string[] {
  const root = repoRoot();
  const out: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(relative(root, child));
    }
  };
  walk(join(root, dir));
  return out.sort();
}

class NoSurfaceDefinesItsOwn extends AlgebraTest {
  readonly id = "no-second-chars-per-token-constant-or-k-m-formatter-exists-outside-the-two-sanctioned-files";
  readonly whyItExists =
    "the renderer once kept a pricing and rounding copy of its own, which drifted from the engine's; the drift is invisible until two numbers for one quantity appear side by side, so the only thing that catches it is refusing a second definition at all";

  override run(t: TestRun): void {
    const root = repoRoot();
    const files = [
      ...sourcesUnder(join("engine", "core", "src"), [".ts"]),
      ...sourcesUnder(join("engine", "providers", "src"), [".ts"]),
      ...sourcesUnder(join("app", "renderer", "modules"), [".js"]),
    ];
    t.assert.ok(files.length > 50, `the scan found only ${files.length} files — it is looking in the wrong place`);

    const text = new Map<string, string>();
    for (const file of files) text.set(file, readFileSync(join(root, file), "utf8"));
    for (const file of SANCTIONED) {
      if (!text.has(file)) text.set(file, readFileSync(join(root, file), "utf8"));
    }

    /** Files outside the two sanctioned ones whose source contains `needle`. */
    const offenders = (needle: string): string[] =>
      [...text]
        .filter(([file, source]) => !SANCTIONED.includes(file) && source.includes(needle))
        .map(([file]) => file.split(sep).join("/"));

    // (a) The characters-per-token constant. Nothing may spell 3.5 for itself;
    // `session.ts` multiplies by the IMPORTED constant, which is the point.
    t.assert.deepEqual(offenders("3.5"), [], "a second characters-per-token constant exists");
    // (b) The k/M display ladder. `util.js` formats BYTES with toFixed(1) and a
    // space before KB/MB, so this literal cannot match it.
    t.assert.deepEqual(offenders("toFixed(1)}M"), [], "a second k/M token formatter exists");
    t.assert.deepEqual(offenders("CHARS_PER_TOKEN ="), [], "a second characters-per-token DEFINITION exists");

    // A search that matches nothing because the thing it looks for was renamed
    // is vacuous, so each pattern must still match inside the sanctioned files.
    for (const needle of ["3.5", "CHARS_PER_TOKEN ="]) {
      t.assert.ok(text.get(SANCTIONED[0]!)!.includes(needle), `${SANCTIONED[0]} no longer contains "${needle}" — the search above proves nothing`);
      t.assert.ok(text.get(SANCTIONED[1]!)!.includes(needle), `${SANCTIONED[1]} no longer contains "${needle}" — the search above proves nothing`);
    }
    t.assert.ok(text.get(SANCTIONED[1]!)!.includes("toFixed(1)}M"), "the renderer mirror no longer spells the M band this way");

    // And the consumers the record names really do import the algebra rather
    // than re-deriving it: absence of a copy plus presence of the import is
    // what "defined exactly once" means.
    const stats = text.get(join("engine", "core", "src", "runtime", "sessionStats.ts"))!;
    t.assert.match(stats, /from "@magentra\/protocol"/, "sessionStats imports the algebra");
    for (const name of ["addUsage", "contextPercentOf", "emptyUsage", "formatTokens", "freeContextOf", "inputTokensOf"]) {
      t.assert.ok(stats.includes(`  ${name},`), `sessionStats must import ${name} rather than re-derive it`);
    }
    const session = text.get(join("engine", "core", "src", "runtime", "session.ts"))!;
    for (const name of ["CHARS_PER_TOKEN", "addUsage", "estimateTokens", "formatTokens", "inputTokensOf"]) {
      t.assert.ok(session.includes(`  ${name},`), `session imports ${name} from the protocol`);
    }
  }
}

registerFeatureTests(
  new DisplayRoundingIsOneLadder(),
  new TheEstimateIsCharactersOverKappa(),
  new OccupancyAndFreeSpaceAreTotal(),
  new TheFourClassesSumSeparately(),
  new NoSurfaceDefinesItsOwn(),
);
