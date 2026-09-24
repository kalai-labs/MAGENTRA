/**
 * `the-sessions-list-follows-the-live-session`.
 *
 * Field test 2026-09-23, finding U-07: the sidebar said "No saved
 * conversations" through the whole 56-minute run and after it, while the
 * session was on disk. The list had been asked for once, at 18:03, before the
 * first message.
 *
 * `ui`: the frames are delivered on the channel main delivers them on, and
 * what the page asked for is read back from each workspace's own log — main
 * writes every frame it sends an engine there, tagged with its tab.
 */

import { join } from "node:path";

import { framesWritten, openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "the-sessions-list-follows-the-live-session";

/** Verbatim from the record. */
const INVARIANT =
  "A session appears in its own tab's Sessions list as soon as its first turn starts, and the list is refreshed when a turn ends.";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

abstract class SessionListTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected workspace(tag: string): string {
    const dir = this.makeTempDir(`magentra-sl-${tag}-`);
    this.writeJsonFile(join(dir, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: `model-${tag}` });
    return dir;
  }

  protected async send(app: AppHandle, frames: Record<string, unknown>[]): Promise<void> {
    await app.evaluateInMain(`for (const f of ${JSON.stringify(frames)}) win.webContents.send("engine:event", f); return true;`);
  }

  /** list_sessions frames the app wrote to `workspace`'s engine, once the count has settled. */
  protected async settledAsks(workspace: string): Promise<number> {
    let last = -1;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const now = framesWritten(workspace, "list_sessions").length;
      if (now === last) return now;
      last = now;
    }
  }

  /** Wait until `workspace`'s log shows `count` list_sessions frames. */
  protected async asksReach(workspace: string, count: number): Promise<number> {
    const deadline = Date.now() + 15_000;
    let seen = 0;
    while (Date.now() < deadline) {
      seen = framesWritten(workspace, "list_sessions").length;
      if (seen >= count) return seen;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return seen;
  }
}

class ATurnAsksForTheList extends SessionListTest {
  readonly id = "a-turn-asks-for-the-list-when-it-starts-and-when-it-ends";
  readonly whyItExists =
    "the list was asked for once, before the first message, so the live session never appeared during its own 56-minute first turn";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-sl-home-");
    const workspace = this.workspace("a");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    const tabId = await this.waitFor<string>(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the tab id");
    const before = await this.settledAsks(workspace);

    await this.send(app, [{ type: "turn_started", turnId: "t_1", tabId }]);
    t.assert.equal(await this.asksReach(workspace, before + 1), before + 1, "the first message put a session on disk, so the start of the turn asks for the list");

    await this.send(app, [{ type: "turn_finished", turnId: "t_1", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, contextTokens: 0, tabId }]);
    t.assert.equal(await this.asksReach(workspace, before + 2), before + 2, "and its end asks again");
  }
}

class ABackgroundTabAsksForItsOwn extends SessionListTest {
  readonly id = "a-background-tabs-turn-asks-its-own-engine-and-not-the-focused-one";
  readonly whyItExists =
    "a refresh sent without a tab goes to whichever tab is focused, so a background tab's session would never appear in its own list and the focused one would be asked for nothing";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-sl-home-");
    const first = this.workspace("a");
    const second = this.workspace("b");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, first);
    await waitForSpawn(first);
    const firstTab = await this.waitFor<string>(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the first tab");
    await openWorkspace(app, second);
    await waitForSpawn(second);
    await this.waitFor(app, `focusedTabId && focusedTabId !== ${JSON.stringify(firstTab)} ? true : null`, "the second tab to take focus");

    const firstBefore = await this.settledAsks(first);
    const secondBefore = await this.settledAsks(second);
    await this.send(app, [{ type: "turn_started", turnId: "t_1", tabId: firstTab }]);

    t.assert.equal(await this.asksReach(first, firstBefore + 1), firstBefore + 1, "the background tab's own engine is asked");
    t.assert.equal(await this.settledAsks(second), secondBefore, "and the focused tab's engine is not");

    // Its answer stays in its own tab: the focused sidebar never shows it.
    await app.evaluateInMain(`win.webContents.send("engine:event", ${JSON.stringify({
      type: "session_list",
      sessions: [{ id: "s_background_only", createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", messageCount: 1, firstUserMessage: "from the other tab" }],
      tabId: firstTab,
    })}); return true;`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const focusedShows = await app.evaluate<boolean>(`document.body.textContent.includes("from the other tab")`);
    t.assert.equal(focusedShows, false, "a background tab's session list is not painted into the focused tab's chrome");
    const kept = await app.evaluate<boolean>(`tabs.get(${JSON.stringify(firstTab)}).sessionSummaries.some((s) => s.id === "s_background_only")`);
    t.assert.equal(kept, true, "it is kept in that tab's own state, for when it is focused");
  }
}

registerFeatureTests(new ATurnAsksForTheList(), new ABackgroundTabAsksForItsOwn());
