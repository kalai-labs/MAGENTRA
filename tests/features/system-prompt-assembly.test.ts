/**
 * `system-prompt-assembly`.
 *
 * The system prompt sent on every request is composed once, in one place:
 * nine behaviour sections in registry order, the environment block, the addon
 * roster when there is one, then any extra sections. Each section is one
 * exported constant registered as a prompt, so it can be edited or switched
 * off — and a disabled section is dropped without leaving a blank gap. Without
 * a single ordered assembly point the sections drift, duplicate, or join in
 * the wrong order, and nothing downstream can tell.
 *
 * `pure` + `fs`, and the record said `pure`. Items 1, 2, 3 and 5 are
 * `buildSystemPrompt` as a function of its arguments. Item 4 switches a
 * section off the way an operator does — a blank override FILE in the prompts
 * directory — so it is filesystem work: the directory is a temp one this test
 * owns, reached through the `MAGENTRA_PROMPTS_DIR` variable the registry
 * honours for exactly this purpose, and put back before the next test.
 * Re-declared 2026-09-19.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  addonsBlock,
  behaviorCore,
  buildSystemPrompt,
  environmentBlock,
  SECTION_ACTION_CARE,
  SECTION_AUTONOMY,
  SECTION_CODE_STYLE,
  SECTION_COMMUNICATION,
  SECTION_GIT,
  SECTION_HARNESS,
  SECTION_IDENTITY,
  SECTION_TASKS,
  SECTION_WORKING_METHOD,
  type PromptEnvironment,
} from "@magentra/core";
import { isPromptDisabled, PRODUCT_NAME, PRODUCT_REPO_URL, promptCatalog, renderPrompt } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "system-prompt-assembly";

/** Verbatim from the record. */
const INVARIANT = "buildSystemPrompt composes the nine SECTION_* exports; every behaviour section has exactly one definition.";

const ENV: PromptEnvironment = { cwd: "C:\\work\\demo", isGitRepo: true, platform: "win32", model: "some/model", date: "2026-09-19" };

/**
 * The nine sections as they appear in the assembled prompt, in registry order.
 * Identity carries two placeholders, so its RENDERED text is what appears.
 */
const SECTIONS_IN_ORDER: [string, string][] = [
  ["identity", renderPrompt("system.identity", { product: PRODUCT_NAME, repo: PRODUCT_REPO_URL }).trim()],
  ["harness", SECTION_HARNESS.trim()],
  ["communication", SECTION_COMMUNICATION.trim()],
  ["action care", SECTION_ACTION_CARE.trim()],
  ["git", SECTION_GIT.trim()],
  ["code style", SECTION_CODE_STYLE.trim()],
  ["tasks", SECTION_TASKS.trim()],
  ["working method", SECTION_WORKING_METHOD.trim()],
  ["autonomy", SECTION_AUTONOMY.trim()],
];

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

abstract class AssemblyTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class NineSectionsOnceEachInOrder extends AssemblyTest {
  readonly id = "the-nine-sections-appear-once-each-in-registry-order-followed-by-the-environment";
  readonly whyItExists = "a section pasted into two constants was sent twice on every request, and a reordering put the autonomy rules before the identity that scopes them";

  override run(t: TestRun): void {
    const prompt = buildSystemPrompt({ env: ENV });
    let last = -1;
    for (const [name, text] of SECTIONS_IN_ORDER) {
      t.assert.ok(text.length > 40, `${name} has real text`);
      t.assert.equal(countOf(prompt, text), 1, `the ${name} section must appear exactly once`);
      const at = prompt.indexOf(text);
      t.assert.ok(at > last, `the ${name} section must come after the one before it`);
      last = at;
    }
    const env = prompt.indexOf("Environment:");
    t.assert.ok(env > last, "the environment block follows every behaviour section");
    t.assert.ok(prompt.includes("- Working directory: C:\\work\\demo"));
    t.assert.ok(prompt.includes("- Git repository: yes"));
    t.assert.ok(prompt.includes("- Platform: win32"));
    t.assert.ok(prompt.includes("- Model: some/model"));
    t.assert.ok(prompt.includes("- Today's date: 2026-09-19"));
    t.assert.equal(prompt, buildSystemPrompt({ env: ENV }), "the assembly is deterministic");
    // The nine constants really are nine distinct definitions.
    t.assert.equal(new Set(SECTIONS_IN_ORDER.map(([, text]) => text)).size, 9);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheAddonRosterFollowsTheEnvironment extends AssemblyTest {
  readonly id = "an-addon-roster-renders-after-the-environment-and-an-empty-one-renders-nothing";
  readonly whyItExists = "a header with no addons under it told the model there were procedures to load and left it inventing names";

  override run(t: TestRun): void {
    const withAddons = buildSystemPrompt({ env: ENV, addons: [{ name: "x", description: "d" }] });
    t.assert.ok(withAddons.includes("Available addons"), "the roster header is present");
    t.assert.ok(withAddons.includes("\n- x: d"), "the roster line is `- name: description`");
    t.assert.ok(withAddons.indexOf("Available addons") > withAddons.indexOf("Environment:"), "the roster comes after the environment block");

    const without = buildSystemPrompt({ env: ENV, addons: [] });
    t.assert.equal(without.includes("Available addons"), false, "no header when there is nothing to list");
    t.assert.equal(addonsBlock([]), undefined);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ExtraSectionsComeLastInOrder extends AssemblyTest {
  readonly id = "extra-sections-are-appended-at-the-end-in-the-order-given";
  readonly whyItExists = "a subagent's ROLE section spliced in before the environment described a working directory the role text then contradicted";

  override run(t: TestRun): void {
    const prompt = buildSystemPrompt({ env: ENV, addons: [{ name: "x", description: "d" }], extraSections: ["ROLE: you review", "CONTRACT: be brief"] });
    const role = prompt.indexOf("ROLE: you review");
    const contract = prompt.indexOf("CONTRACT: be brief");
    t.assert.ok(role > prompt.indexOf("- x: d"), "extra sections come after the addon roster");
    t.assert.ok(contract > role, "and in the order given");
    t.assert.ok(prompt.endsWith("CONTRACT: be brief"), "the last extra section ends the prompt");
    // Blank extras are dropped rather than leaving an empty paragraph.
    const cleaned = buildSystemPrompt({ env: ENV, extraSections: ["", "   ", "ONLY"] });
    t.assert.ok(cleaned.endsWith("\n\nONLY"));
    t.assert.equal(cleaned.includes("\n\n\n"), false);
  }
}

/* ---- checklist 4 — fs ------------------------------------------------ */

class ADisabledSectionLeavesNoGap extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-section-switched-off-in-the-registry-is-dropped-with-no-blank-gap";
  readonly whyItExists = "an emptied section joined in as a blank paragraph, so switching Git guidance off left a visible hole and the model read the two neighbours as one section";

  /** The registry re-stats an override file after a 250ms trust window; the wait is polled, never assumed. */
  private async until(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`waited 3s for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  override async run(t: TestRun): Promise<void> {
    const dir = this.tempDir("magentra-prompts-");
    this.setEnv("MAGENTRA_PROMPTS_DIR", dir);
    t.assert.equal(isPromptDisabled("system.git"), false, "the section starts enabled — a leftover override would make this test vacuous");
    const before = buildSystemPrompt({ env: ENV });
    t.assert.equal(countOf(before, SECTION_GIT.trim()), 1);

    // A blank override file is how an operator switches a prompt off.
    const file = join(dir, "system.git.txt");
    writeFileSync(file, "", "utf8");
    try {
      await this.until(() => isPromptDisabled("system.git"), "the registry to see the blank override");
      const core = behaviorCore();
      t.assert.equal(core.includes(SECTION_GIT.trim()), false, "the git section is gone from behaviorCore()");
      t.assert.equal(core.includes("\n\n\n"), false, "and it left no double blank line behind");
      const prompt = buildSystemPrompt({ env: ENV });
      t.assert.equal(prompt.includes(SECTION_GIT.trim()), false);
      t.assert.equal(prompt.includes("\n\n\n"), false, "the assembled prompt has no gap either");
      t.assert.ok(prompt.includes(SECTION_HARNESS.trim()) && prompt.includes(SECTION_CODE_STYLE.trim()), "the neighbours are intact");
      t.assert.ok(prompt.includes(environmentBlock(ENV).trim()));
    } finally {
      // Put the registry back before the next test in this process reads it.
      rmSync(file, { force: true });
      await this.until(() => !isPromptDisabled("system.git"), "the registry to see the override removed");
    }
    t.assert.equal(countOf(buildSystemPrompt({ env: ENV }), SECTION_GIT.trim()), 1, "the section is back once the override is gone");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class IdentityRendersItsPlaceholders extends AssemblyTest {
  readonly id = "the-identity-section-renders-the-product-name-and-repository-url";
  readonly whyItExists = "the model introduced itself as '{{product}}' after a refactor moved the placeholders and nobody rendered them";

  override run(t: TestRun): void {
    // The shipped text spells the name and URL out; the prompt is REGISTERED
    // with `product` and `repo` placeholders so an operator's override may use
    // them instead. Both routes must end in the same words reaching the model.
    const registered = promptCatalog().find((p) => p.id === "system.identity");
    t.assert.deepEqual(registered?.placeholders, ["product", "repo"], "the identity prompt declares its two placeholders");
    t.assert.equal(renderPrompt("system.identity", { product: PRODUCT_NAME, repo: PRODUCT_REPO_URL }).includes("{{"), false, "rendering leaves no slot behind");
    t.assert.equal(SECTION_IDENTITY.includes(PRODUCT_NAME), true, "the shipped text names the product");

    const prompt = buildSystemPrompt({ env: ENV });
    t.assert.equal(prompt.includes("{{product}}"), false, "no literal {{product}} reaches the model");
    t.assert.equal(prompt.includes("{{repo}}"), false, "no literal {{repo}} either");
    t.assert.ok(prompt.includes(PRODUCT_NAME), `the product name (${PRODUCT_NAME}) is rendered in`);
    t.assert.ok(prompt.includes(PRODUCT_REPO_URL), `and the repository URL (${PRODUCT_REPO_URL})`);
    t.assert.match(PRODUCT_NAME, /magentra/i);
  }
}

registerFeatureTests(new NineSectionsOnceEachInOrder(), new TheAddonRosterFollowsTheEnvironment(), new ExtraSectionsComeLastInOrder(), new ADisabledSectionLeavesNoGap(), new IdentityRendersItsPlaceholders());
