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

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { watch, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/**
 * The repo's TypeScript compiler entry script, or undefined if it is not
 * installed.
 *
 * Resolved once, and NOT invoked as `npx tsc`. On Windows npx is `npx.cmd`, and
 * `execFile` without a shell cannot spawn a `.cmd` — it fails with ENOENT before
 * the compiler is ever reached. That failure was invisible in both places it
 * happened: promote wrote the source file, caught the ENOENT as if it were a
 * type error, restored the file and reported "typecheck failed" with an empty
 * body; and the startup build printed "BUILD FAILED" with nothing after it, so
 * the lab served defaults from a stale `dist`. Running the compiler's own script
 * under the node binary already executing this server puts no shell in the path
 * at all, so it behaves identically on every platform.
 */
const TSC = (() => {
  try {
    return createRequire(join(REPO, "package.json")).resolve("typescript/bin/tsc");
  } catch {
    return undefined;
  }
})();

/** Typechecks and builds the whole repo. Rejects like execFile on failure. */
function tscBuild(timeout) {
  if (TSC === undefined) throw new Error("typescript is not installed — run `npm install` in the repo root");
  return run(process.execPath, [TSC, "-b"], { cwd: REPO, timeout });
}

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

/**
 * The engine build these prompts belong to, read from the repo's VERSION file.
 *
 * Live rather than stamped. `findings.json` used to carry a hand-written
 * `meta.build`, which nothing read and which sat four releases behind in the
 * four-part scheme ADR 0008 retired — so the one place claiming "this is the
 * version you are editing" was quietly wrong. A file read costs nothing and
 * cannot drift.
 */
function engineVersion() {
  try {
    return readFileSync(join(HERE, "..", "..", "VERSION"), "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}
const VERSION = engineVersion();


/** Newest mtime under `dir` for files matching `ext`, or 0 when there are none. */
async function newestMtime(dir, ext) {
  const { readdir, stat } = await import("node:fs/promises");
  let newest = 0;
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules") continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "dist" && ext === ".ts") continue;
        await walk(full);
      } else if (e.name.endsWith(ext)) {
        try {
          newest = Math.max(newest, (await stat(full)).mtimeMs);
        } catch {}
      }
    }
  }
  await walk(dir);
  return newest;
}

/** Compiles the engine when the sources are ahead of the build. */
async function ensureBuilt() {
  const engine = join(REPO, "engine");
  const [src, out] = await Promise.all([newestMtime(engine, ".ts"), newestMtime(engine, ".js")]);
  if (out >= src) return;
  process.stdout.write("  sources changed since the last build — compiling…\n");
  try {
    await tscBuild(300_000);
  } catch (err) {
    // `message` as well as the streams: a compiler that never started (missing
    // install, spawn failure) has empty stdout and stderr, and reporting only
    // those printed a bare "BUILD FAILED" with no cause under it.
    const out2 = `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim() || err?.message || String(err);
    process.stdout.write(`  BUILD FAILED — defaults may not match source:\n${out2.slice(0, 500)}\n`);
  }
}

// The registry resolves every default from the COMPILED engine, while promote
// writes to the TypeScript source. If dist is older than src the two disagree,
// and the symptom is baffling: promote reports "no verbatim match" for a literal
// that is plainly sitting in the file. Build first so the in-memory defaults are
// the ones on disk.
await ensureBuilt();

// Importing these registers every prompt as a side effect of module load:
// core brings the system prompt, reminders, rungs and background calls; the
// tool registry brings all the tool descriptions.
const core = await import("@magentra/core");
const tools = await import("@magentra/tools");
const protocol = await import("@magentra/protocol");

tools.createDefaultRegistry();

const {
  clearPromptOverride,
  setPromptDefault,
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
    addons: [],
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

/**
 * Marks each review note addressed once its prompt no longer matches the text
 * the note was written against. Without this a fixed prompt keeps showing the
 * severity it had before the fix, and there is no way to see what is left.
 *
 * Disabling a prompt counts as addressed — switching a rung off is a decision
 * about it, not an open question.
 */
function markAddressed(review, prompts) {
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const noteMarks = review.manualAddressed ?? {};
  const out = {};
  for (const [id, note] of Object.entries(review.findings ?? {})) {
    const p = byId.get(id);
    const hash = p ? createHash("sha1").update(p.currentText).digest("hex").slice(0, 12) : "";
    const marked = noteMarks[id] !== undefined;
    out[id] = {
      ...note,
      id,
      markedAddressed: marked,
      addressed:
        marked ||
        note.reviewedHash === "addressed" ||
        (p?.disabled ?? false) ||
        (note.reviewedHash !== undefined && note.reviewedHash !== hash),
    };
  }
  const marks = review.workOrder?.manualDone ?? {};
  const work = review.workOrder
    ? {
        ...review.workOrder,
        phases: review.workOrder.phases.map((ph) => ({
          ...ph,
          steps: ph.steps.map((st) => {
            const mark = marks[String(st.n)];
            const verified = stepPasses(st, byId);
            return {
              ...st,
              // `done` drives the counters and the strikethrough; the two flags
              // below keep the distinction visible, so a step someone asserted is
              // never mistaken for one the tests actually confirmed.
              done: verified || mark !== undefined,
              verified,
              markedDone: mark !== undefined,
              ...(mark?.at ? { markedAt: mark.at } : {}),
            };
          }),
        })),
      }
    : null;
  return { ...review, findings: out, workOrder: work, meta: review.meta ?? {} };
}

/**
 * Records or clears an operator's manual "done" mark for a work-order step.
 *
 * Some steps can never satisfy their own test: the operator decides the edit is
 * not worth making, the step is withdrawn, or the work landed somewhere the test
 * cannot see. Those stay red forever, and a board that cannot reach zero stops
 * being a picture of what is left.
 *
 * Stored beside the work order rather than in the overrides directory, because it
 * is progress on a shared plan and belongs with the plan. Kept separate from the
 * tests so {@link markAddressed} can report the two independently.
 */
/**
 * Moves a review note to the Done list by hand, or brings it back.
 *
 * Most notes settle on their own: the prompt's text stops matching the snapshot
 * the note was written against. Notes whose action is "No change." never can —
 * clearing them would mean editing a prompt the review said to leave alone.
 */
async function setNoteAddressed(id, done) {
  const file = join(HERE, "findings.json");
  const review = JSON.parse(await readFile(file, "utf8"));
  if (!review.findings?.[id]) return { ok: false, reason: `no review note for ${id}` };

  const marks = review.manualAddressed ?? {};
  if (done) marks[id] = { at: new Date().toISOString().slice(0, 10) };
  else delete marks[id];
  if (Object.keys(marks).length > 0) review.manualAddressed = marks;
  else delete review.manualAddressed;

  await writeFile(file, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  broadcast({ type: "note-addressed", id, done });
  return { ok: true, id, done };
}

async function setStepDone(n, done) {
  const file = join(HERE, "findings.json");
  // Parsed strictly, unlike loadFindings: a read can fall back to an empty
  // review, but writing over a file we failed to understand would destroy it.
  const review = JSON.parse(await readFile(file, "utf8"));
  const steps = (review.workOrder?.phases ?? []).flatMap((ph) => ph.steps ?? []);
  if (!steps.some((st) => st.n === n)) return { ok: false, reason: `no work-order step ${n}` };

  const marks = review.workOrder.manualDone ?? {};
  if (done) marks[String(n)] = { at: new Date().toISOString().slice(0, 10) };
  else delete marks[String(n)];
  if (Object.keys(marks).length > 0) review.workOrder.manualDone = marks;
  else delete review.workOrder.manualDone;

  await writeFile(file, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  broadcast({ type: "work-order", step: n, done });
  return { ok: true, step: n, done };
}

/**
 * Whether a work-order step's own test confirms it was carried out.
 *
 * Deliberately not "the prompt changed at some point" — that flag is true for
 * any earlier edit and would mark a step done that nobody has started. Each
 * step declares its own test: the receiving prompt now contains the rule, the
 * source prompt is empty, or the prompt no longer exists at all.
 *
 * A step can also be marked done by hand (see {@link setStepDone}) for the cases
 * no test can express. That mark is reported separately and never comes through
 * here — this function only ever answers for the evidence.
 */
function stepPasses(step, byId) {
  const t = step.test;
  if (!t) return false;
  const p = byId.get(t.prompt);
  if (t.gone) return p === undefined;
  // A prompt that was removed from the code outright satisfies any step that
  // only asked for it to be switched off — deletion is the stronger form of the
  // same intent, and a step should not stay red because the operator went
  // further than the instruction asked.
  if (t.disabled) return p === undefined || p.disabled === true;
  if (!p) return false;
  if (t.shorterThan !== undefined) return p.currentTokens < t.shorterThan;
  if (t.matches) return new RegExp(t.matches, "i").test(p.currentText);
  return false;
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
    version: VERSION,
    dir: promptsDir(),
    orphans: orphanedPromptFiles(),
    prompts,
    preview: { system, systemTokens: estimateTokens(system), toolTokens },
  };
}


// ── promote to source ───────────────────────────────────────────────────────
// An override in ~/.magentra/prompts is local to one machine. Promoting writes
// the text back into the .ts literal it came from, so the tuned prompt becomes
// the shipped default: it lands in `git diff` as an ordinary source change and
// reaches every machine.
//
// The literal is located by content rather than by recorded position, because a
// prompt's default and its call site are not always in the same statement. That
// costs one constraint: a default assembled from variables (`${PRODUCT_NAME}`)
// never appears verbatim in the source, so it cannot be found and is reported
// as not promotable rather than silently mangled.

/**
 * Every engine source file with its contents, cached against the newest mtime
 * in the tree.
 *
 * The cache has to be invalidated by the FILESYSTEM, not by this server's own
 * writes. Source changes underneath a running lab — a git checkout, an editor,
 * another session — and a stale copy makes every promote fail with "no verbatim
 * match", because the text being searched for is the one this process loaded at
 * startup rather than the one on disk.
 */
let sourceCache;
async function sourceFiles() {
  const paths = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "dist" || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".ts")) paths.push(full);
    }
  }
  await walk(join(REPO, "engine"));

  let newest = 0;
  for (const f of paths) {
    try {
      newest = Math.max(newest, (await stat(f)).mtimeMs);
    } catch {}
  }
  const sig = `${paths.length}:${newest}`;
  if (sourceCache?.sig === sig) return sourceCache.files;

  const files = [];
  for (const f of paths) files.push([f, await readFile(f, "utf8")]);
  sourceCache = { sig, files };
  promotableCache = undefined; // promotability is derived from these contents
  return files;
}

/**
 * A string as it would be written inside a TS literal of the given quote style.
 *
 * All three styles, not just backticks: a one-line default is usually written
 * `'…'`, and inside those a quote and a newline have to be escaped. Searching
 * only the template-literal form missed every single-quoted default that
 * contains an apostrophe — the text carries a real `'` and the source carries
 * `\'`, so the two never compared equal.
 */
function toSourceLiteral(text, quote) {
  const escaped = text.replace(/\\/g, "\\\\").split(quote).join(`\\${quote}`);
  return quote === "`"
    ? escaped.replace(/\$\{/g, "\\${")
    : // A raw line break cannot appear inside '' or "" — it is written as \n.
      escaped.replace(/\r?\n/g, "\\n");
}

/** The quote styles a default may be written in, template literal first. */
const QUOTES = ["`", "'", '"'];

/**
 * The same text as it appears in a file that uses `eol` for line breaks.
 *
 * Needed because a multi-line default and its source literal are never byte
 * equal on Windows. TypeScript normalizes CRLF to LF inside a template literal
 * when it parses one, so every multi-line default arrives here with LF while
 * the .ts file on disk is checked out with CRLF — 68 of this repo's 71 engine
 * sources are. A plain indexOf therefore missed 36 of 73 prompts and blamed
 * "assembled from variables", which was true of none of them. Searching in both
 * line-ending forms, and remembering which one matched, is what makes the
 * write-back safe too: splicing LF text into a CRLF file would rewrite the
 * whole file's endings on the next editor save and bury the prompt change in
 * the diff.
 */
const withEol = (text, eol) => (eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);

/**
 * Locates a prompt's default literal. Returns the file and the exact source
 * form to replace — already in that file's line endings — or a reason it cannot
 * be found.
 */
async function locateLiteral(defaultText) {
  // One candidate per quote style, and for template literals also per line
  // ending, since only those can carry a raw line break.
  const candidates = QUOTES.flatMap((quote) => {
    const form = toSourceLiteral(defaultText, quote);
    const eols = quote === "`" && form.includes("\n") ? ["\n", "\r\n"] : ["\n"];
    return eols.map((eol) => ({ quote, eol, needle: withEol(form, eol) }));
  });

  const hits = [];
  for (const [file, body] of await sourceFiles()) {
    for (const c of candidates) {
      let from = 0;
      for (;;) {
        const at = body.indexOf(c.needle, from);
        if (at === -1) break;
        from = at + 1;
        // The match must reach the END of the source literal, closed by its own
        // quote. A bare indexOf also matches a PREFIX of a longer literal —
        // which is exactly what happens when source has drifted ahead of this
        // process's in-memory default — and replacing a prefix would leave the
        // tail of the old text dangling after the new.
        if (body[at + c.needle.length] !== c.quote) continue;
        hits.push({ file, at, needle: c.needle, eol: c.eol, quote: c.quote });
      }
    }
  }
  if (hits.length === 0) {
    return {
      ok: false,
      reason:
        "no verbatim match in engine sources. Either this default is assembled from variables (use {{slots}} and descriptionVars " +
        "instead, so the literal is findable), or the source changed since this lab process started — restart it with " +
        "`npm run prompt-lab` and try again.",
    };
  }
  if (hits.length > 1) {
    return { ok: false, reason: `${hits.length} identical literals in source — too ambiguous to edit safely` };
  }
  return { ok: true, file: hits[0].file, needle: hits[0].needle, eol: hits[0].eol, quote: hits[0].quote };
}

/** ids whose default was located, computed once so the UI can enable the button. */
let promotableCache;
async function promotable() {
  await sourceFiles(); // refreshes the cache and clears this one if source moved
  if (promotableCache) return promotableCache;
  promotableCache = {};
  for (const p of promptCatalog()) {
    const found = await locateLiteral(p.defaultText);
    promotableCache[p.id] = found.ok
      ? { ok: true, file: relative(REPO, found.file) }
      : { ok: false, reason: found.reason };
  }
  return promotableCache;
}

/**
 * Writes `text` into the prompt's source literal, then typechecks. A build
 * failure restores the file — a prompt edit must never be able to leave the
 * repository uncompilable.
 */
async function promote(id, text) {
  const entry = promptCatalog().find((p) => p.id === id);
  if (!entry) return { ok: false, reason: `unknown prompt id: ${id}` };
  if (text.trim() === "") return { ok: false, reason: "refusing to promote empty text" };

  const found = await locateLiteral(entry.defaultText);
  if (!found.ok) return found;

  // Override files carry a trailing newline; a source literal must not, or the
  // section gains a blank line every time the prompt is assembled.
  // `\r\n?` and not `\r\n`: a lone CR survived the old normalization, and a lone
  // CR is a line terminator to the TS parser — inside a single-quoted default it
  // would break the literal it was just written into.
  const clean = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const before = await readFile(found.file, "utf8");
  if (!before.includes(found.needle)) {
    return { ok: false, reason: "the file changed on disk while this promote was being prepared — reload the lab and try again" };
  }
  // Written back in the line endings the literal was found in, so the diff is
  // the prompt and nothing else.
  // A function replacement, never a string one: String.replace expands `$&`,
  // "$'" and `` $` `` inside a string replacement, and prompt text is prose that
  // can contain any of them. toSourceLiteral escapes `${` but not those.
  const replacement = withEol(toSourceLiteral(clean, found.quote), found.eol);
  const after = before.replace(found.needle, () => replacement);
  await writeFile(found.file, after, "utf8");

  try {
    await tscBuild(180_000);
  } catch (err) {
    await writeFile(found.file, before, "utf8");
    // A compiler that never started leaves both streams empty; without the
    // message fallback the operator saw a bare "typecheck failed" and no cause.
    const out = `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim() || err?.message || String(err);
    return { ok: false, reverted: true, reason: `typecheck failed, file restored\n${out.slice(0, 600)}` };
  }

  // The literal is now the shipped default, so the local override is redundant.
  setPromptDefault(id, clean);
  clearPromptOverride(id);
  promotableCache = undefined;
  sourceCache = undefined;
  return { ok: true, file: relative(REPO, found.file) };
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
      const [raw, source] = await Promise.all([loadFindings(), promotable()]);
      const data = catalog();
      return json(res, 200, { ...data, review: markAddressed(raw, data.prompts), source });
    }

    if (path.startsWith("/api/promote/") && req.method === "POST") {
      const id = decodeURIComponent(path.slice("/api/promote/".length));
      const result = await promote(id, await readBody(req));
      return json(res, result.ok ? 200 : 409, result);
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

    if (path.startsWith("/api/note/")) {
      const id = decodeURIComponent(path.slice("/api/note/".length));
      if (req.method === "PUT" || req.method === "DELETE") {
        const result = await setNoteAddressed(id, req.method === "PUT");
        return json(res, result.ok ? 200 : 404, result);
      }
    }

    if (path.startsWith("/api/step/")) {
      const n = Number(path.slice("/api/step/".length));
      if (!Number.isInteger(n)) return json(res, 400, { ok: false, reason: "step must be a number" });
      if (req.method === "PUT" || req.method === "DELETE") {
        const result = await setStepDone(n, req.method === "PUT");
        return json(res, result.ok ? 200 : 404, result);
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
    `\n  Prompt Lab — ${n} prompts · MAGENTRA ${VERSION}\n` +
      `  http://${HOST}:${PORT}\n` +
      `  overrides → ${promptsDir()}\n\n`,
  );
});
