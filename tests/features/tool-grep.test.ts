/**
 * `tool-grep`.
 *
 * Grep is a thin skin over the bundled ripgrep, and the whole of the skin is
 * how it reads what ripgrep returns. Two readings are the feature: exit code 1
 * means NO MATCHES and is an ordinary result, not a failure; and a result too
 * big for the 20MB buffer is a TRUNCATED RESULT, not a failure either. Get
 * either wrong and the agent is told its search broke when it worked.
 *
 * `proc`, as the record declares: every assertion here is the output of the
 * real `@vscode/ripgrep` binary, executed by the real tool over real files.
 * The tool runs through the real validate-then-execute path
 * (`tests/lib/directTool.ts`) against `strictServices({})` — Grep reaches for
 * no session service at all, so one appearing in a future version fails these
 * tests by name instead of reading `undefined`.
 *
 * TWO PLATFORM FACTS, MEASURED RATHER THAN ASSUMED.
 *  - The tool passes `ctx.cwd` to ripgrep as an ABSOLUTE search root, and
 *    ripgrep echoes paths in the platform's own spelling — backslashes on
 *    Windows. So every expected path is built with `path.join`, unlike the Glob
 *    tests next door, where fast-glob normalises to forward slashes.
 *  - `@vscode/ripgrep` ships twelve per-platform binary packages as OPTIONAL
 *    dependencies and installs exactly one. The test below does not assume
 *    which: it reads what is on disk and requires that the one present is this
 *    platform's and the other eleven are absent — the Windows truth on Windows,
 *    the Linux truth on Linux, never a skip.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { rgPath } from "@vscode/ripgrep";
import type { ToolContext } from "@magentra/core";
import { grepTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";

const FEATURE = "tool-grep";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT =
  'Grep maps ripgrep exit codes correctly — 1 is "no matches", not an error — and treats a blown 20MB buffer as a truncated RESULT rather than a failure.';

/** The buffer the tool gives `execFile`. A result past it is truncated, never failed. */
const MAX_BUFFER = 20 * 1024 * 1024;

abstract class GrepTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #dirs: string[] = [];
  protected dir = "";

  override setUp(): void {
    // `realpath`, because macOS's tmpdir is a symlink (/var → /private/var) and
    // ripgrep echoes the path it was handed.
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), "magentra-grep-")));
    this.#dirs.push(this.dir);
  }

  protected ctx(): ToolContext {
    return { cwd: this.dir, session: strictServices({}) };
  }

  protected write(name: string, contents: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, contents, "utf8");
    return path;
  }

  protected async grep(input: Record<string, unknown>) {
    return runTool(grepTool, input, this.ctx());
  }

  protected async grepLines(input: Record<string, unknown>): Promise<string[]> {
    return resultText(await this.grep(input)).split("\n");
  }

  /**
   * Removed HERE, with retries: the biggest of these fixtures is a 24MB file
   * ripgrep had open, and Windows keeps a handle a moment after the process is
   * gone while `force` only forgives ENOENT.
   */
  override tearDown(): void {
    const dirs = this.#dirs;
    this.#dirs = [];
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class NoMatchesIsAResult extends GrepTest {
  readonly id = "exit-code-1-is-no-matches-and-not-an-error";
  readonly whyItExists =
    "ripgrep exits 1 when it finds nothing, and every non-zero code was read as a failure — so `isError: true` came back for a search that ran perfectly, and the agent kept re-running it with looser patterns instead of concluding the string was not there";

  override async run(t: TestRun): Promise<void> {
    this.write("a.txt", "hello\n");
    this.write("b.txt", "world\n");

    const empty = await this.grep({ pattern: "zzz" });
    t.assert.equal(resultText(empty), "No matches found.", "an empty search has its own sentence, not an empty string");
    t.assert.equal(empty.isError, undefined, "exit code 1 is the answer 'nothing matched'; it is not a failure");

    // The distinction is only worth anything if a REAL failure still is one.
    const broken = await this.grep({ pattern: "[" });
    t.assert.equal(broken.isError, true, "a code ripgrep uses for an actual error must stay an error");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheThreeOutputModes extends GrepTest {
  readonly id = "the-three-output-modes-answer-three-different-questions";
  readonly whyItExists =
    "content mode was built without `--line-number` even though `-n` defaults to true, so every quoted line arrived without the number the agent needed to open it — and a mode that silently fell back to file names made a 'show me the matches' call return nothing to read";

  override async run(t: TestRun): Promise<void> {
    const a = this.write("a.txt", "hello\n");
    const b = this.write("b.txt", "world\n");

    // The default: paths only.
    const files = await this.grepLines({ pattern: "hello" });
    t.assert.deepEqual(files, [a], "files_with_matches is the default and returns the path, spelled as this platform spells it");
    t.assert.equal(files.includes(b), false);

    // content: the heading, then `<line>:<text>` — `-n` defaults to true.
    const content = await this.grepLines({ pattern: "hello", output_mode: "content" });
    t.assert.deepEqual(content, [a, "1:hello"], "content mode must carry the line number, which is what makes a hit navigable");
    t.assert.equal(content.some((line) => line.includes(basename(b))), false, "a non-matching file must not appear");

    // count: one number per file.
    const count = await this.grepLines({ pattern: "hello", output_mode: "count" });
    t.assert.deepEqual(count, [`${a}:1`], "count mode is path:count, not a bare number");

    // And the filters really filter, rather than being accepted and dropped.
    const filtered = await this.grepLines({ pattern: "o", glob: "b.txt" });
    t.assert.deepEqual(filtered, [b], "a glob filter that is ignored turns a narrow search into a whole-tree one");
    const insensitive = await this.grepLines({ pattern: "HELLO", "-i": true, output_mode: "content" });
    t.assert.deepEqual(insensitive, [a, "1:hello"], "-i must reach ripgrep as --ignore-case");
    t.assert.equal(resultText(await this.grep({ pattern: "HELLO" })), "No matches found.", "without -i the same pattern must miss");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ABadPatternIsAnError extends GrepTest {
  readonly id = "an-unparseable-pattern-is-a-named-ripgrep-error-on-this-platforms-own-binary";
  readonly whyItExists =
    "an invalid regex was returned as an ordinary empty result, so the agent read 'no matches' and moved on believing the string was absent — and the message that said exactly which character was wrong was thrown away";

  override async run(t: TestRun): Promise<void> {
    this.write("a.txt", "hello\n");

    const broken = await this.grep({ pattern: "[" });
    const text = resultText(broken);
    t.assert.equal(broken.isError, true, "a pattern ripgrep cannot parse is a failure, and the agent has to be told");
    t.assert.ok(text.startsWith("ripgrep error:"), `the error must name its source; it said ${JSON.stringify(text.slice(0, 60))}`);
    // ripgrep's own diagnostic, not a message this tool invented — which is
    // also the proof that the real bundled binary ran.
    t.assert.match(text, /regex parse error/);
    t.assert.match(text, /unclosed character class/);

    // The binary that produced it is this platform's, and it is the ONLY one
    // installed. `@vscode/ripgrep` lists twelve per-platform packages as
    // optional dependencies; npm installs the one that matches.
    t.assert.equal(existsSync(rgPath), true, `the bundled ripgrep is missing from ${rgPath}`);
    t.assert.equal(
      basename(rgPath),
      process.platform === "win32" ? "rg.exe" : "rg",
      "the executable is named for the platform that runs it",
    );

    const platformDir = dirname(dirname(rgPath));
    const scopeDir = dirname(platformDir);
    t.assert.equal(
      basename(platformDir),
      `ripgrep-${process.platform}-${process.arch}`,
      `rgPath must resolve into this platform's package; it resolved into ${platformDir}`,
    );

    const declared = Object.keys(
      (JSON.parse(readFileSync(join(scopeDir, "ripgrep", "package.json"), "utf8")) as {
        optionalDependencies?: Record<string, string>;
      }).optionalDependencies ?? {},
    ).map((name) => name.replace("@vscode/", ""));
    t.assert.ok(declared.length > 1, "the per-platform packages must still be optional dependencies of @vscode/ripgrep");

    const installed = readdirSync(scopeDir).filter((name) => declared.includes(name));
    t.assert.deepEqual(
      installed,
      [basename(platformDir)],
      `exactly one per-platform ripgrep is installed, and it is this platform's; found ${JSON.stringify(installed)}`,
    );
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class HeadLimitCapsAndSaysSo extends GrepTest {
  readonly id = "head-limit-caps-the-output-and-names-what-it-cut";
  readonly whyItExists =
    "a broad search returned every line it found and buried the context window, and capping it silently was worse: the agent read ten hits, concluded there were ten, and refactored the other nine hundred and ninety-one out from under itself";

  override async run(t: TestRun): Promise<void> {
    this.write("many.txt", `${Array.from({ length: 1_000 }, (_, i) => `needle ${i}`).join("\n")}\n`);

    const lines = await this.grepLines({ pattern: "needle", output_mode: "content", head_limit: 10, glob: "many.txt" });

    // head_limit counts OUTPUT lines, and `--heading` spends one of them on the
    // file name — so ten lines is the heading plus nine matches.
    t.assert.equal(lines.length, 11, `ten capped lines plus one truncation note; got ${lines.length}`);
    t.assert.equal(lines[0], join(this.dir, "many.txt"), "the heading is the first of the ten");
    t.assert.deepEqual(lines.slice(1, 10), Array.from({ length: 9 }, (_, i) => `${i + 1}:needle ${i}`));
    t.assert.equal(
      lines[10],
      "[truncated — 991 more lines; raise head_limit or narrow the pattern]",
      "the note must say how many lines were dropped and how to get them",
    );

    // Under the cap there is no note at all — otherwise every complete result
    // would look partial.
    const whole = await this.grepLines({ pattern: "needle 999", output_mode: "content", glob: "many.txt" });
    t.assert.deepEqual(whole, [join(this.dir, "many.txt"), "1000:needle 999"]);
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ABlownBufferIsATruncatedResult extends GrepTest {
  readonly id = "a-blown-20mb-buffer-is-a-truncated-result-not-a-failure";
  readonly whyItExists =
    "`execFile` reports a blown maxBuffer as an error with the captured stdout still attached, and returning that as a failure threw away every match the search had already found — one over-broad pattern turned into nothing at all instead of into the first few hundred hits";

  override async run(t: TestRun): Promise<void> {
    // More than 20MB of MATCHING output, so ripgrep fills the buffer and
    // `execFile` aborts it. Nothing is monkeypatched: the real binary really
    // overruns the real buffer the tool really configured.
    const line = `needle ${"x".repeat(100)}\n`;
    const block = line.repeat(50_000);
    const blocks: string[] = [];
    for (let written = 0; written < MAX_BUFFER + 4 * 1024 * 1024; written += block.length) blocks.push(block);
    const big = this.write("big.txt", blocks.join(""));

    const result = await this.grep({ pattern: "needle", output_mode: "content", head_limit: 5 });
    const text = resultText(result);
    const lines = text.split("\n");

    t.assert.equal(result.isError, undefined, "too many matches is an answer, not a failure");
    t.assert.equal(
      lines[lines.length - 1],
      "[truncated — output exceeded the 20MB buffer; narrow the pattern or add a glob filter]",
      `the note must name the buffer as the cause; the result ended ${JSON.stringify(text.slice(-120))}`,
    );
    t.assert.equal(
      /more lines; raise head_limit/.test(text),
      false,
      "the buffer overrun and the head_limit cap are different causes and must not be reported as the same one",
    );

    // What survived is real output, capped at head_limit, not an empty husk
    // with a note bolted on.
    t.assert.equal(lines.length, 6, `head_limit lines plus the note; got ${lines.length}`);
    t.assert.equal(lines[0], big, "the heading of the file the matches came from");
    t.assert.deepEqual(
      lines.slice(1, 5),
      Array.from({ length: 4 }, (_, i) => `${i + 1}:needle ${"x".repeat(100)}`),
      "the matches captured before the buffer blew must be returned, not discarded",
    );
  }
}

registerFeatureTests(
  new NoMatchesIsAResult(),
  new TheThreeOutputModes(),
  new ABadPatternIsAnError(),
  new HeadLimitCapsAndSaysSo(),
  new ABlownBufferIsATruncatedResult(),
);
