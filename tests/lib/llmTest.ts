/**
 * `LlmTest` — the kind that needs a real model. SPEC §3, decisions/0004,
 * decisions/0009.
 *
 * WHAT THIS KIND IS FOR. A feature whose behaviour IS the model's behaviour:
 * whether a reminder actually changes what the next turn does, whether a
 * compaction summary keeps what the session needed, whether steering mid-run
 * lands. For those, a scripted provider proves nothing — `FakeProvider` returns
 * what the script told it to return, so a green test against it is the
 * mock-returns-what-the-mock-was-told non-test this suite was reset to remove.
 * The product owner's note on those records says it in one line: *no mockup or
 * scaffold test for this*.
 *
 * If a feature can be proved by calling a function and looking at what comes
 * back, it is `pure` or `fs` and this class is the wrong one. Kinds are a claim
 * about what proving a feature requires, and this is the most expensive claim
 * in the vocabulary — it costs money and a network round trip per turn.
 *
 * OPT-IN, AND ONLY OPT-IN (decisions/0009). Every other kind runs on every
 * `npm test`. This one does not: it calls a real endpoint, it costs real
 * tokens, and it can fail for reasons that belong to a provider rather than to
 * this repository. `registerFeatureTests` withholds an `llm` test unless
 * {@link realModelTestsEnabled} says the user asked for it, and says out loud
 * which tests it withheld — see `featureTest.ts`.
 *
 * ASKING FOR THEM RUNS THEM ALONE (decisions/0013). The command subtracts, as
 * `test:ui` does: it was additive until 2026-09-21, when `npm test` and
 * `npm run test:llm` were measured executing an identical 558 tests.
 *
 *     npm test           → every other kind. `llm` tests are named, not run.
 *     npm run test:llm   → the `llm` kind, and nothing else.
 *
 * THIS IS NOT A SKIP IN THE SENSE RULE 4 FORBIDS. That rule is about a test
 * quieting ITSELF: a failing test stays failing, and `run()` is handed a
 * `TestRun` with no `skip`, `todo` or `plan` to reach for. A withheld `llm`
 * test is not quieted and not passed — it is REGISTERED with `{ skip: reason }`
 * and counted under `skipped`, never under `pass`. Not registering it was the
 * first attempt and was measured wrong: `node:test` reports a file that
 * registers nothing as one PASSING test, the file itself. decisions/0009 has
 * the numbers. Once a test is registered to run, it is an ordinary test with no
 * escape hatch: no skip, no soft assert, and no `signal`-swallowing retry when
 * the model says something unexpected.
 *
 * WHAT IT OWNS.
 *
 *   1. THE CONNECTION. SPEC §3 says this kind gets "a resolved profile; may
 *      assume §4.2 already passed". It does not assume it — it resolves it, and
 *      fails loudly when there is none, because tests/README rule 7 is "no
 *      connection, no run" and a run the user explicitly asked for must say why
 *      it cannot happen rather than quietly proving nothing.
 *
 *   2. A WORKSPACE THAT IS NOT THIS REPOSITORY. A real model with real tools
 *      writes real files. The engine's cwd is a temp directory removed on
 *      teardown, so a turn that decides to write something cannot land it in
 *      the working tree.
 *
 *   3. THE ONE EVENT CONSUMER. `Engine.events` is single-consumer by contract —
 *      `AsyncQueue` hands each event to whichever waiter asked first, so a
 *      second `for await` steals events from the first. The kind therefore owns
 *      the single drain loop and collects into {@link events}, rather than
 *      handing the queue to the test and hoping only one loop is ever opened.
 *
 *   4. NO ORPHANS. `Engine.stopBackgroundJobs()` on teardown: background agents,
 *      monitors and detached bash children are spawned into their own process
 *      group precisely so they outlive a turn, and interrupt alone does not
 *      reap them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It builds no provider and resolves no API
 * key of its own. `bootstrapEngine` is the shipped path the stdio host uses —
 * `.env`, layered settings, key resolution, endpoint mapping, the tool registry
 * and MCP — and its own comment says "so can a test". A second resolution path
 * here would be a fourth copy of the connection rules and would drift from the
 * one the app actually boots.
 *
 * REQUIRES `npm run build`, for the same reason `engineHarness.ts` does: it
 * imports the engine through its package entry points, which resolve to each
 * package's gitignored `dist/`.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Engine } from "@magentra/core";
import { bootstrapEngine, loadDotEnv } from "@magentra/host";
import type { CoreEvent } from "@magentra/protocol";

import { FeatureTest, realModelTestsEnabled, LLM_OPT_IN_VAR } from "./featureTest.ts";
import { repoRoot } from "./inventory.ts";

/** What `bootstrapEngine` returned, plus the drain loop the kind owns. */
interface BootedEngine {
  readonly engine: Engine;
  readonly warnings: readonly string[];
}

export abstract class LlmTest extends FeatureTest {
  readonly kind = "llm" as const;

  /**
   * A real turn is a network round trip per model call, and the features this
   * kind exists for are multi-turn ones. The 60s a `proc` test gets is a
   * timeout a healthy run would hit.
   */
  override readonly timeoutMs: number = 180_000;

  #dirs: string[] = [];
  #booted: BootedEngine | undefined;
  #events: CoreEvent[] = [];
  #draining: Promise<void> | undefined;

  /**
   * Everything the engine has emitted so far, in order.
   *
   * Read it, do not iterate `engine.events` — see point 3 in this file's
   * header. The array is live: it keeps growing as the drain loop runs, so take
   * a copy if you need a stable snapshot across an `await`.
   */
  protected get events(): readonly CoreEvent[] {
    return this.#events;
  }

  /** Non-fatal settings problems `bootstrapEngine` reported. Empty on a clean boot. */
  protected get bootWarnings(): readonly string[] {
    return this.#booted?.warnings ?? [];
  }

  /** A fresh empty directory this test owns. Removed at teardown. */
  protected tempDir(prefix = "magentra-llm-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /**
   * A real engine, on the connection this folder is pointed at, running in a
   * temp workspace. Booted on first call and shared for the rest of the test.
   *
   * @throws when this folder names no connection — rule 7, made loud. The
   * message names both routes to fixing it, because the two audiences for this
   * failure (a developer who has never connected, and CI) need different ones.
   */
  protected async engine(): Promise<Engine> {
    if (this.#booted !== undefined) return this.#booted.engine;

    const workspace = this.tempDir();
    seedConnectionFrom(repoRoot(), workspace);

    let booted: BootedEngine;
    try {
      booted = await bootstrapEngine({ cwd: workspace });
    } catch (err) {
      throw new Error(
        `${this.featureId} · ${this.id} is an "llm" test and this folder resolves no connection, so there is ` +
          `nothing to ask. tests/README rule 7 is "no connection, no run" — this fails rather than passing ` +
          `against nothing.\n\n` +
          `  Connect the folder in the MAGENTRA app, the TUI, or the gateway's CONNECTION panel — all three ` +
          `write the same two files (<repo>/.env and <repo>/.magentra/settings.json), and this kind copies ` +
          `them into its temp workspace.\n\n` +
          `  ${String(err instanceof Error ? err.message : err)}`,
        { cause: err },
      );
    }

    this.#booted = booted;
    // Point 3: ONE consumer, opened here and nowhere else.
    this.#draining = (async () => {
      for await (const event of booted.engine.events) this.#events.push(event);
    })();
    booted.engine.start();
    return booted.engine;
  }

  /** Resolves when every turn and slash command in flight has finished. */
  protected async settle(): Promise<void> {
    if (this.#booted === undefined) return;
    await this.#booted.engine.idle();
  }

  /**
   * Teardown, innermost first: stop what the model started, close the queue so
   * the drain loop can end, then remove the workspaces.
   *
   * Every step is in its own `finally` — a throw while stopping background jobs
   * must still delete the temp directory, or a long run leaves one per test.
   */
  protected override async tearDownKind(): Promise<void> {
    const booted = this.#booted;
    this.#booted = undefined;
    try {
      if (booted !== undefined) {
        booted.engine.stopBackgroundJobs();
        booted.engine.events.close();
        await this.#draining;
      }
    } finally {
      this.#draining = undefined;
      const dirs = this.#dirs;
      this.#dirs = [];
      // Windows keeps a handle open a moment after the process using it is
      // gone, and `force` only forgives ENOENT — the same retry `UiTest` needs.
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

/**
 * Give `workspace` the connection `source` has, by the two files §4.2 names.
 *
 * A COPY, not a re-resolution. `applyProfile` writes `<ws>/.env` and
 * `<ws>/.magentra/settings.json`; `loadDotEnv` and `loadSettings` read exactly
 * those, so copying the file is enough and nothing here has to know what a
 * connection consists of. Global settings (`~/.magentra/settings.json`) are
 * already the lower layer of `loadSettings` and need no copy — a developer
 * connected globally rather than per-folder is covered without this doing
 * anything.
 *
 * `.env` is read into THIS process's environment rather than copied, because
 * that is what `bootstrapEngine` does with it anyway and because a key written
 * into a temp directory is a key on disk for the life of the test.
 */
function seedConnectionFrom(source: string, workspace: string): void {
  loadDotEnv(source);
  const settings = join(source, ".magentra", "settings.json");
  if (!existsSync(settings)) return;
  mkdirSync(join(workspace, ".magentra"), { recursive: true });
  cpSync(settings, join(workspace, ".magentra", "settings.json"));
}

export { realModelTestsEnabled, LLM_OPT_IN_VAR };
