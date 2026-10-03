/**
 * The brain editor's local server: the page, and a JSON API over model.ts.
 *
 * Same shape as the gateway's server (docs/decisions/0002): stdlib node:http,
 * 127.0.0.1 only, a fixed list of static files, and every write gated on a
 * custom header a cross-site page cannot send without a preflight this server
 * never answers. It adds a Host check, so a DNS-rebound name cannot reach it
 * either.
 *
 * Every route that changes a brain calls applyChanges() — the same function
 * the command line calls — so the page has no write path of its own.
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO, SHIPPED_BRAIN } from "./compiler.ts";
import { forgetProbes } from "./engine.ts";
import { CHANGE_GUIDE } from "./guide.ts";
import { applyChanges, checkEngine, loadBrain, newProfile, planChanges, type PlanOptions } from "./model.ts";
import { engineState, isShippedBrain, localOverrides, startBuild, type BuildRun } from "./project.ts";

export const ACTION_HEADER = "x-magentra-brain-action";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");
/** The app's own bundled fonts, served from where the app keeps them rather than copied. */
const FONTS = join(REPO, "app", "renderer", "fonts");
/** The only files served: a fixed list, so no request path ever reaches the filesystem. */
const STATIC: Readonly<Record<string, readonly [file: string, type: string]>> = {
  "/": [join(UI_DIR, "index.html"), "text/html; charset=utf-8"],
  "/index.html": [join(UI_DIR, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [join(UI_DIR, "app.js"), "text/javascript; charset=utf-8"],
  "/brain.js": [join(UI_DIR, "brain.js"), "text/javascript; charset=utf-8"],
  "/style.css": [join(UI_DIR, "style.css"), "text/css; charset=utf-8"],
  "/favicon.svg": [join(UI_DIR, "favicon.svg"), "image/svg+xml"],
  "/fonts/inter-var.woff2": [join(FONTS, "inter-var.woff2"), "font/woff2"],
  "/fonts/jetbrains-mono-var.woff2": [join(FONTS, "jetbrains-mono-var.woff2"), "font/woff2"],
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8 * 1024 * 1024) throw new Error("request body is larger than 8 MB");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as unknown);
}

/** The plan options in a request body: `expectRevision` and `acknowledge`. */
function planOptions(body: Record<string, unknown>): PlanOptions {
  const ack = body.acknowledge;
  return {
    ...(typeof body.expectRevision === "string" ? { expectRevision: body.expectRevision } : {}),
    ...(Array.isArray(ack) ? { acknowledge: ack.filter((a): a is string => typeof a === "string") } : {}),
  };
}

export interface BrainEditorOptions {
  /** The brain folder to edit first. Default: the repo's brain/. */
  readonly brain?: string;
}

export interface BrainEditor {
  readonly server: Server;
  listen(port: number, host?: string): Promise<{ port: number; host: string; url: string }>;
  /** The brain folder being edited now. */
  brainDir(): string;
  close(): void;
}

/** True for a folder that looks like a brain (something the compiler would read). */
function looksLikeBrain(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && (existsSync(join(dir, "prompts")) || existsSync(join(dir, "tools")) || existsSync(join(dir, "behavior.json")));
  } catch {
    return false;
  }
}

export function createBrainEditor(options: BrainEditorOptions = {}): BrainEditor {
  let brain = resolve(options.brain ?? SHIPPED_BRAIN);
  let origin = "";
  let origins: string[] = [];
  let hosts: string[] = [];
  let build: BuildRun | undefined;
  const clients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;
  let settle: NodeJS.Timeout | undefined;

  const broadcast = (event: unknown): void => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(line);
  };

  /** Tells every open page when the brain changes on disk — a save, an agent's CLI, a git checkout. */
  const watchBrain = (): void => {
    watcher?.close();
    watcher = undefined;
    try {
      watcher = watch(brain, { recursive: true }, () => {
        clearTimeout(settle);
        settle = setTimeout(() => broadcast({ type: "brain" }), 250);
      });
      watcher.on("error", () => undefined);
    } catch {
      // A folder that cannot be watched still works; the page reloads after its own saves.
    }
  };

  const isUserAction = (req: IncomingMessage): boolean => {
    if (req.headers[ACTION_HEADER] !== "1") return false;
    const sent = req.headers.origin;
    return sent === undefined || origins.includes(sent);
  };

  async function state(): Promise<unknown> {
    const snapshot = loadBrain(brain);
    const overrides = await localOverrides();
    return {
      ...snapshot,
      repo: REPO,
      engineState: snapshot.shipped ? engineState() : null,
      overrides: overrides ? { dir: overrides.dir, byId: Object.fromEntries(overrides.byId) } : null,
      build: build ?? null,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.includes(req.headers.host ?? "")) {
      res.writeHead(421, { "content-type": "text/plain" }).end("wrong host\n");
      return;
    }
    const url = new URL(req.url ?? "/", origin);
    const path = url.pathname;
    const method = req.method ?? "GET";

    const asset = STATIC[path];
    if (asset && method === "GET") {
      res.writeHead(200, {
        "content-type": asset[1],
        "cache-control": asset[1].startsWith("font/") ? "max-age=86400" : "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:",
      });
      res.end(readFileSync(asset[0]));
      return;
    }
    if (!path.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }

    if (method === "GET") {
      if (path === "/api/brain") return json(res, 200, await state());
      if (path === "/api/engine") return json(res, 200, await checkEngine(brain));
      if (path === "/api/guide") return json(res, 200, CHANGE_GUIDE);
      if (path === "/api/build") return json(res, 200, build ?? null);
      if (path === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      return json(res, 404, { error: `no route GET ${path}` });
    }
    if (method !== "POST") return json(res, 405, { error: `${method} is not supported` });
    if (!isUserAction(req)) return json(res, 403, { error: `writes require an explicit action from the page (${ACTION_HEADER})` });

    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    } catch (err) {
      return json(res, 400, { error: `the request body is not JSON: ${(err as Error).message}` });
    }

    if (path === "/api/plan") return json(res, 200, await planChanges(brain, body.changes, planOptions(body)));
    if (path === "/api/apply") {
      const result = await applyChanges(brain, body.changes, planOptions(body));
      if (result.applied) broadcast({ type: "brain" });
      return json(res, result.applied || result.ok ? 200 : 409, result);
    }
    if (path === "/api/build") {
      if (!isShippedBrain(brain)) return json(res, 400, { error: "only the shipped brain (brain/) is built into the engine; a profile folder is checked, never built" });
      if (build?.running) return json(res, 409, { error: "a build is already running", build });
      build = startBuild((run) => {
        build = run;
        if (!run.running) forgetProbes();
        broadcast({ type: "build", build: run });
      });
      return json(res, 202, build);
    }
    if (path === "/api/profile") {
      if (typeof body.to !== "string" || body.to.trim() === "") return json(res, 400, { error: 'send { "to": "<folder for the new profile>" }' });
      const result = newProfile(brain, resolve(REPO, body.to.trim()));
      return json(res, result.ok ? 200 : 409, result);
    }
    if (path === "/api/open") {
      const target = typeof body.dir === "string" && body.dir.trim() !== "" ? resolve(REPO, body.dir.trim()) : SHIPPED_BRAIN;
      if (!looksLikeBrain(target)) return json(res, 400, { error: `${target} is not a brain folder (no prompts/, tools/ or behavior.json in it)` });
      brain = target;
      watchBrain();
      broadcast({ type: "brain" });
      return json(res, 200, { dir: brain });
    }
    return json(res, 404, { error: `no route POST ${path}` });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  return {
    server,
    brainDir: () => brain,
    listen(port, host = "127.0.0.1") {
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          const bound = typeof address === "object" && address !== null ? address.port : port;
          origin = `http://${host}:${bound}`;
          hosts = [`${host}:${bound}`, `localhost:${bound}`];
          origins = hosts.map((h) => `http://${h}`);
          watchBrain();
          resolveListen({ port: bound, host, url: origin });
        });
      });
    },
    close() {
      watcher?.close();
      clearTimeout(settle);
      for (const client of clients) client.end();
      server.close();
    },
  };
}
