/**
 * `NetTest` — the kind that uses the network, and no model. SPEC §3, decisions/0004.
 *
 * WHAT THIS KIND IS FOR. A feature whose behaviour is what goes over a socket:
 * which header a request carries, what a client does with a status, whether a
 * timeout is honoured. If the code takes its `fetch` as a parameter the kind is
 * `pure` and this one is the wrong answer — the connection wizard's
 * `testEndpoint` is exactly that, and is tested without a socket. What belongs
 * here is code that reaches the network on its own, where the only place to
 * observe it is the other end.
 *
 * WHAT IT OWNS: the lifecycle of the servers a test starts — closed on
 * teardown, keep-alive sockets destroyed first, because otherwise `close()`
 * waits and the run hangs after every assertion has already passed. The server
 * itself is `localServer.ts`, so a `ui` test that needs the same far end can
 * have one without pretending to be a `net` test.
 *
 * NO MODEL. `llm` is the kind that needs a resolved connection and a real
 * provider; this one binds 127.0.0.1 and nothing leaves the machine.
 */

import { FeatureTest } from "./featureTest.ts";
import { startLocalServer, type Answer, type LocalServer, type ReceivedRequest } from "./localServer.ts";

export type { Answer, LocalServer, ReceivedRequest } from "./localServer.ts";

export abstract class NetTest extends FeatureTest {
  readonly kind = "net" as const;

  /** Binding, handshaking and waiting on a socket is slower than a pure call. */
  override readonly timeoutMs: number = 60_000;

  #servers: LocalServer[] = [];

  /** A real HTTP server answering from `answer`, on a port the OS picks. */
  protected async serve(answer: (request: ReceivedRequest) => Answer): Promise<LocalServer> {
    const server = await startLocalServer(answer);
    this.#servers.push(server);
    return server;
  }

  protected override async tearDownKind(): Promise<void> {
    const servers = this.#servers;
    this.#servers = [];
    for (const server of servers) await server.close();
  }
}
