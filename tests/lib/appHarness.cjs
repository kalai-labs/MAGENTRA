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
 * PROTOCOL — NDJSON, the same shape the engine harness uses:
 *   in   { "id": 1, "cmd": "eval", "js": "…" }   run in the renderer
 *        { "cmd": "quit" }
 *   out  { "type": "harness", "event": "ready" }
 *        { "type": "harness", "event": "result", "id": 1, "ok": true, "value": … }
 *
 * `eval` runs through `webContents.executeJavaScript`, so the JS it is handed
 * reaches the product's own `window.magentra` preload bridge, its own
 * `ipcRenderer.invoke`, and its own ipcMain handler. Nothing is stubbed on the
 * way.
 */

const path = require("node:path");
const { app, BrowserWindow } = require("electron");

function report(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

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

app.whenReady().then(async () => {
  let win;
  try {
    win = await readyWindow(60_000);
  } catch (err) {
    report({ type: "harness", event: "failed", error: String(err) });
    app.exit(1);
    return;
  }
  report({ type: "harness", event: "ready" });

  let pending = "";
  process.stdin.setEncoding("utf8");
  // Electron's main process leaves stdin paused; without this the commands sit
  // in the pipe and the test times out waiting for a reply it never gets.
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
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
      if (command.cmd === "quit") {
        app.exit(0);
        return;
      }
      // `true` is userGesture — some renderer paths refuse without one.
      win.webContents
        .executeJavaScript(command.js, true)
        .then((value) => report({ type: "harness", event: "result", id: command.id, ok: true, value: value === undefined ? null : value }))
        .catch((err) => report({ type: "harness", event: "result", id: command.id, ok: false, error: err && err.message ? err.message : String(err) }));
    }
  });
});
