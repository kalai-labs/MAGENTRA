/**
 * `ndjson-resilience`.
 *
 * The stdio transport is one JSON object per line. The decoder has to survive
 * what real pipes deliver: a line that is not JSON, blank lines, CRLF from a
 * Windows writer, a frame split across two chunks, and a final line the writer
 * never terminated before it closed. One bad frame from either side must not
 * take the whole session down — it becomes a non-fatal error frame and the
 * stream goes on.
 *
 * `pure`: `decodeFrames` is a function of the chunks it is handed.
 */

import { decodeFrames } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "ndjson-resilience";

/** Verbatim from the record. */
const INVARIANT = "An unparseable line yields an error frame and the stream continues; CRLF and an unterminated trailing line are both handled.";

/** The chunks a pipe would deliver, as the async iterable the decoder takes. */
async function* chunks(...parts: (string | Buffer)[]): AsyncIterable<string | Buffer> {
  for (const part of parts) yield part;
}

async function decodeAll(...parts: (string | Buffer)[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const frame of decodeFrames(chunks(...parts))) out.push(frame as Record<string, unknown>);
  return out;
}

abstract class NdjsonTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class ABadLineBecomesAnErrorFrame extends NdjsonTest {
  readonly id = "an-unparseable-line-yields-an-error-frame-and-the-next-frame-still-arrives";
  readonly whyItExists =
    "a JSON.parse throw inside the decoder ended the whole session on one corrupt line, so a single stray log line on stdout killed the engine's connection to the app";

  override async run(t: TestRun): Promise<void> {
    const frames = await decodeAll('{"type":"a"}\nnot json\n{"type":"b"}\n');
    t.assert.equal(frames.length, 3, "three lines in, three frames out");
    t.assert.deepEqual(frames[0], { type: "a" });
    t.assert.equal(frames[1]?.["type"], "error", "the bad line is reported as an error frame");
    t.assert.equal(frames[1]?.["fatal"], false, "and it is NOT fatal — the transport goes on");
    t.assert.match(String(frames[1]?.["message"]), /^unparseable frame: /, "the message names what went wrong");
    t.assert.match(String(frames[1]?.["message"]), /not json/, "and quotes the offending line");
    t.assert.deepEqual(frames[2], { type: "b" }, "the frame AFTER the bad line still arrives intact");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class CrlfIsStripped extends NdjsonTest {
  readonly id = "a-crlf-terminated-line-decodes-without-a-stray-carriage-return";
  readonly whyItExists =
    "a Windows writer terminates lines with CRLF, and a decoder that kept the \\r handed JSON.parse a trailing control character it rejected, so every frame from that side read as an error";

  override async run(t: TestRun): Promise<void> {
    const frames = await decodeAll('{"type":"a"}\r\n');
    t.assert.deepEqual(frames, [{ type: "a" }]);
    t.assert.equal(JSON.stringify(frames).includes("\\r"), false, "no carriage return anywhere in what was decoded");

    // With a string value at the end of the line, where a kept \r would land INSIDE the parsed value.
    const tail = await decodeAll('{"type":"x","text":"hi"}\r\n{"type":"y"}\r\n');
    t.assert.deepEqual(tail, [{ type: "x", text: "hi" }, { type: "y" }]);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnUnterminatedLastLineIsStillParsed extends NdjsonTest {
  readonly id = "a-final-line-with-no-newline-is-yielded-when-the-stream-ends";
  readonly whyItExists =
    "a writer that exits right after its last frame often never writes the newline, and the frame that says WHY it exited — the fatal error — was the one dropped";

  override async run(t: TestRun): Promise<void> {
    const frames = await decodeAll('{"type":"head"}\n', '{"type":"tail"}');
    t.assert.deepEqual(frames, [{ type: "head" }, { type: "tail" }], "the unterminated trailing line is parsed once the stream ends");
    // And not before: the trailing frame is not yielded until the stream is over.
    const single = await decodeAll('{"type":"only"}');
    t.assert.deepEqual(single, [{ type: "only" }]);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AFrameSplitAcrossChunksIsOneFrame extends NdjsonTest {
  readonly id = "a-frame-split-across-chunk-boundaries-decodes-as-exactly-one-frame";
  readonly whyItExists =
    "a pipe delivers bytes, not lines; a decoder that parsed per chunk saw '{\"ty' as garbage and 'pe\":\"x\"}' as more garbage — two error frames and no real one";

  override async run(t: TestRun): Promise<void> {
    const frames = await decodeAll('{"ty', 'pe":"x"}\n');
    t.assert.deepEqual(frames, [{ type: "x" }], "exactly one frame, and it is the real one");

    // Split at every possible byte boundary of one frame, including inside a multi-byte character.
    const line = '{"type":"z","text":"ğü☃"}\n';
    const bytes = Buffer.from(line, "utf8");
    for (let cut = 1; cut < bytes.length; cut++) {
      const parts = await decodeAll(bytes.subarray(0, cut), bytes.subarray(cut));
      t.assert.deepEqual(parts, [{ type: "z", text: "ğü☃" }], `split at byte ${cut} must still decode as one frame`);
    }
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class BlankLinesAreSkippedAndTheErrorIsBounded extends NdjsonTest {
  readonly id = "blank-lines-yield-nothing-and-a-bad-line-is-quoted-to-at-most-200-characters";
  readonly whyItExists =
    "a keep-alive newline read as an error frame filled the app's log with 'unparseable frame:' for nothing, and an unbounded quote of a huge bad line put megabytes into one error message";

  override async run(t: TestRun): Promise<void> {
    t.assert.deepEqual(await decodeAll("\n\n \n"), [], "blank and whitespace-only lines yield nothing at all");
    t.assert.deepEqual(await decodeAll("\r\n", "  \t\n"), []);

    const bad = "x".repeat(500);
    const [frame] = await decodeAll(`${bad}\n`);
    const message = String(frame?.["message"]);
    t.assert.equal(frame?.["type"], "error");
    t.assert.equal(message, `unparseable frame: ${"x".repeat(200)}`, "the quoted line is cut at 200 characters");
    t.assert.ok(message.length <= "unparseable frame: ".length + 200);
  }
}

registerFeatureTests(
  new ABadLineBecomesAnErrorFrame(),
  new CrlfIsStripped(),
  new AnUnterminatedLastLineIsStillParsed(),
  new AFrameSplitAcrossChunksIsOneFrame(),
  new BlankLinesAreSkippedAndTheErrorIsBounded(),
);
