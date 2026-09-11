/**
 * `clear`.
 *
 * Clearing only the screen would leave the model's context full — the next turn
 * would still be paying for a conversation the user believes is gone. And
 * clearing mid-turn would desynchronise the UI from an engine that is still
 * working. So CLEAR is two things at once: a `/clear` to the engine, and a
 * local wipe of everything that belonged to the old session — and it is refused
 * while a turn is running.
 *
 * `ui`. `composer.js` is a classic script in the page's shared global scope, so
 * it cannot be imported; the only place `requestClear` exists is a running
 * renderer. The button is clicked, the keystroke is dispatched, and what the
 * engine was sent is read out of the app's own log.
 *
 * ONE PIECE OF STATE IS SET DIRECTLY. `busy` is a renderer global, and making
 * it true for real would need a turn in flight — which needs a model. It is
 * assigned here because it is the page's own global in the page's own scope,
 * and it is the exact state the product sets; nothing hidden is reached for,
 * and no function the page does not expose is called.
 */

import { join } from "node:path";

import { logLines, openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "clear";

/** Verbatim from the record. */
const INVARIANT = "Clear resets the local view and starts a fresh session.";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

abstract class ClearTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected async openConsole(): Promise<{ app: AppHandle; workspace: string }> {
    const home = this.makeTempDir("magentra-clear-home-");
    const workspace = this.makeTempDir("magentra-clear-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: LOCAL_ENDPOINT,
      model: "model-one",
    });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    return { app, workspace };
  }

  /** Every slash_command frame the app wrote to an engine. */
  protected slashCommands(workspace: string): Record<string, unknown>[] {
    return logLines(workspace)
      .filter((line) => line.ch === "ui" && line.data?.["type"] === "slash_command")
      .map((line) => line.data as Record<string, unknown>);
  }

  /** Put something in the transcript to wipe, using the product's own renderers. */
  protected async fillTranscript(app: AppHandle): Promise<void> {
    await app.evaluate(`
      streamEl.appendChild(renderMarkdown("an answer from the last session"));
      toolRows.set("t1", document.createElement("div"));
      onTaskListUpdated({ tasks: [{ id: "1", title: "an old task", status: "pending" }] });
      true
    `);
  }
}

/* ---- checklist 1 and 6 ------------------------------------------------- */

class ClearWipesTheViewAndTheSession extends ClearTest {
  readonly id = "clear-sends-the-command-and-wipes-what-belonged-to-the-old-session";
  readonly whyItExists =
    "clearing only the screen leaves the model's context full, so the next turn still pays for a conversation the user believes is gone";

  override async run(t: TestRun): Promise<void> {
    const { app, workspace } = await this.openConsole();
    await this.fillTranscript(app);

    const before = await app.evaluate<{ stream: number; tools: number }>(
      `({ stream: streamEl.childNodes.length, tools: toolRows.size })`,
    );
    t.assert.ok(before.stream > 0, "there must be a transcript to wipe, or this proves nothing");
    t.assert.ok(before.tools > 0, "and tool rows to wipe with it");

    await app.evaluate(`clearBtnEl.click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const sent = this.slashCommands(workspace);
    t.assert.equal(sent.length, 1, `exactly one /clear must reach the engine, got ${JSON.stringify(sent)}`);
    t.assert.equal(sent[0]?.["command"], "clear", "and it must be the clear command — the fresh session is the point");

    const after = await app.evaluate<{ stream: number; tools: number; agents: number; tasks: number; text: string }>(`
      ({
        stream: streamEl.childNodes.length,
        tools: toolRows.size,
        agents: agentCards.size,
        tasks: taskListEl.childNodes.length,
        text: streamEl.textContent || "",
      })
    `);
    t.assert.equal(after.tools, 0, "tool rows belong to the session that is gone");
    t.assert.equal(after.agents, 0, "so do agent cards");
    t.assert.equal(after.tasks, 0, "and the task list — checklist 6: everything the old session accumulated");
    // The transcript is emptied and then a note is appended saying so, which is
    // why counting nodes proves nothing: what matters is that the OLD session's
    // content is gone and the note is what replaced it.
    t.assert.doesNotMatch(after.text, /an answer from the last session/, "the previous session's transcript must be gone");
    t.assert.match(after.text, /\/clear/, "and the wipe must leave a note saying what happened");
  }
}

/* ---- checklist 2 ------------------------------------------------------- */

class ClearIsRefusedMidTurn extends ClearTest {
  readonly id = "clear-is-refused-while-a-turn-is-running";
  readonly whyItExists =
    "clearing mid-turn desynchronises the UI from an engine still working, and the turn's output then arrives into a console that has forgotten what asked for it";

  override async run(t: TestRun): Promise<void> {
    const { app, workspace } = await this.openConsole();
    await this.fillTranscript(app);

    const before = await app.evaluate<number>(`streamEl.childNodes.length`);

    await app.evaluate(`busy = true; clearBtnEl.click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Ctrl/Cmd+L must be refused for the same reason, through the same guard.
    await app.evaluate(`
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "l", ctrlKey: true, metaKey: true, bubbles: true }));
      true
    `);
    await new Promise((resolve) => setTimeout(resolve, 800));

    t.assert.deepEqual(this.slashCommands(workspace), [], "nothing may be sent while a turn is in flight");
    t.assert.equal(await app.evaluate<number>(`streamEl.childNodes.length`), before, "and the transcript must be untouched");

    // And once the turn is over, the same click works — the guard is a guard,
    // not a broken button.
    await app.evaluate(`busy = false; clearBtnEl.click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    t.assert.equal(this.slashCommands(workspace).length, 1, "with the turn finished, clear must work again");
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

class ADraftSurvivesButACommandDoesNot extends ClearTest {
  readonly id = "a-typed-draft-survives-clear-and-a-typed-command-does-not";
  readonly whyItExists =
    "losing a half-written question to a button pressed for an unrelated reason is the kind of small theft that teaches people not to use the button";

  override async run(t: TestRun): Promise<void> {
    const { app } = await this.openConsole();

    await app.evaluate(`promptInputEl.value = "fix the tests"; clearBtnEl.click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    t.assert.equal(
      await app.evaluate<string>(`promptInputEl.value`),
      "fix the tests",
      "a draft the user was writing must come back — it has nothing to do with the session",
    );

    // A draft that is itself a command is not prose worth keeping.
    await app.evaluate(`promptInputEl.value = "/help"; clearBtnEl.click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    t.assert.equal(await app.evaluate<string>(`promptInputEl.value`), "", "a slash command in the box is not a draft to restore");
  }
}

/* ---- checklist 4 and 5 ------------------------------------------------- */

class TheWipeIsScopedCorrectly extends ClearTest {
  readonly id = "the-wipe-clears-the-task-list-unless-it-is-asked-not-to";
  readonly whyItExists =
    "a compaction reuses the same local wipe but must keep the task board, and one shared function with the wrong default silently empties it";

  override async run(t: TestRun): Promise<void> {
    const { app } = await this.openConsole();

    await app.evaluate(`onTaskListUpdated({ tasks: [{ id: "1", title: "keep me", status: "pending" }] }); true`);
    const seeded = await app.evaluate<number>(`taskListEl.childNodes.length`);
    t.assert.ok(seeded > 0, "there must be a task list to clear, or this proves nothing");

    await app.evaluate(`resetLocalViewForClear(true); true`);
    t.assert.equal(
      await app.evaluate<number>(`taskListEl.childNodes.length`),
      seeded,
      "preserveTasks must keep the board — a compaction is not a new session",
    );

    await app.evaluate(`resetLocalViewForClear(); true`);
    t.assert.equal(
      await app.evaluate<number>(`taskListEl.childNodes.length`),
      0,
      "by default the board goes with the session it belonged to",
    );
  }
}

registerFeatureTests(
  new ClearWipesTheViewAndTheSession(),
  new ClearIsRefusedMidTurn(),
  new ADraftSurvivesButACommandDoesNot(),
  new TheWipeIsScopedCorrectly(),
);
