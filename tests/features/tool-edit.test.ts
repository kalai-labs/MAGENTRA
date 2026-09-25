/**
 * `tool-edit`.
 *
 * Edit replaces one exact string in a file. The file must have been Read this
 * session and must not have moved on disk since (`FileState.checkFresh`), and
 * `old_string` must occur exactly once unless `replace_all` is set. Zero
 * matches and more than one match are DIFFERENT errors — the zero-match one
 * also tells the caller not to paste the Read line-number prefix back in.
 * Identical old/new is refused outright. A success rewrites the file, re-stamps
 * the freshness record and emits a `file_edited` event with a unified diff.
 *
 * `fs`, as the record declares: every case is a real file on disk, edited or
 * left alone.
 *
 * The tool runs against a REAL `FileState` from `@magentra/core`, through the
 * same validate-then-execute path the Session uses (`tests/lib/directTool.ts`).
 * `emit` is this test's own collector, standing where the Engine's queue would.
 * Nothing the tool does is stubbed, and `strictServices` turns any other
 * service the tool reaches for into a named failure.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FileState, type ToolContext } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";
import { editTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "tool-edit";

/** Verbatim from the record. */
const INVARIANT =
  "Edit requires a prior Read, requires old_string to be unique unless replace_all, and reports 0 and >1 occurrences differently.";

abstract class EditTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected events: CoreEvent[] = [];
  protected dir = "";

  /** The real freshness store the Session hands every tool. */
  protected readonly state = new FileState();

  protected workspace(): string {
    if (this.dir === "") this.dir = this.tempDir("magentra-edit-");
    return this.dir;
  }

  protected file(name: string, contents: string): string {
    const path = join(this.workspace(), name);
    writeFileSync(path, contents);
    return path;
  }

  protected ctx(): ToolContext {
    return {
      cwd: this.workspace(),
      session: strictServices({
        fileState: this.state,
        emit: (event: CoreEvent) => {
          this.events.push(event);
        },
      }),
    };
  }

  /** The diffs announced so far, in order. */
  protected diffs(): string[] {
    return this.events.flatMap((event) => (event.type === "file_edited" ? [event.diff] : []));
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class AnUnreadFileCannotBeEdited extends EditTest {
  readonly id = "editing-a-file-never-read-this-session-fails";
  readonly whyItExists =
    "an Edit that went straight to writeFileSync applied a replacement the model had invented from a filename, changing a file whose contents it had never seen";

  override async run(t: TestRun): Promise<void> {
    const path = this.file("a.txt", "a\nb\n");
    t.assert.equal(this.state.wasRead(path), false, "nothing has Read it");

    const result = await runTool(editTool, { file_path: path, old_string: "a", new_string: "z" }, this.ctx());
    t.assert.equal(result.isError, true, "editing an unread file is an error");
    t.assert.equal(
      resultText(result).includes("has not been read in this session"),
      true,
      `it says why; it said ${JSON.stringify(resultText(result))}`,
    );
    t.assert.equal(readFileSync(path, "utf8"), "a\nb\n", "and the file is untouched");
    t.assert.equal(this.diffs().length, 0, "a refused edit announces nothing");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class AFileChangedOnDiskCannotBeEdited extends EditTest {
  readonly id = "editing-a-file-that-moved-on-disk-since-the-read-fails";
  readonly whyItExists =
    "an Edit applied against a stale copy matched a snippet whose surroundings had changed, so the replacement landed in the wrong place in the user's newer file";

  override async run(t: TestRun): Promise<void> {
    const path = this.file("b.txt", "a\nb\n");
    this.state.recordRead(path);
    t.assert.equal(this.state.checkFresh(path), undefined, "fresh straight after the read");

    appendFileSync(path, "c\n");
    const result = await runTool(editTool, { file_path: path, old_string: "a", new_string: "z" }, this.ctx());
    t.assert.equal(result.isError, true, "editing a file that moved on disk is an error");
    t.assert.equal(
      resultText(result).includes("modified on disk since it was last read"),
      true,
      `it says why; it said ${JSON.stringify(resultText(result))}`,
    );
    t.assert.equal(readFileSync(path, "utf8"), "a\nb\nc\n", "the newer content on disk survived");
    t.assert.equal(this.diffs().length, 0, "a refused edit announces nothing");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ZeroAndManyMatchesAreDifferentErrors extends EditTest {
  readonly id = "no-match-and-several-matches-fail-with-different-messages";
  readonly whyItExists =
    "one shared 'edit failed' message left the model unable to tell a typo from an ambiguous snippet: it retried the same string on a file with two matches, and pasted the Read line-number prefix back in because nothing ever told it not to";

  override async run(t: TestRun): Promise<void> {
    const original = "foo one\nbar\nfoo two\n";
    const path = this.file("c.txt", original);
    this.state.recordRead(path);

    const many = await runTool(editTool, { file_path: path, old_string: "foo", new_string: "bar" }, this.ctx());
    t.assert.equal(many.isError, true, "an ambiguous snippet is an error");
    t.assert.equal(
      resultText(many).includes("matches 2 places"),
      true,
      `the many-match message counts them; it said ${JSON.stringify(resultText(many))}`,
    );
    t.assert.equal(readFileSync(path, "utf8"), original, "and nothing was changed");

    const none = await runTool(editTool, { file_path: path, old_string: "zzz", new_string: "bar" }, this.ctx());
    t.assert.equal(none.isError, true, "a snippet that is not there is an error");
    t.assert.equal(
      resultText(none).includes("not found"),
      true,
      `the no-match message says so; it said ${JSON.stringify(resultText(none))}`,
    );
    t.assert.equal(
      resultText(none).includes("line-number prefix"),
      true,
      "and it names the mistake the Read format invites",
    );
    t.assert.equal(readFileSync(path, "utf8"), original, "and nothing was changed");

    t.assert.notEqual(resultText(none), resultText(many), "0 and >1 are reported differently");
    t.assert.equal(this.diffs().length, 0, "neither refusal announced anything");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnIdenticalEditAndARelativePathAreRefused extends EditTest {
  readonly id = "identical-strings-and-a-relative-path-are-refused";
  readonly whyItExists =
    "a no-op edit reported success and emitted an empty diff, so the model believed a change it had never made; and a relative path was resolved against whatever cwd the engine held, editing a file in another directory entirely";

  override async run(t: TestRun): Promise<void> {
    const path = this.file("d.txt", "x\n");
    this.state.recordRead(path);

    const identical = await runTool(editTool, { file_path: path, old_string: "x", new_string: "x" }, this.ctx());
    t.assert.equal(identical.isError, true, "replacing a string with itself is an error");
    t.assert.equal(
      resultText(identical).includes("identical"),
      true,
      `it says why; it said ${JSON.stringify(resultText(identical))}`,
    );
    t.assert.equal(readFileSync(path, "utf8"), "x\n");

    const relative = await runTool(editTool, { file_path: "d.txt", old_string: "x", new_string: "y" }, this.ctx());
    t.assert.equal(relative.isError, true, "a relative path is an error");
    t.assert.equal(
      resultText(relative).includes("must be absolute"),
      true,
      `it says why; it said ${JSON.stringify(resultText(relative))}`,
    );
    t.assert.equal(readFileSync(path, "utf8"), "x\n", "and the file the relative path would have found is untouched");
    t.assert.equal(this.diffs().length, 0, "neither refusal announced anything");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class ReplaceAllChangesEveryOccurrence extends EditTest {
  readonly id = "replace-all-changes-every-occurrence-announces-the-diff-and-restamps-the-record";
  readonly whyItExists =
    "a replace_all that stopped at the first match left half a rename behind and reported success; and one that wrote the file without re-recording it made the very next Edit fail as 'modified on disk' by its own hand";

  override async run(t: TestRun): Promise<void> {
    const path = this.file("e.txt", "foo one\nbar\nfoo two\n");
    this.state.recordRead(path);

    const result = await runTool(
      editTool,
      { file_path: path, old_string: "foo", new_string: "qux", replace_all: true },
      this.ctx(),
    );
    t.assert.equal(result.isError, undefined, resultText(result));
    t.assert.equal(readFileSync(path, "utf8"), "qux one\nbar\nqux two\n", "both occurrences changed");
    t.assert.equal(
      resultText(result).includes("replaced 2 occurrences"),
      true,
      `the result counts what it did; it said ${JSON.stringify(resultText(result))}`,
    );

    const diff = this.diffs();
    t.assert.equal(diff.length, 1, "exactly one file_edited per edit");
    t.assert.equal(diff[0]?.startsWith("--- a/e.txt"), true, diff[0] ?? "(no diff)");
    t.assert.equal(diff[0]?.includes("-foo one"), true, diff[0] ?? "(no diff)");
    t.assert.equal(diff[0]?.includes("+qux one"), true, diff[0] ?? "(no diff)");

    // The edit re-stamped the record, so the next one does not have to re-Read.
    const again = await runTool(editTool, { file_path: path, old_string: "bar", new_string: "baz" }, this.ctx());
    t.assert.equal(again.isError, undefined, `a second edit straight after the first: ${resultText(again)}`);
    t.assert.equal(readFileSync(path, "utf8"), "qux one\nbaz\nqux two\n");
    t.assert.equal(
      resultText(again).includes("replaced 1 occurrence"),
      true,
      `a single replacement counts one; it said ${JSON.stringify(resultText(again))}`,
    );
  }
}

/* ---- E-05: a near miss names where it differs ---------------------------- */

class ANearMissNamesWhereItDiffers extends EditTest {
  readonly id = "a-near-miss-names-the-first-character-that-differs-and-both-sides-of-it";
  readonly whyItExists =
    "in the field run three Edits failed on one missing '/' in a 1,249-character old_string, and 'not found' gave the model nothing to find it with, so it re-quoted from memory and missed again";

  override async run(t: TestRun): Promise<void> {
    const original = [
      "def load_config(root):",
      '    path = root + "/GameConfig.Overrides.json"',
      "    with open(path, encoding=\"utf-8\") as f:",
      "        return json.load(f)",
      "",
    ].join("\n");
    const path = this.file("config.py", original);
    this.state.recordRead(path);

    // The field case: the whole block quoted from memory, one "/" missing.
    const slipped = original.replace('"/GameConfig', '"GameConfig');
    const miss = await runTool(editTool, { file_path: path, old_string: slipped, new_string: "pass\n" }, this.ctx());
    const text = resultText(miss);
    t.assert.equal(miss.isError, true);
    t.assert.match(text, /old_string not found/, "it is still the not-found error");
    t.assert.match(text, /matches the file for its first 42 of \d+ characters/, `it says how far old_string matched: ${text}`);
    t.assert.match(text, /then old_string has "GameConfig/, "what old_string has at the first difference");
    t.assert.match(text, /where the file \(line 2\) has "\/GameConfig/, "and what the file has there, on which line");
    t.assert.equal(readFileSync(path, "utf8"), original, "and nothing was changed");

    // A CRLF file quoted with bare \n: the hint names the line endings.
    const crlf = this.file("crlf.txt", "first line\r\nsecond line\r\n");
    this.state.recordRead(crlf);
    const ending = await runTool(editTool, { file_path: crlf, old_string: "first line\nsecond line", new_string: "x" }, this.ctx());
    t.assert.match(resultText(ending), /CRLF line endings/, `a line-ending mismatch is named: ${resultText(ending)}`);

    const nothing = await runTool(editTool, { file_path: path, old_string: "completely different text that is nowhere", new_string: "x" }, this.ctx());
    t.assert.match(resultText(nothing), /Not even its beginning appears in the file/, "and a snippet that shares nothing is told to re-read");

    // A SHORT anchor — what the Edit description now asks for — with one slip
    // near its end is quoted at the slip, never told that nothing matched.
    const short = await runTool(editTool, { file_path: path, old_string: "json.laod(f)", new_string: "x" }, this.ctx());
    t.assert.match(resultText(short), /matches the file for its first 6 of 12 characters/, `a short anchor's slip is located: ${resultText(short)}`);
    t.assert.match(resultText(short), /then old_string has "aod\(f\)" where the file \(line 4\) has "oad\(f\)/);

    // An empty old_string is named as empty, not as a zero-length match.
    const empty = await runTool(editTool, { file_path: path, old_string: "", new_string: "x" }, this.ctx());
    t.assert.equal(empty.isError, true);
    t.assert.match(resultText(empty), /old_string is empty/, resultText(empty));
    t.assert.doesNotMatch(resultText(empty), /first 0 of 0/);

    // A difference inside an emoji is quoted as the whole character, never half a surrogate pair.
    const emojiFile = this.file("emoji.md", "status: \u{1F600} ready\n");
    this.state.recordRead(emojiFile);
    const emoji = await runTool(editTool, { file_path: emojiFile, old_string: "status: \u{1F601} ready", new_string: "x" }, this.ctx());
    t.assert.doesNotMatch(resultText(emoji), /\\ud83[de]/i, `no lone surrogate escape in the hint: ${resultText(emoji)}`);
    t.assert.match(resultText(emoji), /then old_string has "\u{1F601} ready" where the file \(line 1\) has "\u{1F600} ready/u, resultText(emoji));
  }
}

registerFeatureTests(
  new ANearMissNamesWhereItDiffers(),
  new AnUnreadFileCannotBeEdited(),
  new AFileChangedOnDiskCannotBeEdited(),
  new ZeroAndManyMatchesAreDifferentErrors(),
  new AnIdenticalEditAndARelativePathAreRefused(),
  new ReplaceAllChangesEveryOccurrence(),
);
