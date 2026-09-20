/**
 * `single-consumer-events`.
 *
 * `Engine.events` is an `AsyncQueue`: each pushed event goes to whichever
 * `for await` loop asked first. It is meant to have exactly one reader for the
 * engine's life. A second reader does not error — it silently receives some of
 * the events and the first reader silently misses them, which shows up as a
 * frontend that skips turns with nothing in any log. That is why the desktop
 * app runs one engine PROCESS per workspace rather than sharing one engine.
 *
 * `pure` + `fs`, and the record said `pure`. Items 1, 2, 3 and 5 are the queue
 * on its own, a function of what is pushed into it. Item 4 is a real Engine
 * on a scripted provider, which runs in a workspace directory and writes its
 * transcript there — filesystem work by `fsTest.ts`'s definition. Re-declared
 * 2026-09-19.
 */

import { AsyncQueue } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "single-consumer-events";

/** Verbatim from the record. */
const INVARIANT = "The event queue has exactly one consumer; a second silently steals events, which is why multi-workspace is a process pool.";

/** Drain `n` items from one iterator, in order. */
async function take<T>(iterator: AsyncIterator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const next = await iterator.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

abstract class QueueTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class ItemsBufferInOrder extends QueueTest {
  readonly id = "items-pushed-before-anyone-reads-are-yielded-in-order";
  readonly whyItExists =
    "events emitted during boot, before the host's pump loop starts, would be lost by a queue that only delivered to a live waiter — session_started is the first of them";

  override async run(t: TestRun): Promise<void> {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    const iterator = queue[Symbol.asyncIterator]();
    t.assert.deepEqual(await take(iterator, 3), [1, 2, 3], "FIFO, nothing lost, nothing reordered");
    // Items pushed after the reader is waiting arrive too.
    const pending = iterator.next();
    queue.push(4);
    t.assert.deepEqual(await pending, { value: 4, done: false });
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ASecondReaderStealsEvents extends QueueTest {
  readonly id = "two-concurrent-readers-split-the-events-between-them";
  readonly whyItExists =
    "the single-consumer contract is a comment on a field; this is the measurement behind it — a second for-await over engine.events silently takes events the first one never sees";

  override async run(t: TestRun): Promise<void> {
    const queue = new AsyncQueue<number>();
    const a = queue[Symbol.asyncIterator]();
    const b = queue[Symbol.asyncIterator]();
    // Both readers ask before anything is pushed, so each push wakes one of them.
    const receivedA: number[] = [];
    const receivedB: number[] = [];
    const readA = (async () => {
      receivedA.push(...(await take(a, 2)));
    })();
    const readB = (async () => {
      receivedB.push(...(await take(b, 2)));
    })();
    for (const n of [1, 2, 3, 4]) queue.push(n);
    await Promise.all([readA, readB]);

    const union = [...receivedA, ...receivedB].sort((x, y) => x - y);
    t.assert.deepEqual(union, [1, 2, 3, 4], "between them the two readers saw everything exactly once");
    t.assert.ok(receivedA.length > 0 && receivedA.length < 4, `reader A got ${receivedA.length} of 4 — it MISSED events`);
    t.assert.ok(receivedB.length > 0 && receivedB.length < 4, `reader B got ${receivedB.length} of 4 — it MISSED events`);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class CloseEndsAWaitingReader extends QueueTest {
  readonly id = "close-resolves-a-waiting-reader-with-done-and-drops-later-pushes";
  readonly whyItExists =
    "a pump loop awaiting the next event of an engine that had shut down hung the host process forever, because nothing ever told the iterator the stream was over";

  override async run(t: TestRun): Promise<void> {
    const queue = new AsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const waiting = iterator.next();
    queue.close();
    t.assert.deepEqual(await waiting, { value: undefined, done: true }, "the reader that was waiting is released with done:true");

    queue.push("after close");
    const fresh = queue[Symbol.asyncIterator]();
    t.assert.deepEqual(await fresh.next(), { value: undefined, done: true }, "a push after close is dropped — a fresh reader sees the end at once");
  }
}

/* ---- checklist 4 — fs ------------------------------------------------ */

class OneConsumerSeesTheWholeTurn extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "one-consumer-over-engine-events-sees-session-started-turn-started-and-turn-finished-in-order";
  readonly whyItExists =
    "the host's single pump loop is the only thing between the engine and the app; if it could miss or reorder a turn's frames the app would show a turn that never ended";

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-single-consumer-");
    // The fixture owns the one for-await loop (scriptedEngine.ts, header point 3)
    // and collects into `events` — exactly the arrangement the host has.
    this.#engine = await startScriptedEngine({ workspace, turns: [{ text: "hello" }] });
    const turn = await this.#engine.runTurn("hi");

    const types = this.#engine.events.map((e) => e.type);
    t.assert.equal(types[0], "session_started", "the first event of an engine's life is session_started");
    const started = types.indexOf("turn_started");
    const finished = types.indexOf("turn_finished");
    t.assert.ok(started > 0, "turn_started arrives after boot");
    t.assert.ok(finished > started, "turn_finished arrives after turn_started");
    t.assert.equal(types.filter((x) => x === "turn_started").length, 1, "one turn, one start");
    t.assert.equal(types.filter((x) => x === "turn_finished").length, 1, "one turn, one finish");
    t.assert.equal(turn.stopReason, "end_turn");
    t.assert.equal(turn.events.some((e) => e.type === "text_delta"), true, "the streamed text was not lost between the two");

    // Checklist 5's other half: every event a real engine emits is an object with a string type.
    for (const event of this.#engine.events) {
      t.assert.equal(typeof event, "object");
      t.assert.equal(typeof (event as CoreEvent).type, "string");
    }
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class UndefinedIsNotAnItem extends QueueTest {
  readonly id = "the-queue-never-yields-undefined-so-an-event-is-always-an-object";
  readonly whyItExists =
    "next() tells an empty buffer from a buffered item with `item !== undefined`; an undefined pushed as an item would wedge the reader on a value that was never a frame";

  override async run(t: TestRun): Promise<void> {
    const queue = new AsyncQueue<Record<string, unknown> | undefined>();
    queue.push(undefined);
    queue.close();
    const iterator = queue[Symbol.asyncIterator]();
    // A buffered undefined is indistinguishable from "nothing buffered", so the
    // closed queue reports its end rather than handing out a non-event.
    t.assert.deepEqual(await iterator.next(), { value: undefined, done: true }, "an undefined item is never yielded as an item");

    // The contract every emitter keeps: an event is an object. Pushing one
    // through a fresh queue yields it intact and `done:false`.
    const events = new AsyncQueue<Record<string, unknown>>();
    events.push({ type: "turn_started", turnId: "t_1" });
    t.assert.deepEqual(await events[Symbol.asyncIterator]().next(), { value: { type: "turn_started", turnId: "t_1" }, done: false });
  }
}

registerFeatureTests(new ItemsBufferInOrder(), new ASecondReaderStealsEvents(), new CloseEndsAWaitingReader(), new OneConsumerSeesTheWholeTurn(), new UndefinedIsNotAnItem());
