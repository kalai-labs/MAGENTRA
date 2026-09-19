/**
 * `version-commit-check`.
 *
 * The next version is computed from commit types, so a commit message that
 * does not parse is dropped from the release and the changelog, or bumps the
 * wrong level. `checkMessage` enforces Conventional Commits against
 * `version.config.json` — the 11 types, the 10 scopes, the 72-character
 * subject — and exempts the messages git writes itself. It runs in the
 * commit-msg hook of this very repository.
 *
 * `pure`: a message and a configuration in, a list of problems out. The
 * configuration is the repository's real one, read by the tool's own loader,
 * so the test fails the day a type or scope is added there without this list
 * following.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "version-commit-check";

/** Verbatim from the record. */
const INVARIANT = "checkMessage accepts the 11 configured types and 10 scopes, rejects an over-length subject, and exempts git-generated messages.";

interface Problem {
  message: string;
  hint?: string;
}
interface ParsedCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  subject: string;
  body: string;
}
interface Config {
  types: Record<string, { bump: string; section: string }>;
  scopes: string[];
  subjectMaxLength: number;
}
interface CommitsModule {
  checkMessage(message: string, config: Config): Problem[];
  parseCommit(commit: { subject: string; body?: string }): ParsedCommit | null;
  isGitGenerated(subject: string): boolean;
}
interface ConfigModule {
  loadConfig(root: string): Config;
}

const LIB = join(repoRoot(), "tools", "version", "lib");

async function commits(): Promise<{ lib: CommitsModule; config: Config }> {
  const lib = (await import(pathToFileURL(join(LIB, "commits.mjs")).href)) as CommitsModule;
  const { loadConfig } = (await import(pathToFileURL(join(LIB, "config.mjs")).href)) as ConfigModule;
  return { lib, config: loadConfig(repoRoot()) };
}

abstract class CommitCheckTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class EveryConfiguredTypeAndScopePasses extends CommitCheckTest {
  readonly id = "every-configured-type-and-scope-passes-and-unknown-ones-are-named";
  readonly whyItExists =
    "a type accepted by the hook but unknown to the changelog renderer, or the reverse, is a commit that lands and then vanishes from the release notes";

  override async run(t: TestRun): Promise<void> {
    const { lib, config } = await commits();
    const types = Object.keys(config.types);
    t.assert.equal(types.length, 11, `the repository configures 11 commit types, found ${types.join(", ")}`);
    t.assert.equal(config.scopes.length, 10, `the repository configures 10 scopes, found ${config.scopes.join(", ")}`);
    for (const type of types) {
      t.assert.deepEqual(lib.checkMessage(`${type}: add thing`, config), [], `"${type}: add thing" must pass`);
    }
    for (const scope of config.scopes) {
      t.assert.deepEqual(lib.checkMessage(`fix(${scope}): add thing`, config), [], `"fix(${scope}): add thing" must pass`);
    }
    const unknownType = lib.checkMessage("wip: x", config);
    t.assert.equal(unknownType.length, 1);
    t.assert.equal(unknownType[0]?.message, 'Unknown type: "wip"');
    t.assert.equal(unknownType[0]?.hint, `Use one of: ${types.join(", ")}`, "the hint lists the allowed types");
    const unknownScope = lib.checkMessage("fix(web): x", config);
    t.assert.equal(unknownScope.length, 1);
    t.assert.equal(unknownScope[0]?.message, 'Unknown scope: "web"');
    t.assert.equal(unknownScope[0]?.hint, `Use one of: ${config.scopes.join(", ")}`);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheSubjectLengthIsExact extends CommitCheckTest {
  readonly id = "a-72-character-subject-passes-and-a-73-character-one-is-refused";
  readonly whyItExists = "an off-by-one on the limit refused the commit that git's own guidance considers the maximum, or let a 73-character one truncate in every log view";

  override async run(t: TestRun): Promise<void> {
    const { lib, config } = await commits();
    t.assert.equal(config.subjectMaxLength, 72);
    const head = "fix: ";
    const exactly72 = head + "x".repeat(72 - head.length);
    t.assert.equal(exactly72.length, 72);
    t.assert.deepEqual(lib.checkMessage(exactly72, config), [], "72 characters is allowed");
    const over = lib.checkMessage(`${exactly72}y`, config);
    t.assert.equal(over.length, 1);
    t.assert.equal(over[0]?.message, "The subject is 73 characters. The largest allowed length is 72.");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class GitsOwnMessagesAreExempt extends CommitCheckTest {
  readonly id = "merge-and-revert-messages-git-writes-are-exempt-but-a-look-alike-is-not";
  readonly whyItExists = "the hook refused every merge commit, so a rebase-free workflow could not merge at all without --no-verify, which then hid real problems";

  override async run(t: TestRun): Promise<void> {
    const { lib, config } = await commits();
    t.assert.deepEqual(lib.checkMessage("Merge branch 'x' into main", config), []);
    t.assert.deepEqual(lib.checkMessage('Revert "feat: thing"', config), []);
    t.assert.equal(lib.isGitGenerated("Merge pull request #1 from a/b"), true);
    const lookAlike = lib.checkMessage("Reverting stuff", config);
    t.assert.equal(lookAlike.length, 1);
    t.assert.match(lookAlike[0]?.message ?? "", /does not have the necessary form/, "a human-written 'Reverting …' is an ordinary malformed subject");
    t.assert.equal(lib.isGitGenerated("Reverting stuff"), false);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class StyleProblemsAreEachNamed extends CommitCheckTest {
  readonly id = "full-stop-capital-letter-body-spacing-and-empty-breaking-footer-are-each-reported";
  readonly whyItExists = "a check that stopped at the first problem made the author fix messages one round trip at a time, and a git template's comment lines used to be checked as the subject";

  override async run(t: TestRun): Promise<void> {
    const { lib, config } = await commits();
    const styled = lib.checkMessage("feat: Add thing.", config).map((p) => p.message);
    t.assert.ok(styled.includes("The subject ends with a full stop."), styled.join(" | "));
    t.assert.ok(styled.includes("The subject starts with a capital letter."), styled.join(" | "));
    t.assert.equal(styled.length, 2, "both, and nothing else");

    const glued = lib.checkMessage("feat: x\nbody", config).map((p) => p.message);
    t.assert.deepEqual(glued, ["The line after the subject is not empty."]);

    const footer = lib.checkMessage("feat: x\n\nBREAKING CHANGE:", config).map((p) => p.message);
    t.assert.deepEqual(footer, ["The BREAKING CHANGE footer has no description."]);
    t.assert.deepEqual(lib.checkMessage("feat: x\n\nBREAKING CHANGE: remove the flag", config), [], "a footer with text is fine");

    // Git's comment lines are stripped before the subject is found.
    const templated = lib.checkMessage("# Please enter the commit message\n# Lines starting with # are ignored\nfeat: real subject\n", config);
    t.assert.deepEqual(templated, [], "the real subject behind the template comments is what gets checked");
    t.assert.deepEqual(lib.checkMessage("# only comments\n", config).map((p) => p.message), ["The commit message is empty."]);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ParseCommitReadsBreakingChanges extends CommitCheckTest {
  readonly id = "parsecommit-reads-the-bang-and-the-breaking-change-footer-and-rejects-nonsense";
  readonly whyItExists = "a breaking change marked only in the footer was released as a patch, and a subject that did not parse crashed the plan instead of being listed as ignored";

  override async run(t: TestRun): Promise<void> {
    const { lib } = await commits();
    const bang = lib.parseCommit({ subject: "feat(core)!: x" });
    t.assert.equal(bang?.breaking, true);
    t.assert.equal(bang?.type, "feat");
    t.assert.equal(bang?.scope, "core");
    t.assert.equal(bang?.subject, "x");
    t.assert.equal(lib.parseCommit({ subject: "fix: x", body: "BREAKING-CHANGE: y" })?.breaking, true, "the hyphenated footer spelling counts");
    t.assert.equal(lib.parseCommit({ subject: "fix: x", body: "BREAKING CHANGE" })?.breaking, false, "a footer with no colon and no text is not a break");
    t.assert.equal(lib.parseCommit({ subject: "fix: x" })?.scope, null, "no scope is null, not undefined");
    t.assert.equal(lib.parseCommit({ subject: "nonsense" }), null, "a subject without the form is null, never a throw");
  }
}

registerFeatureTests(
  new EveryConfiguredTypeAndScopePasses(),
  new TheSubjectLengthIsExact(),
  new GitsOwnMessagesAreExempt(),
  new StyleProblemsAreEachNamed(),
  new ParseCommitReadsBreakingChanges(),
);
