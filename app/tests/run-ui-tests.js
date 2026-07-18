"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const electron = require("electron");
const env = { ...process.env };
// Some development shells export this for the bundled engine. Leaving it set
// turns Electron itself into plain Node and silently skips the browser.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electron,
  [path.join(__dirname, "ui.e2e.js"), "--no-sandbox", "--headless", "--disable-gpu"],
  { env, stdio: "inherit", shell: false },
);

child.on("error", (error) => {
  process.stderr.write(`Could not start Electron UI tests: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.stderr.write(`Electron UI tests stopped by ${signal}\n`);
  process.exitCode = typeof code === "number" ? code : 1;
});
