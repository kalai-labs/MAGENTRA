/**
 * `FsTest` — the kind that touches the filesystem. SPEC §3, decisions/0004.
 *
 * WHAT THIS KIND IS FOR. A feature whose behaviour IS the file it writes or
 * reads: an atomic write, a settings layer, a key resolved from `.env`, a state
 * directory pruned. If the file is incidental — a temp dir a spawned process
 * happens to need — the kind is `proc`, and this class is the wrong one.
 *
 * WHAT IT OWNS: a directory per test, removed on teardown EVEN ON THROW, and
 * the restoration of any home directory the test redirected.
 *
 * WHY HOME IS REDIRECTABLE HERE. A great deal of this repo resolves paths from
 * `os.homedir()` — `~/.magentra/settings.json` is the global settings layer,
 * `~/.magentra/profiles.json` is the connection profiles — and `homedir()`
 * reads `$HOME` (POSIX) or `%USERPROFILE%` (Windows). A test that does not
 * redirect them reads whatever the developer's machine happens to hold, which
 * makes it pass or fail for reasons that have nothing to do with the feature,
 * and a test that WRITES lands in their real configuration. So redirecting is
 * offered, and putting it back is not optional: `node --test` runs the tests in
 * one file in a single process, so a leaked `HOME` is inherited by the next
 * test in the file and the failure surfaces somewhere else entirely.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FeatureTest } from "./featureTest.ts";

/** The variables `os.homedir()` consults, in the order it consults them. */
const HOME_VARS = ["HOME", "USERPROFILE"] as const;

export abstract class FsTest extends FeatureTest {
  readonly kind = "fs" as const;

  #dirs: string[] = [];
  #savedEnv = new Map<string, string | undefined>();

  /** A fresh empty directory this test owns. Removed at teardown. */
  protected tempDir(prefix = "magentra-fs-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /**
   * Point `os.homedir()` at a directory of this test's own, and hand it back.
   *
   * Restored at teardown, whatever happens. Use it for anything that resolves
   * `~/.magentra`; without it the test reads the developer's real configuration.
   */
  protected redirectHome(): string {
    const home = this.tempDir("magentra-home-");
    for (const name of HOME_VARS) this.setEnv(name, home);
    return home;
  }

  /**
   * Set (or with `undefined`, unset) an environment variable for the duration
   * of this test, restoring whatever was there before.
   *
   * A test that asks "does this throw when no API key is present" is vacuous on
   * a machine where the developer exports one — so clearing it is part of
   * building the fixture, and putting it back is part of not breaking the next
   * test in the file.
   */
  protected setEnv(name: string, value: string | undefined): void {
    if (!this.#savedEnv.has(name)) this.#savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  /** Write a file, creating its directory. For building the fixture a feature reads. */
  protected writeFile(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }

  /** Write a JSON file the way this repo's own settings writers do: pretty, newline-terminated. */
  protected writeJson(path: string, value: unknown): void {
    this.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * Put the environment back first, then remove the directories — in that order,
   * because a restore skipped by a throw in the removal would leak `HOME` into
   * every later test in this file.
   */
  protected override tearDownKind(): void {
    try {
      for (const [name, value] of this.#savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      this.#savedEnv.clear();
    } finally {
      const dirs = this.#dirs;
      this.#dirs = [];
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  }
}
