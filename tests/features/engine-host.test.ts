/**
 * `engine-host` — the process boundary itself.
 *
 * The host is the headless process the desktop app spawns. Its entire outward
 * surface is one pipe in and one pipe out, carrying newline-delimited JSON and
 * nothing else: a line on stdout that is not a frame is a line the app cannot
 * parse, a boot failure that only reaches stderr is a dead process with no
 * message, and an engine that keeps running after the window closed is tokens
 * spent on nobody. So every assertion here is made from OUTSIDE the process,
 * over its real stdio.
 *
 * `proc`, as the record declares, and there is no honest alternative: the
 * subject is the wire. Importing `runServe` and handing it a fake stream would
 * prove the loop and skip the pipe, and the pipe is where the bugs have been
 * (a fatal frame lost to an async write on exit; a multi-byte character cut in
 * half by a chunk boundary).
 *
 * TWO PROGRAMS ARE SPAWNED, because the feature spans two files.
 *   - `engine/host/dist/main.js` — the REAL binary, the one `app/main.js:214`
 *     spawns. It is the only way to reach `parseArgs()` and `fail()`, so the
 *     boot contract (checklist 1, 2, 3, 5) is proved against it. Note the
 *     entry point: the package's `main` is `dist/main.js`; `dist/index.js` is
 *     the library export map and running it does nothing but exit 0.
 *   - `tests/lib/engineHarness.ts` — the same `runServe()` around a real
 *     Engine on a scripted provider. Used for the two claims that need a turn
 *     actually in flight (the drain on stdin close, and a frame whose text
 *     survives being cut in half), which a real provider cannot give without a
 *     real endpoint.
 *
 * Only the provider is ever a double, and nothing below asserts on what it
 * answered — the assertions are on frames, exit codes, and which bytes came
 * back out of the decoder.
 *
 * REQUIRES `npm run build`: both programs run the built engine, and `dist/` is
 * gitignored. The first spawn says so rather than failing obscurely.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";

const FEATURE = "engine-host";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT = "The host speaks NDJSON over stdio and nothing else crosses the process boundary.";

/** What the desktop app spawns — `app/main.js` line 214. */
const HOST_ENTRY = "engine/host/dist/main.js";

/** The same `runServe`, with the provider replaced. Read its header first. */
const HARNESS = "tests/lib/engineHarness.ts";

/** Keyless by rule: `isLocalBaseUrl` is what decides a connection needs no key. */
const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

/** A hosted endpoint. Nothing listens there; the host must refuse before it would ever be called. */
const HOSTED_ENDPOINT = "https://api.magentra-nowhere.invalid/v1";

/** Cleared in every child, so "no key" is a fact about the fixture and not about this machine. */
const KEY_VARS = ["MAGENTRA_API_KEY", "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"] as const;

interface Frame {
  readonly type?: string;
  readonly [key: string]: unknown;
}

function isFrame(value: unknown): value is Frame {
  return typeof value === "object" && value !== null;
}

/** The clean environment every child gets: no inherited key, and a home of its own. */
function childEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { HOME: home, USERPROFILE: home };
  for (const name of KEY_VARS) env[name] = undefined;
  return env;
}

/**
 * Shared setup for everything that talks to a host over its stdio.
 *
 * `abstract`, so the gateway reads it as scaffolding and the classes below as
 * the tests; `featureId` and `invariant` are declared once here.
 */
abstract class HostTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #dirs: string[] = [];

  /** A throwaway directory this test owns. Removed in `tearDown`, after the children are gone. */
  protected makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /**
   * A workspace the host will boot on.
   *
   * `contextWindow` is set because the Engine emits a non-fatal `error` frame
   * when a connection has none — a true frame about the fixture rather than
   * about this feature, and one that would make "the first frame is
   * session_started" read as a pass for the wrong reason if it ever moved.
   */
  protected makeWorkspace(baseUrl: string): string {
    const workspace = this.makeDir("magentra-host-ws-");
    mkdirSync(join(workspace, ".magentra"), { recursive: true });
    writeFileSync(
      join(workspace, ".magentra", "settings.json"),
      `${JSON.stringify({ provider: "openai-compatible", baseUrl, model: "model-one", contextWindow: 200_000 }, null, 2)}\n`,
      "utf8",
    );
    return workspace;
  }

  /**
   * `HOME` and `USERPROFILE` both, because `os.homedir()` reads one on each
   * platform and `loadSettings` merges `~/.magentra/settings.json` OVER the
   * workspace's. Without this the host would boot on whatever endpoint the
   * developer's machine is configured for.
   */
  protected startHost(args: readonly string[]): ProcHandle {
    const entry = join(repoRoot(), HOST_ENTRY);
    if (!existsSync(entry)) {
      throw new Error(
        `${HOST_ENTRY} does not exist, so the host cannot be spawned. Run \`npm run build\` — ` +
          `this test drives the built host, which is what the desktop app spawns, and dist/ is gitignored.`,
      );
    }
    return this.spawn(process.execPath, [entry, ...args], {
      label: `engine host ${args.join(" ")}`,
      env: childEnv(this.makeDir("magentra-host-home-")),
    });
  }

  /** The same serve loop with a scripted provider behind it. */
  protected startHarness(workspace: string): ProcHandle {
    return this.spawn(process.execPath, [join(repoRoot(), HARNESS), workspace], {
      label: `engine harness on ${workspace}`,
      env: childEnv(this.makeDir("magentra-host-home-")),
    });
  }

  protected sendFrame(child: ProcHandle, frame: Record<string, unknown>): void {
    child.send(JSON.stringify(frame));
  }

  /** Every frame the child has written so far, without consuming anything. */
  protected framesSoFar(child: ProcHandle): Frame[] {
    const out: Frame[] = [];
    for (const line of child.stdout().split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isFrame(parsed)) out.push(parsed);
      } catch {
        /* not a frame — the assertions below are about exactly this case */
      }
    }
    return out;
  }

  /** The next frame satisfying `predicate`, consuming what it passes over. */
  protected async nextFrame(child: ProcHandle, predicate: (frame: Frame) => boolean, timeoutMs = 25_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = await child.nextLine(undefined, Math.max(1, deadline - Date.now()));
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (isFrame(frame) && predicate(frame)) return frame;
    }
  }

  /**
   * The children are stopped HERE, before the directories go, because a
   * workspace cannot be removed from under a running process on Windows —
   * deleting an open file is a POSIX-only liberty. `tearDownKind` then finds
   * them already gone and still guarantees no orphan. The retries forgive the
   * moment Windows keeps a handle open after the process is already reaped;
   * `FsTest.tearDownKind` has none, which is the other half of why this kind
   * owns its own directories here.
   */
  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#dirs = [];
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class StdoutIsNothingButFrames extends HostTest {
  readonly id = "every-stdout-line-is-a-json-frame-and-the-first-one-is-session-started";
  readonly whyItExists =
    "a stray console.log or a progress line on the host's stdout broke the app's decoder mid-session, because the frontend parses every line and has nowhere to put one that is not a frame";

  override async run(t: TestRun): Promise<void> {
    const workspace = this.makeWorkspace(LOCAL_ENDPOINT);
    const host = this.startHost(["--cwd", workspace]);

    const started = await this.nextFrame(host, (f) => f.type === "session_started");
    t.assert.equal(typeof started["sessionId"], "string", "a session id is what every later frame is about");

    // `--cwd` is resolved, not passed through: the frame carries the absolute
    // path, spelled the way this platform spells one.
    t.assert.equal(started["cwd"], resolve(workspace), "the workspace the host booted on is the one --cwd named");

    // Let the boot finish emitting, then read the whole stream at rest.
    await this.nextFrame(host, (f) => f.type === "task_list_updated");
    host.endInput();
    const exit = await host.exited();
    t.assert.equal(exit.code, 0, `the host exited ${exit.code}/${exit.signal}; stderr was:\n${host.stderr()}`);

    const raw = host.stdout();
    t.assert.equal(raw.endsWith("\n"), true, "the last frame was cut off mid-line, so the stream ended unparseable");

    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    t.assert.ok(lines.length >= 2, `the host wrote ${lines.length} lines, which is too few to have booted at all`);
    for (const line of lines) {
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        t.assert.fail(`a line on the host's stdout is not JSON, so the frontend's decoder cannot read it: ${line.slice(0, 200)}`);
        return;
      }
      t.assert.equal(isFrame(frame), true, `a frame must be an object, not ${JSON.stringify(frame)}`);
      t.assert.equal(typeof (frame as Frame).type, "string", `a frame must carry a string type: ${line.slice(0, 200)}`);
    }

    // And the FIRST of them is the session — not a warning, not a banner.
    t.assert.equal(JSON.parse(lines[0] as string).type, "session_started", `the first line was ${lines[0]?.slice(0, 200)}`);

    // Warnings exist and are kept off the wire on purpose.
    t.assert.equal(host.stderr().includes("{"), false, `stderr carried something frame-shaped: ${host.stderr().slice(0, 300)}`);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ARequestIsAnsweredOnStdout extends HostTest {
  readonly id = "a-request-frame-written-to-stdin-is-answered-on-stdout";
  readonly whyItExists =
    "the serve loop read stdin and the event pump wrote stdout, and nothing proved the two were joined to the same Engine — a host that booted and then ignored every request looked identical from the app's side until the first click did nothing";

  override async run(t: TestRun): Promise<void> {
    const workspace = this.makeWorkspace(LOCAL_ENDPOINT);
    // `--serve` is the flag an older launch command still passes. parseArgs
    // accepts and ignores it, so a host started the old way must still serve;
    // that compatibility is only observable on a real boot like this one.
    const host = this.startHost(["--serve", "--cwd", workspace]);
    await this.nextFrame(host, (f) => f.type === "session_started");

    this.sendFrame(host, { type: "list_sessions" });
    const list = await this.nextFrame(host, (f) => f.type === "session_list");
    t.assert.equal(Array.isArray(list["sessions"]), true, "session_list must carry the sessions, not just its own name");

    // The answer came back because the request crossed the boundary, so a
    // second one must be answered too — a single reply could have been a boot
    // broadcast that happened to look like one.
    this.sendFrame(host, { type: "list_sessions" });
    await this.nextFrame(host, (f) => f.type === "session_list");
    const answers = this.framesSoFar(host).filter((f) => f.type === "session_list");
    t.assert.equal(answers.length, 2, "one request, one answer — the second went unanswered");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ABadLineDoesNotCloseTheTransport extends HostTest {
  readonly id = "a-line-that-is-not-a-request-is-refused-and-the-host-keeps-serving";
  readonly whyItExists =
    "one malformed line from the frontend used to end the session, so a single bad frame cost the user the whole conversation instead of one refusal";

  override async run(t: TestRun): Promise<void> {
    const workspace = this.makeWorkspace(LOCAL_ENDPOINT);
    const host = this.startHost(["--cwd", workspace]);
    await this.nextFrame(host, (f) => f.type === "session_started");

    // Valid JSON, no `type` — `isRequestLike` is the gate, and this is what it
    // exists to catch.
    host.send(JSON.stringify({ foo: 1 }));
    const refused = await this.nextFrame(host, (f) => f.type === "error");
    t.assert.equal(refused["message"], "invalid request frame");
    t.assert.equal(refused["fatal"], false, "a bad frame is not a reason to take the process down");

    // Not JSON at all. The decoder turns it into an error frame, which HAS a
    // string `type` and is therefore request-like — so it reaches the Engine
    // and is refused there instead. Asserted as what the code does, not as the
    // checklist's shorthand: either way the transport survives, but the two
    // paths produce different messages and a test that accepted both would not
    // notice the gate moving.
    host.send("this is not json");
    const unknown = await this.nextFrame(host, (f) => f.type === "error");
    t.assert.match(String(unknown["message"]), /Unknown request type "error"/);
    t.assert.equal(unknown["fatal"], false);

    // Still serving, after both.
    this.sendFrame(host, { type: "list_sessions" });
    await this.nextFrame(host, (f) => f.type === "session_list");
    t.assert.equal(host.hasExited(), false, "the host died on a line it was supposed to refuse");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ClosingStdinDrainsAndExitsZero extends HostTest {
  readonly id = "closing-stdin-drains-the-work-in-flight-and-exits-zero";
  readonly whyItExists =
    "closing the window left the turn running headless — the frontend was gone, nobody would ever read the answer, and the engine went on calling the model until the tokens ran out";

  override async run(t: TestRun): Promise<void> {
    // The harness, not the real host: the claim is about work IN FLIGHT, and a
    // turn only flies when there is a provider to answer it.
    const workspace = this.makeWorkspace(LOCAL_ENDPOINT);
    const engine = this.startHarness(workspace);
    await this.nextFrame(engine, (f) => f.type === "session_started");

    // The turn and the EOF go out in the same tick, with no `await` between
    // them, so the count taken here cannot include anything the turn produced:
    // the serve loop reads the message, starts the turn, and only then sees
    // that stdin has ended.
    this.sendFrame(engine, { type: "user_message", text: "one" });
    engine.endInput();
    const beforeEof = this.framesSoFar(engine).length;

    const exit = await engine.exited();
    t.assert.equal(exit.code, 0, `stdin EOF must be a clean stop, not ${exit.code}/${exit.signal}; stderr:\n${engine.stderr()}`);

    const drained = this.framesSoFar(engine).slice(beforeEof);
    const types = drained.map((f) => f.type);
    t.assert.ok(types.includes("turn_started"), `the turn never reached stdout after stdin closed; got ${types.join(", ")}`);
    t.assert.ok(
      types.includes("turn_finished"),
      `the turn's own events were dropped instead of drained, so the pump was closed before the queue emptied; got ${types.join(", ")}`,
    );

    // `shutdown()` interrupts before it drains, and the interrupt's own
    // acknowledgement is the last thing the Engine emits. Its presence is the
    // proof that `engine.send({type:'interrupt'})` really ran on EOF — and
    // that the frame it produced still made it out.
    const acknowledged = drained.some((f) => f.type === "command_output" && /nothing was running|stopping/i.test(String(f["text"])));
    t.assert.ok(acknowledged, `the EOF never became an interrupt; the frames after it were ${types.join(", ")}`);

    // Nothing was cut in half on the way out.
    t.assert.equal(engine.stdout().endsWith("\n"), true, "the process exited with a partial frame still in the pipe");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AFatalBootIsAFrameBeforeExit extends HostTest {
  readonly id = "a-fatal-boot-failure-is-an-error-frame-on-stdout-before-exit-1";
  readonly whyItExists =
    "the fatal frame was written with the buffered `write()` and then `process.exit(1)` threw the buffer away, so the app saw a process that died with an exit code and no reason — which is the one case the in-band error frame exists for";

  override async run(t: TestRun): Promise<void> {
    // A typo'd flag. Silently ignoring it would mean a session running on the
    // wrong configuration, which is why parseArgs refuses instead.
    const typo = this.startHost(["--bogus"]);
    const typoExit = await typo.exited();
    t.assert.equal(typoExit.code, 1, `an unrecognised flag must be fatal, not ${typoExit.code}/${typoExit.signal}`);

    const typoLines = typo.stdout().split("\n").filter((line) => line.trim() !== "");
    t.assert.equal(typoLines.length, 1, `exactly one frame belongs on a failed boot; got ${JSON.stringify(typoLines)}`);
    const typoFrame = JSON.parse(typoLines[0] as string) as Frame;
    t.assert.equal(typoFrame.type, "error");
    t.assert.equal(typoFrame["fatal"], true, "fatal:false would tell the frontend to keep waiting for a session that will never start");
    t.assert.match(String(typoFrame["message"]), /unknown flag "--bogus"/);
    // stderr is the backup, and it must not be the only copy.
    t.assert.match(typo.stderr(), /unknown flag "--bogus"/);

    // The other fatal boot: a hosted endpoint with no key anywhere. The child's
    // environment has all four key variables removed and a home of its own, so
    // this is a fact about the fixture rather than about this machine.
    const workspace = this.makeWorkspace(HOSTED_ENDPOINT);
    const keyless = this.startHost(["--cwd", workspace]);
    const keylessExit = await keyless.exited();
    t.assert.equal(keylessExit.code, 1, `a hosted endpoint with no key must refuse to boot, not ${keylessExit.code}`);

    const keylessLines = keyless.stdout().split("\n").filter((line) => line.trim() !== "");
    t.assert.equal(keylessLines.length, 1, `got ${JSON.stringify(keylessLines)}`);
    const keylessFrame = JSON.parse(keylessLines[0] as string) as Frame;
    t.assert.equal(keylessFrame.type, "error");
    t.assert.equal(keylessFrame["fatal"], true);
    t.assert.match(String(keylessFrame["message"]), /No API key found/);
    // It names the variable to set and the directory to set it in — a fatal
    // frame the user cannot act on is the same dead end as no frame at all.
    t.assert.match(String(keylessFrame["message"]), /MAGENTRA_API_KEY/);
    t.assert.ok(
      String(keylessFrame["message"]).includes(resolve(workspace)),
      `the message must name the workspace whose .env would be read; it said ${String(keylessFrame["message"])}`,
    );
  }
}

/* ---- the decoder, over the real pipe ---------------------------------- */

/**
 * The writer: a child that owns the host's stdin so the test can decide where
 * the chunk boundary falls.
 *
 * `ProcHandle.send` writes one whole line at a time, which is exactly what
 * cannot express "half a frame". So this program sits in between — it spawns
 * the harness with stdout INHERITED (the harness's frames land on the same
 * pipe this test already reads) and writes raw byte ranges to its stdin on
 * command.
 *
 * `head` writes a COMPLETE frame followed by the first half of a second one.
 * That is what makes the split provable rather than hoped for: the complete
 * frame's answer coming back is proof that the decoder consumed the chunk, so
 * the partial UTF-8 sequence at its tail was already in the decoder's buffer
 * before `tail` was written. Two timed writes could have been coalesced by the
 * pipe into one chunk and the test would never have known.
 */
function writerSource(harness: string, workspace: string, text: string): string {
  return `import { spawn } from "node:child_process";

const HARNESS = ${JSON.stringify(harness)};
const WORKSPACE = ${JSON.stringify(workspace)};
// Embedded rather than passed in argv, so no argument encoding sits between
// the test's string and the bytes this program writes.
const TEXT = ${JSON.stringify(text)};

const first = Buffer.from(JSON.stringify({ type: "list_sessions" }) + "\\n", "utf8");
const second = Buffer.from(JSON.stringify({ type: "user_message", text: TEXT }) + "\\n", "utf8");

// The last two-byte UTF-8 sequence in the frame; the cut goes between its bytes.
let cut = -1;
for (let i = 0; i < second.length - 1; i++) {
  if ((second[i] & 0xe0) === 0xc0 && (second[i + 1] & 0xc0) === 0x80) cut = i + 1;
}
if (cut === -1) {
  process.stderr.write("writer: the frame carries no two-byte UTF-8 sequence to cut\\n");
  process.exit(3);
}
// Written before the harness exists, so it cannot interleave with a frame.
process.stdout.write(JSON.stringify({ type: "writer", cut, lead: second[cut - 1], tail: second[cut] }) + "\\n");

const child = spawn(process.execPath, [HARNESS, WORKSPACE], { stdio: ["pipe", "inherit", "inherit"] });
child.on("exit", (code) => process.exit(code ?? 0));

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const command = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (command === "head") child.stdin.write(Buffer.concat([first, second.subarray(0, cut)]));
    else if (command === "tail") child.stdin.write(second.subarray(cut));
  }
});
`;
}

class AMultibyteCharacterSurvivesAChunkBoundary extends HostTest {
  readonly id = "a-multibyte-character-split-across-two-stdin-chunks-arrives-whole";
  readonly whyItExists =
    "the decoder called `chunk.toString()` per chunk, so a Turkish letter whose two bytes fell either side of a pipe boundary reached the engine as two U+FFFD replacement characters — the user's own words, silently corrupted, only when the message was long enough for the cut to land there";

  override async run(t: TestRun): Promise<void> {
    const workspace = this.makeWorkspace(LOCAL_ENDPOINT);
    const text = "şu dosyayı sil: İstanbul'daki ağaç";

    const writerDir = this.makeDir("magentra-host-writer-");
    const writerPath = join(writerDir, "writer.mjs");
    writeFileSync(writerPath, writerSource(join(repoRoot(), HARNESS), workspace, text), "utf8");

    const writer = this.spawn(process.execPath, [writerPath], {
      label: "stdin writer around the engine harness",
      env: childEnv(this.makeDir("magentra-host-home-")),
    });

    // The cut really falls inside a two-byte sequence: a lead byte 110xxxxx
    // followed by a continuation byte 10xxxxxx. Without this the test could
    // pass by splitting between two ASCII characters.
    const plan = await this.nextFrame(writer, (f) => f.type === "writer");
    const lead = Number(plan["lead"]);
    const tail = Number(plan["tail"]);
    t.assert.equal(lead & 0xe0, 0xc0, `byte ${lead} before the cut is not a two-byte lead byte`);
    t.assert.equal(tail & 0xc0, 0x80, `byte ${tail} after the cut is not a continuation byte`);

    await this.nextFrame(writer, (f) => f.type === "session_started");

    // One chunk: a whole frame, then half of the next one.
    writer.send("head");
    await this.nextFrame(writer, (f) => f.type === "session_list");
    // That answer is the proof: the decoder has consumed the chunk, so the
    // orphaned lead byte is sitting in its buffer right now.
    const early = this.framesSoFar(writer).filter((f) => f.type === "harness" && f["event"] === "stream");
    t.assert.deepEqual(early, [], "half a frame must not start a turn");

    writer.send("tail");
    const stream = await this.nextFrame(writer, (f) => f.type === "harness" && f["event"] === "stream");

    const messages = Array.isArray(stream["messages"]) ? (stream["messages"] as { role?: string; text?: string }[]) : [];
    const user = messages.find((m) => m.role === "user");
    t.assert.ok(user !== undefined, `the session received no user message; it saw ${JSON.stringify(messages)}`);
    t.assert.ok(
      (user?.text ?? "").includes(text),
      `the text the model received is not the text that was sent — it was ${JSON.stringify(user?.text?.slice(0, 120))}`,
    );
    t.assert.equal((user?.text ?? "").includes("�"), false, "a replacement character means the cut destroyed a letter");
  }
}

registerFeatureTests(
  new StdoutIsNothingButFrames(),
  new ARequestIsAnsweredOnStdout(),
  new ABadLineDoesNotCloseTheTransport(),
  new ClosingStdinDrainsAndExitsZero(),
  new AFatalBootIsAFrameBeforeExit(),
  new AMultibyteCharacterSurvivesAChunkBoundary(),
);
