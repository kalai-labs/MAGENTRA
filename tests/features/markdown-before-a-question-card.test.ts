/**
 * `markdown-before-a-question-card`.
 *
 * Assistant text streams in as PLAIN text, and is only re-rendered as Markdown
 * when the message closes. A card appended over a live message therefore leaves
 * that message showing raw source until something else closes it — which is the
 * end of the turn. So the message is closed FIRST: the text above the card is
 * formatted while the user is still deciding what to answer.
 *
 * `ui`: `landing.js` and `stream.js` are classic scripts in the page's shared
 * scope, and what is asserted is DOM the running page built.
 */

import { join } from "node:path";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "markdown-before-a-question-card";

/** Verbatim from the record. */
const INVARIANT = "A question_request closes the streaming message first, so text above an approval card is rendered while the user decides.";

/** A question the renderer will build a card for. */
const QUESTION = {
  type: "question_request",
  id: "q1",
  questions: [{ header: "Pick", question: "Which one?", options: [{ label: "A", description: "the first" }, { label: "B", description: "the second" }], multiSelect: false }],
};

abstract class QuestionCardTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected async console(): Promise<AppHandle> {
    const home = this.makeTempDir("magentra-q-home-");
    const workspace = this.makeTempDir("magentra-q-ws-");
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

  protected async deliver(app: AppHandle, event: Record<string, unknown>): Promise<void> {
    await app.evaluate(`handleEngineEvent(${JSON.stringify(event)}); true`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/* ---- checklist 1 and 2 ------------------------------------------------- */

class TheMessageIsClosedBeforeTheCard extends QuestionCardTest {
  readonly id = "the-message-above-the-card-is-rendered-markdown";
  readonly whyItExists =
    "live text is plain until its message closes, so without this the paragraph above the card sat as raw Markdown source for as long as the user took to answer";

  override async run(t: TestRun): Promise<void> {
    const app = await this.console();

    await app.evaluate(`
      currentAssistantEl = null;
      onTextDelta("**bold** text\\n\\n");
      onTextDelta("more");
      true
    `);

    // Before the card: the message is still live, so still plain.
    const streaming = await app.evaluate<{ strongs: number; live: number }>(`
      ({ strongs: currentAssistantEl.querySelectorAll("strong").length, live: currentAssistantEl.querySelectorAll(".md-live").length })
    `);
    t.assert.equal(streaming.live, 1, "a streaming message keeps its live tail — that is what makes it live");

    await this.deliver(app, QUESTION);

    const after = await app.evaluate<{ strongs: number; carets: number; cleared: boolean; cardAfterMessage: boolean }>(`
      (() => {
        const messages = [...streamEl.querySelectorAll(".msg-assistant")];
        const last = messages[messages.length - 1];
        const card = streamEl.querySelector(".question-card, .q-card, [data-question-id], .ask-card");
        const nodes = [...streamEl.children];
        return {
          strongs: streamEl.querySelectorAll("strong").length,
          carets: streamEl.querySelectorAll(".caret").length,
          cleared: currentAssistantEl === null,
          cardAfterMessage: Boolean(card) && Boolean(last) && nodes.indexOf(card.closest("*[class]") === card ? card : card) >= 0,
        };
      })()
    `);

    t.assert.ok(after.strongs > 0, "the text above the card must be rendered — a <strong> where the author wrote **bold**");
    t.assert.equal(after.carets, 0, "and the message must be closed, so no cursor is left blinking above the card");
    t.assert.equal(after.cleared, true, "the streaming message is finished before the card is built");

    // Checklist 2: the transcript stays chronological.
    const order = await app.evaluate<{ messageIndex: number; cardIndex: number }>(`
      (() => {
        const nodes = [...streamEl.children];
        const messageIndex = nodes.findIndex((n) => n.querySelector && n.querySelector("strong"));
        const cardIndex = nodes.findIndex((n) => /question|ask|choice/i.test(n.className || ""));
        return { messageIndex, cardIndex };
      })()
    `);
    t.assert.ok(order.messageIndex >= 0, "the finished message must be in the transcript");
    t.assert.ok(order.cardIndex > order.messageIndex, `the card belongs after the message that led to it (message ${order.messageIndex}, card ${order.cardIndex})`);
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

class TextAfterTheCardStartsANewMessage extends QuestionCardTest {
  readonly id = "text-arriving-after-the-card-starts-a-new-message";
  readonly whyItExists =
    "appending to the finished message would put the answer's continuation above the question it answers, and the transcript would stop reading in order";

  override async run(t: TestRun): Promise<void> {
    const app = await this.console();

    await app.evaluate(`currentAssistantEl = null; onTextDelta("before the card"); true`);
    const first = await app.evaluate<number>(`streamEl.querySelectorAll(".msg-assistant").length`);

    await this.deliver(app, QUESTION);
    await app.evaluate(`onTextDelta("after the card"); true`);

    const second = await app.evaluate<{ messages: number; lastText: string }>(`
      (() => {
        const msgs = [...streamEl.querySelectorAll(".msg-assistant")];
        return { messages: msgs.length, lastText: msgs.length ? (msgs[msgs.length - 1].textContent || "") : "" };
      })()
    `);
    t.assert.ok(second.messages > first, "text after the card must begin its own message");
    t.assert.match(second.lastText, /after the card/, "and that message is the one holding the new text");
    t.assert.doesNotMatch(second.lastText, /before the card/, "the finished message must not have been reopened");
  }
}

/* ---- checklist 4 ------------------------------------------------------- */

class AMessageNeverVanishesOverFormatting extends QuestionCardTest {
  readonly id = "a-message-never-vanishes-because-its-markdown-failed";
  readonly whyItExists =
    "the renderer runs over untrusted model output; if one pathological string could take a message off the screen, the user would lose an answer they had already read";

  override async run(t: TestRun): Promise<void> {
    const app = await this.console();

    // Fault injection at the page's own seam: `renderMarkdown` is a global in
    // the shared renderer scope, and it is replaced here with one that throws,
    // then put back. This is the only way to reach the `catch` — the real
    // renderer does not throw, which is why the branch is a safety net.
    const kept = await app.evaluate<{ text: string; present: boolean }>(`
      (() => {
        currentAssistantEl = null;
        onTextDelta("the answer the user already read");
        const el = currentAssistantEl;
        const real = renderMarkdown;
        renderMarkdown = () => { throw new Error("pathological input"); };
        try {
          finalizeAssistantEl();
        } finally {
          renderMarkdown = real;
        }
        return { text: el.textContent || "", present: streamEl.contains(el) };
      })()
    `);

    t.assert.equal(kept.present, true, "the message must still be on screen");
    t.assert.match(kept.text, /the answer the user already read/, "with the plain text it already had — formatting is the part that may fail, not the message");
  }
}

registerFeatureTests(new TheMessageIsClosedBeforeTheCard(), new TextAfterTheCardStartsANewMessage(), new AMessageNeverVanishesOverFormatting());
