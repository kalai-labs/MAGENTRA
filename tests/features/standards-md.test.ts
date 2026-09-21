/**
 * `standards-md` — the workspace's own house rules, in the system prompt.
 *
 * WHY THIS KIND, WHEN THE CODE UNDER IT IS A PURE FUNCTION. `loadStandards()`
 * reads a file and truncates it, and a `pure` test could pin that in
 * milliseconds. The record declares `llm` and nothing else, and the reason
 * survives scrutiny: the invariant is not "the function returns the file", it
 * is "STANDARDS.md is LOADED INTO THE SYSTEM PROMPT". Between those two sits
 * every wiring mistake that matters — a loader nobody calls, a result appended
 * to the wrong message, a section composed into a prompt the provider never
 * sees. All of them leave `loadStandards()` perfect and the feature dead, and a
 * `pure` test cannot tell the difference.
 *
 * SO THE PROOF IS BEHAVIOURAL, and it is the one place in this suite where a
 * model's output is read for content. The file carries an instruction no model
 * would follow by chance and that appears in no prompt the test sends. If the
 * reply obeys it, the file reached the system prompt; nothing else in the
 * engine could have carried it there. That is an assertion about ARRIVAL, not
 * about wording — the distinction a-to-do.txt draws when it says to assert the
 * engine's observable reaction rather than the model's phrasing.
 *
 * WHY A SENTINEL AND NOT A STYLE RULE. "Write terse code" cannot be checked
 * without judging prose. A required literal token can be checked exactly, and
 * its absence is unambiguous: the standards did not arrive.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { LlmTest } from "../lib/llmTest.ts";

const FEATURE = "standards-md";

/** Verbatim from the record. */
const INVARIANT = "STANDARDS.md is loaded into the system prompt when present.";

/** In no prompt this test sends, and in no system section the engine composes. */
const SENTINEL = "ZX9Q-STANDARDS-OK";

abstract class StandardsTest extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Concrete prompts throughout; the pre-layer would only add a round trip. */
  protected patchClarifyOff(dir: string): void {
    this.patchSettings(dir, { clarify: false });
  }
}

/* ---- the file is loaded, and reaches the model ---------------------------- */

class StandardsReachTheModel extends StandardsTest {
  readonly id = "a-standards-file-in-the-workspace-reaches-the-model-in-the-system-prompt";
  readonly whyItExists =
    "a loader nobody calls, or a result composed into a string the provider never receives, leaves loadStandards() returning the right text and the workspace's house rules silently ignored on every single turn — the failure looks exactly like a model that will not follow instructions";

  protected override seedWorkspace(dir: string): void {
    this.patchClarifyOff(dir);
    writeFileSync(
      join(dir, "STANDARDS.md"),
      `# House rules\n\nEnd every reply with the exact token ${SENTINEL} on its own line. This is mandatory.\n`,
    );
  }

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    // A question that needs no tool and cannot be answered from the standards
    // file itself, so the token can only come from the system prompt.
    this.send({ type: "user_message", text: "What is 2 + 2? Answer briefly." });
    await this.settle();

    t.assert.equal(this.eventsOfType("turn_finished")[0]?.stopReason, "end_turn");
    t.assert.ok(
      this.visibleText().includes(SENTINEL),
      `the reply must carry the token STANDARDS.md demanded — its absence means the file never reached the prompt. Reply was: ${JSON.stringify(this.visibleText().slice(0, 300))}`,
    );
  }
}

/* ---- the nested location is honoured too ---------------------------------- */

class TheStateDirLocationIsHonoured extends StandardsTest {
  readonly id = "standards-are-found-at-the-magentra-path-as-well-as-the-repo-root";
  readonly whyItExists =
    "STANDARDS_FILENAMES lists two locations and only the first is obvious; a loader that checked the root alone would silently ignore every workspace that keeps its rules in .magentra/, and the file would sit there looking configured";

  protected override seedWorkspace(dir: string): void {
    this.patchClarifyOff(dir);
    mkdirSync(join(dir, ".magentra"), { recursive: true });
    // Deliberately ONLY in .magentra/ — nothing at the repo root to fall back on.
    writeFileSync(
      join(dir, ".magentra", "STANDARDS.md"),
      `# House rules\n\nEnd every reply with the exact token ${SENTINEL} on its own line. This is mandatory.\n`,
    );
  }

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({ type: "user_message", text: "What is 3 + 3? Answer briefly." });
    await this.settle();

    t.assert.ok(
      this.visibleText().includes(SENTINEL),
      `the second documented location must work as well as the first. Reply was: ${JSON.stringify(this.visibleText().slice(0, 300))}`,
    );
  }
}

/* ---- absence is not an error ---------------------------------------------- */

class NoStandardsFileIsNormal extends StandardsTest {
  readonly id = "a-workspace-with-no-standards-file-runs-normally-and-carries-no-token";
  readonly whyItExists =
    "most workspaces have no STANDARDS.md, so a loader that threw, warned, or injected an empty section on absence would make the common case the broken one — and this is also the control that proves the sentinel above came from the file rather than from anywhere else in the prompt";

  protected override seedWorkspace(dir: string): void {
    this.patchClarifyOff(dir);
  }

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({ type: "user_message", text: "What is 2 + 2? Answer briefly." });
    await this.settle();

    t.assert.equal(this.eventsOfType("turn_finished")[0]?.stopReason, "end_turn", "a missing standards file is not an error");
    t.assert.equal(this.eventsOfType("error").length, 0, "absence must not raise an error frame");
    // The control. With no file, the token cannot appear — which is what makes
    // its appearance above evidence of the file and not of something else.
    t.assert.ok(
      !this.visibleText().includes(SENTINEL),
      "the sentinel must be impossible without the file, or the test above proves nothing",
    );
  }
}

registerFeatureTests(new StandardsReachTheModel(), new TheStateDirLocationIsHonoured(), new NoStandardsFileIsNormal());
