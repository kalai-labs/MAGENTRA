/**
 * `tool-glob`.
 *
 * Glob lists files whose PATH matches a pattern; it never reads a byte of
 * content. `node_modules` and `.git` are always ignored, and MAGENTRA's own
 * `.magentra` state directory is ignored too — unless the caller named it, as
 * a path SEGMENT, in the pattern or in the search root. Results are newest
 * modified first, capped at 1000 with a truncation note, and no match is an
 * ordinary result rather than an error.
 *
 * `fs`, as the record declares: every assertion here is about real files in a
 * real temp directory, matched by the real `fast-glob`.
 *
 * The tool runs through the same validate-then-execute path the Session uses
 * (`tests/lib/directTool.ts`) against `strictServices({})` — Glob reaches for
 * no session service at all, so a service appearing in a future version fails
 * these tests by name instead of reading `undefined`.
 *
 * TWO PLATFORM FACTS, MEASURED RATHER THAN ASSUMED.
 *  - With `absolute: true`, fast-glob returns FORWARD slashes on Windows
 *    (`C:/Users/…/a.txt`) while `path.join` produces backslashes, so every
 *    expected path is built with `join` and then converted with {@link posix}.
 *  - The `dot` input defaults to `false` (`z.boolean().optional()`,
 *    `input.dot ?? false`), so the checklist's dot-directory cases pass it
 *    explicitly.
 */

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import type { ToolContext } from "@magentra/core";
import { globTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "tool-glob";

/** Verbatim from the record. */
const INVARIANT =
  "Glob keeps .magentra out of results unless the pattern or path names it, matched on a path SEGMENT, and orders by mtime descending.";

/** A path as fast-glob spells it with `absolute: true`: forward slashes, on every platform. */
function posix(path: string): string {
  return path.split(sep).join("/");
}

abstract class GlobTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected dir = "";

  override setUp(): void {
    this.dir = this.tempDir("magentra-glob-");
  }

  /** The absolute path of `rel`, spelled the way a Glob result line spells it. */
  protected expected(rel: string): string {
    return posix(join(this.dir, rel));
  }

  protected ctx(): ToolContext {
    return { cwd: this.dir, session: strictServices({}) };
  }

  /** The result's lines — one match per line, plus any truncation note. */
  protected async glob(input: Record<string, unknown>): Promise<string[]> {
    const result = await runTool(globTool, input, this.ctx());
    if (result.isError === true) throw new Error(`Glob refused ${JSON.stringify(input)}: ${resultText(result)}`);
    return resultText(result).split("\n");
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheStateDirectoryIsSkippedOnASegmentMatch extends GlobTest {
  readonly id = "a-dot-true-search-skips-magentra-node-modules-and-git-but-not-a-lookalike-name";
  readonly whyItExists =
    "a dot:true search matched .magentra/**, so one 'find the config files' call dumped session transcripts and whole worktree checkouts into the context; a substring exclusion instead of a segment one then hid docs/magentra-notes.md and .magentra-backup/, which are the user's own files";

  override async run(t: TestRun): Promise<void> {
    this.writeFile(join(this.dir, "a.txt"), "a");
    this.writeFile(join(this.dir, ".magentra", "s.json"), "{}");
    this.writeFile(join(this.dir, "node_modules", "n.txt"), "n");
    this.writeFile(join(this.dir, ".git", "g.txt"), "g");
    this.writeFile(join(this.dir, "docs", "magentra-notes.md"), "notes");
    this.writeFile(join(this.dir, ".magentra-backup", "b.txt"), "b");

    const lines = await this.glob({ pattern: "**/*", dot: true });

    t.assert.ok(lines.includes(this.expected("a.txt")), `a.txt is listed; got ${JSON.stringify(lines)}`);
    t.assert.ok(
      lines.includes(this.expected(join("docs", "magentra-notes.md"))),
      "a FILE with magentra in its name is not the state directory",
    );
    t.assert.ok(
      lines.includes(this.expected(join(".magentra-backup", "b.txt"))),
      "a DIRECTORY whose name merely starts with .magentra is not the state directory either",
    );

    t.assert.equal(lines.includes(this.expected(join(".magentra", "s.json"))), false, "the state directory is skipped");
    t.assert.equal(lines.includes(this.expected(join("node_modules", "n.txt"))), false, "node_modules is always skipped");
    t.assert.equal(lines.includes(this.expected(join(".git", "g.txt"))), false, ".git is always skipped");
    t.assert.equal(lines.length, 3, `exactly those three matched; got ${JSON.stringify(lines)}`);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class NamingTheSegmentOptsIn extends GlobTest {
  readonly id = "naming-magentra-in-the-pattern-or-in-the-search-path-lists-it";
  readonly whyItExists =
    "an unconditional .magentra exclusion made the state directory unreachable, so an agent asked to read a session transcript got 'No files match the pattern.' for a file that was plainly there";

  override async run(t: TestRun): Promise<void> {
    this.writeFile(join(this.dir, "a.txt"), "a");
    this.writeFile(join(this.dir, ".magentra", "s.json"), "{}");

    const named = await this.glob({ pattern: ".magentra/**/*.json" });
    t.assert.deepEqual(named, [this.expected(join(".magentra", "s.json"))], "the pattern names the segment, so it is listed");

    const rooted = await this.glob({ pattern: "**/*", path: join(this.dir, ".magentra"), dot: true });
    t.assert.deepEqual(rooted, [this.expected(join(".magentra", "s.json"))], "the search ROOT names the segment, so it is listed");

    // And the opt-in is not a global switch: the same workspace without the
    // segment still hides it.
    const unnamed = await this.glob({ pattern: "**/*", dot: true });
    t.assert.deepEqual(unnamed, [this.expected("a.txt")], "no segment named, so the state directory stays out");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class NewestModifiedFirst extends GlobTest {
  readonly id = "results-are-ordered-by-modification-time-newest-first";
  readonly whyItExists =
    "results came back in directory order, so the file the user had just edited sat below hundreds of untouched ones and the agent read the wrong end of the list first";

  override async run(t: TestRun): Promise<void> {
    this.writeFile(join(this.dir, "old.txt"), "o");
    this.writeFile(join(this.dir, "mid.txt"), "m");
    this.writeFile(join(this.dir, "new.txt"), "n");

    // Explicit times, seconds apart: NTFS and HFS+ granularity both round, and
    // three files written in one tick are otherwise indistinguishable.
    const now = Date.now() / 1000;
    utimesSync(join(this.dir, "old.txt"), now - 300, now - 300);
    utimesSync(join(this.dir, "mid.txt"), now - 200, now - 200);
    utimesSync(join(this.dir, "new.txt"), now - 100, now - 100);

    const lines = await this.glob({ pattern: "*.txt" });
    t.assert.deepEqual(
      lines,
      [this.expected("new.txt"), this.expected("mid.txt"), this.expected("old.txt")],
      "newest modified first, descending",
    );
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class NoMatchIsNotAnError extends GlobTest {
  readonly id = "a-pattern-that-matches-nothing-is-an-ordinary-result";
  readonly whyItExists =
    "an empty match was returned with isError:true, so the agent treated 'this project has no .rs files' as a broken tool and retried the same search instead of concluding";

  override async run(t: TestRun): Promise<void> {
    this.writeFile(join(this.dir, "a.txt"), "a");

    const result = await runTool(globTool, { pattern: "**/*.nothing-matches-this" }, this.ctx());
    t.assert.equal(resultText(result), "No files match the pattern.");
    t.assert.equal(result.isError, undefined, "an empty result is not an error");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ResultsAreCappedAtAThousand extends GlobTest {
  readonly id = "a-thousand-paths-are-returned-followed-by-a-truncation-note";
  readonly whyItExists =
    "an uncapped '**/*' over a large repository returned every path at once, which spent the whole context window on a directory listing before the agent had read a single file";

  override readonly timeoutMs = 60_000;

  override async run(t: TestRun): Promise<void> {
    const many = join(this.dir, "many");
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 1005; i++) writeFileSync(join(many, `f${String(i).padStart(4, "0")}.txt`), "x", "utf8");

    const lines = await this.glob({ pattern: "many/*.txt" });

    t.assert.equal(lines.length, 1001, "1000 paths plus one truncation line");
    const paths = lines.slice(0, 1000);
    t.assert.equal(paths.length, 1000, "exactly 1000 paths");
    t.assert.equal(
      paths.every((line) => line.startsWith(this.expected(join("many", "f")))),
      true,
      "every one of the first 1000 lines is a match, not a note",
    );
    t.assert.ok(
      lines[1000]?.includes("truncated — 5 more matches"),
      `the last line names how many were dropped; got ${JSON.stringify(lines[1000])}`,
    );
  }
}

registerFeatureTests(
  new TheStateDirectoryIsSkippedOnASegmentMatch(),
  new NamingTheSegmentOptsIn(),
  new NewestModifiedFirst(),
  new NoMatchIsNotAnError(),
  new ResultsAreCappedAtAThousand(),
);
