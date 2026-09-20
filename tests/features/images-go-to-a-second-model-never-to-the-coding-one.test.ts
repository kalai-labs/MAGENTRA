/**
 * `images-go-to-a-second-model-never-to-the-coding-one`.
 *
 * A coding model that is handed a picture either refuses it or, worse, claims
 * to have looked at it. So an image never reaches it: a SECOND model at the
 * configured vision endpoint looks at the picture and writes a description, and
 * that text — wrapped in a warning that the coding model did not see anything —
 * is the only thing that enters the conversation.
 *
 * ABOUT THE DESCRIPTION'S NOTE. The ready description says this test needs a
 * vision model set at the connection, and should otherwise be skipped with a
 * warning. It does not need a skip: the test SETS one, as part of its own
 * fixture, pointing `visionConnection` at a local HTTP server it runs. That
 * server is a real endpoint — the engine builds a real provider for it with
 * `createProviderForEndpoint` and speaks real SSE to it — so the routing under
 * test is exercised end to end without anyone's credentials, cost or network.
 * A skipped test proves nothing, and the suite forbids one (tests/README rule
 * 4); this way the test runs everywhere, every time.
 *
 * What a REAL vision model would add is whether that model describes the
 * picture well, which is not this feature's claim. The claim is where the image
 * goes, and where it does not.
 *
 * `proc`: proving it needs the engine running, because the routing decision and
 * the second provider both live inside it. The record said `fs` + `llm`; the
 * file and the socket are incidental, and no model is needed at all.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { startLocalServer, type LocalServer } from "../lib/localServer.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";

const FEATURE = "images-go-to-a-second-model-never-to-the-coding-one";

/** Verbatim from the record. */
const INVARIANT =
  "The coding model is never sent a picture: a vision profile describes it and the description enters the conversation, with no exceptions for tool results.";

/** What the stub vision model says, so its answer is unmistakable in the transcript. */
const DESCRIPTION = "a small red square on a white background";

/** A 1x1 PNG. Enough to be an image; small enough to read in a failure message. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface Frame {
  readonly type?: string;
  readonly [key: string]: unknown;
}

interface HarnessMessage {
  readonly role?: string;
  readonly text?: string;
  readonly images?: number;
}

abstract class VisionRoutingTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** The engine boots, runs a turn, and speaks to a second endpoint over SSE. */
  override readonly timeoutMs: number = 120_000;

  #dirs: string[] = [];
  #servers: LocalServer[] = [];

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const server of this.#servers) await server.close();
    this.#servers = [];
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true });
    this.#dirs = [];
  }

  /**
   * A vision endpoint that answers the way an OpenAI-compatible one does: a
   * streamed chat completion. The engine builds a REAL provider for this — the
   * injectable factory is only used for the coding model — so anything less
   * than the real wire format would not be answered at all.
   */
  protected async visionEndpoint(): Promise<LocalServer> {
    const server = await startLocalServer((request) => {
      if (!request.url.includes("/chat/completions")) return { status: 404, text: "no" };
      const body = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: DESCRIPTION } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n");
      return { status: 200, text: body, headers: { "content-type": "text/event-stream" } };
    });
    this.#servers.push(server);
    return server;
  }

  /** A workspace whose connection names a vision model — the precondition this feature needs. */
  protected workspaceWithVision(vision: LocalServer): string {
    const workspace = mkdtempSync(join(tmpdir(), "magentra-vision-"));
    this.#dirs.push(workspace);
    mkdirSync(join(workspace, ".magentra"), { recursive: true });
    writeFileSync(
      join(workspace, ".magentra", "settings.json"),
      `${JSON.stringify(
        {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "coding-model",
          vision: true,
          visionConnection: { provider: "openai-compatible", baseUrl: `${vision.url}/v1`, model: "vision-model" },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "w" },
    );
    return workspace;
  }

  protected startEngine(workspace: string): ProcHandle {
    const built = join(repoRoot(), "engine", "host", "dist", "index.js");
    if (!existsSync(built)) throw new Error("engine/host/dist is missing — run `npm run build`");
    return this.spawn(process.execPath, [join(repoRoot(), "tests", "lib", "engineHarness.ts"), workspace], {
      label: `engine on ${workspace}`,
      env: { HOME: workspace, USERPROFILE: workspace },
    });
  }

  protected sendFrame(child: ProcHandle, frame: Record<string, unknown>): void {
    child.send(JSON.stringify(frame));
  }

  protected async nextFrame(child: ProcHandle, predicate: (frame: Frame) => boolean, timeoutMs = 60_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = await child.nextLine(undefined, Math.max(1, deadline - Date.now()));
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        continue;
      }
      if (predicate(frame)) return frame;
    }
  }

  protected framesSoFar(child: ProcHandle): Frame[] {
    const out: Frame[] = [];
    for (const line of child.stdout().split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as Frame);
      } catch {
        /* not a frame */
      }
    }
    return out;
  }

  /** Attach the picture to a message and let the turn finish. */
  protected async sendImageTurn(child: ProcHandle): Promise<void> {
    this.sendFrame(child, {
      type: "user_message",
      text: "what is in this picture?",
      images: [{ name: "square.png", mediaType: "image/png", data: PNG_BASE64 }],
    });
    await this.nextFrame(child, (f) => f.type === "turn_finished");
  }
}

/* ---- the image goes to the second model -------------------------------- */

class TheImageGoesToTheVisionEndpoint extends VisionRoutingTest {
  readonly id = "the-image-is-sent-to-the-vision-endpoint";
  readonly whyItExists =
    "an image that never reaches the vision endpoint leaves the user's question unanswerable, while the app has already told them vision is on";

  override async run(t: TestRun): Promise<void> {
    const vision = await this.visionEndpoint();
    const workspace = this.workspaceWithVision(vision);
    const engine = this.startEngine(workspace);
    await this.nextFrame(engine, (f) => f.type === "session_started");

    await this.sendImageTurn(engine);

    t.assert.ok(vision.requests.length > 0, "the vision endpoint must have been asked to look at the picture");
    const asked = vision.requests[0]!;
    t.assert.match(asked.url, /\/chat\/completions$/, "it is asked the way any chat endpoint is asked");
    t.assert.equal(asked.method, "POST");

    const body = JSON.parse(asked.body) as { model?: string; messages?: { content?: unknown }[] };
    t.assert.equal(body.model, "vision-model", "the request must name the VISION model, not the coding one");
    t.assert.match(asked.body, new RegExp(PNG_BASE64.slice(0, 32)), "and it must carry the actual picture");
  }
}

/* ---- and never to the coding model -------------------------------------- */

class TheCodingModelNeverSeesTheImage extends VisionRoutingTest {
  readonly id = "the-coding-model-receives-the-description-and-never-the-image";
  readonly whyItExists =
    "a coding model handed a picture either refuses the turn or claims to have looked at it, and a user who is told the model saw their screenshot believes a description it invented";

  override async run(t: TestRun): Promise<void> {
    const vision = await this.visionEndpoint();
    const workspace = this.workspaceWithVision(vision);
    const engine = this.startEngine(workspace);
    await this.nextFrame(engine, (f) => f.type === "session_started");

    await this.sendImageTurn(engine);

    // Every call the coding model received, as the harness observed them.
    const calls = this.framesSoFar(engine).filter((f) => f.type === "harness" && f["event"] === "stream");
    t.assert.ok(calls.length > 0, "the coding model must have been called at all");

    const withImages = calls.flatMap((call) => (Array.isArray(call["messages"]) ? (call["messages"] as HarnessMessage[]) : []))
      .filter((message) => (message.images ?? 0) > 0);
    t.assert.deepEqual(
      withImages.map((m) => m.role),
      [],
      "no image content may ever reach the coding model — this is the whole of the feature",
    );

    // What it got instead: the vision model's words, wrapped in the warning
    // that stops it claiming to have looked.
    const seen = calls
      .flatMap((call) => (Array.isArray(call["messages"]) ? (call["messages"] as HarnessMessage[]) : []))
      .map((message) => message.text ?? "")
      .join("\n");
    t.assert.match(seen, new RegExp(DESCRIPTION), "the description the vision model wrote must be what enters the conversation");
    t.assert.match(seen, /did NOT see the image|cannot see it/i, "and it must arrive wrapped in the warning that it was not seen");
  }
}

registerFeatureTests(new TheImageGoesToTheVisionEndpoint(), new TheCodingModelNeverSeesTheImage());
