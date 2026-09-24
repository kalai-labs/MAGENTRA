/**
 * `a-shell-command-names-the-read-files-it-changed`.
 *
 * Field test 2026-09-23, finding E-04: Bash never touched the freshness
 * store. A file edited by a shell command was still caught — at the next
 * Edit, refused as "modified on disk since it was last read", with nothing
 * saying which command had moved it.
 *
 * `proc`: the real Bash tool spawns a real shell in a real directory, through
 * the same validate-then-execute path the Session uses (`lib/directTool.ts`),
 * against a real `FileState`.
 */

import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileState } from "@magentra/core";
import { bashTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";

const FEATURE = "a-shell-command-names-the-read-files-it-changed";

/** Verbatim from the record. */
const INVARIANT =
  "A foreground shell command that changes a file Read this session names that file in its result, and never names one it did not change.";

class TheCommandSaysWhatItChanged extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-command-that-changes-a-read-file-names-it-and-one-that-does-not-names-nothing";
  readonly whyItExists =
    "a sed -i left every Read of the file stale and the next Edit was refused with no word about which command had moved it, so the model re-read and re-quoted by trial";

  #dir = "";

  override setUp(): void {
    this.#dir = realpathSync(mkdtempSync(join(tmpdir(), "magentra-shell-edit-")));
  }

  override tearDown(): void {
    rmSync(this.#dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }

  override async run(t: TestRun): Promise<void> {
    const state = new FileState();
    const ctx = { cwd: this.#dir, session: strictServices({ fileState: state }) };
    const bash = (command: string) => runTool(bashTool, { command, description: "a command this test runs" }, ctx);

    const edited = join(this.#dir, "a.txt");
    const untouched = join(this.#dir, "b.txt");
    const movedEarlier = join(this.#dir, "c.txt");
    for (const path of [edited, untouched, movedEarlier]) {
      writeFileSync(path, "one\n");
      state.recordRead(path);
    }
    // Someone else moved c.txt before any command ran.
    appendFileSync(movedEarlier, "two\n");

    const changing = resultText(await bash("echo appended >> a.txt"));
    t.assert.match(changing, /This command changed a file you had Read: /, `the result names the change: ${changing}`);
    t.assert.equal(changing.includes(edited), true, "it names a.txt");
    t.assert.equal(changing.includes(untouched), false, "and not b.txt, which the command never touched");
    t.assert.equal(changing.includes(movedEarlier), false, "nor c.txt, which was stale before the command ran");

    const quiet = resultText(await bash("echo nothing to see"));
    t.assert.equal(quiet.includes("you had Read"), false, `a command that changes nothing adds no note: ${quiet}`);

    // A Read file the command DELETES is gone, not changed: "Read it again
    // before you Edit" would send the model to a file that no longer exists.
    const doomed = join(this.#dir, "d.txt");
    writeFileSync(doomed, "one\n");
    state.recordRead(doomed);
    const removing = resultText(await bash("rm d.txt"));
    t.assert.equal(removing.includes(doomed), false, `a deleted file is not named as changed: ${removing}`);
  }
}

registerFeatureTests(new TheCommandSaysWhatItChanged());
