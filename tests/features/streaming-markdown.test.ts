/**
 * `streaming-markdown`.
 *
 * Rendering everything only at the end left long answers as raw source for the
 * whole turn. Rendering as it arrived made half-finished constructs flicker
 * between parses — a code fence reformatting itself line by line as it streams.
 * So the renderer commits only COMPLETE blocks: text up to the last blank line
 * whose fences and `$$` delimiters are balanced. The unfinished tail stays
 * plain until its closing delimiter arrives.
 *
 * `ui`: `stream.js` is a classic script in the page's shared scope, so
 * `markdownCommitPoint` exists nowhere but a running renderer.
 */

import { join } from "node:path";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "streaming-markdown";

/** Verbatim from the record. */
const INVARIANT =
  "Each block renders when complete, so a half-streamed fence, table or formula stays plain text until its closing delimiter arrives.";

abstract class StreamingTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /**
   * The app with a workspace console open.
   *
   * `onTextDelta` returns at once when `streamEl` is absent, and `streamEl`
   * only exists once a console is mounted — on the start page nothing streams,
   * which is correct and made the first version of these tests assert against a
   * transcript that was never created.
   */
  protected async page(): Promise<AppHandle> {
    const home = this.makeTempDir("magentra-stream-home-");
    const workspace = this.makeTempDir("magentra-stream-ws-");
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

  /** Where the renderer would cut this raw text, if anywhere. */
  protected async commitPoint(app: AppHandle, raw: string): Promise<string> {
    return app.evaluate<string>(`markdownCommitPoint(${JSON.stringify(raw)})`);
  }

  /** A streaming assistant element, fed deltas through the product's own path. */
  protected async stream(app: AppHandle, deltas: readonly string[]): Promise<{ done: string; live: string; committed: number; tags: string[]; liveTags: string[] }> {
    return app.evaluate(`
      (() => {
        currentAssistantEl = null;
        for (const delta of ${JSON.stringify(deltas)}) onTextDelta(delta);
        const el = currentAssistantEl;
        const done = el.querySelector(".md-done");
        const live = el.querySelector(".md-live");
        const tags = [];
        if (done) { const walk = (n) => { tags.push(n.tagName.toLowerCase()); for (const c of n.children) walk(c); }; for (const c of done.children) walk(c); }
        const liveTags = [];
        if (live) for (const c of live.children) liveTags.push(c.tagName.toLowerCase());
        return {
          done: done ? done.textContent || "" : "",
          live: live ? live.textContent || "" : "",
          committed: el._committedLen || 0,
          tags,
          liveTags,
        };
      })()
    `);
  }
}

/* ---- checklist 1 and 2 ------------------------------------------------- */

class AnOpenFenceIsNeverCommitted extends StreamingTest {
  readonly id = "a-cut-inside-an-unbalanced-fence-or-formula-is-refused";
  readonly whyItExists =
    "committing at a blank line inside an open code fence renders half a program as prose, and the block reformats itself again when the fence finally closes";

  override async run(t: TestRun): Promise<void> {
    const app = await this.page();

    // The blank line inside the fence cannot be the cut; the earlier one is.
    t.assert.equal(
      await this.commitPoint(app, "para one\n\n```js\nlet x\n\nmore"),
      "para one\n",
      "a blank line inside an open fence is not a block boundary",
    );

    // An unbalanced display formula has no safe cut at all.
    t.assert.equal(await this.commitPoint(app, "$$\na+b\n\n"), "", "an unclosed $$ means nothing is complete yet");
    t.assert.equal(await this.commitPoint(app, "$$a$$\n\ntail"), "$$a$$\n", "a closed one commits up to the blank line");

    // And the ordinary case still commits, or nothing would ever render early.
    t.assert.equal(await this.commitPoint(app, "one\n\ntwo"), "one\n");
  }
}

/* ---- checklist 3 and 4 ------------------------------------------------- */

class CommittedBlocksRenderAndTheTailStaysPlain extends StreamingTest {
  readonly id = "committed-blocks-render-while-the-tail-stays-plain";
  readonly whyItExists =
    "a long answer that stays raw source until the turn ends is unreadable for the whole time it is being written, which is exactly when someone is reading it";

  override async run(t: TestRun): Promise<void> {
    const app = await this.page();

    const heading = await this.stream(app, ["# Title\n\n", "streaming words"]);
    t.assert.ok(heading.tags.includes("h1"), `a finished heading must render; committed ${heading.tags.join(", ")}`);
    // The tail keeps the newline that followed the committed block — the cut is
    // after the blank line's first newline, not after both. What the feature
    // promises is that the tail is PLAIN, not that its whitespace is trimmed.
    t.assert.equal(heading.live.trim(), "streaming words", "the unfinished tail is the text that has arrived since the cut");
    t.assert.equal(heading.liveTags.length, 0, "and it is plain text — nothing is parsed until its block is complete");

    // Committing again with no new boundary must not re-parse what is done.
    const before = heading.committed;
    const again = await app.evaluate<number>(`
      (() => { onTextDelta(" more"); return currentAssistantEl._committedLen || 0; })()
    `);
    t.assert.equal(again, before, "with no new blank line, the committed prefix must not move");

    // Checklist 4: a table is not a table until the blank line after it.
    const table = await this.stream(app, ["| a | b |\n|---|---|\n| 1 | 2 |"]);
    t.assert.deepEqual(table.tags.filter((tag) => tag === "table"), [], "a table with no blank line after it is still arriving");
    t.assert.match(table.live, /\| a \| b \|/, "so it stays plain text");

    const closed = await this.stream(app, ["| a | b |\n|---|---|\n| 1 | 2 |\n\n"]);
    t.assert.ok(closed.tags.includes("table"), `once the blank line arrives it becomes a table; committed ${closed.tags.join(", ")}`);
  }
}

/* ---- checklist 5 ------------------------------------------------------- */

class FinishingRendersTheWholeMessage extends StreamingTest {
  readonly id = "finishing-re-renders-the-whole-message-once";
  readonly whyItExists =
    "a block split awkwardly across two commits renders as two halves; the final pass is what makes the finished message look the way it would have if it had arrived at once";

  override async run(t: TestRun): Promise<void> {
    const app = await this.page();

    const finished = await app.evaluate<{ tags: string[]; carets: number; live: number; cleared: boolean }>(`
      (() => {
        currentAssistantEl = null;
        onTextDelta("# Title\\n\\n");
        onTextDelta("a **bold** word\\n\\n");
        onTextDelta("| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n");
        const el = currentAssistantEl;
        finalizeAssistantEl();
        const body = el.querySelector(".msg-body") || el;
        const tags = [];
        const walk = (n) => { tags.push(n.tagName.toLowerCase()); for (const c of n.children) walk(c); };
        for (const c of body.children) walk(c);
        return {
          tags,
          carets: el.querySelectorAll(".caret").length,
          live: el.querySelectorAll(".md-live").length,
          cleared: currentAssistantEl === null,
        };
      })()
    `);

    t.assert.ok(finished.tags.includes("h1"), `the finished message keeps its heading; got ${finished.tags.join(", ")}`);
    t.assert.ok(finished.tags.includes("strong"), "and its inline formatting");
    t.assert.ok(finished.tags.includes("table"), "and its table, rendered whole");
    t.assert.equal(finished.carets, 0, "a finished message has no cursor — it is not still being written");
    t.assert.equal(finished.live, 0, "and nothing is left in the live tail");
    t.assert.equal(finished.cleared, true, "the next delta must start a new message, not append to this one");

    // A message with NO text is where the explicit caret removal is the only
    // thing that removes it: the whole-message re-render is skipped when there
    // is nothing to render, so the body swap cannot take the caret with it.
    // Without this case, deleting that removal passed.
    const empty = await app.evaluate<number>(`
      (() => {
        currentAssistantEl = null;
        onTextDelta("");
        const el = currentAssistantEl;
        finalizeAssistantEl();
        return el ? el.querySelectorAll(".caret").length : -1;
      })()
    `);
    t.assert.equal(empty, 0, "a finished message with no text must still lose its cursor");
  }
}

registerFeatureTests(new AnOpenFenceIsNeverCommitted(), new CommittedBlocksRenderAndTheTailStaysPlain(), new FinishingRendersTheWholeMessage());
