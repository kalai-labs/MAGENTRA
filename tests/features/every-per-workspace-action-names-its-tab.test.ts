/**
 * `every-per-workspace-action-names-its-tab`.
 *
 * With several workspaces tiled, acting on "the focused one" silently changed a
 * different workspace's connection. The user right-clicked a row, chose SET
 * CONNECTION, saved — and another console was re-pointed. So every per-workspace
 * action carries the id of the tab it was invoked from, and the main process
 * acts on THAT tab's workspace; falling back to the focused tab is only for the
 * single-console case where there is nothing else it could mean.
 *
 * `ui`. The proof is two real workspaces and the files on disk afterwards: the
 * one that was named changed, and the one that was focused did not.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openWorkspace, saveProfile, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "every-per-workspace-action-names-its-tab";

/** Verbatim from the record. */
const INVARIANT = "Connect, vision and the attach picker act on the tab they were opened from, never on whatever is focused.";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

interface TwoWorkspaces {
  readonly app: AppHandle;
  readonly first: string;
  readonly second: string;
  readonly firstTab: string;
  readonly secondTab: string;
}

abstract class TabScopedTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Two consoles, the SECOND focused — so "the focused one" is the wrong answer. */
  protected async twoConsoles(): Promise<TwoWorkspaces> {
    const home = this.makeTempDir("magentra-tabs-home-");
    const first = this.workspace("a");
    const second = this.workspace("b");

    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await app.evaluateInMain(`
      globalThis.__tabs = [];
      globalThis.__ipc = [];
      const realSend = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel, payload, ...rest) => {
        if (channel === "tab:opened") globalThis.__tabs.push(payload);
        return realSend(channel, payload, ...rest);
      };
      return true;
    `);

    await openWorkspace(app, first);
    await waitForSpawn(first);
    await openWorkspace(app, second);
    await waitForSpawn(second);

    const tabs = await app.evaluateInMain<{ tabId: string; workspace: string }[]>("return globalThis.__tabs;");
    const firstTab = tabs.find((tab) => tab.workspace === first)?.tabId ?? "";
    const secondTab = tabs.find((tab) => tab.workspace === second)?.tabId ?? "";
    if (!firstTab || !secondTab) throw new Error(`both workspaces must have tabs; saw ${JSON.stringify(tabs)}`);
    return { app, first, second, firstTab, secondTab };
  }

  /**
   * A configured workspace, WITH a vision model.
   *
   * `settings:setVision` refuses a workspace whose connection names none — "add
   * one to its profile in the connection wizard" — which is correct, and which
   * made the first version of this fixture prove nothing: the toggle was
   * rejected before it could land anywhere.
   */
  protected workspace(model: string): string {
    const dir = this.makeTempDir(`magentra-ws-${model}-`);
    this.writeJsonFile(join(dir, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: LOCAL_ENDPOINT,
      model: `model-${model}`,
      visionConnection: { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: `vision-${model}` },
    });
    return dir;
  }

  protected settingsOf(workspace: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(workspace, ".magentra", "settings.json"), "utf8")) as Record<string, unknown>;
  }
}

/* ---- checklist 1 and 2 ------------------------------------------------- */

class TheWizardActsOnTheRowItWasOpenedFrom extends TabScopedTest {
  readonly id = "connecting-from-a-background-row-changes-that-workspace";
  readonly whyItExists =
    "the user right-clicks the workspace they mean, and before this the save landed on whichever console happened to be focused — silently, in a different folder";

  override async run(t: TestRun): Promise<void> {
    const { app, first, second, firstTab } = await this.twoConsoles();

    // The BACKGROUND row: `first` was opened first, so `second` is focused.
    const targeted = await app.evaluate<string | null>(`
      (() => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        try {
          appendConnectionCtxItems(host, ${JSON.stringify(firstTab)});
          [...host.querySelectorAll("button, .ctx-item")].find((el) => /SET CONNECTION/i.test(el.textContent || "")).click();
          return typeof wizTargetTabId === "undefined" ? null : wizTargetTabId;
        } finally {
          host.remove();
        }
      })()
    `);
    t.assert.equal(targeted, firstTab, "the wizard must be aimed at the row it was opened from");

    // SAVE & CONNECT then applies to that tab — through the real IPC.
    const id = await saveProfile(app, {
      name: "for-the-background-tab",
      provider: "openai-compat",
      baseUrl: LOCAL_ENDPOINT,
      model: "model-applied",
      apiKey: "sk-background",
    });
    const applied = await app.evaluate<{ ok?: boolean; error?: string }>(
      `window.magentra.applyProfile(${JSON.stringify(id)}, ${JSON.stringify(firstTab)})`,
    );
    t.assert.equal(applied.ok, true, `applying must succeed: ${String(applied.error)}`);

    // Checklist 2: the named workspace changed, and the focused one did not.
    t.assert.equal(this.settingsOf(first)["model"], "model-applied", "the tab that was named is the one that changed");
    t.assert.equal(this.settingsOf(second)["model"], "model-b", "the focused workspace must be untouched — it was never asked about");
    t.assert.match(readFileSync(join(first, ".env"), "utf8"), /sk-background/, "the key goes to the named workspace");
    t.assert.equal(existsSync(join(second, ".env")), false, "and nowhere near the other one");
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

class VisionFlipsOnTheNamedTab extends TabScopedTest {
  readonly id = "the-vision-toggle-flips-the-named-workspace-only";
  readonly whyItExists =
    "switching vision on for the workspace you are looking at, and having it land on another, is a change nobody can see until an image is described by the wrong endpoint";

  override async run(t: TestRun): Promise<void> {
    const { app, first, second, firstTab } = await this.twoConsoles();

    // Both start without vision switched on; the background tab is the one named.
    t.assert.notEqual(this.settingsOf(first)["vision"], true);
    t.assert.notEqual(this.settingsOf(second)["vision"], true);

    await app.evaluate(`window.magentra.setVision(true, ${JSON.stringify(firstTab)})`);
    await new Promise((resolve) => setTimeout(resolve, 800));

    t.assert.equal(this.settingsOf(first)["vision"], true, "the named workspace is the one that changes");
    t.assert.notEqual(this.settingsOf(second)["vision"], true, "the focused one must be left alone");

    // And back off again, still on the named tab.
    await app.evaluate(`window.magentra.setVision(false, ${JSON.stringify(firstTab)})`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    t.assert.notEqual(this.settingsOf(first)["vision"], true, "the toggle is a toggle, on the same tab both ways");

    // And a workspace with no vision model refuses the toggle rather than
    // writing a flag with nothing behind it.
    const noVision = this.makeTempDir("magentra-ws-novision-");
    this.writeJsonFile(join(noVision, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "m" });
    await openWorkspace(app, noVision);
    const refused = await app.evaluate<{ ok?: boolean; error?: string }>(`window.magentra.setVision(true)`);
    t.assert.equal(refused.ok, false, "vision cannot be switched on where there is no vision model");
    t.assert.match(String(refused.error), /vision model/i, "and the refusal must say what is missing");
    t.assert.notEqual(this.settingsOf(noVision)["vision"], true, "nothing may be written for a refused toggle");

  }
}

/* ---- checklist 5 ------------------------------------------------------- */

class WithoutATabTheFocusedOneIsMeant extends TabScopedTest {
  readonly id = "an-action-with-no-tab-named-falls-back-to-the-focused-one";
  readonly whyItExists =
    "the single-console top bar has no tab to name, and if the fallback were dropped those actions would reach no workspace at all";

  override async run(t: TestRun): Promise<void> {
    const { app, first, second } = await this.twoConsoles();

    // No tabId: the focused console — the one opened last — is what is meant.
    await app.evaluate(`window.magentra.setVision(true)`);
    await new Promise((resolve) => setTimeout(resolve, 800));

    t.assert.equal(this.settingsOf(second)["vision"], true, "with no tab named, the focused console is the one meant");
    t.assert.notEqual(this.settingsOf(first)["vision"], true, "and the background one is still not guessed at");
  }
}

registerFeatureTests(new TheWizardActsOnTheRowItWasOpenedFrom(), new VisionFlipsOnTheNamedTab(), new WithoutATabTheFocusedOneIsMeant());
