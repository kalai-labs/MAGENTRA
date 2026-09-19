/**
 * The abstract base every MAGENTRA test extends — SPEC §3, decisions/0004.
 *
 * Tests inherit on KIND (`pure` / `fs` / `proc` / `net` / `llm` / `ui`), because
 * kind decides the two things nothing else decides: what setup and teardown a
 * test needs, and whether it can run at all. Area is a filter, so it stays a
 * field on the record. This file holds what is true of all six.
 *
 * WHAT THE BASE REFUSES TO LET A TEST OMIT
 *
 * `featureId`, `invariant`, `whyItExists` and `id` are abstract, so a test that
 * cannot say which record it proves, what is true while the feature works, or
 * which failure it would have caught does not compile. That is ability 2 of the
 * gateway, made structural: 21 files and 6,366 lines were deleted on 2026-09-09
 * because 28 ticked boxes had no assertion behind them, and a test that cannot
 * state why it exists is the scaffold that reset removed.
 *
 * THREE RULES ENFORCED BY MECHANISM, NOT BY MEMORY
 *
 *   1. NO SKIP, NO SOFT ASSERT, NO EXPECTED-FAILURE STATE (§3). `run()` never
 *      receives a `node:test` TestContext — it gets {@link TestRun}, which has
 *      no `skip`, no `todo` and no `plan`. A failing test cannot be quieted
 *      from inside itself; it stays failing until the feature is fixed.
 *
 *   2. A TEST MUST ASSERT SOMETHING. `run()` is handed the assertion library it
 *      must use, counted, and a run that finishes having asserted nothing FAILS.
 *      This is the deleted suite's exact defect, and the only way to catch it
 *      is to count. Use `t.assert`, not an imported `node:assert` — an import
 *      is invisible to the counter and its test will fail as unasserted.
 *
 *   3. A TEST AGREES WITH ITS RECORD, or it fails. The class's kind must be one
 *      the record declares, its `invariant` must match the record's verbatim,
 *      and its `id` must appear in the record's `tests`. Freshness already
 *      blocks a record that has drifted from the CODE (SPEC §4.1); this is the
 *      same discipline for a record that has drifted from its TEST, and it is
 *      what lets the gateway derive `status` from the `tests` array and be right.
 *
 * WHY THE CHECKS RUN INSIDE THE TEST BODY, not in the constructor: class field
 * initializers in a subclass run after the base constructor returns, so a
 * constructor here would read `undefined` for every one of them. Registration
 * time is the first moment a test is fully built.
 *
 * THE ONE KIND THAT IS OPT-IN (decisions/0009). `llm` tests call a real model:
 * they cost tokens and can fail for a provider's reasons rather than this
 * repository's. They are withheld unless {@link realModelTestsEnabled}, and
 * WITHHELD IS NOT SKIPPED — see {@link registerFeatureTests}.
 */

import { test } from "node:test";
import baseAssert from "node:assert/strict";

import { featureRecordPath, readFeatureRecord, type FeatureRecordSubset, type Kind } from "./inventory.ts";

/**
 * What `run()` is given. Deliberately narrower than `node:test`'s TestContext:
 * everything that could turn a failure into a non-failure is absent, per rule 1
 * above. `signal` aborts when the runner's timeout fires, so a long wait can be
 * cancelled instead of hanging the suite.
 */
export interface TestRun {
  /** Aborted when this test times out. Pass it to anything that waits. */
  readonly signal: AbortSignal;
  /** `node:assert/strict`, counted. The base fails a run that never called it. */
  readonly assert: typeof baseAssert;
  /** A note in the test output. Never a substitute for an assertion. */
  diagnostic(message: string): void;
}

/** Class-valued members of `node:assert`, which must not be wrapped: `new assert.AssertionError()` is not an assertion. */
const NOT_AN_ASSERTION = new Set(["AssertionError", "CallTracker"]);

/** `node:assert/strict`, wrapped so every call through it is counted. See rule 2. */
function countingAssert(count: { n: number }): typeof baseAssert {
  const wrapped = new Map<string, unknown>();
  return new Proxy(baseAssert, {
    apply(target, thisArg, args: unknown[]) {
      count.n += 1;
      return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
    },
    get(target, prop, receiver) {
      // `assert.strict` is the module's self-reference; hand back the counting
      // view so reaching for it cannot step around the counter.
      if (prop === "strict") return receiver;
      const value = Reflect.get(target, prop, target);
      if (typeof prop !== "string" || typeof value !== "function" || NOT_AN_ASSERTION.has(prop)) return value;
      const already = wrapped.get(prop);
      if (already !== undefined) return already;
      const fn = (...args: unknown[]): unknown => {
        count.n += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
      wrapped.set(prop, fn);
      return fn;
    },
  }) as typeof baseAssert;
}

/**
 * One test, proving one thing about one feature.
 *
 * A concrete test extends a KIND subclass (`ProcTest`, …), never this class
 * directly: `kind` is fixed by the subclass, which is also where the setup and
 * teardown that kind requires lives.
 */
export abstract class FeatureTest {
  /** The inventory record this test proves — `tests/gateway/features/<id>.json`. */
  abstract readonly featureId: string;

  /**
   * This test's id, stable and unique within its feature. It is what the
   * record's `tests` array lists, and what the gateway counts to derive
   * `status`, so renaming one is a record edit too.
   */
  abstract readonly id: string;

  /** One sentence: what is true while the feature works. Must match the record's `invariant` verbatim. */
  abstract readonly invariant: string;

  /**
   * The failure this test would have caught. Required by §3, and the reason the
   * gateway can answer "why does this test exist" for every row it shows.
   * Name the wrong behaviour, not the right one: "a 404 on /models was read as
   * reachable, so TEST passed on a URL that could never chat".
   */
  abstract readonly whyItExists: string;

  /** Fixed by the kind subclass. Must be one the record declares. */
  abstract readonly kind: Kind;

  /**
   * True on a test that needs a PACKAGED app — one that runs the real
   * packager and launches, or inspects, what it produced. Withheld unless
   * {@link realArtifactTestsEnabled}, exactly as `llm` is (decisions/0010).
   *
   * A MEMBER AND NOT A SEVENTH KIND. Kind is a claim about what setup and
   * teardown a proof requires, and packaging is not one of those — it is a
   * cost. These tests keep the kind their proof actually needs and this flag
   * says only that the proof is expensive enough to be asked for.
   */
  readonly artifact: boolean = false;

  /** Per-test limit. A kind that spawns or waits on I/O may raise it. */
  readonly timeoutMs: number = 30_000;

  /** The assertion. Everything this test proves happens here. */
  abstract run(t: TestRun): void | Promise<void>;

  /**
   * Setup and teardown for THIS test. The kind's own lifecycle is
   * {@link setUpKind}/{@link tearDownKind} and is deliberately a different pair:
   * a concrete test overriding `tearDown` can then never shadow the guarantee
   * its kind makes — a `ProcTest` that forgets to call `super.tearDown()` would
   * otherwise leak the child process the kind promised to kill.
   */
  setUp(): void | Promise<void> {}
  tearDown(): void | Promise<void> {}

  /** Owned by the kind subclass, never by a concrete test. Always run, even when `run()` throws. */
  protected setUpKind(): void | Promise<void> {}
  protected tearDownKind(): void | Promise<void> {}

  /** @internal — the registrar reaches the kind hooks through this, so they stay `protected` to tests. */
  async invokeKindSetUp(): Promise<void> {
    await this.setUpKind();
  }

  /** @internal */
  async invokeKindTearDown(): Promise<void> {
    await this.tearDownKind();
  }
}

/** Placeholders that pass a non-empty check while saying nothing. */
const PLACEHOLDER = /^(todo|tbd|n\/?a|none|why|because|it exists|test|fixme|xxx)\b/i;

/**
 * Rule 3, as a list of problems rather than a throw, so one report names
 * everything wrong with a test's registration instead of the first thing.
 */
export function inventoryLinkageProblems(t: FeatureTest, record: FeatureRecordSubset): string[] {
  const rel = featureRecordPath(t.featureId);
  const problems: string[] = [];

  if (!record.kinds.includes(t.kind)) {
    problems.push(
      `this test is a "${t.kind}" test, but ${rel} declares kinds [${record.kinds.join(", ")}]. ` +
        `Kind decides setup, teardown and whether the test can run at all (decisions/0004), so one of the two is wrong: ` +
        `either extend the class the record names, or change the record because the honest kind changed.`,
    );
  }

  if (t.invariant !== record.invariant) {
    problems.push(
      `the invariant does not match ${rel} verbatim.\n  record: ${JSON.stringify(record.invariant)}\n  test:   ${JSON.stringify(t.invariant)}\n` +
        `  The record is the source of truth. If the invariant changed, the test is what has to be re-read, which is why this fails rather than warns.`,
    );
  }

  if (!record.tests.includes(t.id)) {
    problems.push(
      `${rel} does not list test id "${t.id}" in its "tests" array (it lists [${record.tests.join(", ") || "nothing"}]). ` +
        `The gateway derives a feature's status from that array, so an unrecorded test is a test the inventory reports as missing. Add the id.`,
    );
  }

  // `deferred` is NOT checked here, deliberately. §2.1 says a deferred feature
  // "carries no test expectation" and "never counts against coverage" — it does
  // not say a test is forbidden, and this rule used to read it that way and
  // refuse one. That was an overreach: it made the flag, which is set BY RULE
  // from a record's entry files, into a prohibition nobody had decided on.
  // decisions/0008 records the correction. A deferred feature may be proven;
  // it is simply never counted as a gap when it is not.

  if (t.whyItExists.trim().length < 20 || PLACEHOLDER.test(t.whyItExists.trim())) {
    problems.push(
      `whyItExists says ${JSON.stringify(t.whyItExists)}, which does not name a failure. ` +
        `§3 makes it mandatory: state the wrong behaviour this test would have caught.`,
    );
  }

  return problems;
}

/**
 * The environment variable that turns the real-model tests on.
 *
 * An ENVIRONMENT VARIABLE and not a file, deliberately (decisions/0009): the
 * opt-in belongs to one run, not to the repository. A checked-in flag would
 * turn real API calls on for everyone who pulled it — including CI, which has
 * no connection and would go red for a reason that is nobody's defect.
 */
export const LLM_OPT_IN_VAR = "MAGENTRA_LLM_TESTS";

/** Values that mean "yes" in an environment variable, spelled the ways people spell it. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** The npm script that exists for no other purpose than running these. */
const OPT_IN_SCRIPT = "test:llm";

/**
 * Whether the user asked for the real-model tests in THIS run.
 *
 * `npm test` does not ask, so the default stays: every kind that can prove
 * itself locally runs, and the one that needs a real endpoint waits to be
 * asked.
 *
 * TWO SIGNALS, ONE QUESTION. The variable is the contract — anything can set
 * it, including CI and a single `node --test` invocation with no npm in front
 * of it. `npm_lifecycle_event` is the second, and it is what makes
 * `npm run test:llm` work on all three platforms: the obvious spelling,
 * `"test:llm": "MAGENTRA_LLM_TESTS=1 node --test …"`, is sh syntax, and npm
 * runs scripts through `cmd.exe` on Windows, where it is not a variable
 * assignment but a command named `MAGENTRA_LLM_TESTS=1` that does not exist.
 * The alternatives were a `cross-env` dependency or a wrapper script that
 * spawns the runner; npm already exports the name of the script it is running,
 * to every child of it, on every platform, so neither was worth adding.
 */
export function realModelTestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (TRUTHY.has((env[LLM_OPT_IN_VAR] ?? "").trim().toLowerCase())) return true;
  return env["npm_lifecycle_event"] === OPT_IN_SCRIPT;
}

/**
 * The environment variable that turns the packaged-artifact tests on.
 *
 * The same shape as {@link LLM_OPT_IN_VAR}, for the same reason and by the
 * same decision extended (decisions/0010): building an installer takes
 * minutes, holds `lib/exclusive.ts`'s lock for the whole of it, and writes
 * hundreds of megabytes. That belongs to a run somebody asked for, not to
 * the repository and not to CI.
 */
export const ARTIFACT_OPT_IN_VAR = "MAGENTRA_ARTIFACT_TESTS";

/** The npm script that exists for no other purpose than running these. */
const ARTIFACT_OPT_IN_SCRIPT = "test:artifacts";

/**
 * Whether the user asked for the packaged-artifact tests in THIS run.
 *
 * Two signals and one question, for the reason spelled out on
 * {@link realModelTestsEnabled}: `MAGENTRA_ARTIFACT_TESTS=1 node …` is sh
 * syntax and npm runs scripts through `cmd.exe` on Windows, so the script
 * NAME is the second way of asking and the one `npm run` uses.
 */
export function realArtifactTestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (TRUTHY.has((env[ARTIFACT_OPT_IN_VAR] ?? "").trim().toLowerCase())) return true;
  return env["npm_lifecycle_event"] === ARTIFACT_OPT_IN_SCRIPT;
}

/**
 * Register tests with `node:test` — the one way a `tests/features/*.test.ts`
 * file turns its classes into runnable tests.
 *
 * The name is `<featureId> · <test id>`, so `--test-name-pattern` filters by
 * feature the same way the gateway does.
 *
 * A WITHHELD TEST IS REGISTERED AND MARKED SKIPPED, and the first attempt at
 * this got it backwards. Not registering the test at all looks like the purer
 * answer — nothing registered cannot read green — and it is the opposite: a
 * file that registers NOTHING is reported by `node:test` as one passing test,
 * the file itself. A run of three real-model tests then printed
 * `tests 1 · pass 1` with not one assertion behind it, which is precisely the
 * ticked box with nothing behind it that the 2026-09-09 reset removed. Measured,
 * not reasoned about.
 *
 * Registering with `{ skip }` counts them where they belong — `pass 0`,
 * `skipped 3`, each one named in the reporter with its reason. That is the
 * honest number.
 *
 * This is NOT the skip tests/README rule 4 forbids. That rule is about a test
 * quieting ITSELF: `run()` is handed a {@link TestRun} with no `skip`, `todo`
 * or `plan`, so a failing test can never be talked out of failing from the
 * inside. Nothing here can reach that. The decision is made once, before any
 * test body exists, from the one question the user answered on the command
 * line — and a real-model test the user DID ask for has no escape hatch at all.
 *
 * {@link announceWithheld} adds the part a reporter line cannot: the command
 * that runs them. The gateway's REAL-MODEL TESTS view is the durable half of
 * the same answer — making the absence of a test visible and specific is what
 * that tool is for.
 */
export function registerFeatureTests(...tests: readonly FeatureTest[]): void {
  const seen = new Map<string, string>();
  const withheld: FeatureTest[] = [];
  const withheldArtifacts: FeatureTest[] = [];
  const enabled = realModelTestsEnabled();
  const artifactsEnabled = realArtifactTestsEnabled();

  for (const t of tests) {
    const key = `${t.featureId}/${t.id}`;
    const dupe = seen.get(key);
    if (dupe !== undefined) {
      throw new Error(`two tests registered as "${key}" — a test id is unique within its feature, and the record's "tests" array cannot list one twice`);
    }
    seen.set(key, key);

    // The duplicate check runs FIRST, so two tests colliding on one id is still
    // a loud error in a run that was not going to execute either of them.
    if (t.kind === "llm" && !enabled) {
      withheld.push(t);
      registerOne(t, `needs a real model — not run without ${LLM_OPT_IN_VAR}. Run: npm run test:llm`);
      continue;
    }

    if (t.artifact && !artifactsEnabled) {
      withheldArtifacts.push(t);
      registerOne(t, `needs a packaged app — not run without ${ARTIFACT_OPT_IN_VAR}. Run: npm run test:artifacts`);
      continue;
    }
    registerOne(t);
  }

  if (withheld.length > 0) {
    announceWithheld(withheld, "real-model", "a scripted provider cannot prove them", LLM_OPT_IN_VAR, "npm run test:llm");
  }
  if (withheldArtifacts.length > 0) {
    announceWithheld(withheldArtifacts, "packaged-artifact", "they need the real installer, built and launched", ARTIFACT_OPT_IN_VAR, "npm run test:artifacts");
  }
}

/**
 * Say, on stderr, exactly which real-model tests this run did not execute.
 *
 * stderr rather than stdout because stdout is where the test reporter's own
 * stream lives, and a line that looks like part of a TAP or spec report is a
 * line that reads as a result. This is not a result; it is the absence of one.
 */
function announceWithheld(
  withheld: readonly FeatureTest[],
  what: string,
  why: string,
  optInVar: string,
  command: string,
): void {
  const lines = [
    "",
    `  ┌─ ${withheld.length} ${what} test${withheld.length === 1 ? "" : "s"} NOT RUN in this session`,
    ...withheld.map((t) => `  │  ${t.featureId} · ${t.id}`),
    `  │`,
    `  │  Withheld because ${why}.`,
    `  │  Run them with:  ${command}   (or ${optInVar}=1)`,
    `  └─ They are counted as skipped, never as passed.`,
    "",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

/**
 * @param skip - present only for a real-model test the user did not ask for.
 * It is the ONE reason a body here does not run, it is decided before the body
 * exists, and no test can set it for itself — see {@link registerFeatureTests}.
 */
function registerOne(t: FeatureTest, skip?: string): void {
  test(`${t.featureId} · ${t.id}`, { timeout: t.timeoutMs, ...(skip !== undefined ? { skip } : {}) }, async (ctx) => {
    // Rule 3 first: a test that disagrees with its record has nothing to prove
    // yet, and running it would report on a feature the record no longer
    // describes. The plain `baseAssert` here is uncounted on purpose — passing
    // the linkage check must never satisfy rule 2.
    const record = readFeatureRecord(t.featureId);
    const problems = inventoryLinkageProblems(t, record);
    if (problems.length > 0) {
      // `fail` rather than a comparison: an assertion diff over an array of
      // sentences buries the sentences, and these ARE the report.
      baseAssert.fail(
        `${t.featureId} · ${t.id} does not agree with its inventory record:\n\n${problems.map((p) => `  - ${p}`).join("\n\n")}\n`,
      );
    }

    ctx.diagnostic(`kind: ${t.kind} · why: ${t.whyItExists}`);

    const count = { n: 0 };
    const run: TestRun = {
      signal: ctx.signal,
      assert: countingAssert(count),
      diagnostic: (message: string) => ctx.diagnostic(message),
    };

    // The kind's teardown is the outermost `finally`, so it runs whether the
    // test passed, failed, or threw in its own teardown. "No orphans" is a
    // promise a kind makes, and a promise kept only on the happy path is not one.
    try {
      await t.invokeKindSetUp();
      try {
        await t.setUp();
        await t.run(run);
      } finally {
        await t.tearDown();
      }
    } finally {
      await t.invokeKindTearDown();
    }

    if (count.n === 0) {
      baseAssert.fail(
        `${t.featureId} · ${t.id} finished without asserting anything. ` +
          `A test that asserts nothing is the ticked box with nothing behind it that the 2026-09-09 reset removed — ` +
          `assert through the \`t.assert\` handed to run(); an imported \`node:assert\` is not counted.`,
      );
    }
  });
}
