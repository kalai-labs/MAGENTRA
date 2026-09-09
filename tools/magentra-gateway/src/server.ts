/**
 * The HTTP surface — SPEC §5, and the read-only UI of §9.
 *
 * `node:http` on 127.0.0.1 only, no framework, no dependency. Follows
 * `tools/prompt-lab/server.mjs` so `tools/` has one local-server pattern rather
 * than two (decisions/0002).
 *
 * SCOPE. This is SPEC §11 steps 1, 3, 4, 5, 7 and 9. The record-editing route
 * answers 501 naming the reason, rather than 404 — a route that silently does
 * not exist is indistinguishable from one that is broken. There is no run route
 * and no brief route: running tests and handing work to an agent happen outside
 * the gateway (decisions/0006). Nothing here touches git, and no route mutates
 * on GET.
 */

import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyProfileToWorkspace, disconnectWorkspace, UnknownProfileError } from "./connection.js";
import { clearDependencyCache, resolveDependencies } from "./deps.js";
import { evaluateGate, type GateState } from "./gate.js";
import { checkFeature, reRecord } from "./freshness.js";
import {
  deleteDescription,
  featuresDir,
  loadDescriptions,
  loadFeatures,
  setDescriptionStatus,
  repoRoot,
  writeDescription,
  writeFeature,
  RegistryError,
  UnknownDescriptionError,
  UnknownFeatureError,
} from "./registry.js";
import { AREAS, KINDS, STATUSES, type Feature } from "./schema.js";

const UIDIR = join(dirname(fileURLToPath(import.meta.url)), "ui");

export interface GatewayOptions {
  readonly root?: string;
  readonly port?: number;
  readonly host?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A write must come from an explicit action in our own UI (§5,
 * "approval-gated"). A cross-site form post cannot set a custom header, and a
 * cross-site fetch cannot either without a CORS preflight this server never
 * answers — so requiring the header is what stops any other page in the
 * browser from reconciling a record or writing an API key into `.env`.
 */
const ACTION_HEADER = "x-magentra-gateway-action";

function isUserAction(req: IncomingMessage, origin: string): boolean {
  if (req.headers[ACTION_HEADER] !== "1") return false;
  const sent = req.headers.origin;
  return sent === undefined || sent === origin;
}

/**
 * Everything the UI needs in one payload — §5 `/api/state`.
 *
 * `fresh` per feature is derived from the gate's own report rather than hashed
 * a second time, so the list and the lamp can never disagree about one record.
 */
function stateOf(root: string, features: readonly Feature[], gate: GateState) {
  const stale = new Set(gate.freshness.stale.map((s) => s.id));
  return {
    features: features.map((f) => ({
      id: f.id,
      name: f.name,
      area: f.area,
      section: f.section,
      kinds: f.kinds,
      status: f.status,
      deferred: f.deferred === true,
      entryFiles: f.entryFiles,
      invariant: f.invariant,
      tests: f.tests,
      fresh: !stale.has(f.id),
    })),
    descriptions: loadDescriptions(root),
    gate,
    vocabulary: { areas: AREAS, kinds: KINDS, statuses: STATUSES },
  };
}

export interface Gateway {
  readonly server: Server;
  readonly listen: (port: number, host: string) => Promise<{ port: number; host: string }>;
  readonly gate: () => GateState;
  readonly featureCount: () => number;
  readonly close: () => void;
}

export function createGateway(options: GatewayOptions = {}): Gateway {
  const root = options.root ?? repoRoot();

  // Loaded once and reloaded when a record file changes. A malformed record
  // throws out of loadFeatures and is reported to the client; the previously
  // loaded good set is kept rather than being replaced by a partial one.
  let features: Feature[] = loadFeatures(root);
  let loadError: RegistryError | null = null;

  const clients = new Set<ServerResponse>();
  const watchers: FSWatcher[] = [];
  let origin = "";

  function reload(): void {
    try {
      features = loadFeatures(root);
      loadError = null;
    } catch (err) {
      if (err instanceof RegistryError) loadError = err;
      else throw err;
    }
  }

  function gate(): GateState {
    return evaluateGate(root, features);
  }

  function broadcast(event: unknown): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  /**
   * File-watch invalidation (§5). Watches the DIRECTORIES holding entry files
   * — 25 of them for the 96 unique entry files of the seed inventory — rather
   * than 96 individual files, so a rename or a delete is seen too. Debounced,
   * because one editor save can fire several events.
   *
   * The watcher only prompts a re-check; the answer still comes from hashing
   * the contents. A watch event on a file whose bytes did not change (a
   * `git checkout` of an identical version, a touch) therefore changes nothing.
   */
  function startWatching(): void {
    const dirs = new Set<string>([featuresDir(root)]);
    for (const f of features) for (const e of f.entryFiles) dirs.add(join(root, dirname(e)));

    let timer: NodeJS.Timeout | undefined;
    let lastSignature = "";
    const settle = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        reload();
        const g = gate();
        const signature = JSON.stringify([g.blocked, g.freshness.stale.map((s) => [s.id, s.currentHash])]);
        if (signature !== lastSignature) {
          lastSignature = signature;
          broadcast({ type: "gate", gate: g, loadError: loadError?.message ?? null });
        }
      }, 300);
    };

    for (const dir of dirs) {
      try {
        watchers.push(watch(dir, settle));
      } catch {
        // A directory that cannot be watched degrades to "no live invalidation
        // for these files"; the gate still re-checks on every /api/state.
      }
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", origin || `http://${req.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // ---- UI ------------------------------------------------------------
    if (method === "GET" && (path === "/" || path === "/index.html")) return serveUi(res, "index.html");
    if (method === "GET" && (path === "/app.js" || path === "/style.css")) return serveUi(res, path.slice(1));

    // ---- read ----------------------------------------------------------
    if (path === "/api/state") {
      if (method !== "GET") return void json(res, 405, { error: "GET only" });
      if (loadError !== null) return void json(res, 500, { error: loadError.message, problems: loadError.problems });
      return void json(res, 200, stateOf(root, features, gate()));
    }

    const featureMatch = /^\/api\/features\/([^/]+)(\/reconcile)?$/.exec(path);
    if (featureMatch) {
      const id = decodeURIComponent(featureMatch[1] ?? "");
      const suffix = featureMatch[2];
      const feature = features.find((f) => f.id === id);
      if (feature === undefined) return void json(res, 404, { error: `no feature record with id "${id}"` });

      if (suffix === undefined && method === "GET") {
        // Dependencies are resolved lazily, per feature, because indexing the
        // repo costs about a second — far too much to spend 164 times on
        // /api/state, and unnecessary until someone opens a feature.
        return void json(res, 200, {
          feature,
          freshness: checkFeature(root, feature),
          descriptions: loadDescriptions(root).filter((d) => d.featureIds.includes(id)),
          dependencies: await resolveDependencies(root, feature, features),
        });
      }

      // §4.1 — re-record freshness. Approval-gated: the write happens only on
      // an explicit action in the UI, and the UI states next to the button that
      // reconciling without reviewing defeats the mechanism.
      if (suffix === "/reconcile" && method === "POST") {
        if (!isUserAction(req, origin)) {
          return void json(res, 403, { error: `writes require an explicit UI action (${ACTION_HEADER})` });
        }
        const before = checkFeature(root, feature);
        const updated = reRecord(root, feature);
        writeFeature(updated, root);
        reload();
        clearDependencyCache();
        const g = gate();
        broadcast({ type: "gate", gate: g, loadError: loadError?.message ?? null });
        return void json(res, 200, { id, reRecorded: before.drifted, freshness: updated.freshness, gate: g });
      }
    }

    // ---- connection (§4.2 branch 3) ------------------------------------
    // SPEC §5's route table has no entry for this, while §4.2 requires that
    // choosing a profile writes `<ws>/.env` and `<ws>/.magentra/settings.json`.
    // The table is the gap; this is the route that closes it.
    if (path === "/api/connection/apply") {
      if (method !== "POST") return void json(res, 405, { error: "POST only" });
      if (!isUserAction(req, origin)) {
        return void json(res, 403, { error: `writes require an explicit UI action (${ACTION_HEADER})` });
      }
      let profileId: unknown;
      try {
        profileId = (JSON.parse(await readBody(req)) as { profileId?: unknown }).profileId;
      } catch {
        return void json(res, 400, { error: "body must be JSON: { profileId }" });
      }
      if (typeof profileId !== "string" || profileId === "") {
        return void json(res, 400, { error: "profileId is required" });
      }
      try {
        const connection = applyProfileToWorkspace(root, profileId);
        const g = gate();
        broadcast({ type: "gate", gate: g, loadError: null });
        return void json(res, 200, { connection, gate: g });
      } catch (err) {
        if (err instanceof UnknownProfileError) return void json(res, 404, { error: err.message });
        throw err;
      }
    }

    // §4.2 branch 5 — clear this folder's connection so another can be chosen.
    // The inverse of the route above, and gated identically.
    if (path === "/api/connection/clear") {
      if (method !== "POST") return void json(res, 405, { error: "POST only" });
      if (!isUserAction(req, origin)) {
        return void json(res, 403, { error: `writes require an explicit UI action (${ACTION_HEADER})` });
      }
      const connection = disconnectWorkspace(root);
      const g = gate();
      broadcast({ type: "gate", gate: g, loadError: null });
      return void json(res, 200, { connection, gate: g });
    }

    // ---- not this scope --------------------------------------------------
    if (path === "/api/features" && method === "POST") {
      return void json(res, 501, { error: "creating and editing records is not in SPEC §11 steps 1–5; the UI is read-only" });
    }
    // ---- descriptions (§2.2, §11 step 9) --------------------------------
    if (path === "/api/descriptions") {
      if (method === "GET") return void json(res, 200, { descriptions: loadDescriptions(root) });
      if (method !== "POST") return void json(res, 405, { error: "GET or POST" });
      if (!isUserAction(req, origin)) {
        return void json(res, 403, { error: `writes require an explicit UI action (${ACTION_HEADER})` });
      }
      let body: { id?: unknown; featureIds?: unknown; body?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        return void json(res, 400, { error: "body must be JSON: { featureIds, body, id? }" });
      }
      const featureIds = Array.isArray(body.featureIds) ? body.featureIds.filter((x): x is string => typeof x === "string") : [];
      if (typeof body.body !== "string" || body.body.trim() === "") {
        return void json(res, 400, { error: "body is required — an empty description is not a directive" });
      }
      try {
        const saved = writeDescription(
          { ...(typeof body.id === "string" ? { id: body.id } : {}), featureIds, body: body.body },
          root,
        );
        broadcast({ type: "descriptions" });
        return void json(res, 200, { description: saved });
      } catch (err) {
        if (err instanceof UnknownFeatureError) return void json(res, 400, { error: err.message });
        if (err instanceof UnknownDescriptionError) return void json(res, 404, { error: err.message });
        throw err;
      }
    }

    const descMatch = /^\/api\/descriptions\/([^/]+)(\/ready|\/draft)?$/.exec(path);
    if (descMatch) {
      const id = decodeURIComponent(descMatch[1] ?? "");
      const suffix = descMatch[2];
      if (method !== "POST" && method !== "DELETE") return void json(res, 405, { error: "POST or DELETE" });
      if (!isUserAction(req, origin)) {
        return void json(res, 403, { error: `writes require an explicit UI action (${ACTION_HEADER})` });
      }
      try {
        if (method === "DELETE") {
          deleteDescription(id, root);
          broadcast({ type: "descriptions" });
          return void json(res, 200, { deleted: id });
        }
        // The user-only transition. Nothing that runs on its own reaches this,
        // and there is no route that sets `status` while saving a body.
        const saved = setDescriptionStatus(id, suffix === "/draft" ? "draft" : "ready", root);
        broadcast({ type: "descriptions" });
        return void json(res, 200, { description: saved });
      } catch (err) {
        if (err instanceof UnknownDescriptionError) return void json(res, 404, { error: err.message });
        throw err;
      }
    }

    // ---- SSE -------------------------------------------------------------
    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      res.write(`data: ${JSON.stringify({ type: "gate", gate: gate(), loadError: loadError?.message ?? null })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  }

  async function serveUi(res: ServerResponse, name: string): Promise<void> {
    const ext = name.slice(name.lastIndexOf("."));
    const body = await readFile(join(UIDIR, name), "utf8");
    res.writeHead(200, { "content-type": MIME[ext] ?? "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const bound = typeof addr === "object" && addr !== null ? addr.port : port;
          origin = `http://${host}:${bound}`;
          startWatching();
          resolve({ port: bound, host });
        });
      }),
    gate,
    featureCount: () => features.length,
    close: () => {
      for (const w of watchers) w.close();
      for (const c of clients) c.end();
      server.close();
    },
  };
}
