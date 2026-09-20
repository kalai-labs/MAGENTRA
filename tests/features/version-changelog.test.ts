/**
 * `version-changelog`.
 *
 * `CHANGELOG.md` is written by the version tool, never by hand. `renderRelease`
 * turns a plan into one Markdown section — heading, breaking changes, one block
 * per configured commit type in configuration order, a compare link — and
 * `prependRelease` puts it at the top under the `<!-- new-release -->` marker
 * without touching what is already there.
 *
 * `pure` + `fs`, and the record said `pure`. Rendering is a function of the
 * plan (items 1–3). Prepending is a file rewritten in place (items 4–5), and
 * what is asserted is the file. Re-declared 2026-09-19.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "version-changelog";

/** Verbatim from the record. */
const INVARIANT = "renderRelease groups commits into their configured sections and prependRelease inserts without disturbing earlier entries.";

interface Version {
  major: number;
  minor: number;
  patch: number;
}
interface ParsedCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  subject: string;
  body: string;
  hash: string;
  shortHash: string;
}
interface Plan {
  current: Version;
  next: Version;
  level: string | null;
  isFirstRelease: boolean;
  hasRelease: boolean;
  fromTag: string | null;
  commits: ParsedCommit[];
  ignored: { subject: string; shortHash: string }[];
}
interface Config {
  tagPrefix: string;
  types: Record<string, { bump: string; section: string }>;
}
interface ChangelogModule {
  renderRelease(plan: Plan, config: Config, options: { date: string; repositoryUrl: string | null }): string;
  prependRelease(root: string, release: string): void;
}

const LIB = join(repoRoot(), "tools", "version", "lib");
const URL = "https://github.com/example/magentra";

async function changelog(): Promise<{ lib: ChangelogModule; config: Config }> {
  const lib = (await import(pathToFileURL(join(LIB, "changelog.mjs")).href)) as ChangelogModule;
  const { loadConfig } = (await import(pathToFileURL(join(LIB, "config.mjs")).href)) as { loadConfig(root: string): Config };
  return { lib, config: loadConfig(repoRoot()) };
}

function commit(type: string, subject: string, extra: Partial<ParsedCommit> = {}): ParsedCommit {
  return { type, scope: null, breaking: false, subject, body: "", hash: "0123456789abcdef0123456789abcdef01234567", shortHash: "0123456", ...extra };
}

function plan(commits: ParsedCommit[], extra: Partial<Plan> = {}): Plan {
  return {
    current: { major: 1, minor: 0, patch: 0 },
    next: { major: 1, minor: 1, patch: 0 },
    level: "minor",
    isFirstRelease: false,
    hasRelease: true,
    fromTag: "v1.0.0",
    commits,
    ignored: [],
    ...extra,
  };
}

/* ---- checklist 1 — pure ---------------------------------------------- */

class SectionsFollowTheConfiguration extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "sections-appear-in-configuration-order-empty-ones-are-skipped-and-bullets-link-when-a-url-is-given";
  readonly whyItExists = "sections in commit order made every release read differently, and a bullet with a link to a repository that was not GitHub produced dead links in the notes";

  override async run(t: TestRun): Promise<void> {
    const { lib, config } = await changelog();
    const commits = [commit("docs", "explain it"), commit("fix", "stop the crash", { scope: "app" }), commit("feat", "add the thing")];
    const text = lib.renderRelease(plan(commits), config, { date: "2026-09-19", repositoryUrl: URL });

    const headings = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    t.assert.deepEqual(headings, ["Features", "Bug fixes", "Documentation"], "configuration order, and only the sections with commits");
    t.assert.equal(text.includes("### Chores"), false, "an empty section is skipped");
    t.assert.equal(text.startsWith("## 1.1.0 — 2026-09-19\n"), true, "the heading is the next version and the date");
    t.assert.ok(text.includes(`- **app:** stop the crash ([0123456](${URL}/commit/0123456789abcdef0123456789abcdef01234567))`), "a scoped, linked bullet");
    t.assert.ok(text.includes(`- add the thing ([0123456](${URL}/commit/`), "an unscoped, linked bullet");

    const plain = lib.renderRelease(plan(commits), config, { date: "2026-09-19", repositoryUrl: null });
    t.assert.ok(plain.includes("\n- add the thing\n"), "with no repository URL a bullet is the bare subject");
    t.assert.equal(plain.includes("/commit/"), false, "and carries no link");
  }
}

/* ---- checklist 2 — pure ---------------------------------------------- */

class BreakingChangesAndTheCompareLink extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "breaking-changes-get-their-own-block-with-the-footer-note-and-a-compare-link-closes-the-section";
  readonly whyItExists = "a breaking change buried in its type's section was missed by the people it broke, and a footer note split over two lines lost its second half";

  override async run(t: TestRun): Promise<void> {
    const { lib, config } = await changelog();
    const breaking = commit("feat", "drop the old flag", { breaking: true, body: "BREAKING CHANGE: remove X\nuse Y instead\n\nSigned-off-by: someone" });
    const text = lib.renderRelease(plan([breaking, commit("fix", "small")]), config, { date: "2026-09-19", repositoryUrl: URL });

    const block = text.slice(text.indexOf("### Breaking changes"), text.indexOf("### Features"));
    t.assert.ok(block.includes("- drop the old flag ("), "the breaking commit is listed in its own block first");
    t.assert.ok(block.includes("\n  remove X use Y instead\n"), "the footer note, continuation lines joined, indented under the bullet");
    t.assert.equal(block.includes("Signed-off-by"), false, "a trailer after the note is not part of it");
    t.assert.ok(text.includes("### Features\n\n- drop the old flag ("), "and the commit still appears in its own type's section");
    t.assert.ok(text.trimEnd().endsWith(`[Compare with v1.0.0](${URL}/compare/v1.0.0...v1.1.0)`), "the compare link uses the tag prefix and closes the section");
  }
}

/* ---- checklist 3 — pure ---------------------------------------------- */

class TheFirstReleaseSaysSo extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-first-release-renders-the-first-release-and-no-compare-link";
  readonly whyItExists = "a compare link from a tag that does not exist is a 404 on the very first release page anyone opens";

  override async run(t: TestRun): Promise<void> {
    const { lib, config } = await changelog();
    const first = plan([commit("feat", "begin")], { isFirstRelease: true, fromTag: null, level: null, next: { major: 0, minor: 1, patch: 0 } });
    const text = lib.renderRelease(first, config, { date: "2026-09-19", repositoryUrl: URL });
    t.assert.ok(text.startsWith("## 0.1.0 — 2026-09-19\n\nThe first release.\n"), "the heading is followed by the first-release line");
    t.assert.equal(text.includes("Compare with"), false, "no compare link, even with a repository URL");
    t.assert.ok(text.includes("### Features\n\n- begin"), "the commits still render");
  }
}

/* ---- checklist 4 — fs ------------------------------------------------ */

abstract class ChangelogFileTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

class PrependingKeepsEarlierEntriesIntact extends ChangelogFileTest {
  readonly id = "prepending-creates-the-file-under-the-marker-and-a-second-release-goes-above-the-first-unchanged";
  readonly whyItExists = "an insertion that rewrote the file from a template lost every hand-fixed typo in earlier sections, and one that appended put the newest release at the bottom";

  override async run(t: TestRun): Promise<void> {
    const { lib } = await changelog();
    const root = this.tempDir("magentra-changelog-");
    const file = join(root, "CHANGELOG.md");
    t.assert.equal(existsSync(file), false);

    const first = "## 1.0.0 — 2026-09-01\n\n### Features\n\n- begin\n";
    lib.prependRelease(root, first);
    const created = readFileSync(file, "utf8");
    t.assert.ok(created.startsWith("# Changelog\n"), "a new file gets the fixed header");
    t.assert.ok(created.includes("<!-- new-release -->\n\n## 1.0.0 — 2026-09-01"), "the marker, two newlines, then the release");
    t.assert.ok(created.endsWith(first), "the first release is the tail of the file, byte for byte");

    const second = "## 1.1.0 — 2026-09-19\n\n### Bug fixes\n\n- mend\n";
    lib.prependRelease(root, second);
    const grown = readFileSync(file, "utf8");
    const marker = grown.indexOf("<!-- new-release -->");
    t.assert.ok(grown.indexOf("## 1.1.0") > marker, "the second release sits after the marker");
    t.assert.ok(grown.indexOf("## 1.1.0") < grown.indexOf("## 1.0.0"), "and above the first");
    t.assert.ok(grown.endsWith(first), "the first section is unchanged byte for byte below it");
    t.assert.equal(grown.slice(0, marker), created.slice(0, marker), "nothing above the marker moved");
  }
}

/* ---- checklist 5 — fs ------------------------------------------------ */

class AHandWrittenFileIsRespected extends ChangelogFileTest {
  readonly id = "without-a-marker-the-release-goes-before-the-first-heading-or-after-everything";
  readonly whyItExists = "a project adopting the tool has a changelog with an intro and no marker; inserting at the top would put a release above the intro, and failing would block the release";

  override async run(t: TestRun): Promise<void> {
    const { lib } = await changelog();
    const withHeadings = this.tempDir("magentra-changelog-hand-");
    const intro = "# History\n\nAn intro paragraph that must stay first.\n";
    const older = "\n## 0.9.0\n\n- old\n\n## 0.8.0\n\n- older\n";
    writeFileSync(join(withHeadings, "CHANGELOG.md"), intro + older, "utf8");
    const release = "## 1.0.0 — 2026-09-19\n\n- new\n";
    lib.prependRelease(withHeadings, release);
    const result = readFileSync(join(withHeadings, "CHANGELOG.md"), "utf8");
    t.assert.ok(result.startsWith(intro), "the intro is still first");
    t.assert.ok(result.indexOf("## 1.0.0") < result.indexOf("## 0.9.0"), "the release sits before the first existing heading");
    t.assert.ok(result.endsWith(older), "every existing section is intact");

    const noHeadings = this.tempDir("magentra-changelog-flat-");
    writeFileSync(join(noHeadings, "CHANGELOG.md"), "Some notes.\n\n\n", "utf8");
    lib.prependRelease(noHeadings, release);
    t.assert.equal(readFileSync(join(noHeadings, "CHANGELOG.md"), "utf8"), `Some notes.\n\n${release}`, "with no heading the release is appended after the trimmed content");
  }
}

registerFeatureTests(
  new SectionsFollowTheConfiguration(),
  new BreakingChangesAndTheCompareLink(),
  new TheFirstReleaseSaysSo(),
  new PrependingKeepsEarlierEntriesIntact(),
  new AHandWrittenFileIsRespected(),
);
