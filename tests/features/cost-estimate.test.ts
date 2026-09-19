/**
 * `cost-estimate`.
 *
 * The four token classes bill at four different rates, so a model's rate card
 * holds four of them ($/1M tokens) and never collapses to "in/out" — a cache
 * read is roughly a tenth of a fresh input token and a cache write costs more
 * than one, so the shortcut misprices every cached conversation. A model with
 * no entry, in the built-in table or in the user's `settings.pricing`, has NO
 * rate card: `pricingFor` returns undefined and the engine shows nothing,
 * because an invented `$0.00` reads as a real (free) bill. The `/session`
 * report deliberately prints counts and no money at all.
 *
 * `pure` + `fs`, and the record said `pure`. Items 1, 2, 4 and 5 are
 * `pricingFor` and `SessionStats.format()`, both exported from
 * `@magentra/core` and both functions of their arguments — they stay `pure`.
 * Item 3 names `buildRateCard`, which is module-private in
 * `engine/core/src/runtime/engine.ts` (a plain `function`, not exported, and
 * not re-exported by the package): the only place its output is observable is
 * the `rateCard` the Engine ships in `session_started`, which needs a real
 * Engine on a real workspace. That one item is `fs`, on `lib/scriptedEngine.ts`.
 * Re-declared 2026-09-20.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { MODEL_PRICING, SessionStats, pricingFor, settingsSchema, type Settings } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "cost-estimate";

/** Verbatim from the record. */
const INVARIANT = "Four token classes bill at four rates, and no rate card means no cost shown — never a fabricated $0.00.";

abstract class PricingTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class NoEntryMeansNoRateCard extends PricingTest {
  readonly id = "pricingfor-returns-undefined-for-an-unpriced-model-and-the-table-entry-for-a-priced-one";
  readonly whyItExists =
    "a default of `{input: 0, output: 0}` for an unknown model turned 'we do not know what this costs' into '$0.00', which a user reads as a free session rather than as a missing rate card";

  override run(t: TestRun): void {
    t.assert.equal(pricingFor("no-such-model"), undefined, "an unknown model has no rate card at all — not a zeroed one");
    t.assert.equal(pricingFor(""), undefined);

    const glm = pricingFor("zai-org/GLM-5");
    t.assert.notEqual(glm, undefined, "a model in the built-in table has one");
    t.assert.equal(glm?.input, 0.6, "input, in dollars per million tokens");
    t.assert.equal(glm?.output, 2.08, "output bills at its own rate, several times input");
    t.assert.equal(glm?.cacheRead, 0.12, "and a cache read at a fraction of input — the reason the classes are separate");

    // A rate card is four OPTIONAL-tailed fields, not two: an entry that prices
    // only what it charges still answers for the other two by defaulting to
    // `input` at the point of use, and must not invent a number here.
    const oss = pricingFor("openai/gpt-oss-120b");
    t.assert.deepEqual(oss, { input: 0.039, output: 0.17 }, "an entry with no separate cache rates states only what it charges");
    t.assert.equal(oss?.cacheRead, undefined, "and does not fabricate a cache rate");
    t.assert.equal(oss?.cacheWrite, undefined);
    t.assert.ok(Object.keys(MODEL_PRICING).length > 0, "the built-in table is not empty");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheUsersEntryWins extends PricingTest {
  readonly id = "a-settings-pricing-entry-replaces-the-built-in-table-entry-for-that-model";
  readonly whyItExists =
    "a self-hosted or newly-released model could only be priced by editing the table and rebuilding; and when the override was merged into the built-in entry instead of replacing it, a user who priced a model with no caching kept the old cache rate underneath";

  override run(t: TestRun): void {
    const model = "zai-org/GLM-5";
    const settings = settingsSchema.parse({ pricing: { [model]: { input: 1, output: 2 } } }) as Settings;

    t.assert.deepEqual(pricingFor(model, settings), { input: 1, output: 2 }, "the user's entry is returned whole");
    t.assert.notEqual(pricingFor(model, settings)?.input, MODEL_PRICING[model]?.input, "and the table's rate is not what comes back");
    t.assert.equal(pricingFor(model, settings)?.cacheRead, undefined, "the table's cacheRead 0.12 does not survive underneath the override");
    t.assert.equal(pricingFor(model)?.cacheRead, 0.12, "the table itself is unchanged — the override is per lookup, not a mutation");

    // A model the table has never heard of becomes priceable without a code change.
    const local = settingsSchema.parse({ pricing: { "my-local-model": { input: 0, output: 0 } } }) as Settings;
    t.assert.deepEqual(pricingFor("my-local-model", local), { input: 0, output: 0 }, "a deliberately free local model is priced at zero BECAUSE the user said so");
    t.assert.equal(pricingFor("my-local-model"), undefined, "which is a different thing from having no rate card");

    // Settings that price nothing fall through to the table rather than hiding it.
    const empty = settingsSchema.parse({}) as Settings;
    t.assert.deepEqual(pricingFor(model, empty), MODEL_PRICING[model], "no user entry means the built-in one");
    t.assert.equal(pricingFor("no-such-model", empty), undefined);
  }
}

/* ---- checklist 3 — fs ------------------------------------------------ */

type RateCard = Extract<CoreEvent, { type: "session_started" }>["rateCard"];

class TheShippedCardHoldsOnlyPricedModels extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-rate-card-in-session-started-omits-unpriced-models-and-carries-a-cache-rate-only-when-one-is-defined";
  readonly whyItExists =
    "the frontend used to keep a pricing copy of its own, which drifted from the engine's; shipping the card instead only works if an unpriced model is ABSENT rather than present with zeros, and if an absent cache rate stays absent instead of arriving as 0 — which would price every cached token at nothing";

  override readonly timeoutMs: number = 90_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-pricing-");
    mkdirSync(join(workspace, ".magentra"), { recursive: true });

    const engine = await startScriptedEngine({
      workspace,
      turns: [],
      settings: {
        pricing: {
          // Priced by the user only: not in the built-in table at all.
          "test-local-plain": { input: 1, output: 2 },
          "test-local-cached": { input: 3, output: 4, cacheRead: 0.5, cacheWrite: 6 },
          // Priced by the user OVER a table entry that has a cacheRead.
          "moonshotai/Kimi-K2.5": { input: 9, output: 9 },
        },
      },
    });
    this.#engine = engine;

    const started = await engine.waitFor(
      (e): e is Extract<CoreEvent, { type: "session_started" }> => e.type === "session_started",
    );
    const card: RateCard = started.rateCard;

    // Omission, not zeroing: a model nobody priced is simply not in the card.
    t.assert.equal(card["no-such-model"], undefined, "an unpriced model is absent from the card");
    t.assert.equal(card["test-local-absent"], undefined);
    for (const model of Object.keys(card)) {
      t.assert.notEqual(
        pricingFor(model, engine.settings),
        undefined,
        `the card carries ${model}, which pricingFor does not price — the two must agree`,
      );
    }
    for (const model of Object.keys(MODEL_PRICING)) {
      t.assert.notEqual(card[model], undefined, `${model} is priced by the table and must be in the card`);
    }

    // Four rates, and the optional two present only when the entry defines them.
    t.assert.deepEqual(
      card["test-local-plain"],
      { input: 1, output: 2, contextWindow: 128_000 },
      "an entry with no cache rates ships neither key — not cacheRead: 0",
    );
    t.assert.ok(!("cacheRead" in (card["test-local-plain"] ?? {})), "the key itself is absent, so the frontend falls back to the input rate");
    t.assert.deepEqual(
      card["test-local-cached"],
      { input: 3, output: 4, cacheRead: 0.5, cacheWrite: 6, contextWindow: 128_000 },
      "and an entry that defines all four ships all four",
    );
    t.assert.deepEqual(
      card["zai-org/GLM-5"],
      { input: 0.6, output: 2.08, cacheRead: 0.12, contextWindow: 128_000 },
      "a table entry with a cacheRead and no cacheWrite ships exactly that",
    );
    t.assert.deepEqual(
      card["moonshotai/Kimi-K2.5"],
      { input: 9, output: 9, contextWindow: 128_000 },
      "the user's entry replaces the table's — the table's cacheRead 0.07 is not left underneath",
    );

    // The card describes MODELS, so the session's own context-window override
    // (the fixture pins 200k) must not leak into it.
    t.assert.equal(engine.settings.contextWindow, 200_000, "the session really does have a window override");
    for (const [model, entry] of Object.entries(card)) {
      t.assert.equal(entry.contextWindow, 128_000, `${model}: the card ships the model's intrinsic window, not the session's override`);
    }
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheReportPrintsFourClassesAndNoMoney extends PricingTest {
  readonly id = "the-session-report-prints-all-four-token-classes-per-model-and-not-one-dollar-sign";
  readonly whyItExists =
    "collapsing the per-model line to 'in/out' hid the cache split the whole rate card exists for, and any dollar figure printed beside counts we measure ourselves would be presented as a bill while our counting and the provider's can diverge";

  override run(t: TestRun): void {
    const stats = new SessionStats(1_000);
    // A model that IS priced, so a cost line would have had every number it
    // needed — and still none is printed.
    t.assert.notEqual(pricingFor("zai-org/GLM-5"), undefined, "the model is priced, so nothing but the decision stops a cost line");
    stats.recordResponse("explorer-model", { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 }, 1_000);
    stats.recordResponse("zai-org/GLM-5", { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 7890, cacheWriteTokens: 12 }, 4_000);

    const text = stats.format(undefined, 1_000 + 65_000);
    t.assert.equal(text.includes("$"), false, `the report must contain no dollar sign:\n${text}`);
    t.assert.equal(/\b0\.00\b/.test(text), false, "and no bare 0.00 standing in for one");

    // Four classes, per model, each labelled — so a collapsed "in/out" line fails.
    t.assert.match(
      text,
      /zai-org\/GLM-5:\s+1\.2k input, 56 output, 7\.9k cache read, 12 cache write/,
      `the priced model's four classes, in tokens:\n${text}`,
    );
    t.assert.match(text, /explorer-model:\s+5 input, 6 output, 7 cache read, 8 cache write/, "and every model gets its own line");
    for (const label of ["input", "output", "cache read", "cache write"]) {
      t.assert.ok(text.includes(label), `the report names the "${label}" class`);
    }

    // The context line is the point-in-time window, labelled as such — not a total.
    t.assert.match(text, /Current context:\s+9\.1k tokens \(input of the last request\)/, "the window is the LAST request's input");
    t.assert.match(text, /Total duration \(API\):\s+5s/);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AnEmptySessionSaysSoRatherThanCostingZero extends PricingTest {
  readonly id = "a-session-with-no-model-calls-says-no-model-calls-yet-and-prints-no-amount";
  readonly whyItExists =
    "a session that had not called a model yet rendered its empty ledger as a priced total, so '$0.00' appeared before anything had happened and was indistinguishable from a real free session";

  override run(t: TestRun): void {
    const text = new SessionStats(1_000).format(undefined, 1_000);
    t.assert.ok(text.includes("(no model calls yet)"), `an empty ledger says so in words:\n${text}`);
    t.assert.equal(text.includes("$"), false, "and prints no amount at all");
    t.assert.equal(/\d+\.\d\d\b/.test(text), false, "nothing that reads as a currency amount either");
    t.assert.equal(text.includes("Usage by model (cumulative"), false, "and no empty per-model table");

    // The window is honestly reported as an estimate, not as a measured zero.
    t.assert.match(text, /Current context:\s+~0 tokens \(input of the last request, estimated — no response measured yet\)/);
  }
}

registerFeatureTests(
  new NoEntryMeansNoRateCard(),
  new TheUsersEntryWins(),
  new TheShippedCardHoldsOnlyPricedModels(),
  new TheReportPrintsFourClassesAndNoMoney(),
  new AnEmptySessionSaysSoRatherThanCostingZero(),
);
