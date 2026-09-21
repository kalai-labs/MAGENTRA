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

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Engine } from "@magentra/core";
import { bootstrapEngine, loadDotEnv } from "@magentra/host";
import type { CoreEvent, FrontendRequest, PermissionDecision } from "@magentra/protocol";

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
  #workspace: string | undefined;
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

  /**
   * Write whatever this test's workspace must already contain when the engine
   * boots into it. Called with the workspace directory, after the connection is
   * seeded and before `bootstrapEngine`. Does nothing by default.
   */
  protected seedWorkspace(_dir: string): void {}

  /**
   * The directory the engine is running in — a temp directory, not this
   * repository, so a turn that decides to write something cannot land it in the
   * working tree. Assert against files here; it is removed at teardown.
   */
  protected get workspace(): string {
    if (this.#workspace === undefined) throw new Error("workspace before engine() — boot the engine first");
    return this.#workspace;
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
    this.#workspace = workspace;
    seedConnectionFrom(repoRoot(), workspace);
    // After the connection, before the engine: `standards-md` needs its
    // STANDARDS.md on disk when `buildSystemPrompt` first reads the folder, and
    // `reuse-check` needs the existing code its gate is supposed to notice.
    this.seedWorkspace(workspace);

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
      for await (const event of booted.engine.events) {
        this.#events.push(event);
        if (event.type === "permission_request") this.#onPermissionRequest(booted.engine, event);
        if (event.type === "question_request") this.#onQuestionRequest(booted.engine, event);
      }
    })();
    booted.engine.start();
    return booted.engine;
  }

  /**
   * Answer permission prompts with `handler` for the rest of this test.
   *
   * WHY THIS IS NOT A DEFAULT. A prompt is a fact about what the model asked
   * for, and auto-approving one everywhere would hide the difference between
   * "the turn ran" and "the turn ran because the harness said yes to something
   * the test never anticipated". So a test that expects a prompt installs a
   * handler and OWNS the decision; a test that expects none installs nothing
   * and {@link settle} fails the moment one arrives, naming the tool — see
   * {@link unexpectedPrompt}.
   *
   * `approval-note` is the reason this takes a `message`: the note a user types
   * on the card travels with the decision, and proving it reaches the model is
   * the whole feature.
   */
  protected answerPermissions(
    handler: (req: Extract<CoreEvent, { type: "permission_request" }>) => {
      decision: PermissionDecision;
      message?: string;
    },
  ): void {
    this.#permissionHandler = handler;
  }

  /**
   * Answer question cards with `handler` for the rest of this test — the
   * same bargain as {@link answerPermissions}, and needed for the same reason.
   *
   * `settings.clarify` defaults to TRUE, so an open-ended request raises a
   * question round BEFORE any work and the turn then waits for cards nobody is
   * going to fill in. A test whose subject is that round installs a handler; a
   * test that merely phrased its prompt loosely gets told so by {@link settle}
   * instead of dying at its 180s timeout. Most tests here want neither and turn
   * the pre-layer off in {@link seedWorkspace} via {@link patchSettings}.
   *
   * RETURNING `undefined` LEAVES THE ROUND OPEN, deliberately. `interrupt`'s
   * fourth checklist item is that an interrupt settles a round still waiting
   * for cards, so that test needs a question that stays pending — and needs to
   * say so, rather than reaching that state by installing no handler and
   * tripping {@link settle}'s "you forgot" guard.
   */
  protected answerQuestions(
    handler: (req: Extract<CoreEvent, { type: "question_request" }>) => Record<string, string[]> | undefined,
  ): void {
    this.#questionHandler = handler;
  }

  /**
   * Merge `patch` into the workspace's `.magentra/settings.json`.
   *
   * Called from {@link seedWorkspace}, so it lands before `bootstrapEngine`
   * reads the folder. It merges rather than replaces because the file it is
   * editing is the CONNECTION this test runs on — provider, baseUrl, model,
   * contextWindow — and overwriting that would leave the test with no endpoint.
   */
  protected patchSettings(dir: string, patch: Record<string, unknown>): void {
    const file = join(dir, ".magentra", "settings.json");
    const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
    mkdirSync(join(dir, ".magentra"), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
  }

  /** Send a frame to the booted engine. `engine()` must have been awaited first. */
  protected send(request: FrontendRequest): void {
    if (this.#booted === undefined) throw new Error("send() before engine() — boot the engine first");
    this.#booted.engine.send(request);
  }

  /**
   * Resolves when every turn and slash command in flight has finished.
   *
   * REJECTS INSTEAD OF WAITING on a permission prompt nobody installed a
   * handler for. `Engine.idle()` would otherwise wait for a card that is never
   * going to be filled in, and the test would die at its 180s timeout saying
   * only "timed out" — for a run that costs money and is hard to reproduce,
   * that is the least useful failure available. The tool and its input are
   * named instead, because the interesting fact is WHICH call the model made
   * that the test did not expect.
   */
  protected async settle(): Promise<void> {
    if (this.#booted === undefined) return;
    const idle = this.#booted.engine.idle();
    let done = false;
    void idle.then(
      () => (done = true),
      () => (done = true),
    );
    for (;;) {
      if (this.#unexpectedPrompt !== undefined) {
        const prompt = this.#unexpectedPrompt;
        throw new Error(
          `${this.featureId} · ${this.id}: the model asked permission for "${prompt.tool}" and this test installed no ` +
            `handler, so the turn can never finish. Either the prompt is part of what you are proving — call ` +
            `answerPermissions() and decide it — or the model did something the prompt did not intend.\n` +
            `  input: ${JSON.stringify(prompt.input)?.slice(0, 400)}`,
        );
      }
      if (this.#unexpectedQuestion !== undefined) {
        const asked = this.#unexpectedQuestion;
        throw new Error(
          `${this.featureId} · ${this.id}: a question round opened and this test installed no handler, so the turn can ` +
            `never finish. Either the round is what you are proving — call answerQuestions() — or the prompt read as ` +
            `open-ended and the clarify pre-layer fired; turn it off with patchSettings(dir, { clarify: false }).\n` +
            `  asked: ${JSON.stringify(asked.questions.map((q) => q.question)).slice(0, 400)}`,
        );
      }
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await idle;
  }

  /**
   * Wait until an event this test is looking for has been emitted, and return it.
   *
   * For the things that happen DURING a turn rather than at the end of one: the
   * question card the clarify pre-layer raises, the permission card whose note
   * is the subject, the first tool call a steering test wants to land behind.
   * `signal` is the runner's — a wait that outlives the test aborts with the
   * name of what it was waiting for, never with a bare timeout.
   */
  protected async waitForEvent<T extends CoreEvent["type"]>(
    signal: AbortSignal,
    type: T,
    what: string,
    match: (event: Extract<CoreEvent, { type: T }>) => boolean = () => true,
  ): Promise<Extract<CoreEvent, { type: T }>> {
    let seen = 0;
    for (;;) {
      for (; seen < this.#events.length; seen++) {
        const event = this.#events[seen]!;
        if (event.type === type && match(event as Extract<CoreEvent, { type: T }>)) {
          return event as Extract<CoreEvent, { type: T }>;
        }
      }
      if (signal.aborted) throw new Error(`timed out waiting for ${what} (${type})`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Every event of one type, in order — the usual shape of an assertion here. */
  protected eventsOfType<T extends CoreEvent["type"]>(type: T): Extract<CoreEvent, { type: T }>[] {
    return this.#events.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === type);
  }

  /**
   * The current session's transcript file, as raw text.
   *
   * THE DETERMINISTIC WITNESS for everything the engine puts into the
   * conversation that the user never sees: the self-check rung, the approval
   * note travelling with a tool result, the compaction summary that replaced a
   * span, the steering text that joined a running turn. None of those is an
   * event, and none can be read off what the model said — but all of them are
   * written down, by the engine, as they happen.
   *
   * The id comes from the latest `session_started`, so this follows a `/clear`
   * or a resume to whichever session is live now.
   */
  protected transcriptRaw(): string {
    const started = this.eventsOfType("session_started");
    const id = started[started.length - 1]?.sessionId;
    if (id === undefined) throw new Error("no session_started seen yet — the engine has not announced a session");
    return readFileSync(join(this.workspace, ".magentra", "sessions", `${id}.jsonl`), "utf8");
  }

  /** The transcript's records, parsed, in the order they were appended. */
  protected transcriptRecords(): Record<string, unknown>[] {
    return this.transcriptRaw()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /**
   * What this test billed, summed from the engine's own per-turn figures.
   *
   * `turn_finished.usage` is T_turn — "tokens BILLED for this turn: the sum
   * over every model call it made, including the auxiliary prompts
   * (clarification, summarization) and every subagent". So summing it over the
   * test's turns is the whole spend, not a re-derivation: nothing here counts
   * tokens itself, and there is no second accounting to drift from the
   * engine's.
   *
   * ONE THING IT CANNOT SEE: a model call made outside any turn — a manual
   * `/compact`, for instance — has no `turn_finished` to ride on. No test here
   * makes one, and the reporter says "per-turn" rather than "total" for that
   * reason.
   */
  protected usage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number } {
    const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
    for (const turn of this.eventsOfType("turn_finished")) {
      total.inputTokens += turn.usage.inputTokens;
      total.outputTokens += turn.usage.outputTokens;
      total.cacheReadTokens += turn.usage.cacheReadTokens;
      total.cacheWriteTokens += turn.usage.cacheWriteTokens;
      total.turns += 1;
    }
    return total;
  }

  /**
   * The one report line this kind adds to every test, green or red.
   *
   * A STRICT `key=value` SHAPE, not prose, because two audiences read it: a
   * person scanning the spec output, and `lib/llmUsageReporter.mjs`, which
   * totals these across the run's processes. `node --test` runs every FILE in
   * its own process, so a diagnostic the reporter can parse is the only place
   * a run-wide total can come from.
   */
  protected override kindDiagnostics(): readonly string[] {
    // Reported whenever a session was started, INCLUDING a test that ran no
    // turn — `interrupt · interrupting-an-idle-session…` is one, by design. A
    // zero row keeps the report's test count equal to the run's, which a
    // silently omitted row does not: the first version of this printed TOTAL 25
    // under a summary saying 26 passed.
    const started = this.eventsOfType("session_started")[0];
    if (started === undefined) return [];
    const u = this.usage();
    const model = started.model;
    // `feature=` rather than letting the reporter read the diagnostic's file:
    // `test:diagnostic` reports the file the diagnostic was EMITTED from, which
    // is `featureTest.ts` for every one of these, so every feature landed in
    // one row labelled with the registrar. The test knows its own id; say it.
    return [
      `llm-usage feature=${this.featureId} in=${u.inputTokens} out=${u.outputTokens} ` +
        `cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens} turns=${u.turns} model=${model}`,
    ];
  }

  /** Everything the model said out loud this test, concatenated. */
  protected visibleText(): string {
    return this.eventsOfType("text_delta")
      .map((e) => e.text)
      .join("");
  }

  #permissionHandler:
    | ((req: Extract<CoreEvent, { type: "permission_request" }>) => { decision: PermissionDecision; message?: string })
    | undefined;
  #unexpectedPrompt: Extract<CoreEvent, { type: "permission_request" }> | undefined;
  #questionHandler:
    | ((req: Extract<CoreEvent, { type: "question_request" }>) => Record<string, string[]> | undefined)
    | undefined;
  #unexpectedQuestion: Extract<CoreEvent, { type: "question_request" }> | undefined;

  #onQuestionRequest(engine: Engine, event: Extract<CoreEvent, { type: "question_request" }>): void {
    const handler = this.#questionHandler;
    if (handler === undefined) {
      this.#unexpectedQuestion ??= event;
      return;
    }
    const answers = handler(event);
    if (answers === undefined) return; // left open on purpose — see answerQuestions()
    engine.send({ type: "question_response", id: event.id, answers });
  }

  #onPermissionRequest(engine: Engine, event: Extract<CoreEvent, { type: "permission_request" }>): void {
    const handler = this.#permissionHandler;
    if (handler === undefined) {
      this.#unexpectedPrompt ??= event;
      return;
    }
    const answer = handler(event);
    engine.send({
      type: "permission_response",
      id: event.id,
      decision: answer.decision,
      ...(answer.message !== undefined ? { message: answer.message } : {}),
    });
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
