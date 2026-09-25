/**
 * `consecutive-tool-calls-are-grouped`.
 *
 * Field run 2026-09-25 (t11, ember-1/kimi-k3, a from-scratch Asteroids
 * build): a single autonomous session ran 114 tool calls, most of them Bash,
 * often a dozen in a row — the transcript read as an unbroken wall of rows,
 * each one no more informative on its own than the last. The owner's verdict:
 * "still spams reasoning or job call... spam is not good we shall group them
 * up." A lone call (one Read, one Edit) is still exactly as informative as
 * before and stays bare; only a genuine run of the SAME tool, back to back,
 * collapses — into a count that opens to the calls it stands for.
 *
 * `ui`: every frame goes through `win.webContents.send("engine:event", …)`,
 * the call main makes per engine line, and every figure is a real DOM
 * measurement of the running page.
 */

import { join } from "node:path";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "consecutive-tool-calls-are-grouped";

/** Verbatim from the record. */
const INVARIANT =
  "A run of consecutive calls to the same tool collapses into one expandable count instead of one row per call; a lone call stays a bare row.";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

abstract class ConsoleTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected async console(): Promise<{ app: AppHandle; tabId: string }> {
    const home = this.makeTempDir("magentra-toolgroup-home-");
    const workspace = this.makeTempDir("magentra-toolgroup-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "model-one" });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    const tabId = await this.waitFor<string>(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the tab id");
    return { app, tabId };
  }

  protected async send(app: AppHandle, frames: Record<string, unknown>[], tabId: string): Promise<void> {
    await app.evaluateInMain(`for (const f of ${JSON.stringify(frames.map((f) => ({ ...f, tabId })))}) win.webContents.send("engine:event", f); return true;`);
  }

  /** A finished, non-erroring call — the two frames a real one always sends. */
  protected call(id: string, tool: string, description: string): Record<string, unknown>[] {
    return [
      { type: "tool_call_started", id, tool, description, input: {} },
      { type: "tool_call_finished", id, tool, resultPreview: "ok", isError: false },
    ];
  }
}

/* ---- checklist 1 ------------------------------------------------------- */

class ARunCollapsesIntoOneCount extends ConsoleTest {
  readonly id = "a-run-of-the-same-tool-collapses-into-one-count";
  readonly whyItExists =
    "a session that called Bash a dozen times in a row buried everything else under a dozen identical-looking rows; grouping them is the whole fix for the field run's 'spam' complaint";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    await this.send(app, [{ type: "turn_started", turnId: "t_1" }], tabId);
    await this.send(
      app,
      [...this.call("c1", "Bash", "npm test"), ...this.call("c2", "Bash", "npm run build"), ...this.call("c3", "Bash", "npm run lint")],
      tabId,
    );
    const shape = await this.waitFor<{ runs: number; label: string; rows: number; open: boolean }>(
      app,
      `(() => {
        const runs = [...streamEl.querySelectorAll(".tool-run")];
        if (runs.length !== 1) return null;
        const run = runs[0];
        const rows = run.querySelectorAll(".tool-row").length;
        if (rows !== 3) return null;
        return { runs: runs.length, label: run.querySelector(".tool-run-count").textContent, rows, open: run.open };
      })()`,
      "one collapsed run holding all three calls",
    );
    t.assert.equal(shape.runs, 1, "three consecutive Bash calls become one group, not three rows");
    t.assert.equal(shape.label, "3 × Bash", "the group names the tool and the count");
    t.assert.equal(shape.rows, 3, "every call is still there, inside the group");
    t.assert.equal(shape.open, false, "collapsed by default — the count is the point");
  }
}

/* ---- checklist 2 ------------------------------------------------------- */

class ALoneCallStaysBare extends ConsoleTest {
  readonly id = "a-lone-call-stays-a-bare-row";
  readonly whyItExists =
    "the ordinary case — one Read, one Edit, one Bash — must read exactly as it always has; grouping chrome only earns its place once a real run of repeats shows up";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    await this.send(app, [{ type: "turn_started", turnId: "t_1" }], tabId);
    await this.send(app, [...this.call("r1", "Read", "notes.md"), ...this.call("b1", "Bash", "ls"), ...this.call("e1", "Edit", "notes.md")], tabId);
    const shape = await this.waitFor<{ runs: number; rows: number }>(
      app,
      `(() => {
        const rows = streamEl.querySelectorAll(".tool-row").length;
        if (rows !== 3) return null;
        return { runs: streamEl.querySelectorAll(".tool-run").length, rows };
      })()`,
      "three distinct calls, none of them grouped",
    );
    t.assert.equal(shape.runs, 0, "three DIFFERENT tools never collapse into a count");
    t.assert.equal(shape.rows, 3, "each stays its own row");
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

class ADifferentToolBreaksTheRun extends ConsoleTest {
  readonly id = "a-different-tool-in-between-splits-the-run-in-two";
  readonly whyItExists =
    "grouping is about consecutive repeats, not a tool's overall popularity — two Bash calls either side of a Read must not silently merge into 'Bash ×4'";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    await this.send(app, [{ type: "turn_started", turnId: "t_1" }], tabId);
    await this.send(
      app,
      [...this.call("b1", "Bash", "one"), ...this.call("b2", "Bash", "two"), ...this.call("r1", "Read", "notes.md"), ...this.call("b3", "Bash", "three"), ...this.call("b4", "Bash", "four")],
      tabId,
    );
    const shape = await this.waitFor<{ labels: string[] }>(
      app,
      `(() => {
        const runs = [...streamEl.querySelectorAll(".tool-run")];
        if (runs.length !== 2) return null;
        return { labels: runs.map((r) => r.querySelector(".tool-run-count").textContent) };
      })()`,
      "two separate two-call groups",
    );
    t.assert.deepEqual(shape.labels, ["2 × Bash", "2 × Bash"], "the Read in the middle splits one run of four into two runs of two");
  }
}

registerFeatureTests(new ARunCollapsesIntoOneCount(), new ALoneCallStaysBare(), new ADifferentToolBreaksTheRun());
