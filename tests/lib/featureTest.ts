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
 * Register tests with `node:test` — the one way a `tests/features/*.test.ts`
 * file turns its classes into runnable tests.
 *
 * The name is `<featureId> · <test id>`, so `--test-name-pattern` filters by
 * feature the same way the gateway does.
 */
export function registerFeatureTests(...tests: readonly FeatureTest[]): void {
  const seen = new Map<string, string>();
  for (const t of tests) {
    const key = `${t.featureId}/${t.id}`;
    const dupe = seen.get(key);
    if (dupe !== undefined) {
      throw new Error(`two tests registered as "${key}" — a test id is unique within its feature, and the record's "tests" array cannot list one twice`);
    }
    seen.set(key, key);
    registerOne(t);
  }
}

function registerOne(t: FeatureTest): void {
  test(`${t.featureId} · ${t.id}`, { timeout: t.timeoutMs }, async (ctx) => {
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
