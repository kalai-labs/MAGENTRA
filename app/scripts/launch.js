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

/**
 * True when Chromium has a usable sandbox: unprivileged user namespaces
 * (Chromium's preferred path — the setuid helper is ignored when they work),
 * or a correctly configured setuid-root helper as the fallback. The same rule,
 * in shell, guards packaged Linux artifacts — see scripts/afterPack.js.
 */
function sandboxUsable() {
  if (process.platform !== "linux") return true;
  // root cannot use the setuid sandbox at all.
  if (typeof process.getuid === "function" && process.getuid() === 0) return false;

  const readKnob = (name) => {
    try {
      return fs.readFileSync(`/proc/sys/kernel/${name}`, "utf8").trim();
    } catch {
      return undefined; // knob absent — that restriction does not exist here
    }
  };
  if (
    readKnob("apparmor_restrict_unprivileged_userns") !== "1" &&
    readKnob("unprivileged_userns_clone") !== "0"
  ) {
    return true; // namespace sandbox works — helper state is irrelevant
  }

  try {
    const st = fs.statSync(path.join(REPO_ROOT, "node_modules", "electron", "dist", "chrome-sandbox"));
    return st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {
    return false; // namespaces restricted and no helper — no sandbox path left
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
