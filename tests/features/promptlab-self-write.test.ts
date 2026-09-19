/**
 * `promptlab-self-write`.
 *
 * Prompt Lab watches the overrides directory with `fs.watch` and pushes
 * `{type:"changed", id}` to every connected browser. When the SERVER itself
 * writes or deletes an override (PUT / DELETE `/api/prompt/<id>`) it records
 * the id with a timestamp first, and the watcher ignores change events for
 * that id for 1.5 seconds — otherwise every save echoes straight back, the
 * page reloads the text it just sent, and the lab loops.
 *
 * `proc`, and the record said `fs`. Re-declared 2026-09-20. `selfWrites`,
 * `markSelfWrite`, `isSelfWrite` and `SELF_WRITE_GRACE_MS` are module-private
 * in `tools/prompt-lab/server.mjs`, which exports nothing and starts listening
 * on import; there is no way to call them, and adding an export or faking
 * `Date.now` would be changing the product for the test and substituting a
 * double that is not the model. So the guard is proven where it is actually
 * visible: a real server process, a real `fs.watch` on a real directory, and a
 * real SSE client counting what the browser would have been told.
 *
 * THE SANDBOX. `server.mjs` is copied byte for byte (`copyFileSync`, never
 * edited) into a temp repository with a `node_modules` JUNCTION back to this
 * repo's, through which it resolves `@magentra/core|tools|protocol` to the
 * built `dist` exactly as the real lab does. There is no `engine/` directory,
 * so `ensureBuilt()` finds nothing newer than nothing and never runs the
 * compiler — the boot is a fraction of a second. THE OVERRIDES DIRECTORY IS
 * CREATED BEFORE THE SERVER STARTS, which is load-bearing: `startWatching()`
 * silently does nothing when the directory is absent, and a watcher that never
 * started would make "no event arrived" true for the wrong reason. Every test
 * below therefore also writes a DIFFERENT id's `.txt` from outside and
 * requires ITS event, so the silence being asserted is the guard and not a
 * dead watcher. `rmSync` does not follow the junction (verified on this
 * machine first), and the child is killed before the directory is removed.
 *
 * WHAT IS PROVEN OBSERVABLY, AND WHAT IS NOT:
 *   - checklist 1 as written ("use a fake Date.now", "the expired entry is
 *     removed from selfWrites") is BLOCKED — a private map behind a faked
 *     clock. Its substance is proven in
 *     `the-guard-expires-so-a-later-external-write-of-the-same-id-is-reported`
 *     with a real wait and no clock faking: the same id, touched from outside
 *     after the grace has run out, IS reported. That the map ENTRY is deleted
 *     rather than merely ignored is invisible from outside and is not claimed
 *     here.
 *   - checklist 2's first clause (`isSelfWrite('never.marked')` is false) is
 *     the same private function; its substance is the second clause, which is
 *     asserted in every test below as the live-watcher control.
 *   - checklist 3 and 4 are asserted as written.
 *   - CHECKLIST 5 WAS RED BY MEASUREMENT ON 2026-09-20, AND IS NOW PROVEN. It
 *     asks that `/api/import` and `/api/reset-all` each deliver a single
 *     `{type:"reset-all"}` and nothing else. `/api/import` already did.
 *     `/api/reset-all` did not: it called `clearPromptOverride` for every
 *     overridden prompt without marking those deletions as self-writes, and
 *     the watcher stays live across a reset, so each deletion came back as its
 *     own `changed`. Three runs, identical every time, the client received
 *     `reset-all`, then `changed:tool.CronDelete`, then `changed:tool.CronList`
 *     — the echo of the lab's own writes that this feature exists to prevent,
 *     arriving by the other route. The fix marks each deletion before clearing
 *     it, in this record's own entry file (`tools/prompt-lab/server.mjs`, the
 *     `/api/reset-all` handler), and the last test below is what holds it.
 *     `/api/import` needs no mark for the same outcome: it calls
 *     `startWatching()` after its writes, and closing the old watcher discards
 *     the events it had queued for them.
 *
 * `fs.watch` on Windows delivers more than one event per write (rename and
 * change), so nothing below counts events: the assertions are "no event for
 * this id" and "at least one event for that id".
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get, request, type ClientRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";
import { repoRoot } from "../lib/inventory.ts";

const FEATURE = "promptlab-self-write";

/** Verbatim from the record. */
const INVARIANT = "A write the lab makes itself does not retrigger its own file watcher.";

/** The id the lab itself writes, and whose echo must not come back. */
const MINE = "tool.CronDelete";
/** The id another editor writes, whose event MUST come back — the proof the watcher is alive. */
const THEIRS = "tool.CronList";
/** Two more ids, so the bulk routes below have a live-watcher control each that is not one of the ids they touch. */
const CONTROL_A = "tool.TaskGet";
const CONTROL_B = "tool.CronCreate";

/** `SELF_WRITE_GRACE_MS` is 1500; this is a real wait past it, never a faked clock. */
const PAST_THE_GRACE_MS = 2_000;

/** How long an event that is not coming is given to not come. */
const SETTLE_MS = 1_000;

interface LabEvent {
  readonly type?: string;
  readonly id?: string;
}

/** Ask the OS for a port and give it straight back: `--port 0` would make the banner print `0`. */
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

abstract class SelfWriteTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 120_000;

  #tmp: string | undefined;
  #port = 0;
  #stream: ClientRequest | undefined;
  #buffer = "";

  /** Everything the browser would have been told, in arrival order. */
  protected readonly events: LabEvent[] = [];
  protected overrides = "";

  /** The real server, on an overrides directory that already exists so the watcher starts at boot. */
  protected async startLab(): Promise<ProcHandle> {
    const tmp = mkdtempSync(join(tmpdir(), "magentra-selfwrite-"));
    this.#tmp = tmp;
    mkdirSync(join(tmp, "tools", "prompt-lab"), { recursive: true });
    const from = join(repoRoot(), "tools", "prompt-lab");
    copyFileSync(join(from, "server.mjs"), join(tmp, "tools", "prompt-lab", "server.mjs"));
    copyFileSync(join(from, "index.html"), join(tmp, "tools", "prompt-lab", "index.html"));
    symlinkSync(join(repoRoot(), "node_modules"), join(tmp, "node_modules"), "junction");

    this.overrides = join(tmp, "overrides");
    mkdirSync(this.overrides, { recursive: true });
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });

    this.#port = await freePort();
    const child = this.spawn(
      process.execPath,
      [join(tmp, "tools", "prompt-lab", "server.mjs"), "--dir", this.overrides, "--port", String(this.#port)],
      {
        cwd: tmp,
        label: `prompt-lab on 127.0.0.1:${this.#port}`,
        env: { HOME: home, USERPROFILE: home, MAGENTRA_PROMPTS_DIR: undefined },
      },
    );
    await child.nextLine((line) => line.includes(`http://127.0.0.1:${this.#port}`), 60_000);
    return child;
  }

  /** A browser on `/api/events`, resolved once the server has said `: connected`. */
  protected async connectBrowser(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream = get({ host: "127.0.0.1", port: this.#port, path: "/api/events" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          this.#buffer += chunk;
          for (;;) {
            const end = this.#buffer.indexOf("\n\n");
            if (end === -1) break;
            const frame = this.#buffer.slice(0, end);
            this.#buffer = this.#buffer.slice(end + 2);
            for (const line of frame.split("\n")) {
              if (line.startsWith("data:")) this.events.push(JSON.parse(line.slice(5).trim()) as LabEvent);
              else if (line.startsWith(": connected")) resolve();
            }
          }
        });
      });
      this.#stream = stream;
      stream.on("error", reject);
    });
  }

  protected async call(method: string, path: string, body?: string): Promise<Record<string, unknown>> {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: this.#port, path, method }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve(JSON.parse(text) as Record<string, unknown>));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** Another editor, writing an override file behind the server's back. */
  protected externalWrite(id: string, text: string): void {
    writeFileSync(join(this.overrides, `${id}.txt`), `${text}\n`, "utf8");
  }

  protected changedFor(id: string, from: number): LabEvent[] {
    return this.events.slice(from).filter((e) => e.type === "changed" && e.id === id);
  }

  protected resetAllsSince(from: number): LabEvent[] {
    return this.events.slice(from).filter((e) => e.type === "reset-all");
  }

  /** Waits until at least one `changed` for `id` has arrived since `from`. Returns whether it did. */
  protected async waitForChanged(id: string, from: number, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.changedFor(id, from).length > 0) return true;
      await sleep(20);
    }
    return false;
  }

  /** Children die here so Windows will let the directory go; the kind still guarantees no orphan. */
  override async tearDown(): Promise<void> {
    this.#stream?.destroy();
    this.#stream = undefined;
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

/* ---- checklist 3, and checklist 2's observable substance ---------------- */

class APutIsNotEchoedBackButAnotherEditorsWriteIs extends SelfWriteTest {
  readonly id = "a-put-is-not-echoed-to-the-browser-while-another-editors-write-is";
  readonly whyItExists =
    "every save came straight back as a 'changed' event, so the page reloaded the text it had just sent and the lab looped on each keystroke-save — while a guard drawn too wide would have swallowed the events that are the reason the watcher exists at all";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    await this.connectBrowser();
    const from = this.events.length;

    const saved = await this.call("PUT", `/api/prompt/${MINE}`, "an edit made in the browser");
    t.assert.equal(saved["id"], MINE);
    t.assert.equal(saved["overridden"], true, "the lab really did write the file whose event must be suppressed");
    t.assert.equal(existsSync(join(this.overrides, `${MINE}.txt`)), true);

    // A SECOND write to the same file, from outside, still inside the 1.5 s
    // grace. This is what makes the silence below `isSelfWrite`'s doing: the
    // PUT handler calls startWatching() after its own write, which closes the
    // old watcher and discards whatever it had queued, so the PUT's OWN event
    // never reaches the callback and the guard alone would not be visible.
    // This write lands on the fresh watcher and is suppressed only because the
    // id is still marked. (Checked by mutation: with `isSelfWrite` removed
    // from the watcher callback this arrives, three times, within 20 ms.)
    this.externalWrite(MINE, "the same prompt, rewritten from outside inside the grace");
    // Written from outside too, and never marked: the live-watcher control.
    this.externalWrite(THEIRS, "written by another editor");

    const theirs = await this.waitForChanged(THEIRS, from);
    t.assert.equal(theirs, true, "an override changed by another process must reach the browser — without this the silence below proves nothing");

    // fs.watch delivers in order for one directory, so a suppressed event for
    // MINE would already be behind this one; the settle is belt and braces.
    await sleep(SETTLE_MS);
    t.assert.deepEqual(this.changedFor(MINE, from), [], "a change to the id the lab has just written was reported inside the grace, so the browser that made the edit is told to reload it");
  }
}

/* ---- checklist 1's observable substance -------------------------------- */

class TheGuardExpires extends SelfWriteTest {
  readonly id = "the-guard-expires-so-a-later-external-write-of-the-same-id-is-reported";
  readonly whyItExists =
    "an id marked once stayed marked, so after one save from the lab that prompt's file could be rewritten by an editor, by git or by the engine and the browser was never told — the page then showed text that was no longer on disk";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    await this.connectBrowser();
    const from = this.events.length;

    await this.call("PUT", `/api/prompt/${MINE}`, "an edit made in the browser");
    await sleep(SETTLE_MS);
    t.assert.deepEqual(this.changedFor(MINE, from), [], "the save itself is suppressed, which is what makes the rest of this test about EXPIRY");

    // A real wait past SELF_WRITE_GRACE_MS. Nothing here fakes a clock.
    await sleep(PAST_THE_GRACE_MS);
    const afterGrace = this.events.length;

    this.externalWrite(MINE, "the same prompt, rewritten by another editor");
    const reported = await this.waitForChanged(MINE, afterGrace);
    t.assert.equal(reported, true, "once the grace has run out the very same id must be reported again — the guard covers one write, not the prompt for ever");
    t.assert.equal(readFileSync(join(this.overrides, `${MINE}.txt`), "utf8"), "the same prompt, rewritten by another editor\n", "and the file really did change under it");
  }
}

/* ---- checklist 4 -------------------------------------------------------- */

class ADeleteIsNotEchoedEither extends SelfWriteTest {
  readonly id = "a-delete-through-the-api-is-not-echoed-to-the-browser-either";
  readonly whyItExists =
    "only the PUT marked the id, so 'reset to default' deleted the file and the resulting watch event came back as 'changed' — the page reloaded a prompt that had just been reset and showed the override it had removed";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    await this.connectBrowser();

    await this.call("PUT", `/api/prompt/${MINE}`, "an experiment to throw away");
    t.assert.equal(existsSync(join(this.overrides, `${MINE}.txt`)), true, "there is an override to reset");

    // The PUT's own mark must be gone before the DELETE, or this test would
    // pass on the PUT's grace and say nothing about the DELETE marking the id.
    await sleep(PAST_THE_GRACE_MS + SETTLE_MS);
    const from = this.events.length;

    const cleared = await this.call("DELETE", `/api/prompt/${MINE}`);
    t.assert.equal(cleared["overridden"], false);
    t.assert.equal(existsSync(join(this.overrides, `${MINE}.txt`)), false, "the delete really did remove the file whose event must be suppressed");

    this.externalWrite(THEIRS, "written by another editor while the delete settles");
    const theirs = await this.waitForChanged(THEIRS, from);
    t.assert.equal(theirs, true, "the watcher is live in this window, so the silence below is the guard and not a dead watcher");

    await sleep(SETTLE_MS);
    t.assert.deepEqual(this.changedFor(MINE, from), [], "the delete the lab made itself was echoed back to the browser that asked for it");
  }
}

/* ---- checklist 5 -------------------------------------------------------- */

class TheBulkRoutesTellTheBrowserOnce extends SelfWriteTest {
  readonly id = "reset-all-and-import-say-reset-all-once-and-never-changed-per-prompt";
  readonly whyItExists =
    "'Reset all' and 'Import' each told the browser once that everything had changed and THEN sent a 'changed' for every prompt they had touched, so the page reloaded once per reset prompt — and anyone who happened to be typing watched the editor flash 'changed on disk' prompt by prompt and lose the draft in the box";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    await this.connectBrowser();

    // Two overrides for the bulk routes to act on.
    await this.call("PUT", `/api/prompt/${MINE}`, "an experiment on one prompt");
    await this.call("PUT", `/api/prompt/${THEIRS}`, "an experiment on another");
    t.assert.equal(existsSync(join(this.overrides, `${MINE}.txt`)), true);
    t.assert.equal(existsSync(join(this.overrides, `${THEIRS}.txt`)), true);

    // Both PUT marks must expire first, or the silence below would be theirs.
    await sleep(PAST_THE_GRACE_MS + SETTLE_MS);

    /* (a) reset-all */
    const beforeReset = this.events.length;
    const reset = await this.call("POST", "/api/reset-all");
    t.assert.equal(reset["ok"], true);
    t.assert.equal(existsSync(join(this.overrides, `${MINE}.txt`)), false, "the reset really did delete the files whose events must be suppressed");
    t.assert.equal(existsSync(join(this.overrides, `${THEIRS}.txt`)), false);

    this.externalWrite(CONTROL_A, "a third editor writes while the reset settles");
    t.assert.equal(await this.waitForChanged(CONTROL_A, beforeReset), true, "the watcher is live across a reset — without this the silence below proves nothing");
    await sleep(SETTLE_MS);

    t.assert.equal(this.resetAllsSince(beforeReset).length, 1, "a reset is ONE message to the page, not one per prompt");
    t.assert.deepEqual(this.changedFor(MINE, beforeReset), [], "a prompt the reset cleared was reported as changed on disk as well");
    t.assert.deepEqual(this.changedFor(THEIRS, beforeReset), [], "and so was the second one — this is the reload-per-prompt the reset-all message replaces");

    // The reset's own marks must expire too, or the import below would be
    // silent for a reason that has nothing to do with the import.
    await sleep(PAST_THE_GRACE_MS);

    /* (b) import */
    const beforeImport = this.events.length;
    const imported = await this.call("POST", "/api/import", JSON.stringify({ [MINE]: "imported one", [THEIRS]: "imported two" }));
    t.assert.equal(imported["applied"], 2, "both overrides were written");
    t.assert.equal(existsSync(join(this.overrides, `${MINE}.txt`)), true, "the import really did write the files whose events must not be reported");
    t.assert.equal(existsSync(join(this.overrides, `${THEIRS}.txt`)), true);

    this.externalWrite(CONTROL_B, "a fourth editor writes while the import settles");
    t.assert.equal(await this.waitForChanged(CONTROL_B, beforeImport), true, "the import restarts the watcher, and it must be watching again afterwards");
    await sleep(SETTLE_MS);

    t.assert.equal(this.resetAllsSince(beforeImport).length, 1, "an import is ONE message to the page too");
    t.assert.deepEqual(this.changedFor(MINE, beforeImport), [], "an imported prompt was reported as changed on disk on top of the reset-all");
    t.assert.deepEqual(this.changedFor(THEIRS, beforeImport), []);
  }
}

registerFeatureTests(
  new APutIsNotEchoedBackButAnotherEditorsWriteIs(),
  new TheGuardExpires(),
  new ADeleteIsNotEchoedEither(),
  new TheBulkRoutesTellTheBrowserOnce(),
);
