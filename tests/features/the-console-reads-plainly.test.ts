/**
 * `the-console-reads-plainly`.
 *
 * Field test 2026-09-23, findings U-06, U-08, U-09: "I still see all outputs
 * at reasoning part"; HTTP 429 retries up to attempt 4 that never reached the
 * screen; a horizontal scroll bar under the conversation; and a model field
 * that read "accounts/fireworks/models/" over a preset list saying "Custom…".
 *
 * `ui`: every frame goes through `win.webContents.send("engine:event", …)`,
 * the call main makes per engine line, and every figure is a real DOM
 * measurement of the running page.
 */

import { join } from "node:path";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "the-console-reads-plainly";

/** Verbatim from the record. */
const INVARIANT =
  "The console keeps reasoning collapsed and apart from progress, shows retries, never scrolls sideways, and names the model by its own name.";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";
const FIELD_MODEL = "accounts/fireworks/models/glm-5p3";

abstract class ConsoleTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected workspace(tag: string, model = `model-${tag}`): string {
    const dir = this.makeTempDir(`magentra-plain-${tag}-`);
    this.writeJsonFile(join(dir, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model });
    return dir;
  }

  protected async console(model?: string): Promise<{ app: AppHandle; tabId: string }> {
    const home = this.makeTempDir("magentra-plain-home-");
    const workspace = this.workspace("a", model);
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    const tabId = await this.waitFor<string>(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the tab id");
    return { app, tabId };
  }

  protected async send(app: AppHandle, frames: Record<string, unknown>[], tabId: string): Promise<void> {
    await app.evaluateInMain(`for (const f of ${JSON.stringify(frames.map((f) => ({ ...f, tabId })))}) win.webContents.send("engine:event", f); return true;`);
  }
}

/* ---- checklist 1: U-06 ----------------------------------------------- */

class ReasoningStaysApart extends ConsoleTest {
  readonly id = "live-reasoning-is-collapsed-and-the-tool-row-and-answer-sit-outside-it";
  readonly whyItExists =
    "a reasoning block that opened itself, or that swallowed the tool rows after it, would make progress and drafting look the same — the owner's 'I still see all outputs at reasoning part'";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    await this.send(app, [
      { type: "turn_started", turnId: "t_1" },
      { type: "thinking_delta", text: "drafting the whole renderer here…" },
      { type: "tool_call_started", id: "c1", tool: "Write", input: { file_path: "Renderer.js" }, description: "Write Renderer.js" },
      { type: "text_delta", text: "Wrote the renderer.\n\n" },
    ], tabId);
    const shape = await this.waitFor<{ open: boolean; rowInside: boolean; answerInside: boolean }>(
      app,
      `(() => {
        const block = streamEl.querySelector(".msg-thinking");
        const row = streamEl.querySelector(".tool-row");
        const answer = streamEl.querySelector(".msg-assistant");
        if (!block || !row || !answer) return null;
        return { open: block.open, rowInside: block.contains(row), answerInside: block.contains(answer) };
      })()`,
      "the block, the row and the answer",
    );
    t.assert.equal(shape.open, false, "reasoning is collapsed by default");
    t.assert.equal(shape.rowInside, false, "the tool row is its own item, outside the reasoning");
    t.assert.equal(shape.answerInside, false, "and so is the answer");
  }
}

/* ---- checklist 2: U-08 ----------------------------------------------- */

class RetriesAreShown extends ConsoleTest {
  readonly id = "a-provider-retry-is-announced-on-the-now-line-in-one-console-and-in-a-pane";
  readonly whyItExists =
    "HTTP 429 retries up to attempt 4 with 7.5 s backoffs looked like a frozen spinner — the engine said why it waited and the screen never did";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    const retry = { type: "retry_status", attempt: 3, delayMs: 3_000, reason: "rate limited (HTTP 429)" };
    await this.send(app, [{ type: "turn_started", turnId: "t_1" }, retry], tabId);
    const single = await app.evaluate<string>(`nowTextEl.textContent`);
    t.assert.equal(single, "rate limited (HTTP 429) — retrying in 3s (attempt 3)", "the reason, the wait and the attempt are all on the strip");

    // Tiled: the same frame for a background pane shows on that pane's own strip.
    const second = this.workspace("b");
    await openWorkspace(app, second);
    await waitForSpawn(second);
    await this.waitFor(app, `tabs.size === 2 ? true : null`, "two tiled consoles");
    await this.send(app, [retry], tabId);
    const pane = await this.waitFor<string>(
      app,
      `(() => { const ts = tabs.get(${JSON.stringify(tabId)}); const el = ts && ts.paneEl && ts.paneEl.querySelector(".pane-now-text"); return el && el.textContent.includes("retrying") ? el.textContent : null; })()`,
      "the pane's now-line",
    );
    t.assert.match(pane, /rate limited \(HTTP 429\) — retrying in 3s \(attempt 3\)/, "a tiled pane shows it on its own strip");

    // The notice is a moment, not a state: it clears from THAT pane after its
    // four seconds, although another tab's state is the live one by then.
    const cleared = await this.waitFor<boolean>(
      app,
      `(() => { const ts = tabs.get(${JSON.stringify(tabId)}); const el = ts && ts.paneEl && ts.paneEl.querySelector(".pane-now-text"); return ts && ts.nowOverrideText === null && el && !el.textContent.includes("retrying") ? true : null; })()`,
      "the background pane's retry notice to clear",
    );
    t.assert.equal(cleared, true, "a background pane's retry notice does not stay for the rest of the turn");
  }
}

/* ---- checklist 3: U-09 scroll ------------------------------------------ */

class NoSidewaysScroll extends ConsoleTest {
  readonly id = "a-long-unbroken-line-wraps-and-never-widens-the-transcript";
  readonly whyItExists =
    "one 600-character command_output line gave the transcript a scrollWidth of 3,753 against a clientWidth of 1,521 — the horizontal bar under the field run's conversation";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    const long = "x".repeat(600);
    await this.send(app, [
      { type: "command_output", text: long },
      { type: "error", message: long, fatal: false },
    ], tabId);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const size = await app.evaluate<{ scroll: number; client: number; notes: number }>(
      `(() => { const t = document.getElementById("transcript"); return { scroll: t.scrollWidth, client: t.clientWidth, notes: streamEl.querySelectorAll(".sys-note, .sys-error").length }; })()`,
    );
    t.assert.ok(size.notes >= 2, "both lines were drawn");
    t.assert.equal(size.scroll, size.client, `the transcript never scrolls sideways (scrollWidth ${size.scroll}, clientWidth ${size.client})`);
  }
}

/* ---- checklist 4: U-09 model label -------------------------------------- */

class TheModelByItsName extends ConsoleTest {
  readonly id = "the-picker-names-the-model-by-its-last-segment-with-the-full-id-on-hover";
  readonly whyItExists =
    "the picker read 'Custom…' over a 150 px box showing 'accounts/fireworks/models/' — the one part of the id that says nothing about the model";

  override async run(t: TestRun): Promise<void> {
    const { app } = await this.console(FIELD_MODEL);
    const picker = await this.waitFor<{ label: string; title: string; value: string; customHidden: boolean }>(
      app,
      `(() => {
        if (activeModel !== ${JSON.stringify(FIELD_MODEL)}) return null; // the configured model has been applied
        const s = document.getElementById("modelSelect");
        const o = s.options[s.selectedIndex];
        return { label: o ? o.textContent : "", title: o ? o.title : "", value: o ? o.value : "", customHidden: document.getElementById("customModel").classList.contains("hidden") };
      })()`,
      "the configured model to be selected",
    );
    t.assert.equal(picker.label, "glm-5p3", "the model's own name");
    t.assert.equal(picker.title, FIELD_MODEL, "with the full id on hover");
    t.assert.equal(picker.customHidden, true, "and no Custom box standing in for it");

    // A second tab on another endpoint: the shared picker offers ITS model,
    // not the first tab's — an option added for one tab is that tab's.
    const firstTab = await app.evaluate<string>(`focusedTabId`);
    const otherModel = "vendor/models/other-model";
    const second = this.workspace("b", otherModel);
    await openWorkspace(app, second);
    await waitForSpawn(second);
    const options = (): string => `Array.from(document.getElementById("modelSelect").options).map((o) => o.value)`;
    const onSecond = await this.waitFor<string[]>(
      app,
      `(() => focusedTabId !== ${JSON.stringify(firstTab)} && activeModel === ${JSON.stringify(otherModel)} ? ${options()} : null)()`,
      "the second tab's model in the picker",
    );
    t.assert.equal(onSecond.includes(otherModel), true, "the focused tab's model is offered");
    t.assert.equal(onSecond.includes(FIELD_MODEL), false, "and the other tab's model is not");
    await app.evaluate(`window.magentra.focusTab(${JSON.stringify(firstTab)}); true`);
    const onFirst = await this.waitFor<string[]>(
      app,
      `(() => focusedTabId === ${JSON.stringify(firstTab)} && document.getElementById("modelSelect").value === ${JSON.stringify(FIELD_MODEL)} ? ${options()} : null)()`,
      "the first tab's model back in the picker",
    );
    t.assert.equal(onFirst.includes(otherModel), false, "focusing back drops the second tab's model again");
  }
}

registerFeatureTests(new ReasoningStaysApart(), new RetriesAreShown(), new NoSidewaysScroll(), new TheModelByItsName());
