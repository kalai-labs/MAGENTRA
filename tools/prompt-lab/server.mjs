#!/usr/bin/env node
// Prompt Lab — a local console for every prompt the engine sends.
//
// It serves index.html and a small JSON API over the prompt registry in
// @magentra/protocol. Editing in the browser writes a plain .txt file per
// prompt under the overrides directory; the engine re-reads those files live,
// so a change lands on the next turn without a restart.
//
//   npm run prompt-lab            → http://127.0.0.1:4319
//   npm run prompt-lab -- --port 5000 --dir ./experiments/short-prompts

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// The overrides directory must be set before the registry module is first
// imported, since promptsDir() reads it on every call but the engine modules
// resolve their defaults as they load.
const dirOverride = arg("dir", process.env.MAGENTRA_PROMPTS_DIR);
if (dirOverride) process.env.MAGENTRA_PROMPTS_DIR = dirOverride;

const PORT = Number(arg("port", 4319));
const HOST = arg("host", "127.0.0.1");

// Importing these registers every prompt as a side effect of module load:
// core brings the system prompt, reminders, rungs and background calls; the
// tool registry brings all the tool descriptions.
const core = await import("@magentra/core");
const tools = await import("@magentra/tools");
const protocol = await import("@magentra/protocol");

tools.createDefaultRegistry();

const {
  clearPromptOverride,
  estimateTokens,
  orphanedPromptFiles,
  promptCatalog,
  promptsDir,
  promptText,
  writePromptOverride,
} = protocol;

/**
 * The assembled system prompt, exactly as a session would build it, so the UI
 * can show the real thing rather than a reconstruction. Uses placeholder
 * environment values — the point is the shape and the size, not this machine.
 */
function systemPreview() {
  return core.buildSystemPrompt({
    env: {
      cwd: process.cwd(),
      isGitRepo: true,
      platform: process.platform,
      model: "<the configured model>",
      date: "<today>",
    },
    skills: [],
  });
}

/**
 * Review notes keyed by prompt id, read fresh on every request so the file can
 * be edited while the lab is open. A missing or malformed file is not fatal —
 * the lab is still a prompt editor without them.
 */
async function loadFindings() {
  try {
    return JSON.parse(await readFile(join(HERE, "findings.json"), "utf8"));
  } catch {
    return { meta: {}, findings: {} };
  }
}

function catalog() {
  const prompts = promptCatalog().map((p) => ({
    ...p,
    defaultTokens: estimateTokens(p.defaultText),
    currentTokens: estimateTokens(p.currentText),
  }));
  const system = systemPreview();
  const toolTokens = prompts
    .filter((p) => p.channel === "tool")
    .reduce((n, p) => n + p.currentTokens, 0);
  return {
    dir: promptsDir(),
    orphans: orphanedPromptFiles(),
    prompts,
    preview: { system, systemTokens: estimateTokens(system), toolTokens },
  };
}

// ── live reload ─────────────────────────────────────────────────────────────
// Every connected browser hears about override files that changed on disk,
// including ones changed by another editor or by the engine itself.
const clients = new Set();

function broadcast(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(frame);
}

let watcher;
/** ids this server wrote recently, so fs.watch does not report our own writes. */
const selfWrites = new Map();
const SELF_WRITE_GRACE_MS = 1500;

function markSelfWrite(id) {
  selfWrites.set(id, Date.now());
}

function isSelfWrite(id) {
  const at = selfWrites.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > SELF_WRITE_GRACE_MS) {
    selfWrites.delete(id);
    return false;
  }
  return true;
}

function startWatching() {
  try {
    watcher?.close();
    watcher = watch(promptsDir(), (_type, file) => {
      if (typeof file === "string" && file.endsWith(".txt")) {
        const id = file.slice(0, -4);
        if (!isSelfWrite(id)) broadcast({ type: "changed", id });
      }
    });
    watcher.on("error", () => {});
  } catch {
    // The directory does not exist until the first override is written; the
    // first write starts the watcher.
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (path === "/" || path === "/index.html") {
      const html = await readFile(join(HERE, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }

    if (path === "/api/catalog") {
      const review = await loadFindings();
      return json(res, 200, { ...catalog(), review });
    }

    if (path === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (path.startsWith("/api/prompt/")) {
      const id = decodeURIComponent(path.slice("/api/prompt/".length));
      if (req.method === "PUT") {
        const text = await readBody(req);
        markSelfWrite(id);
        writePromptOverride(id, text);
        startWatching();
        const entry = promptCatalog().find((p) => p.id === id);
        return json(res, 200, {
          id,
          overridden: entry?.overridden ?? false,
          currentTokens: estimateTokens(promptText(id)),
        });
      }
      if (req.method === "DELETE") {
        markSelfWrite(id);
        clearPromptOverride(id);
        return json(res, 200, { id, overridden: false, currentTokens: estimateTokens(promptText(id)) });
      }
    }

    if (path === "/api/reset-all" && req.method === "POST") {
      for (const p of promptCatalog()) if (p.overridden) clearPromptOverride(p.id);
      broadcast({ type: "reset-all" });
      return json(res, 200, { ok: true });
    }

    if (path === "/api/import" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      let applied = 0;
      for (const [id, text] of Object.entries(body)) {
        try {
          writePromptOverride(id, String(text));
          applied++;
        } catch {
          // An id from an older build no longer exists; skip it rather than
          // failing the whole import.
        }
      }
      startWatching();
      broadcast({ type: "reset-all" });
      return json(res, 200, { applied });
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

startWatching();
server.listen(PORT, HOST, () => {
  const n = promptCatalog().length;
  process.stdout.write(
    `\n  Prompt Lab — ${n} prompts\n` +
      `  http://${HOST}:${PORT}\n` +
      `  overrides → ${promptsDir()}\n\n`,
  );
});
