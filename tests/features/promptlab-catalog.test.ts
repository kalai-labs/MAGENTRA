/**
 * `promptlab-catalog`.
 *
 * Prompt Lab is a local console, on `127.0.0.1:4319` by default, for every
 * prompt the engine sends. `GET /api/catalog` reflects the REAL prompt
 * registry as built — the same `promptCatalog()` this repository's engine
 * calls, populated the same way (`@magentra/core`, `@magentra/tools` and
 * `@magentra/protocol` imported, `createDefaultRegistry()` run) — and
 * `GET /api/events` is a Server-Sent Events stream that pushes a `changed`
 * message when an override file changes on disk, so a browser tab and the
 * engine reading the same file never disagree about what is current.
 *
 * `proc`, as the record declares: every clause is proven through the REAL
 * SERVER PROCESS, spawned from a sandbox copy of `server.mjs`
 * (`promptlab-promote.test.ts` established this pattern first and is this
 * suite's read-only reference for why — the module exports nothing and starts
 * listening on import, so it cannot be reached any other way). Nothing here
 * needs the compiler: this sandbox has no `engine/*.ts` sources at all, so
 * `ensureBuilt()`'s own mtime walk finds nothing to compare and returns
 * without ever calling `tscBuild()` — the build guard is a different
 * feature's proof (`promptlab-build-guard.test.ts`), and dragging a real `tsc`
 * invocation into every class here would only slow this one down for nothing
 * this feature's invariant is about.
 *
 * THE OVERRIDES DIRECTORY IS PRE-CREATED, before the server is spawned.
 * `startWatching()` runs once at module load, and `fs.watch` on a directory
 * that does not exist yet throws (caught, silently) — nothing else calls
 * `startWatching()` again until the API itself writes an override, so a test
 * that writes a `.txt` file from OUTSIDE the server, into a directory the
 * watcher was never able to open, would wait forever for an event that no
 * watcher exists to send.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type ClientRequest } from "node:http";
import { connect } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultRegistry } from "@magentra/tools";
import { estimateTokens, promptCatalog } from "@magentra/protocol";
// Imported for the registrations it makes as a side effect — the same import
// `server.mjs` performs before building its own catalog.
import "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";
import { repoRoot } from "../lib/inventory.ts";

const FEATURE = "promptlab-catalog";

/** Verbatim from the record. */
const INVARIANT = "/api/catalog reflects the registry as built, and /api/events streams changes as they happen.";

// The server's own module-load side effect, reproduced here once so this
// process's `promptCatalog()` is exactly what the sandboxed server computes.
createDefaultRegistry();

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  /** Parsed as JSON when it is JSON (every real API route); `{}` otherwise. */
  readonly body: Record<string, unknown>;
  /** The response body exactly as sent — the 404 route answers plain text, not JSON. */
  readonly text: string;
}

interface CatalogPrompt {
  readonly id?: string;
  readonly channel?: string;
  readonly defaultTokens?: number;
  readonly currentTokens?: number;
  readonly overridden?: boolean;
  readonly currentText?: string;
}

/** Ask the OS for a port and give it straight back. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        if (port === 0) reject(new Error("the OS gave out no port"));
        else resolve(port);
      });
    });
  });
}

/** An open `/api/events` connection: what has arrived so far, parsed, and a way to wait for more. */
interface EventClient {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly frames: Record<string, unknown>[];
  readonly raw: () => string;
  waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

abstract class CatalogTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  override readonly timeoutMs: number = 60_000;

  #tmps: string[] = [];
  #port = 0;

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const tmp of this.#tmps) rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#tmps = [];
  }

  protected get port(): number {
    return this.#port;
  }

  /** A sandbox with no `engine/` at all — see the header for why that is deliberate here. */
  protected buildSandboxFiles(): { tmp: string; overrides: string } {
    const tmp = mkdtempSync(join(tmpdir(), "magentra-catalog-"));
    this.#tmps.push(tmp);

    mkdirSync(join(tmp, "tools", "prompt-lab"), { recursive: true });
    const from = join(repoRoot(), "tools", "prompt-lab");
    // Copied byte for byte, unedited — same as promptlab-promote.test.ts.
    copyFileSync(join(from, "server.mjs"), join(tmp, "tools", "prompt-lab", "server.mjs"));
    copyFileSync(join(from, "index.html"), join(tmp, "tools", "prompt-lab", "index.html"));

    symlinkSync(join(repoRoot(), "node_modules"), join(tmp, "node_modules"), "junction");

    // PRE-CREATED — see the header. `startWatching()` runs at module load, and
    // a directory that does not exist yet is caught and silently skipped.
    const overrides = join(tmp, "overrides");
    mkdirSync(overrides, { recursive: true });
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });

    return { tmp, overrides };
  }

  protected async startLab(tmp: string, overrides: string): Promise<ProcHandle> {
    this.#port = await freePort();
    const home = join(tmp, "home");
    const child = this.spawn(process.execPath, [join(tmp, "tools", "prompt-lab", "server.mjs"), "--dir", overrides, "--port", String(this.#port)], {
      cwd: tmp,
      label: `prompt-lab on 127.0.0.1:${this.#port}`,
      env: { HOME: home, USERPROFILE: home, MAGENTRA_PROMPTS_DIR: undefined },
    });
    await child.nextLine((line) => line.includes(`http://127.0.0.1:${this.#port}`), 60_000);
    return child;
  }

  protected async call(method: string, path: string, host = "127.0.0.1"): Promise<Answer> {
    return await new Promise<Answer>((resolve, reject) => {
      const req = request({ host, port: this.#port, path, method, timeout: 5_000 }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          // The 404 route answers `text/plain`, not JSON — a body is only
          // parsed as JSON when it actually is some.
          let body: Record<string, unknown> = {};
          try {
            if (text) body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* not JSON — `text` still carries it */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("request timed out")));
      req.end();
    });
  }

  /** Opens `/api/events` and parses each `data: {...}` frame as it streams in. */
  protected async openEvents(): Promise<EventClient> {
    let buffer = "";
    // Everything ever received, never trimmed — `buffer` above is consumed as
    // each complete block is parsed, so it cannot answer "what arrived first"
    // once that block (e.g. the leading ": connected" comment) has already
    // been processed and sliced away.
    let everything = "";
    const frames: Record<string, unknown>[] = [];
    let onFrame: (() => void) | undefined;

    const { req, res } = await new Promise<{ req: ClientRequest; res: IncomingMessage }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: this.#port, path: "/api/events", method: "GET" }, (response) => {
        response.setEncoding("utf8");
        resolve({ req: r, res: response });
      });
      r.on("error", reject);
      r.end();
    });

    res.on("data", (chunk: string) => {
      everything += chunk;
      buffer += chunk;
      let at = buffer.indexOf("\n\n");
      while (at !== -1) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              frames.push(JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
            } catch {
              /* not JSON — ignore */
            }
          }
        }
        onFrame?.();
        at = buffer.indexOf("\n\n");
      }
    });

    return {
      status: res.statusCode ?? 0,
      headers: res.headers,
      frames,
      raw: () => everything,
      waitFor: async (predicate, timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const found = frames.find(predicate);
          if (found) return found;
          if (Date.now() >= deadline) throw new Error(`waited ${timeoutMs}ms for a matching /api/events frame; saw: ${JSON.stringify(frames)}`);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 50);
            onFrame = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
      },
      close: () => {
        req.destroy();
      },
    };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class CatalogMatchesTheRealRegistryAndTheConfiguredDirectory extends CatalogTest {
  readonly id = "catalog-lists-exactly-the-real-registrys-prompts-for-the-configured-directory";
  readonly whyItExists =
    "a reconstructed or partial catalog would drift from what the engine actually sends the model, and an operator tuning a prompt against the wrong list would tune something the running session never reads";

  override async run(t: TestRun): Promise<void> {
    const { tmp, overrides } = this.buildSandboxFiles();
    await this.startLab(tmp, overrides);

    const answer = await this.call("GET", "/api/catalog");
    t.assert.equal(answer.status, 200);
    t.assert.equal(answer.headers["content-type"]?.toString().includes("application/json"), true);

    const prompts = (answer.body["prompts"] ?? []) as CatalogPrompt[];
    const expected = promptCatalog();
    t.assert.equal(prompts.length, expected.length, "the catalog must carry exactly the registry's own prompt count");
    t.assert.deepEqual(
      prompts.map((p) => p.id).sort(),
      expected.map((p) => p.id).sort(),
      "and exactly the registry's own ids",
    );

    t.assert.equal(answer.body["dir"], overrides, "the reported directory must be the one this server was actually started with");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class EveryEntryCarriesRealTokenCountsAndThePreviewSumsToolTokens extends CatalogTest {
  readonly id = "every-entry-carries-real-token-counts-and-the-preview-sums-tool-tokens";
  readonly whyItExists =
    "a missing or wrong token estimate would make the console's size warnings meaningless, and a preview whose toolTokens did not actually sum the tool entries would misreport how much of every request is tool description rather than instruction";

  override async run(t: TestRun): Promise<void> {
    const { tmp, overrides } = this.buildSandboxFiles();
    await this.startLab(tmp, overrides);

    const answer = await this.call("GET", "/api/catalog");
    t.assert.equal(answer.status, 200);
    const prompts = (answer.body["prompts"] ?? []) as CatalogPrompt[];
    t.assert.ok(prompts.length > 0);

    for (const p of prompts) {
      t.assert.equal(typeof p.defaultTokens, "number");
      t.assert.equal(typeof p.currentTokens, "number");
      t.assert.equal(Number.isFinite(p.defaultTokens), true, `${p.id}: defaultTokens must be a real number`);
      t.assert.equal(p.currentTokens, estimateTokens(p.currentText ?? ""), `${p.id}: currentTokens must be the real estimate of currentText`);
    }

    const preview = answer.body["preview"] as Record<string, unknown>;
    t.assert.equal(typeof preview["system"], "string");
    t.assert.ok((preview["system"] as string).length > 0, "the assembled system prompt must not be empty");
    t.assert.equal(preview["systemTokens"], estimateTokens(preview["system"] as string), "systemTokens must be the real estimate of the previewed system prompt");

    const expectedToolTokens = prompts.filter((p) => p.channel === "tool").reduce((n, p) => n + (p.currentTokens ?? 0), 0);
    t.assert.equal(preview["toolTokens"], expectedToolTokens, "toolTokens must be the sum of currentTokens over channel 'tool' entries — not a separate estimate that could disagree");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnExternalOverrideShowsUpInTheCatalogAndOnTheEventStream extends CatalogTest {
  readonly id = "an-override-written-from-outside-the-server-appears-in-the-catalog-and-on-the-event-stream";
  readonly whyItExists =
    "the whole point of the console is that it reflects reality even when something else changed a prompt — the engine re-reading its own override, another editor, a script — and a stream that missed an outside change would leave an open tab showing a prompt that is no longer what is in force";

  override async run(t: TestRun): Promise<void> {
    const { tmp, overrides } = this.buildSandboxFiles();
    await this.startLab(tmp, overrides);

    const before = await this.call("GET", "/api/catalog");
    const first = (before.body["prompts"] as CatalogPrompt[])[0];
    t.assert.equal(typeof first?.id, "string");
    const id = first!.id!;

    const events = await this.openEvents();
    try {
      const overrideText = "this text was written directly to disk, outside the server\n";
      writeFileSync(join(overrides, `${id}.txt`), overrideText, "utf8");

      const frame = await events.waitFor((f) => f["type"] === "changed" && f["id"] === id);
      t.assert.deepEqual(frame, { type: "changed", id });

      // `overrideText()` trusts a resolved value for up to 250ms
      // (CACHE_TTL_MS) before it stats the file again — a single GET right
      // after the event could still legitimately read the pre-write cache
      // entry, so this polls rather than sleeping a fixed time or asserting once.
      const deadline = Date.now() + 10_000;
      let entry: CatalogPrompt | undefined;
      for (;;) {
        const after = await this.call("GET", "/api/catalog");
        entry = (after.body["prompts"] as CatalogPrompt[]).find((p) => p.id === id);
        if (entry?.overridden === true) break;
        if (Date.now() >= deadline) throw new Error(`waited 10s for the catalog to report ${id} as overridden; last saw: ${JSON.stringify(entry)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      t.assert.equal(entry?.currentText, overrideText.replace(/\n+$/, ""), "currentText must be the file's content, normalized the same way the registry normalizes any override");
    } finally {
      events.close();
    }
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class EventsStreamOpensCleanlyAndSurvivesADisconnectedClient extends CatalogTest {
  readonly id = "the-event-stream-opens-with-a-connected-comment-and-a-disconnect-does-not-break-later-broadcasts";
  readonly whyItExists =
    "a broadcast that threw on a client whose response object was already closed would crash the fs.watch callback with an uncaught exception, taking the whole running server down with it the next time ANY client's file changed";

  override async run(t: TestRun): Promise<void> {
    const { tmp, overrides } = this.buildSandboxFiles();
    await this.startLab(tmp, overrides);

    const events = await this.openEvents();
    t.assert.equal(events.status, 200);
    t.assert.equal(events.headers["content-type"], "text/event-stream");
    // Give the ": connected" comment a moment to arrive, then read the raw
    // buffer directly — a comment line is not a `data:` frame `waitFor` parses.
    await new Promise((resolve) => setTimeout(resolve, 300));
    t.assert.match(events.raw(), /^: connected/, "the stream must open with the connected comment before anything else");

    events.close();
    // Give the server a moment to see the closed connection and run its
    // `req.on('close', …)` cleanup before the next broadcast is provoked.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const catalog = await this.call("GET", "/api/catalog");
    const id = (catalog.body["prompts"] as CatalogPrompt[])[0]!.id!;
    // Provokes a broadcast with the disconnected client's response object
    // still sitting in `clients` if cleanup had not removed it.
    writeFileSync(join(overrides, `${id}.txt`), "provoking a broadcast after a client disconnected\n", "utf8");

    // If broadcast() threw inside the fs.watch callback, this whole server
    // process would already be dead — proven by the very next request.
    const stillAlive = await this.call("GET", "/api/catalog");
    t.assert.equal(stillAlive.status, 200, "the server must still answer after a broadcast that had a disconnected client to skip");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class UnknownPathIs404AndTheServerBindsOnlyToLoopback extends CatalogTest {
  readonly id = "an-unknown-path-is-404-and-the-server-binds-only-to-127-0-0-1";
  readonly whyItExists =
    "a server that answered on every address, or fell through silently on a bad path, would be reachable from other machines on the network for a console with no authentication of its own — a local tool becoming a network-exposed one is exactly the kind of change nothing else here would notice";

  override async run(t: TestRun): Promise<void> {
    const { tmp, overrides } = this.buildSandboxFiles();
    await this.startLab(tmp, overrides);

    const missing = await this.call("GET", "/api/no-such-route");
    t.assert.equal(missing.status, 404);
    t.assert.equal(missing.text, "not found");

    const reachable = await this.call("GET", "/api/catalog");
    t.assert.equal(reachable.status, 200, "the loopback address itself must work, so the refusal below is about the OTHER address, not a broken server");

    // `::1` is IPv6 loopback — present on every platform this suite runs on,
    // unlike a LAN address, which some sandboxed CI hosts have none of. A
    // server bound only to the IPv4 127.0.0.1 socket must refuse this one.
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "::1", port: this.port, family: 6, timeout: 3_000 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(true);
      });
    });
    t.assert.equal(refused, true, "a connection to the IPv6 loopback address must be refused — the server must bind only the IPv4 127.0.0.1 socket it was given");
  }
}

registerFeatureTests(
  new CatalogMatchesTheRealRegistryAndTheConfiguredDirectory(),
  new EveryEntryCarriesRealTokenCountsAndThePreviewSumsToolTokens(),
  new AnExternalOverrideShowsUpInTheCatalogAndOnTheEventStream(),
  new EventsStreamOpensCleanlyAndSurvivesADisconnectedClient(),
  new UnknownPathIs404AndTheServerBindsOnlyToLoopback(),
);
