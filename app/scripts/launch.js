#!/usr/bin/env node
// Launches the desktop app, deciding up-front whether Chromium can sandbox
// itself on this machine.
//
// Why this exists instead of a switch inside main.js: Chromium forks its zygote
// BEFORE the main script runs, so `app.commandLine.appendSwitch("no-sandbox")`
// is already too late for the sandbox decision — the flag has to be in the
// process arguments. On an npm-installed Electron the `chrome-sandbox` helper
// cannot be setuid (npm has no way to set it), Chromium finds it, refuses to
// run less securely than its presence implies, and dies with a FATAL at boot.
//
// So: check first, pass --no-sandbox only when there is genuinely no sandbox
// path available, and say so. The renderer stays locked down either way
// (contextIsolation, no Node integration, strict CSP, navigation denied).
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const APP_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(APP_DIR, "..");

/** True when Chromium has a usable sandbox: a setuid-root helper, or unprivileged user namespaces. */
function sandboxUsable() {
  if (process.platform !== "linux") return true;
  // root cannot use the setuid sandbox at all.
  if (typeof process.getuid === "function" && process.getuid() === 0) return false;

  const helper = path.join(REPO_ROOT, "node_modules", "electron", "dist", "chrome-sandbox");
  try {
    const st = fs.statSync(helper);
    // Present: this is the sandbox Chromium will insist on using, so it must be
    // configured correctly — otherwise there is no sandbox at all.
    return st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {
    /* helper absent — the namespace sandbox is the only path left */
  }
  try {
    return fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() !== "1";
  } catch {
    return true; // knob absent — user namespaces are unrestricted
  }
}

const args = [APP_DIR, ...process.argv.slice(2)];

if (!sandboxUsable()) {
  const helper = path.join(REPO_ROOT, "node_modules", "electron", "dist", "chrome-sandbox");
  console.warn(
    "Chromium sandbox unavailable on this system — launching with --no-sandbox.\n" +
      "To enable it:\n" +
      `  sudo chown root:root ${helper}\n` +
      `  sudo chmod 4755 ${helper}`,
  );
  args.push("--no-sandbox");
}

const electron = require("electron"); // resolves to the electron binary path
const child = spawn(electron, args, { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 0));
