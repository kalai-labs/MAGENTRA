"use strict";

/**
 * The desktop app's real main process, with a way in — the program a `UiTest`
 * launches under Electron.
 *
 * WHY A HOST SCRIPT AND NOT A TEST-ONLY IPC CHANNEL. The suite deleted on
 * 2026-09-09 drove the app through a `wireTestIpc()` that lived in shipped code
 * and answered every main-process call from a fake `apiResult()` — which is why
 * its "coverage" of `applyValidatedConnection` was a hard-coded
 * `{ ok: true, live: true }` and the function was never once run. This harness
 * adds nothing to the product: it `require`s `app/main.js` unchanged, so every
 * ipcMain handler, every window and every engine spawn is the real one, and it
 * only drives the renderer that already exists and reads what comes back.
 *
 * CJS, and not TypeScript, because Electron's main process cannot strip types.
 *
 * WHY A SOCKET AND NOT STDIN — THE ONE FACT THAT DECIDES THIS FILE'S SHAPE.
 * Electron's MAIN process does not have a usable `process.stdin` on Windows.
 * `electron.exe` is linked as a GUI-subsystem binary, and the browser process
 * hands Node a placeholder `Readable` that emits `end` immediately instead of
 * the pipe the parent opened — so every command written to the child's stdin is
 * accepted by the parent, delivered to nothing, and answered never. Measured,
 * not assumed: a probe that spawns Electron with `stdio: ["pipe", …]` prints
 * `{"stdinType":"Readable","isTTY":false}` and then `end`, before the parent has
 * written a byte. stdOUT is real on the same process, which is why the old
 * arrangement looked like it worked — the app announced itself and then ignored
 * every instruction. On macOS and Linux stdin IS the pipe, so the identical
 * suite passed there and hung on Windows, 30 seconds per `evaluate`.
 *
 * A loopback socket behaves the same on all three platforms, so the channel is
 * one mechanism rather than one per OS: `UiTest` listens on 127.0.0.1 on a port
 * the OS picks, passes it in `MAGENTRA_HARNESS_PORT`, and this file connects
 * back. Nothing is bound to a public interface and nothing outlives the test.
 *
 * PROTOCOL — NDJSON over that socket, the same shape the engine harness uses:
 *   in   { "id": 1, "cmd": "eval", "js": "…" }   run in the renderer
 *        { "id": 2, "cmd": "main", "js": "…" }   run in the main process
 *        { "cmd": "quit" }
 *   out  { "type": "harness", "event": "ready" }
 *        { "type": "harness", "event": "result", "id": 1, "ok": true, "value": … }
 *
 * `eval` runs through `webContents.executeJavaScript`, so the JS it is handed
 * reaches the product's own `window.magentra` preload bridge, its own
 * `ipcRenderer.invoke`, and its own ipcMain handler. Nothing is stubbed on the
 * way.
 */

const net = require("node:net");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const PORT = Number(process.env["MAGENTRA_HARNESS_PORT"]);
if (!Number.isInteger(PORT) || PORT <= 0) {
  process.stderr.write("appHarness: MAGENTRA_HARNESS_PORT is not set to a port — UiTest.launchApp sets it, and there is no other way in\n");
  process.exit(2);
}

/** The command channel. Opened before anything else, so even a failed boot can say so. */
const channel = net.connect(PORT, "127.0.0.1");
channel.setEncoding("utf8");

/** Messages produced before the socket finished connecting. Flushed on connect, in order. */
let outbox = [];
let connected = false;

function report(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (connected) channel.write(line);
  else outbox.push(line);
}

channel.on("connect", () => {
  connected = true;
  const queued = outbox;
  outbox = [];
  for (const line of queued) channel.write(line);
});

// A dead channel is not a reason to take the app down — the test owns that, and
// killing the app here would replace a readable timeout with a bare exit code.
channel.on("error", (err) => {
  process.stderr.write(`appHarness: command channel failed — ${String(err)}\n`);
});

// The real app. This registers the ipcMain handlers and creates the window.
require(path.join(__dirname, "..", "..", "app", "main.js"));

/** The app's window, once it exists and has painted. Polled, because main.js creates it in its own whenReady. */
async function readyWindow(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [win] = BrowserWindow.getAllWindows();
    if (win && !win.isDestroyed()) {
      if (!win.webContents.isLoading()) return win;
      await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      return win;
    }
    if (Date.now() > deadline) throw new Error("no BrowserWindow appeared");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The window, once `ready` has been reported. Commands that arrive before it are held, not dropped. */
let window;
let held = [];

function handle(command) {
  if (command.cmd === "quit") {
    app.exit(0);
    return;
  }
  // Run JS in the MAIN process, with the window and Electron's own modules
  // in scope. Some of what the app promises is only observable here — a
  // key event delivered to the window's webContents, whether the window is
  // full screen — and none of it is reachable from the renderer. Test
  // scaffolding, in a test file: the product is not asked to expose it.
  if (command.cmd === "main") {
    Promise.resolve()
      .then(() => new Function("win", "electron", "require", `return (async () => { ${command.js} })();`)(window, require("electron"), require))
      .then((value) => report({ type: "harness", event: "result", id: command.id, ok: true, value: value === undefined ? null : value }))
      .catch((err) => report({ type: "harness", event: "result", id: command.id, ok: false, error: err && err.message ? err.message : String(err) }));
    return;
  }
  // `true` is userGesture — some renderer paths refuse without one.
  window.webContents
    .executeJavaScript(command.js, true)
    .then((value) => report({ type: "harness", event: "result", id: command.id, ok: true, value: value === undefined ? null : value }))
    .catch((err) => report({ type: "harness", event: "result", id: command.id, ok: false, error: err && err.message ? err.message : String(err) }));
}

let pending = "";
channel.on("data", (chunk) => {
  pending += chunk;
  let nl = pending.indexOf("\n");
  while (nl !== -1) {
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    nl = pending.indexOf("\n");
    if (line.trim() === "") continue;

    let command;
    try {
      command = JSON.parse(line);
    } catch (err) {
      report({ type: "harness", event: "result", id: null, ok: false, error: `unreadable command: ${String(err)}` });
      continue;
    }
    // `continue`, never `return`: a `return` here would abandon every line the
    // same chunk carried after this one, which is a dropped command the test
    // can only see as a 30-second silence.
    if (window === undefined) {
      held.push(command);
      continue;
    }
    handle(command);
  }
});

app.whenReady().then(async () => {
  let win;
  try {
    win = await readyWindow(60_000);
  } catch (err) {
    report({ type: "harness", event: "failed", error: String(err) });
    app.exit(1);
    return;
  }
  window = win;
  report({ type: "harness", event: "ready" });

  const queued = held;
  held = [];
  for (const command of queued) handle(command);
});
