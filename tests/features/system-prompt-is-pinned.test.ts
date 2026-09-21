/**
 * `system-prompt-is-pinned`.
 *
 * `system-prompt-assembly` proves the nine sections compose in the right ORDER.
 * `prompt-registry` proves how MANY prompts exist. Neither proves what any of
 * them SAYS — so rewording a behaviour section changes every session's
 * instructions and leaves the whole suite green. For an agent harness the
 * assembled prompt is the product, and this is the one place where a
 * byte-for-byte snapshot is the correct assertion rather than a brittle one:
 * the artifact IS the observable behaviour, the literal text sent to the model.
 *
 * `pure` + `fs`, and the record said `pure` when it was written an hour before
 * this file. Items 1, 2, 4 and 5 are a function of its arguments and a file
 * read. Item 3 needs a real override on disk to prove the guard fires, which
 * is a temp directory and an environment variable — `fs`. Re-declared
 * 2026-09-21, before the record was ever marked covered.
 *
 * NOTHING HERE WRITES THE ARTIFACT, and item 5 is the assertion that keeps it
 * that way. The only way to move it is `npm run approve`, run by a person, and
 * the approval is the diff in the commit. An `APPROVE=1` mode would let an
 * agent that broke the prompt re-approve its own change and report green.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { promptCatalog, writePromptOverride } from "@magentra/protocol";

import {
  CANONICAL_ENV,
  firstDifference,
  overriddenPromptIds,
  readApproved,
  renderSystemPrompt,
} from "../lib/approved.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "system-prompt-is-pinned";
const ARTIFACT = "system-prompt.txt";

/** Verbatim from the record. */
const INVARIANT =
  "buildSystemPrompt's output for the canonical environment is byte-identical to the approved artifact, and no prompt override is in effect when it is taken.";

abstract class PinnedPromptTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheRenderIsByteIdenticalToTheArtifact extends PinnedPromptTest {
  readonly id = "the-canonical-render-is-byte-identical-to-the-approved-artifact";
  readonly whyItExists =
    "every other prompt test asserts a property — an order, a count, a section's presence — and a reworded sentence satisfies all of them, so without this the agent's actual instructions can be rewritten with nothing going red";

  override run(t: TestRun): void {
    t.assert.deepEqual(
      overriddenPromptIds(),
      [],
      "a prompt override is in effect, so this comparison would pin a local edit rather than the product — clear it and run again",
    );

    const rendered = renderSystemPrompt();
    const approved = readApproved(FEATURE, ARTIFACT);
    const difference = firstDifference(rendered, approved);

    t.assert.equal(
      difference,
      undefined,
      difference ?? "the render and the approved artifact agree",
    );
    t.assert.equal(rendered, approved, "the two must be identical, not merely line-wise equal");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheArtifactCannotBeEmptyAndPass extends PinnedPromptTest {
  readonly id = "the-artifact-carries-the-whole-prompt-and-every-environment-value";
  readonly whyItExists =
    "an emptied or truncated artifact agrees with an emptied or truncated render, so equality alone would report green for a prompt that had been deleted — the artifact has to be checked for substance independently of the comparison";

  override run(t: TestRun): void {
    const approved = readApproved(FEATURE, ARTIFACT);

    t.assert.ok(approved.trim().length > 0, "the approved artifact is empty");
    t.assert.ok(
      approved.split("\n").length >= 50,
      `the approved artifact is ${approved.split("\n").length} lines; the assembled prompt is far longer than that, so this one has been truncated`,
    );

    // The environment block is the last thing the prompt carries and the only
    // part built from CANONICAL_ENV, so its five values prove the artifact was
    // rendered for the canonical environment and not for somebody's machine.
    for (const line of [
      `- Working directory: ${CANONICAL_ENV.cwd}`,
      `- Git repository: ${CANONICAL_ENV.isGitRepo ? "yes" : "no"}`,
      `- Platform: ${CANONICAL_ENV.platform}`,
      `- Model: ${CANONICAL_ENV.model}`,
      `- Today's date: ${CANONICAL_ENV.date}`,
    ]) {
      t.assert.ok(approved.includes(line), `the approved artifact is missing its environment line: ${line}`);
    }
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheRenderIsDeterministic extends PinnedPromptTest {
  readonly id = "two-renders-in-one-process-produce-identical-text";
  readonly whyItExists =
    "an artifact that pins a lucky ordering rather than a deterministic function fails at random later, and the failure looks like a product change to whoever is holding it";

  override run(t: TestRun): void {
    t.assert.equal(renderSystemPrompt(), renderSystemPrompt());
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class NothingHereCanRewriteTheArtifact extends PinnedPromptTest {
  readonly id = "neither-the-test-nor-the-printer-can-write-the-artifact";
  readonly whyItExists =
    "the whole value of an approved artifact is that a person reviewed the diff; a self-approving test is a file that costs disk and proves nothing, and an agent hitting a red prompt test is exactly who would reach for the escape hatch";

  override run(t: TestRun): void {
    // Assembled from fragments on purpose: spelled out in full, this very line
    // would be the match and the assertion could never pass.
    const writeApis = ["write" + "FileSync", "append" + "FileSync", "create" + "WriteStream", "write" + "File("];

    for (const relative of [
      join("tests", "features", "system-prompt-is-pinned.test.ts"),
      join("tests", "features", "tool-wire-contract-is-pinned.test.ts"),
      join("tests", "lib", "approved.ts"),
    ]) {
      const source = readFileSync(join(repoRoot(), relative), "utf8");
      for (const api of writeApis) {
        t.assert.equal(
          source.includes(api),
          false,
          `${relative} names ${api} — nothing on the test side of an approved artifact may write, or the artifact approves itself`,
        );
      }
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnOverrideRefusesTheComparison extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "an-override-in-effect-is-detected-and-named-rather-than-frozen";
  readonly whyItExists =
    "promptsDir() falls back to ~/.magentra/prompts, so overrides are global to the user and need no environment variable to be live — without this guard a developer who had tuned one prompt would regenerate the artifact from their own tuning and commit it as the product's default";

  override async run(t: TestRun): Promise<void> {
    const id = "system.environment";
    t.assert.ok(
      promptCatalog().some((p) => p.id === id),
      `${id} is no longer a registered prompt; this test needs a real one the system prompt uses`,
    );

    const dir = this.tempDir("magentra-prompts-");
    this.setEnv("MAGENTRA_PROMPTS_DIR", dir);
    writePromptOverride(id, "an override that must never reach an approved artifact");

    // overrideText caches per id for 250 ms, so the write is not necessarily
    // visible on the next call. Poll rather than sleep: a fixed sleep either
    // wastes the time or is too short on a loaded machine.
    const deadline = Date.now() + 5000;
    let ids: string[] = [];
    do {
      ids = overriddenPromptIds();
      if (ids.includes(id)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);

    t.assert.ok(ids.includes(id), `the override on ${id} was never observed; the guard cannot see overrides at all`);
    t.assert.deepEqual(ids, [id], "exactly the prompt that was overridden should be named");
  }
}

registerFeatureTests(
  new TheRenderIsByteIdenticalToTheArtifact(),
  new TheArtifactCannotBeEmptyAndPass(),
  new AnOverrideRefusesTheComparison(),
  new TheRenderIsDeterministic(),
  new NothingHereCanRewriteTheArtifact(),
);
