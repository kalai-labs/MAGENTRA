/**
 * A real HTTP server on 127.0.0.1, recording what it was asked.
 *
 * A test can only extend ONE kind class, and "which header actually went over
 * the wire" is a question a `ui` test needs as often as a `net` one — driving
 * the app and reading the far end of its socket is one test, not two. So the
 * server lives here and `NetTest` owns its lifecycle for the kind that is about
 * the network; other kinds close it themselves.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One request received, with its body already collected. */
export interface ReceivedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** What a scripted endpoint answers. */
export interface Answer {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

export interface LocalServer {
  /** `http://127.0.0.1:<port>` — no trailing slash, ready to be a base URL. */
  readonly url: string;
  readonly port: number;
  /** Every request received, in order. The point of the thing. */
  readonly requests: ReceivedRequest[];
  /** Wait until a request satisfying `predicate` has arrived. */
  received(predicate: (request: ReceivedRequest) => boolean, timeoutMs?: number): Promise<ReceivedRequest>;
  /** Destroys keep-alive sockets first: without that, `close()` waits and the run hangs. */
  close(): Promise<void>;
}

const RECEIVE_TIMEOUT_MS = 20_000;

/**
 * Port 0 is deliberate: a fixed port makes two tests that run at the same time
 * fight, and the loser's failure has nothing to do with what it was testing.
 */
export async function startLocalServer(answer: (request: ReceivedRequest) => Answer): Promise<LocalServer> {
  const requests: ReceivedRequest[] = [];
  const sockets = new Set<Socket>();
  let wake: (() => void) | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name.toLowerCase()] = value;
      }
      const received: ReceivedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(received);
      wake?.();

      const reply = answer(received);
      const body = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
      res.writeHead(reply.status ?? 200, {
        "content-type": reply.json !== undefined ? "application/json" : "text/plain",
        ...reply.headers,
      });
      res.end(body);
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    received: async (predicate, timeoutMs = RECEIVE_TIMEOUT_MS): Promise<ReceivedRequest> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = requests.find(predicate);
        if (found !== undefined) return found;
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(
            `waited ${timeoutMs}ms for a matching request; received ${requests.length}: ${requests.map((r) => `${r.method} ${r.url}`).join(", ") || "nothing"}`,
          );
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, Math.min(100, left));
        });
        wake = undefined;
      }
    },
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
