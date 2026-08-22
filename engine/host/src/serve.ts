import { decodeFrames } from "@magentra/protocol";
import type { FrontendRequest } from "@magentra/protocol";
import type { Engine } from "@magentra/core";
import { writeFrame } from "./stdout.js";

/**
 * NDJSON-over-stdio server: reads FrontendRequest frames from stdin, writes
 * CoreEvent frames to stdout, one JSON object per line. This is the engine's
 * entire outward surface — the desktop app spawns this process and speaks this
 * protocol to it, and nothing else does.
 */
export async function runServe(engine: Engine): Promise<void> {
  engine.start();

  // Pump core events to stdout concurrently with reading requests.
  const pump = (async () => {
    for await (const event of engine.events) {
      writeFrame(event);
    }
  })();

  // The frontend is gone (stdin EOF) or asked us to stop (SIGTERM): nobody is
  // listening, so an in-flight turn must be INTERRUPTED, not left to run
  // headless burning tokens. After the abort settles, drain the buffered
  // events and stop cleanly.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Detached background jobs (dev servers, monitors) outlive the engine unless
    // explicitly reaped — do it first so a closed workspace leaves nothing running.
    engine.stopBackgroundJobs();
    engine.send({ type: "interrupt" });
    await engine.idle();
    engine.events.close();
    await pump;
    process.exitCode = 0;
  };
  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });

  for await (const frame of decodeFrames(process.stdin)) {
    if (isRequestLike(frame)) {
      engine.send(frame as FrontendRequest);
    } else {
      writeFrame({ type: "error", message: "invalid request frame", fatal: false });
    }
  }

  await shutdown();
}

function isRequestLike(frame: unknown): boolean {
  return (
    typeof frame === "object" &&
    frame !== null &&
    typeof (frame as { type?: unknown }).type === "string"
  );
}
