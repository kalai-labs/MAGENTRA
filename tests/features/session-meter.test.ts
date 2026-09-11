/**
 * `session-meter`.
 *
 * The context figure is the one number that tells a user whether their
 * conversation is about to be compacted. Adding this turn's output to it, or
 * accumulating it across turns, would show a figure that grows past the real
 * window — the user would watch a number climb toward a limit it had already
 * passed, and compaction would arrive as a surprise. So the renderer displays
 * what the engine reports and does no arithmetic of its own.
 *
 * `ui`: the meter is DOM driven by engine events, and `session.js` is a classic
 * script in the page's shared scope. The events below are delivered through
 * `handleEngineEvent`, which is the renderer's own front door for them.
 */

import { join } from "node:path";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "session-meter";

/** Verbatim from the record. */
const INVARIANT =
  "The session meter shows context now and this turn's output, never their sum.";

interface Meter {
  readonly hint: string;
  readonly hintHidden: boolean;
  readonly now: string;
  readonly nowHidden: boolean;
}

abstract class MeterTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected async console(): Promise<AppHandle> {
    const home = this.makeTempDir("magentra-meter-home-");
    const workspace = this.makeTempDir("magentra-meter-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "model-one",
    });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    return app;
  }

  /** Deliver an engine event through the renderer's own front door. */
  protected async deliver(app: AppHandle, event: Record<string, unknown>): Promise<void> {
    await app.evaluate(`handleEngineEvent(${JSON.stringify(event)}); true`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  protected async read(app: AppHandle): Promise<Meter> {
    return app.evaluate(`
      ({
        hint: (document.getElementById("hintUsage").textContent || "").trim(),
        hintHidden: document.getElementById("hintUsage").classList.contains("hidden"),
        now: (document.getElementById("nowTokens").textContent || "").trim(),
        nowHidden: document.getElementById("nowTokens").classList.contains("hidden"),
      })
    `);
  }
}

/* ---- checklist 1, 2 and 4 ---------------------------------------------- */

class TheFigureIsWhatTheEngineReported extends MeterTest {
  readonly id = "the-context-figure-is-the-engines-number-and-nothing-else";
  readonly whyItExists =
    "adding this turn's output to the context shows a number past the real window, so compaction arrives as a surprise to someone who was watching the meter";

  override async run(t: TestRun): Promise<void> {
    const app = await this.console();

    await this.deliver(app, { type: "context_update", contextTokens: 12_345 });
    const shown = await this.read(app);
    t.assert.equal(shown.hint, "ctx ~12k", "the hint shows the engine's figure, formatted");
    t.assert.equal(shown.hintHidden, false);

    // An update with no output figure must not invent one.
    await this.deliver(app, { type: "context_update", contextTokens: 10_000, outputTokens: 500 });
    const both = await this.read(app);
    t.assert.equal(both.hint, "ctx ~10k", "context is context");
    t.assert.match(both.now, /500/, "and this turn's output is reported on its own");
    t.assert.doesNotMatch(both.hint, /10\.5k/, "the two are never added together — that is the whole feature");

    // Checklist 4: the formatting boundaries, from the page's own function.
    const formatted = await app.evaluate<string[]>(
      `[formatTokens(9949), formatTokens(9950), formatTokens(999500), formatTokens(0)]`,
    );
    t.assert.deepEqual(formatted, ["9.9k", "10k", "1.0M", "0"], "the boundaries are what make the figure readable at every size");

    // And nothing to report is shown as nothing, not as "0".
    await this.deliver(app, { type: "context_update", contextTokens: 0 });
    t.assert.equal((await this.read(app)).hintHidden, true, "a context of zero is not a figure worth a line of chrome");
  }
}

/* ---- checklist 3 and 6 -------------------------------------------------- */

class TheFigureNeverAccumulates extends MeterTest {
  readonly id = "the-context-figure-never-accumulates-and-follows-a-compaction-down";
  readonly whyItExists =
    "summing contexts across turns makes the meter climb forever, and after a compaction — when the real figure drops sharply — it would still be reporting the old total";

  override async run(t: TestRun): Promise<void> {
    const app = await this.console();

    await this.deliver(app, { type: "context_update", contextTokens: 8_000 });
    await this.deliver(app, { type: "turn_started", turnId: "t1" });
    await this.deliver(app, { type: "context_update", contextTokens: 8_000 });
    t.assert.equal((await this.read(app)).hint, "ctx ~8.0k", "two turns at the same size is still that size, not twice it");

    // turn_started resets this turn's output without touching the context.
    await this.deliver(app, { type: "context_update", contextTokens: 8_000, outputTokens: 900 });
    await this.deliver(app, { type: "turn_started", turnId: "t2" });
    const fresh = await this.read(app);
    t.assert.equal(fresh.hint, "ctx ~8.0k", "a new turn does not change what is already in the window");
    // The COUNTER is what turn_started resets; the strip repaints on the next
    // figure the engine sends. Asserting the strip's text here was asserting
    // when a repaint happens, which is not what the feature claims.
    t.assert.equal(
      await app.evaluate<number>(`outputTokens`),
      0,
      "this turn's output counter starts at nothing — it is per turn, not per session",
    );
    await this.deliver(app, { type: "context_update", contextTokens: 8_000, outputTokens: 10 });
    t.assert.match((await this.read(app)).now, /10/, "and the strip follows the new turn's figure, not the old one");
    t.assert.doesNotMatch((await this.read(app)).now, /900/, "the previous turn's output is gone, not added to");

    // Checklist 6: a compaction reports a SMALLER context, and the meter must
    // follow it down rather than keeping the high-water mark.
    await this.deliver(app, { type: "context_update", contextTokens: 1_200 });
    t.assert.equal(
      (await this.read(app)).hint,
      "ctx ~1.2k",
      "after a compaction the figure drops, because the figure is whatever the engine last reported",
    );
  }
}

/* ---- checklist 5 -------------------------------------------------------- */

class TheTopBarSumsOnlyWhenTiled extends MeterTest {
  readonly id = "the-top-bar-meter-sums-open-consoles-and-only-when-tiled";
  readonly whyItExists =
    "with one console the top-bar sum is the same number twice on one screen, and a meter that says the same thing in two places is one more thing to keep in step";

  override async run(t: TestRun): Promise<void> {
    const app = await this.console();

    // One console: the shared meter has nothing to add up, so it stays away.
    await this.deliver(app, { type: "context_update", contextTokens: 3_000 });
    t.assert.equal(
      await app.evaluate<boolean>(`document.getElementById("ctxMeter").classList.contains("hidden")`),
      true,
      "with a single console the top-bar meter is noise",
    );

    // Tiled, with two consoles carrying their own figures.
    const meter = await app.evaluate<{ hidden: boolean; value: string }>(`
      (() => {
        document.body.classList.add("tiled");
        for (const [id, state] of tabs) { state.contextTokens = id === [...tabs.keys()][0] ? 3000 : 5000; }
        if (tabs.size < 2) {
          // Only one console is open; give the sum a second one to add.
          tabs.set("test-second", { contextTokens: 5000 });
        }
        updateContextMeter();
        return {
          hidden: document.getElementById("ctxMeter").classList.contains("hidden"),
          value: (document.getElementById("ctxMeterValue").textContent || "").trim(),
        };
      })()
    `);
    t.assert.equal(meter.hidden, false, "tiled consoles each hold their own context, so the total is worth showing");
    t.assert.match(meter.value, /8\.0k|8000/, `the total must be the sum of the open consoles, showed "${meter.value}"`);

    // Untiled again, it goes away.
    const untiled = await app.evaluate<boolean>(`
      (() => { document.body.classList.remove("tiled"); updateContextMeter(); return document.getElementById("ctxMeter").classList.contains("hidden"); })()
    `);
    t.assert.equal(untiled, true, "leaving the tiled view takes the shared meter with it");
  }
}

registerFeatureTests(new TheFigureIsWhatTheEngineReported(), new TheFigureNeverAccumulates(), new TheTopBarSumsOnlyWhenTiled());
