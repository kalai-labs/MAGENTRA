/**
 * `tool-askuserquestion`.
 *
 * AskUserQuestion hands one to five multiple-choice questions to the frontend
 * and blocks until the user answers. Options are 2–4 per question and the
 * frontend adds its own "Other" free-text choice; answers come back keyed by
 * position (`q:0`, `q:1`) with the question text as a fallback, so two
 * questions with the same text cannot overwrite each other's answers.
 *
 * `pure`. The tool is a function of its input and of the answers the
 * frontend returns. The `askUser` hop IS the frontend — the Engine wires it to
 * a `question_request` frame and a `question_response` reply — so the test
 * plays that side, exactly as a test that answers a permission prompt does.
 * Nothing the tool does is stubbed; the answers are the fixture.
 */

import type { ToolContext } from "@magentra/core";
import { askUserQuestionTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "tool-askuserquestion";

/** Verbatim from the record. */
const INVARIANT = "Up to five questions block until answered, and the answers key positionally.";

function question(text: string, options = 2) {
  return {
    question: text,
    header: "Pick",
    options: Array.from({ length: options }, (_, i) => ({ label: `Option ${i + 1}`, description: `choice ${i + 1}` })),
  };
}

abstract class AskTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A context whose frontend answers with `answers`, recording what it was asked. */
  protected frontend(answers: Record<string, string[]> | (() => Promise<Record<string, string[]>>)): { ctx: ToolContext; asked: unknown[] } {
    const asked: unknown[] = [];
    const ctx: ToolContext = {
      cwd: process.cwd(),
      session: strictServices({
        askUser: async (questions) => {
          asked.push(questions);
          return typeof answers === "function" ? answers() : answers;
        },
      }),
    };
    return { ctx, asked };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheSchemaBoundsTheRound extends AskTest {
  readonly id = "the-schema-allows-one-to-five-questions-with-two-to-four-options-each";
  readonly whyItExists = "a round of six questions or a question with a single option is a card the frontend cannot draw, and it used to reach the renderer before anything refused it";

  override run(t: TestRun): void {
    const schema = askUserQuestionTool.inputSchema;
    t.assert.equal(schema.safeParse({ questions: Array.from({ length: 6 }, (_, i) => question(`q${i}?`)) }).success, false, "six questions is too many");
    t.assert.equal(schema.safeParse({ questions: [] }).success, false, "zero questions is nothing to ask");
    t.assert.equal(schema.safeParse({ questions: [question("one option?", 1)] }).success, false, "one option is not a choice");
    t.assert.equal(schema.safeParse({ questions: [question("five options?", 5)] }).success, false, "five options is too many");
    t.assert.equal(schema.safeParse({ questions: [{ ...question("long header?"), header: "thirteen-chars" }] }).success, false, "a header over 12 characters is refused");

    const ok = schema.safeParse({ questions: [question("a?"), question("b?", 4)] });
    t.assert.equal(ok.success, true, "two valid questions parse");
    if (ok.success) {
      t.assert.equal(ok.data.questions[0]?.multiSelect, false, "multiSelect defaults to false");
      t.assert.equal(ok.data.questions[1]?.options.length, 4);
    }
    t.assert.equal(askUserQuestionTool.permissionClass, "interact");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class PositionalKeysWin extends AskTest {
  readonly id = "two-questions-with-identical-text-keep-their-own-answers-by-position";
  readonly whyItExists = "answers keyed by question text collided when two questions read the same, so the second question's answer overwrote the first's and one decision was lost";

  override async run(t: TestRun): Promise<void> {
    const { ctx, asked } = this.frontend({ "q:0": ["A"], "q:1": ["B", "C"] });
    const result = await runTool(askUserQuestionTool, { questions: [question("Which one?"), { ...question("Which one?", 3), multiSelect: true }] }, ctx);
    t.assert.equal(result.isError, undefined);
    t.assert.equal(asked.length, 1, "the frontend was asked once, with the whole round");
    t.assert.equal((asked[0] as unknown[]).length, 2, "both questions went across");
    t.assert.equal(resultText(result), "The user answered:\nWhich one?\n-> A\n\nWhich one?\n-> B, C");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class QuestionTextIsTheFallbackKey extends AskTest {
  readonly id = "an-answer-keyed-by-question-text-is-still-read";
  readonly whyItExists = "an older frontend keys answers by the question text; dropping that shape would turn every one of its answers into '(no answer)' after an engine update";

  override async run(t: TestRun): Promise<void> {
    const { ctx } = this.frontend({ "Which colour?": ["X"] });
    const result = await runTool(askUserQuestionTool, { questions: [question("Which colour?")] }, ctx);
    t.assert.equal(resultText(result), "The user answered:\nWhich colour?\n-> X");
    // When both shapes are present, the positional key is the one that counts.
    const both = this.frontend({ "q:0": ["positional"], "Which colour?": ["textual"] });
    const mixed = await runTool(askUserQuestionTool, { questions: [question("Which colour?")] }, both.ctx);
    t.assert.match(resultText(mixed), /-> positional$/);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class NoAnswerIsSaidPlainly extends AskTest {
  readonly id = "an-unanswered-question-reads-no-answer";
  readonly whyItExists = "an empty answer rendered as '-> ' and the model read the blank as the user having chosen nothing in particular, then proceeded as if approved";

  override async run(t: TestRun): Promise<void> {
    const { ctx } = this.frontend({});
    const result = await runTool(askUserQuestionTool, { questions: [question("First?"), question("Second?")] }, ctx);
    const lines = resultText(result).split("\n");
    t.assert.equal(lines.filter((l) => l === "-> (no answer)").length, 2, "each question line ends with the explicit '(no answer)'");
    const partial = this.frontend({ "q:1": [] });
    t.assert.match(resultText(await runTool(askUserQuestionTool, { questions: [question("Only?")] }, partial.ctx)), /-> \(no answer\)$/, "an empty selection is also no answer");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheCallBlocksUntilAnswered extends AskTest {
  readonly id = "execute-does-not-resolve-before-the-frontend-answers";
  readonly whyItExists = "a tool that returned before the user answered handed the model '(no answer)' for every question, and the card the user was still looking at answered nothing";

  override async run(t: TestRun): Promise<void> {
    let release: (() => void) | undefined;
    const answered = new Promise<Record<string, string[]>>((resolve) => {
      release = () => resolve({ "q:0": ["Later"] });
    });
    const { ctx } = this.frontend(() => answered);

    let settled = false;
    const pending = runTool(askUserQuestionTool, { questions: [question("Wait?")] }, ctx).then((r) => {
      settled = true;
      return r;
    });
    // Give the tool every chance to return early: a few turns of the event loop and a real delay.
    await new Promise((resolve) => setTimeout(resolve, 150));
    t.assert.equal(settled, false, "the tool must still be waiting on the user");

    release?.();
    const result = await pending;
    t.assert.equal(settled, true);
    t.assert.match(resultText(result), /-> Later$/, "and it returns the answer that finally arrived");
  }
}

registerFeatureTests(new TheSchemaBoundsTheRound(), new PositionalKeysWin(), new QuestionTextIsTheFallbackKey(), new NoAnswerIsSaidPlainly(), new TheCallBlocksUntilAnswered());
