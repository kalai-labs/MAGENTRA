import { decodeFrames, encodeFrame } from "@magentra/protocol";
import type { FrontendRequest } from "@magentra/protocol";
import type { Engine } from "@magentra/core";

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
      process.stdout.write(encodeFrame(event));
    }
  })();

  for await (const frame of decodeFrames(process.stdin)) {
    if (isRequestLike(frame)) {
      engine.send(frame as FrontendRequest);
    } else {
      process.stdout.write(
        encodeFrame({ type: "error", message: "invalid request frame", fatal: false }),
      );
    }
  }

  // stdin ended — the frontend is gone. Let the in-flight turn (if any) finish
  // so its events still reach stdout, then close the event queue so the pump
  // drains whatever is buffered and stops on its own. A turn may enqueue
  // further user_messages via the cron scheduler; those aren't worth waiting
  // for, so a single idle() await is enough.
  await engine.idle();
  engine.events.close();
  await pump;
  process.exitCode = 0;
}

function isRequestLike(frame: unknown): boolean {
  return (
    typeof frame === "object" &&
    frame !== null &&
    typeof (frame as { type?: unknown }).type === "string"
  );
}
