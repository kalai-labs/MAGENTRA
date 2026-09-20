/**
 * `promptlab-override-roundtrip`.
 *
 * Editing a prompt in the Prompt Lab page sends `PUT /api/prompt/<id>`; the
 * server writes a plain `<id>.txt` into the overrides directory, and the
 * engine's registry re-stats that file at most every 250 ms, so the next turn
 * uses the new text with no restart. `--dir` points the whole thing at an
 * experiment set instead of `~/.magentra/prompts`.
 *
 * `fs` + `proc`, and the record said `fs`. Re-declared 2026-09-20. Checklist
 * items 1, 2, 3 and 5's first clause are the registry itself — real files in a
 * real temp directory, with `MAGENTRA_PROMPTS_DIR` pointed at it, which is
 * `fs`. Items 4 and 5's second clause are claims about a RUNNING lab: that
 * `--dir` reaches `promptsDir()` before the engine modules load, and that a
 * request over the socket writes and deletes the file. Nothing in
 * `tools/prompt-lab/server.mjs` is exported and the module starts listening on
 * import, so the only way to reach either is to spawn it — which is `proc`.
 *
 * THE SANDBOX the `proc` half spawns. `server.mjs` resolves `REPO` as
 * `dirname(server.mjs)/../..`, and at startup compares the newest `.ts` and
 * `.js` mtimes under `REPO/engine` and runs `tsc -b` there when the sources
 * are ahead. Run from this repository that is a full build of MAGENTRA, so the
 * tests copy the file — byte for byte, `copyFileSync`, never edited — into a
 * temp directory of its own with a `node_modules` JUNCTION back to this repo's.
 * Through the junction the copy resolves `@magentra/core`, `@magentra/tools`
 * and `@magentra/protocol` to exactly the built `dist/` the real lab uses. The
 * sandbox has no `engine/` directory at all, so `ensureBuilt()` finds nothing
 * newer than nothing and skips the compiler; it is the real server, unchanged,
 * on a repository too small to be expensive. `rmSync` does not follow the
 * junction (checked on this machine before these tests were written), and the
 * children are killed in `tearDown` before the directory is removed, because
 * Windows will not delete a directory a live process holds.
 *
 * `--port 0` is useless here — the banner would print the literal `0` — so a
 * free port is taken from the OS, released, and passed in.
 *
 * NOTHING IS DOUBLED. The registry is the real one, the files are real files,
 * and the lab is the real server process answering on a real socket.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, copyFileSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "@magentra/core";
import {
  isPromptDisabled,
  promptCatalog,
  promptFile,
  promptText,
  promptTextIfEnabled,
  writePromptOverride,
} from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";
import { repoRoot } from "../lib/inventory.ts";

const FEATURE = "promptlab-override-roundtrip";

/** Verbatim from the record. */
const INVARIANT = "Editing a prompt in the browser writes an override .txt the engine re-reads live, with no restart.";

/** Real prompt ids, one per test, so no test can read another's cache slot inside the TTL. */
const WRITE_ID = "system.environment";
const RELOAD_ID = "session.auto-name.role";
const DISABLE_ID = "compaction.wrapper";
const LAB_ID = "system.environment";

/** The registry trusts a resolved override for 250 ms, so a change is polled for, never slept on. */
const CACHE_TTL_MS = 250;

function defaultTextOf(id: string): string {
  const entry = promptCatalog().find((p) => p.id === id);
  if (entry === undefined) throw new Error(`no prompt "${id}" is registered — this test's fixture is wrong, not the feature`);
  return entry.defaultText;
}

/** Polls `read` every 20 ms until it equals `want`, or gives up and returns what it last saw. */
async function pollFor(read: () => string, want: string, deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let seen = read();
  while (seen !== want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    seen = read();
  }
  return seen;
}

/* ---- the registry, on real files — checklist 1, 2, 3, 5a ---------------- */

abstract class OverrideFileTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /**
   * A directory the overrides live in, with `MAGENTRA_PROMPTS_DIR` pointed at
   * it and `HOME`/`USERPROFILE` redirected — `promptsDir()` falls back to
   * `homedir()/.magentra/prompts`, and a test that leaves that pointing at the
   * developer's machine would write into their real prompt overrides.
   */
  protected overridesDir(): string {
    this.redirectHome();
    const dir = this.tempDir("magentra-prompts-");
    this.setEnv("MAGENTRA_PROMPTS_DIR", dir);
    return dir;
  }
}

/* ---- checklist 1 ------------------------------------------------------- */

class AWriteIsNormalisedAndImmediate extends OverrideFileTest {
  readonly id = "a-written-override-normalises-crlf-and-is-in-force-at-once";
  readonly whyItExists =
    "text typed in a browser on Windows arrives as CRLF, and storing it raw put a stray carriage return into every line of the prompt the model was sent; the 250 ms cache also served the OLD text for a quarter of a second after a save, so a hand-timed check of the edit read the text it had just replaced";

  override async run(t: TestRun): Promise<void> {
    const dir = this.overridesDir();

    writePromptOverride(WRITE_ID, "new text\r\n");

    const file = join(dir, `${WRITE_ID}.txt`);
    t.assert.equal(promptFile(WRITE_ID), file, "the override file is <dir>/<id>.txt");
    t.assert.equal(existsSync(file), true, "the write landed");
    t.assert.equal(readFileSync(file, "utf8"), "new text\n", "CRLF normalised, exactly one trailing newline");
    // Immediately: writePromptOverride drops the cache slot, so nothing waits
    // out the TTL for an edit this process itself made.
    t.assert.equal(promptText(WRITE_ID), "new text", "the new text is in force at once, with no restart and no wait");

    const entry = promptCatalog().find((p) => p.id === WRITE_ID);
    t.assert.equal(entry?.overridden, true);
    t.assert.equal(entry?.currentText, "new text");
    t.assert.equal(entry?.defaultText, defaultTextOf(WRITE_ID), "the shipped default is untouched by an override");
  }
}

/* ---- checklist 2 ------------------------------------------------------- */

class AnExternalEditIsPickedUpLive extends OverrideFileTest {
  readonly id = "an-external-edit-of-the-file-is-picked-up-without-a-restart";
  readonly whyItExists =
    "the override was resolved once and cached for the life of the process, so editing the .txt in an editor — or from the lab in another process — changed nothing until the engine was restarted, which is the whole point of storing prompts in files";

  override readonly timeoutMs: number = 60_000;

  override async run(t: TestRun): Promise<void> {
    const dir = this.overridesDir();
    const file = join(dir, `${RELOAD_ID}.txt`);

    writePromptOverride(RELOAD_ID, "first");
    t.assert.equal(promptText(RELOAD_ID), "first", "the override is in force");
    // Prime the cache slot, so what follows is the re-check and not a first read.
    t.assert.equal(promptText(RELOAD_ID), "first");

    // A different process editing the file — no call to writePromptOverride, so
    // nothing invalidates the cache but the mtime check itself. The mtime is
    // pushed forward because two writes can land inside one filesystem
    // timestamp tick, and an unchanged mtime is exactly what the registry is
    // entitled to trust.
    writeFileSync(file, "edited by another process\n", "utf8");
    const stamped = statSync(file);
    utimesSync(file, new Date(stamped.atimeMs + 2_000), new Date(stamped.mtimeMs + 2_000));

    // Polled, not slept on: the assertion is the value, never the timing.
    const seen = await pollFor(() => promptText(RELOAD_ID), "edited by another process", 20 * CACHE_TTL_MS);
    t.assert.equal(seen, "edited by another process", "the registry re-read the file on disk, with no restart and no writePromptOverride call");

    const entry = promptCatalog().find((p) => p.id === RELOAD_ID);
    t.assert.equal(entry?.currentText, "edited by another process", "the catalog an editor reads shows the same text");
    t.assert.equal(entry?.overridden, true);
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

class DefaultDeletesAndBlankDisables extends OverrideFileTest {
  readonly id = "the-default-text-deletes-the-file-while-blank-text-disables-the-prompt";
  readonly whyItExists =
    "editing a prompt back to its shipped wording left a file on disk that said 'overridden', so the lab showed an experiment nobody was running; and a box emptied to switch a prompt OFF was read as 'no override' and the prompt kept being sent";

  override async run(t: TestRun): Promise<void> {
    const dir = this.overridesDir();
    const file = join(dir, `${DISABLE_ID}.txt`);
    const shipped = defaultTextOf(DISABLE_ID);

    writePromptOverride(DISABLE_ID, "an experiment");
    t.assert.equal(existsSync(file), true, "there is a file to remove");

    writePromptOverride(DISABLE_ID, shipped);
    t.assert.equal(existsSync(file), false, "text equal to the default REMOVES the file rather than storing a copy of it");
    const restored = promptCatalog().find((p) => p.id === DISABLE_ID);
    t.assert.equal(restored?.overridden, false, "'edited back to the original' and 'never edited' are one state");
    t.assert.equal(restored?.currentText, shipped);
    t.assert.equal(isPromptDisabled(DISABLE_ID), false);

    // Blank is NOT that case: it is stored, and it switches the prompt off.
    writePromptOverride(DISABLE_ID, " ");
    t.assert.equal(existsSync(file), true, "a blank override is stored, not treated as 'no override'");
    t.assert.match(readFileSync(file, "utf8"), /^\s*$/, "the stored file is blank");
    const off = promptCatalog().find((p) => p.id === DISABLE_ID);
    t.assert.equal(off?.overridden, true);
    t.assert.equal(off?.disabled, true);
    t.assert.equal(off?.currentText, "", "a blank override resolves to the empty string, not to the default");
    t.assert.equal(promptTextIfEnabled(DISABLE_ID), undefined, "nothing that drives a model call may run on a switched-off prompt");
    t.assert.equal(isPromptDisabled(DISABLE_ID), true);

    // The empty string takes the same door, and writes a truly empty file.
    writePromptOverride(DISABLE_ID, "");
    t.assert.equal(readFileSync(file, "utf8"), "", "an emptied box writes an empty file");
    t.assert.equal(isPromptDisabled(DISABLE_ID), true);
  }
}

/* ---- checklist 5, first clause ----------------------------------------- */

class AnUnknownIdThrowsAndWritesNothing extends OverrideFileTest {
  readonly id = "an-unknown-prompt-id-throws-and-writes-nothing";
  readonly whyItExists =
    "a mistyped or retired id was written as a .txt nobody would ever read, so the lab reported a saved override for a prompt that does not exist and the edit was silently lost";

  override async run(t: TestRun): Promise<void> {
    const dir = this.overridesDir();

    t.assert.throws(
      () => {
        writePromptOverride("no.such.id", "x");
      },
      /unknown prompt id/,
      "an id that is not registered is refused by name",
    );
    t.assert.deepEqual(readdirSync(dir), [], "and nothing was written — not the file, not the directory it would have gone in");
  }
}

/* ---- the running lab — checklist 4 and 5's second clause ---------------- */

/** Ask the OS for a port, then give it straight back: `--port 0` would make the banner print `0`. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        if (port === 0) reject(new Error("the OS gave out no port"));
        else resolve(port);
      });
    });
  });
}

interface Answer {
  readonly status: number;
  readonly body: string;
}

abstract class RunningLabTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 120_000;

  #tmp: string | undefined;
  #port = 0;

  /** Overrides directory of the sandbox, created BEFORE the server boots. */
  protected overrides = "";
  /** The `HOME` the child sees — proof that `~/.magentra/prompts` was never reached. */
  protected home = "";

  /**
   * The real `server.mjs`, copied unchanged into a repository of its own, and
   * started on `--dir <overrides>`.
   */
  protected async startLab(): Promise<ProcHandle> {
    const tmp = mkdtempSync(join(tmpdir(), "magentra-plab-"));
    this.#tmp = tmp;
    mkdirSync(join(tmp, "tools", "prompt-lab"), { recursive: true });
    const from = join(repoRoot(), "tools", "prompt-lab");
    copyFileSync(join(from, "server.mjs"), join(tmp, "tools", "prompt-lab", "server.mjs"));
    copyFileSync(join(from, "index.html"), join(tmp, "tools", "prompt-lab", "index.html"));
    // A junction, so the copied server resolves @magentra/* to this repo's
    // built dist exactly as the real lab does. rmSync does not follow it.
    symlinkSync(join(repoRoot(), "node_modules"), join(tmp, "node_modules"), "junction");

    this.overrides = join(tmp, "overrides");
    mkdirSync(this.overrides, { recursive: true });
    this.home = join(tmp, "home");
    mkdirSync(this.home, { recursive: true });

    this.#port = await freePort();
    const child = this.spawn(
      process.execPath,
      [join(tmp, "tools", "prompt-lab", "server.mjs"), "--dir", this.overrides, "--port", String(this.#port)],
      {
        cwd: tmp,
        label: `prompt-lab on 127.0.0.1:${this.#port}`,
        // MAGENTRA_PROMPTS_DIR is cleared so --dir is the ONLY thing that can
        // be pointing the registry anywhere; HOME/USERPROFILE are redirected so
        // the fallback, if it were ever reached, lands in the sandbox.
        env: { HOME: this.home, USERPROFILE: this.home, MAGENTRA_PROMPTS_DIR: undefined },
      },
    );
    await child.nextLine((line) => line.includes(`http://127.0.0.1:${this.#port}`), 120_000);
    return child;
  }

  protected async call(method: string, path: string, body?: string): Promise<Answer> {
    return await new Promise<Answer>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: this.#port, path, method }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  protected async json(method: string, path: string, body?: string): Promise<Record<string, unknown>> {
    const answer = await this.call(method, path, body);
    return { ...(JSON.parse(answer.body) as Record<string, unknown>), __status: answer.status };
  }

  /**
   * The children die here rather than in the kind's teardown, because Windows
   * will not remove a directory a live process is sitting in. `tearDownKind`
   * then finds them gone and still guarantees no orphan.
   */
  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    const tmp = this.#tmp;
    this.#tmp = undefined;
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
}

/* ---- checklist 4 ------------------------------------------------------- */

class DirPointsTheLabAtAnExperimentSet extends RunningLabTest {
  readonly id = "the-dir-flag-points-the-running-lab-at-an-experiment-set";
  readonly whyItExists =
    "--dir was read after the engine modules had already loaded, so an experiment run with it wrote into ~/.magentra/prompts and changed the prompts of every other session on the machine";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();

    const catalog = await this.json("GET", "/api/catalog");
    t.assert.equal(catalog["dir"], this.overrides, "the running lab reports the --dir directory as the one it is editing");
    const prompts = catalog["prompts"];
    t.assert.equal(Array.isArray(prompts) && prompts.length > 0, true, "and it has a catalog of real prompts behind it");

    const saved = await this.json("PUT", `/api/prompt/${LAB_ID}`, "text typed in the browser");
    t.assert.equal(saved["__status"], 200);
    t.assert.equal(saved["id"], LAB_ID);
    t.assert.equal(saved["overridden"], true, "the answer tells the page the edit is now in force");
    t.assert.equal(typeof saved["currentTokens"], "number", "and what it costs");

    const file = join(this.overrides, `${LAB_ID}.txt`);
    t.assert.equal(existsSync(file), true, "the PUT wrote the override into --dir");
    t.assert.equal(readFileSync(file, "utf8"), "text typed in the browser\n");

    // The whole point of --dir: the user's global overrides are not touched.
    t.assert.equal(existsSync(join(this.home, ".magentra", "prompts")), false, "~/.magentra/prompts must not even be created by an experiment run under --dir");
    t.assert.equal(existsSync(join(this.home, ".magentra")), false, "nothing under the home directory was reached at all");
  }
}

/* ---- checklist 5, second clause ---------------------------------------- */

class DeleteRemovesTheOverrideFile extends RunningLabTest {
  readonly id = "a-delete-through-the-api-removes-the-override-file";
  readonly whyItExists =
    "'reset to default' left the .txt on disk, so the prompt the engine kept sending was the experiment the user had just thrown away";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    const file = join(this.overrides, `${LAB_ID}.txt`);

    await this.json("PUT", `/api/prompt/${LAB_ID}`, "an experiment to throw away");
    t.assert.equal(existsSync(file), true, "there is an override to reset");

    const cleared = await this.json("DELETE", `/api/prompt/${LAB_ID}`);
    t.assert.equal(cleared["__status"], 200);
    t.assert.equal(cleared["id"], LAB_ID);
    t.assert.equal(cleared["overridden"], false, "the page is told the prompt is back on its shipped default");
    t.assert.equal(existsSync(file), false, "and the file is gone from disk");

    const catalog = await this.json("GET", "/api/catalog");
    const prompts = (catalog["prompts"] ?? []) as { id?: string; overridden?: boolean; currentText?: string; defaultText?: string }[];
    const entry = prompts.find((p) => p.id === LAB_ID);
    t.assert.equal(entry?.overridden, false, "the catalog the page re-reads agrees");
    t.assert.equal(entry?.currentText, entry?.defaultText, "and the text in force is the shipped one again");
  }
}

registerFeatureTests(
  new AWriteIsNormalisedAndImmediate(),
  new AnExternalEditIsPickedUpLive(),
  new DefaultDeletesAndBlankDisables(),
  new AnUnknownIdThrowsAndWritesNothing(),
  new DirPointsTheLabAtAnExperimentSet(),
  new DeleteRemovesTheOverrideFile(),
);
