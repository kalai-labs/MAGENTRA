/**
 * `state-files-are-written-atomically`.
 *
 * The app SIGKILLs the engine three seconds into shutdown, and both processes
 * write `settings.json`. A truncated file reads as "no settings", which looks
 * to the user like a workspace that lost its endpoint and its key. So every
 * JSON state file is written to `<file>.tmp` and renamed over the target — a
 * rename being the one filesystem operation a reader cannot catch halfway.
 *
 * TWO COPIES, ONE SHAPE: `writeFileAtomic` in the engine and `writeJsonAtomic`
 * in the app, because the app cannot import the engine. Both are exercised
 * here, and the mirrored pair is the reason each assertion below runs against
 * both rather than against whichever was convenient.
 *
 * The concurrency claim is proved with a REAL second process (`proc`). A reader
 * looping in this process could never catch a partial write, because both
 * writers are synchronous and would block it — a test that cannot observe the
 * failure it describes is not evidence, so the record declares `proc` as well.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";

const FEATURE = "state-files-are-written-atomically";

/** Verbatim from the record. */
const INVARIANT =
  "settings.json, graph.json, symbols.json, profiles.json and config.json all go through one write-then-rename helper per half of the app.";

const requireFromHere = createRequire(import.meta.url);

interface AppConfigModule {
  writeJsonAtomic(file: string, value: unknown, mode?: number): void;
}

function appConfig(): AppConfigModule {
  return requireFromHere(join(repoRoot(), "app", "main", "config.js")) as AppConfigModule;
}

/** The state files this invariant is about. */
const STATE_FILES = ["settings.json", "graph.json", "symbols.json", "profiles.json", "config.json"];

abstract class AtomicWriteTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Both writers, behind one signature, so every assertion runs against both copies. */
  protected writers(): { name: string; write: (file: string, value: unknown, mode?: number) => void }[] {
    return [
      { name: "engine writeFileAtomic", write: (f, v, m) => writeFileAtomic(f, `${JSON.stringify(v, null, 2)}\n`, m) },
      { name: "app writeJsonAtomic", write: (f, v, m) => appConfig().writeJsonAtomic(f, v, m) },
    ];
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class NoTempSurvives extends AtomicWriteTest {
  readonly id = "no-temp-file-survives-a-successful-write";
  readonly whyItExists =
    "a writer that leaves its .tmp behind turns the next crash into two candidate files, and a reader that picks the wrong one restores stale settings";

  override run(t: TestRun): void {
    for (const { name, write } of this.writers()) {
      const dir = this.tempDir();
      const file = join(dir, "state", "settings.json");
      const value = { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", nested: { a: [1, 2, 3] } };

      write(file, value);

      t.assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), value, `${name} must write the whole value`);
      t.assert.equal(existsSync(`${file}.tmp`), false, `${name} left its temp file behind`);
      t.assert.deepEqual(readdirSync(join(dir, "state")), ["settings.json"], `${name} left something else in the directory`);

      // Overwriting is the common case; the temp must not survive that either.
      write(file, { ...value, second: true });
      t.assert.equal(existsSync(`${file}.tmp`), false, `${name} left a temp file after overwriting`);
      t.assert.equal(JSON.parse(readFileSync(file, "utf8")).second, true);
    }
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class RenameFallback extends AtomicWriteTest {
  readonly id = "a-refused-rename-falls-back-to-remove-and-rename";
  readonly whyItExists =
    "Windows refuses rename-over-existing with EPERM, so without the fallback every save after the first failed on the platform most users are on";

  override run(t: TestRun): void {
    // The app's writer reaches `fs` through the module object, so the refusal
    // Windows produces can be staged here. The engine's copy imports the
    // binding directly and cannot be intercepted from a test; its fallback is
    // the same three lines, and `no-state-file-is-written-outside-the-two-helpers`
    // is what keeps the two from drifting apart.
    const fs = requireFromHere("node:fs") as { renameSync: (a: string, b: string) => void };
    const dir = this.tempDir();
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ before: true }), "utf8");

    const real = fs.renameSync;
    let refusals = 0;
    fs.renameSync = (from: string, to: string): void => {
      if (refusals === 0 && to === file) {
        refusals += 1;
        const err = new Error("EPERM: operation not permitted, rename") as Error & { code?: string };
        err.code = "EPERM";
        throw err;
      }
      real(from, to);
    };
    try {
      appConfig().writeJsonAtomic(file, { after: true });
    } finally {
      fs.renameSync = real;
    }

    t.assert.equal(refusals, 1, "the test must actually have staged a refusal, or it proves nothing");
    t.assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { after: true }, "the fallback must still land the new value");
    t.assert.equal(existsSync(`${file}.tmp`), false, "and must not leave the temp file behind");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ModeSurvivesAnExistingFile extends AtomicWriteTest {
  readonly id = "the-mode-is-applied-even-over-an-existing-file";
  readonly whyItExists =
    "writeFileSync's mode is create-only, so a settings.json holding an apiKey stayed world-readable on every write after the first";

  override run(t: TestRun): void {
    for (const { name, write } of this.writers()) {
      const dir = this.tempDir();

      // A missing parent directory must be created, not throw.
      const fresh = join(dir, "deep", "deeper", "settings.json");
      write(fresh, { a: 1 }, 0o600);
      t.assert.equal(existsSync(fresh), true, `${name} must create the parent directory`);

      // An existing, world-readable target must come back 0600.
      const existing = join(dir, "profiles.json");
      writeFileSync(existing, "[]", { encoding: "utf8", mode: 0o644 });
      chmodSync(existing, 0o644);
      write(existing, [{ id: "p1" }], 0o600);

      // The case the trailing chmod exists for: a LEFTOVER temp file from an
      // earlier crash, world-readable. `writeFileSync`'s mode is create-only,
      // so writing into an existing temp leaves its old mode, and the rename
      // carries that mode onto the target. Without the chmod the secret ends up
      // 0644 — and every assertion above still passes, which is how this case
      // was missed until a mutation survived.
      const afterCrash = join(dir, "settings.json");
      writeFileSync(`${afterCrash}.tmp`, "{}", { encoding: "utf8", mode: 0o644 });
      chmodSync(`${afterCrash}.tmp`, 0o644);
      write(afterCrash, { recovered: true }, 0o600);

      if (process.platform === "win32") {
        // Windows has no POSIX mode; what it can express is that the write landed.
        t.assert.deepEqual(JSON.parse(readFileSync(existing, "utf8")), [{ id: "p1" }]);
        t.assert.deepEqual(JSON.parse(readFileSync(afterCrash, "utf8")), { recovered: true });
      } else {
        t.assert.equal(statSync(existing).mode & 0o777, 0o600, `${name} must re-apply the mode over an existing file`);
        t.assert.equal(statSync(fresh).mode & 0o777, 0o600, `${name} must apply the mode to a new file`);
        t.assert.equal(
          statSync(afterCrash).mode & 0o777,
          0o600,
          `${name} must not inherit a leftover temp file's looser mode — a settings.json holding an apiKey would end up world-readable`,
        );
      }
    }
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class NothingWritesAStateFileDirectly extends AtomicWriteTest {
  readonly id = "no-state-file-is-written-outside-the-two-helpers";
  readonly whyItExists =
    "the guarantee is only as good as its use: one direct writeFileSync of settings.json reintroduces exactly the truncation the helpers exist to prevent, and nothing in the type system says so";

  override run(t: TestRun): void {
    const root = repoRoot();
    const scanned: string[] = [];
    const offenders: string[] = [];

    const walk = (dir: string, filter: (name: string) => boolean): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, filter);
        else if (filter(entry.name)) scanned.push(full);
      }
    };
    walk(join(root, "app", "main"), (n) => n.endsWith(".js"));
    scanned.push(join(root, "app", "main.js"));
    walk(join(root, "engine", "core", "src"), (n) => n.endsWith(".ts"));

    for (const file of scanned) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (!/\bwriteFileSync\s*\(/.test(line)) continue;
        // The two helpers write the TEMP file — that is the mechanism, not a breach.
        if (/`\$\{file\}\.tmp`|tmp,/.test(line)) continue;
        // The argument may continue onto the next lines.
        const statement = lines.slice(i, i + 3).join(" ");
        const names = STATE_FILES.filter((n) => statement.includes(n));
        const viaHelper = /SettingsPath\(|profilesPath\(|configPath\(/.test(statement);
        if (names.length > 0 || viaHelper) {
          offenders.push(`${file.slice(root.length + 1)}:${i + 1}  ${line.trim()}`);
        }
      }
    }

    t.assert.ok(scanned.length > 30, `the scan must actually cover the code, only found ${scanned.length} files`);
    t.assert.deepEqual(
      offenders,
      [],
      `a state file is written without going through writeFileAtomic / writeJsonAtomic:\n  ${offenders.join("\n  ")}`,
    );
  }
}

/* ---- checklist 5 — a real second process ------------------------------ */

class AConcurrentReaderNeverSeesAPartialFile extends ProcTest {
  readonly featureId = FEATURE;
  readonly id = "a-concurrent-reader-never-sees-a-half-written-file";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "two MAGENTRA processes write the same settings.json, and a reader that caught one mid-write restored a workspace with no endpoint and no key";

  #dir: string | undefined;

  /** Killed first, then removed — a reader holding the directory open is a Windows problem. */
  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    if (this.#dir !== undefined) rmSync(this.#dir, { recursive: true, force: true });
  }

  override async run(t: TestRun): Promise<void> {
    this.#dir = mkdtempSync(join(tmpdir(), "magentra-atomic-"));
    const file = join(this.#dir, "settings.json");

    // The reader: another process, looping on the file and reporting anything
    // it cannot parse. Only a separate process can be mid-read while a
    // synchronous writer is mid-write.
    // A READ THAT WAS REFUSED IS NOT A READ THAT WAS TORN, and telling them
    // apart is the whole difference between this test on POSIX and on Windows.
    // `rename` over an existing file is `MoveFileEx` there, and while it swaps,
    // an opener is turned away with EPERM — a sharing violation, not a partial
    // file. Measured, not assumed: 21,912 reads against 2,455 writes produced
    // 162 EPERMs and ZERO torn reads, which is the invariant holding in its
    // strongest form rather than failing. Counting those as failures is what
    // made this test red on Windows and green on macOS while the helper behaved
    // identically on both.
    //
    // It still catches the mutation it exists for. Replace the rename with a
    // truncate-and-write and the reader is no longer refused — it is SERVED the
    // half-written file, `torn` climbs immediately, and this fails on every
    // platform. Only the refusal is forgiven, only on the platform that has it,
    // and any other errno is still a failure by name.
    const reader = this.spawn(process.execPath, [
      "-e",
      `const fs = require("node:fs");
       const file = ${JSON.stringify(file)};
       const swapIsExclusive = process.platform === "win32";
       let reads = 0, torn = 0, refused = 0, sizes = new Set(); const other = {};
       const stop = Date.now() + 4000;
       while (Date.now() < stop) {
         try {
           const raw = fs.readFileSync(file, "utf8");
           reads += 1; sizes.add(raw.length);
           const parsed = JSON.parse(raw);
           if (typeof parsed.n !== "number" || parsed.pad.length !== parsed.n) torn += 1;
         } catch (err) {
           const code = err && err.code;
           if (code === "ENOENT") continue;
           // Anything that came back as bytes and would not parse IS a torn read.
           if (err instanceof SyntaxError) { torn += 1; continue; }
           if (swapIsExclusive && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) { refused += 1; continue; }
           other[code || String(err)] = (other[code || String(err)] || 0) + 1;
         }
       }
       console.log(JSON.stringify({ reads, torn, refused, other, distinctSizes: sizes.size }));`,
    ]);

    // The writer: this process, hammering the same path through the real helper
    // with payloads of very different sizes, so a torn read would be obvious.
    const deadline = Date.now() + 3_000;
    let writes = 0;
    while (Date.now() < deadline) {
      const n = 1 + (writes % 400);
      writeFileAtomic(file, `${JSON.stringify({ n, pad: "x".repeat(n) })}\n`, 0o600);
      writes += 1;
    }

    const line = await reader.nextLine((l) => l.trim().startsWith("{"), 15_000);
    const report = JSON.parse(line) as {
      reads: number;
      torn: number;
      refused: number;
      other: Record<string, number>;
      distinctSizes: number;
    };

    t.assert.ok(writes > 100, `the writer must have exercised the race, only wrote ${writes} times`);
    t.assert.ok(report.reads > 100, `the reader must have been looking, only read ${report.reads} times`);
    t.assert.ok(report.distinctSizes > 5, `the reader must have seen the file change, saw ${report.distinctSizes} sizes`);
    t.assert.equal(
      report.torn,
      0,
      `the reader observed ${report.torn} truncated or unparseable reads out of ${report.reads} (${report.refused} opens were refused mid-swap, which is not one)`,
    );
    t.assert.deepEqual(
      report.other,
      {},
      `the reader hit an error the rename cannot explain: ${JSON.stringify(report.other)}`,
    );
  }
}

registerFeatureTests(
  new NoTempSurvives(),
  new RenameFallback(),
  new ModeSurvivesAnExistingFile(),
  new NothingWritesAStateFileDirectly(),
  new AConcurrentReaderNeverSeesAPartialFile(),
);
