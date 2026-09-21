/**
 * What a real-model run cost, totalled across the whole run.
 *
 * WHY A REPORTER AND NOT A SUMMARY PRINTED BY THE TESTS. `node --test` runs
 * every FILE in its own process, so no test — and no `process.on("exit")` in
 * one — can see more than its own file's share. A reporter runs in the PARENT,
 * receives every child's events, and is therefore the only place a run-wide
 * figure can be assembled. It is the same constraint decisions/0011 measured
 * when the withheld-test banner turned into 109 copies of itself: anything a
 * test process prints, it prints once per file.
 *
 * WHERE THE NUMBERS COME FROM. Nothing here counts tokens. Each `llm` test
 * emits one `llm-usage` diagnostic summing its own `turn_finished.usage`, which
 * is the engine's own per-turn billed figure; this file parses those lines and
 * adds them up. There is no second accounting to drift from the engine's.
 *
 * COST IS SHOWN ONLY WHEN THE RATE CARD KNOWS THE MODEL, which is the rule
 * `config/pricing.ts` already states for itself: "A model absent from this
 * table simply has no cost estimate — counts are still reported." A guessed
 * price on a test run is worse than no price, because it is the kind of number
 * people quote later.
 *
 * It adds output and never replaces it: `test:llm` runs the `spec` reporter
 * alongside this one, so the ordinary pass/fail stream is untouched.
 */

import { pricingFor } from "@magentra/core";

/** `llm-usage feature=x in=1 out=2 cacheRead=3 cacheWrite=4 turns=5 model=y` */
const USAGE_LINE = /^llm-usage (feature=\S+ .*)$/;

function parse(message) {
  const match = USAGE_LINE.exec(message);
  if (!match) return undefined;
  const fields = {};
  for (const pair of match[1].split(" ")) {
    const eq = pair.indexOf("=");
    if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return {
    feature: fields.feature ?? "unknown",
    inputTokens: Number(fields.in ?? 0),
    outputTokens: Number(fields.out ?? 0),
    cacheReadTokens: Number(fields.cacheRead ?? 0),
    cacheWriteTokens: Number(fields.cacheWrite ?? 0),
    turns: Number(fields.turns ?? 0),
    model: fields.model ?? "unknown",
  };
}

const n = (value) => value.toLocaleString("en-US");

/** $/1M tokens against the engine's own rate card, or undefined when it has no entry. */
function costOf(model, totals) {
  const rate = pricingFor(model);
  if (rate === undefined) return undefined;
  const per = (tokens, dollarsPerMillion) => (tokens / 1_000_000) * dollarsPerMillion;
  return (
    per(totals.inputTokens, rate.input) +
    per(totals.outputTokens, rate.output) +
    per(totals.cacheReadTokens, rate.cacheRead ?? rate.input) +
    per(totals.cacheWriteTokens, rate.cacheWrite ?? rate.input)
  );
}

export default async function* llmUsageReporter(source) {
  const byFeature = new Map();
  const models = new Set();
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, tests: 0 };

  for await (const event of source) {
    if (event.type !== "test:diagnostic") continue;
    const usage = parse(event.data.message ?? "");
    if (usage === undefined) continue;

    // The feature comes from the LINE, not from `event.data.file`: a
    // diagnostic reports the file it was emitted from, and these all come out
    // of the registrar in `featureTest.ts`. Measured — the first run of this
    // reporter put all six tests in one row called "featureTest.ts".
    const feature = usage.feature;

    const row = byFeature.get(feature) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, tests: 0 };
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "turns"]) {
      row[key] += usage[key];
      total[key] += usage[key];
    }
    row.tests += 1;
    total.tests += 1;
    byFeature.set(feature, row);
    models.add(usage.model);
  }

  if (total.tests === 0) return; // not a real-model run — say nothing at all

  const lines = [
    "",
    "▸ real-model token usage — per-turn figures reported by the engine, summed",
    "",
    `  ${"feature".padEnd(32)}${"tests".padStart(6)}${"turns".padStart(7)}${"in".padStart(12)}${"out".padStart(10)}${"cache rd".padStart(12)}${"cache wr".padStart(11)}`,
    `  ${"─".repeat(32 + 6 + 7 + 12 + 10 + 12 + 11)}`,
  ];
  for (const [feature, row] of [...byFeature].sort((a, b) => b[1].outputTokens - a[1].outputTokens)) {
    lines.push(
      `  ${feature.padEnd(32)}${String(row.tests).padStart(6)}${String(row.turns).padStart(7)}` +
        `${n(row.inputTokens).padStart(12)}${n(row.outputTokens).padStart(10)}` +
        `${n(row.cacheReadTokens).padStart(12)}${n(row.cacheWriteTokens).padStart(11)}`,
    );
  }
  lines.push(
    `  ${"─".repeat(32 + 6 + 7 + 12 + 10 + 12 + 11)}`,
    `  ${"TOTAL".padEnd(32)}${String(total.tests).padStart(6)}${String(total.turns).padStart(7)}` +
      `${n(total.inputTokens).padStart(12)}${n(total.outputTokens).padStart(10)}` +
      `${n(total.cacheReadTokens).padStart(12)}${n(total.cacheWriteTokens).padStart(11)}`,
    "",
  );

  // Every `llm` test that booted a session has a row, zeros included, so this
  // count matches the run's pass/fail count instead of quietly omitting the
  // tests that never ran a turn.
  const billed = total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens;
  lines.push(`  ${n(billed)} tokens billed across ${total.turns} turns on ${[...models].join(", ")}`);

  const cost = models.size === 1 ? costOf([...models][0], total) : undefined;
  lines.push(
    cost === undefined
      ? "  no cost estimate: this model is not in the engine's rate card (settings.pricing can add one)"
      : `  estimated cost: $${cost.toFixed(4)}`,
  );
  lines.push("");

  yield `${lines.join("\n")}\n`;
}
