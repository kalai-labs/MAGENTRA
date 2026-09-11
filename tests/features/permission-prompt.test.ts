/**
 * `permission-prompt`.
 *
 * A tool that needs approval blocks the engine until someone answers. If the
 * prompt never appears, the engine waits forever; if the answer reaches the
 * wrong workspace's engine, one console approves another console's command. So
 * the feature is a queue — one card at a time, in arrival order — and a
 * response routed back to the engine that asked.
 *
 * `ui`. The record also said `llm`, and that is what a request would take to
 * ARRIVE naturally: a model deciding to call a tool. But nothing in the
 * checklist is about the model. What is under test is the renderer's queue and
 * main's routing, and a `permission_request` is delivered on exactly the
 * channel `app/main.js` delivers it on — `webContents.send("engine:event", …)`,
 * the same call, with the same frame. Spending a real model call to produce a
 * frame this test then has to assert about would make the test slower, dearer
 * and non-deterministic, and would prove nothing extra about the queue.
 *
 * The RESPONSE half is not simulated at all: the click goes through the
 * product's own button, its own preload call, its own ipcMain handler, and is
 * read back out of the engine's stdin log.
 */

import { join } from "node:path";

import { logLines, openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "permission-prompt";

/** Verbatim from the record. */
const INVARIANT = "A permission request reaches the user, the decision returns to the right tab's engine, and the queue drains in order.";

/** Keyless and local, so the workspace is configured and its engine starts. */
const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

abstract class PermissionTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected configuredWorkspace(): string {
    const workspace = this.makeTempDir("magentra-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: LOCAL_ENDPOINT,
      model: "model-one",
    });
    return workspace;
  }

  /**
   * Record every `tab:opened` main sends, so a test can name a tab that is not
   * the focused one. The ids are the product's own; nothing here invents them.
   */
  protected async watchTabs(app: AppHandle): Promise<void> {
    await app.evaluateInMain("globalThis.__tabs = []; return true;");
    await this.watchIpc(app);
  }

  /** The tab main opened for `workspace`. */
  protected async tabFor(app: AppHandle, workspace: string): Promise<string> {
    const tabs = await app.evaluateInMain<{ tabId: string; workspace: string }[]>("return globalThis.__tabs;");
    const found = tabs.find((tab) => tab.workspace === workspace);
    if (found === undefined) throw new Error(`no tab was opened for ${workspace}; saw ${JSON.stringify(tabs)}`);
    return found.tabId;
  }

  /**
   * Deliver a `permission_request` the way the main process delivers one.
   *
   * `app/main.js` pumps engine stdout frames to the renderer with
   * `sendToRenderer("engine:event", frame, tab.win)`; this is that call, with
   * that frame. Nothing in the renderer can tell the difference, which is the
   * point — the renderer is what is under test.
   */
  protected async deliver(app: AppHandle, frame: Record<string, unknown>): Promise<void> {
    await app.evaluateInMain(`win.webContents.send("engine:event", ${JSON.stringify(frame)}); return true;`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  /**
   * What the approval card is showing, if anything.
   *
   * There are TWO presentations and the product chooses between them: the
   * shared modal in the single-console view, and an in-pane approval when the
   * consoles are tiled — because with several workspaces open, every screen
   * answers its own. A test that only knew about the modal reported "no card"
   * the moment a second workspace was opened, which is precisely the case
   * checklist 1 is about.
   */
  protected async card(app: AppHandle): Promise<{ open: boolean; subject: string; alwaysShown: boolean; note: string; where: string }> {
    return app.evaluate(`
      (() => {
        const pane = [...document.querySelectorAll(".pane-approval")].find((el) => !el.classList.contains("hidden"));
        if (pane) {
          return {
            open: true,
            where: "pane",
            subject: (pane.querySelector(".pane-approval-subject")?.textContent || "").trim(),
            alwaysShown: !pane.querySelector(".pa-always")?.classList.contains("hidden"),
            note: pane.querySelector(".pane-approval-note")?.value || "",
          };
        }
        const modal = document.getElementById("deleteModal");
        return {
          open: !modal.classList.contains("hidden"),
          where: "modal",
          subject: (document.getElementById("deleteSubject").textContent || "").trim(),
          alwaysShown: !document.getElementById("allowAlwaysBtn").classList.contains("hidden"),
          note: document.getElementById("permissionNote").value || "",
        };
      })()
    `);
  }

  /** Wait for an engine event main forwarded to the renderer. */
  protected async waitForEvent(app: AppHandle, predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = await app.evaluateInMain<Record<string, unknown>[]>("return globalThis.__toRenderer;");
      const found = events.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`waited ${timeoutMs}ms; the renderer was sent ${events.length} engine events`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Answer whichever presentation is up, through the product's own buttons. */
  protected async decide(app: AppHandle, decision: "allow" | "deny" | "always", note?: string): Promise<void> {
    await app.evaluate(`
      (() => {
        const pane = [...document.querySelectorAll(".pane-approval")].find((el) => !el.classList.contains("hidden"));
        const noteText = ${JSON.stringify(note ?? "")};
        if (pane) {
          if (noteText) {
            const n = pane.querySelector(".pane-approval-note");
            n.value = noteText;
            n.dispatchEvent(new Event("input", { bubbles: true }));
          }
          pane.querySelector(${JSON.stringify({ allow: ".pa-allow", deny: ".pa-deny", always: ".pa-always" }[decision])}).click();
          return true;
        }
        if (noteText) {
          const n = document.getElementById("permissionNote");
          n.value = noteText;
          n.dispatchEvent(new Event("input", { bubbles: true }));
        }
        document.getElementById(${JSON.stringify({ allow: "allowBtn", deny: "denyBtn", always: "allowAlwaysBtn" }[decision])}).click();
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  /**
   * Capture what the renderer sends on `engine:permission`, and what main sends
   * back to the renderer.
   *
   * The black-box log cannot answer "which tab's engine got this": `logEvent`
   * writes to ONE file per app session — whichever workspace was opened last
   * owns it — so a frame written to a background tab's engine is logged under
   * the focused workspace. A test that read the log as if it were per-tab
   * concluded the product had misrouted when it had not. These two are the
   * seams that can actually answer the question.
   */
  protected async watchIpc(app: AppHandle): Promise<void> {
    await app.evaluateInMain(`
      globalThis.__sent = [];
      globalThis.__toRenderer = [];
      require("electron").ipcMain.on("engine:permission", (_e, payload) => globalThis.__sent.push(payload));
      const realSend = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel, payload, ...rest) => {
        if (channel === "tab:opened") globalThis.__tabs.push(payload);
        if (channel === "engine:event") globalThis.__toRenderer.push(payload);
        return realSend(channel, payload, ...rest);
      };
      return true;
    `);
  }

  /** Every permission_response frame the app wrote to an engine (app-wide, see watchIpc). */
  protected responses(workspace: string): Record<string, unknown>[] {
    return logLines(workspace)
      .filter((l) => l.ch === "ui" && l.data?.["type"] === "permission_response")
      .map((l) => l.data as Record<string, unknown>);
  }
}

/* ---- checklist 1 ------------------------------------------------------- */

class TheDecisionReachesTheEngineThatAsked extends PermissionTest {
  readonly id = "the-decision-goes-to-the-engine-that-asked";
  readonly whyItExists =
    "a decision routed to whichever console happened to be focused approved one workspace's command in another workspace's engine, and the asking engine waited forever";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home-");
    const first = this.configuredWorkspace();
    const second = this.configuredWorkspace();

    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await this.watchTabs(app);
    await openWorkspace(app, first);
    await waitForSpawn(first);
    await openWorkspace(app, second);
    await waitForSpawn(second);

    // The request comes from the tab that is NOT focused — opening the second
    // workspace focused it. Every engine event main forwards is stamped with
    // its tab's id, and that stamp is the only thing that can route the answer
    // back to the engine that is actually blocked.
    const background = await this.tabFor(app, first);
    const askingPid = await waitForSpawn(first);
    await this.deliver(app, {
      type: "permission_request",
      id: "p1",
      tool: "Bash",
      input: { command: "rm -rf ./build" },
      subject: "rm -rf ./build",
      tabId: background,
    });

    const shown = await this.card(app);
    t.assert.equal(shown.open, true, "a request must put a card in front of the user, or the engine waits forever");
    t.assert.match(shown.subject, /rm -rf \.\/build/, "the card must show what is about to run");

    await this.decide(app, "allow");

    // The renderer routes the answer by the REQUEST's tab, not by what is
    // focused. This is the decision the feature is about, and the ipcMain
    // payload is where it is visible.
    const sent = await app.evaluateInMain<Record<string, unknown>[]>("return globalThis.__sent;");
    t.assert.equal(sent.length, 1, `exactly one decision must be sent, got ${JSON.stringify(sent)}`);
    t.assert.equal(sent[0]?.["id"], "p1", "it must carry the id it was asked with");
    t.assert.equal(sent[0]?.["decision"], "allow_once");
    t.assert.equal(
      sent[0]?.["tabId"],
      background,
      "the decision must name the tab that ASKED — the focused tab is a different engine, and answering it leaves the asking one blocked forever",
    );

    // And a frame addressed to that tab reaches THAT tab's engine. Proved with
    // a frame the engine answers: the reply comes back stamped with the tab it
    // came from, which is the same routing `permission_response` rides on.
    await app.evaluate(`window.magentra.send({ type: "list_sessions" }, ${JSON.stringify(background)}); true`);
    const replied = await this.waitForEvent(app, (event) => event["type"] === "session_list" && event["tabId"] === background);
    t.assert.equal(replied["tabId"], background, "a frame addressed to a tab must be answered by that tab's engine");

    // The answer really was written to an engine.
    const written = this.responses(first).concat(this.responses(second));
    t.assert.equal(written.length, 1, "the decision must reach an engine, not stop in the renderer");
    t.assert.equal(written[0]?.["id"], "p1");

    // WHICH engine, proved by killing the asking one. The black-box log cannot
    // attribute a frame to a tab (one file per app session), but it does record
    // a frame that could not be written — so with the asking tab's engine dead,
    // a correctly routed decision is DROPPED, and a decision routed to whatever
    // is focused is written to a live child instead. The two outcomes are
    // distinguishable; without this, main ignoring the tabId passed unnoticed.
    process.kill(askingPid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    await this.deliver(app, {
      type: "permission_request",
      id: "p2",
      tool: "Bash",
      input: { command: "echo two" },
      subject: "echo two",
      tabId: background,
    });
    await this.decide(app, "allow");

    const dropped = logLines(second)
      .concat(logLines(first))
      .filter((line) => line.data?.["ev"] === "engine-write-dropped" && line.data?.["type"] === "permission_response");
    t.assert.equal(dropped.length, 1, "with the asking engine dead the decision must be dropped — writing it to the focused engine would answer a question it never asked");
    t.assert.deepEqual(
      this.responses(first).concat(this.responses(second)).filter((r) => r["id"] === "p2"),
      [],
      "and nothing may have been written to the engine that was still alive",
    );

    t.assert.equal((await this.card(app)).open, false, "the card must close once it is answered");
  }
}

/* ---- checklist 2, 3 and 4 ---------------------------------------------- */

class RequestsAreQueuedOneAtATime extends PermissionTest {
  readonly id = "requests-are-shown-one-at-a-time-in-arrival-order";
  readonly whyItExists =
    "two requests arriving together used to overwrite one card with the other, so one of the two engines was never answered and sat blocked";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home2-");
    const workspace = this.configuredWorkspace();
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);

    // THREE, not two. With only two, the first is shown the moment it arrives
    // and the queue holds exactly one — where taking from the front and taking
    // from the back are the same thing, and a mutation that reversed the order
    // passed. Two waiting in the queue is what makes the order observable.
    await this.deliver(app, { type: "permission_request", id: "first", tool: "Bash", input: { command: "one" }, subject: "one" });
    await this.deliver(app, { type: "permission_request", id: "second", tool: "Bash", input: { command: "two" }, subject: "two" });
    await this.deliver(app, { type: "permission_request", id: "third", tool: "Bash", input: { command: "three" }, subject: "three" });

    const first = await this.card(app);
    t.assert.match(first.subject, /one/, "the first to arrive is the first shown");
    t.assert.equal(first.alwaysShown, true, "a request that names a subject can be granted durably");

    // Checklist 4: a note travels with the decision.
    await this.decide(app, "deny", "use the safe flag");

    const afterFirst = await this.card(app);
    t.assert.equal(afterFirst.open, true, "the second request must be shown once the first is answered");
    t.assert.match(afterFirst.subject, /two/, "and in the order they arrived");
    t.assert.equal(afterFirst.note, "", "the note box must be empty for the next decision, not carry the last one");

    await this.decide(app, "always");

    const afterSecond = await this.card(app);
    t.assert.match(afterSecond.subject, /three/, "and the third waits its turn behind the second");
    await this.decide(app, "allow");

    // Checklist 3: with nothing to scope a durable grant to, the button that
    // would silently behave like ALLOW ONCE is not offered at all.
    await this.deliver(app, { type: "permission_request", id: "unscoped", tool: "Write", input: { path: "a.txt" } });
    const unscoped = await this.card(app);
    t.assert.equal(unscoped.open, true, "a request with no subject is still a request");
    t.assert.equal(unscoped.alwaysShown, false, "with nothing to remember, ALWAYS ALLOW must not be offered");
    await this.decide(app, "deny");

    const answers = this.responses(workspace).filter((a) => a["id"] !== "unscoped");
    t.assert.deepEqual(
      answers.map((a) => [a["id"], a["decision"]]),
      [["first", "deny"], ["second", "allow_always"], ["third", "allow_once"]],
      "each decision must carry its own id, in the order the requests arrived",
    );
    t.assert.equal(answers[0]?.["message"], "use the safe flag", "a note typed for a decision must travel with it");
    t.assert.equal((await this.card(app)).open, false, "the queue is empty, so the card closes");
  }
}

/* ---- checklist 5 ------------------------------------------------------- */

class AGoneEngineClearsTheQueue extends PermissionTest {
  readonly id = "an-engine-that-exits-clears-its-pending-requests";
  readonly whyItExists =
    "a decision answered after the engine restarted was sent to a new engine for an id it had never issued, which it could only ignore while the user believed they had approved something";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-home3-");
    const workspace = this.configuredWorkspace();
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);

    await this.deliver(app, { type: "permission_request", id: "stale-shown", tool: "Bash", input: { command: "old" }, subject: "old" });
    await this.deliver(app, { type: "permission_request", id: "stale-queued", tool: "Bash", input: { command: "older" }, subject: "older" });
    t.assert.equal((await this.card(app)).open, true, "the card must be up before the engine goes");

    await this.deliver(app, { type: "engine_exit", code: 0, signal: null, expected: false });

    t.assert.equal((await this.card(app)).open, false, "an engine that is gone cannot be answered, so the card must go with it");
    t.assert.deepEqual(this.responses(workspace), [], "and nothing may be sent for a request the engine can no longer be holding");

    // The QUEUE has to go too, not just the card. A request from the next
    // engine must be what appears next — if the old queue survived, the stale
    // one would be shown instead and answered with an id the new engine never
    // issued. Hiding the card alone passed this test until the queue was asked
    // about directly.
    await this.deliver(app, { type: "permission_request", id: "fresh", tool: "Bash", input: { command: "brand new" }, subject: "brand new" });
    const next = await this.card(app);
    t.assert.equal(next.open, true, "a request from the new engine must still be shown");
    t.assert.match(next.subject, /brand new/, "and it must be THAT request, not one left over from the engine that died");
  }
}

registerFeatureTests(new TheDecisionReachesTheEngineThatAsked(), new RequestsAreQueuedOneAtATime(), new AGoneEngineClearsTheQueue());
