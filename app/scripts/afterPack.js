"use strict";
// electron-builder afterPack hook.
//
// Linux: wrap the real binary in a shell launcher that (1) routes interactive
// terminal launches to the terminal UI, and (2) decides up-front whether
// Chromium can sandbox itself on the machine that RUNS the artifact.
// Chromium makes the sandbox decision before any app code executes (verified:
// main.js never runs when it FATALs), so neither main.js nor a relaunch can
// save a packaged build — only something in front of the process can. In dev
// that something is scripts/launch.js; in a packaged AppImage/tar.gz it is
// this wrapper, and both apply the same rule:
//
//   sandbox is usable  ⇔  unprivileged user namespaces are available
//                         OR the setuid-root helper beside the binary is usable
//
// AppImage mounts are nosuid and tar.gz cannot carry setuid bits, so on
// distros that restrict user namespaces (Ubuntu 23.10+ by default) the app
// would otherwise die at boot with a Chromium FATAL and a double-click user
// would see nothing at all.
//
// macOS: write the terminal launcher into Contents/Resources/bin/magentra.
// Users put it on PATH with one documented symlink; writing it here (not via
// extraResources) is what gives it its exec bit, since this repo is routinely
// checked out on Windows where git cannot record one.

const path = require("node:path");
const fs = require("node:fs");

// The launcher replaces the binary under its original name so both entry
// paths run it: AppImage's AppRun execs <executableName>, and a tar.gz user
// runs ./magentra by hand. The deb's /usr/bin/magentra symlink resolves here
// too (readlink -f).
//
// Terminal dispatch: an interactive stdin+stdout and no --gui means a human
// typed `magentra` in a shell — run the terminal UI through Electron's own
// Node (ELECTRON_RUN_AS_NODE starts no Chromium, so the sandbox question
// below never arises for that branch). Desktop entries and double-clicks have
// no TTY and fall through to the GUI exactly as before. The TUI's own no-TTY
// fallback re-enters this wrapper, not magentra-bin, so the --no-sandbox
// rescue keeps working on restricted distros.
const WRAPPER = `#!/bin/sh
# MAGENTRA launcher: terminal → terminal UI; desktop → GUI, with --no-sandbox
# only when Chromium genuinely has no sandbox path on this system
# (see scripts/afterPack.js in the source repo).
DIR="$(dirname "$(readlink -f "$0")")"
BIN="$DIR/magentra-bin"
TUI="$DIR/resources/engine/tui.mjs"

GUI=0
for a in "$@"; do [ "$a" = "--gui" ] && GUI=1; done

if [ "$GUI" = "0" ] && [ -t 0 ] && [ -t 1 ] && [ -f "$TUI" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$BIN" "$TUI" "$@"
fi

case " $* " in *" --no-sandbox "*) exec "$BIN" "$@" ;; esac

sandbox_usable() {
  # root cannot use the setuid sandbox at all.
  [ "$(id -u)" = "0" ] && return 1
  # Unprivileged user namespaces available: Chromium's namespace sandbox works.
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != "1" ] &&
     [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" != "0" ]; then
    return 0
  fi
  # Last resort: a correctly configured setuid-root helper beside the binary.
  if [ -u "$DIR/chrome-sandbox" ] && [ "$(stat -c %u "$DIR/chrome-sandbox" 2>/dev/null)" = "0" ]; then
    return 0
  fi
  return 1
}

if sandbox_usable; then
  exec "$BIN" "$@"
fi

echo "MAGENTRA: Chromium sandbox unavailable on this system — launching with --no-sandbox." >&2
exec "$BIN" "$@" --no-sandbox
`;

// macOS terminal launcher. Lives INSIDE the .app so it travels with it; must
// survive being invoked through the documented /usr/local/bin symlink, and
// stock macOS readlink has no -f — hence the manual resolution loop.
const MAC_LAUNCHER = `#!/bin/sh
# MAGENTRA terminal launcher (macOS). Put it on PATH with:
#   sudo ln -s "/Applications/MAGENTRA.app/Contents/Resources/bin/magentra" /usr/local/bin/magentra
SELF="$0"
while [ -L "$SELF" ]; do
  T="$(readlink "$SELF")"
  case "$T" in /*) SELF="$T" ;; *) SELF="$(dirname "$SELF")/$T" ;; esac
done
RES="$(cd "$(dirname "$SELF")/.." && pwd)"
BIN="$RES/../MacOS/MAGENTRA"
TUI="$RES/engine/tui.mjs"

GUI=0
for a in "$@"; do [ "$a" = "--gui" ] && GUI=1; done

if [ "$GUI" = "0" ] && [ -t 0 ] && [ -t 1 ] && [ -f "$TUI" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$BIN" "$TUI" "$@"
fi
exec "$BIN" "$@"
`;

/**
 * magentra-cli.exe: a byte-copy of MAGENTRA.exe with the PE subsystem flipped
 * GUI → CONSOLE. The terminal command needs it because a GUI-subsystem binary
 * never attaches to the launching console, so under ELECTRON_RUN_AS_NODE
 * libuv finds no TTY (verified in a real conhost: isTTY stays false even with
 * explicit CON handle redirection) and ink cannot enter raw mode. The console
 * copy attaches like any CLI and inherits real console handles.
 *
 * The copy is only ever run AS NODE (the shim sets ELECTRON_RUN_AS_NODE), so
 * Chromium, the sandbox, and asar integrity never come into play; the GUI
 * keeps launching through the untouched MAGENTRA.exe. The duplicate costs
 * little in the download — the NSIS payload is a solid 7z, which all but
 * dedupes a second copy of the same bytes.
 */
function writeConsoleSubsystemCopy(srcExe, destExe) {
  const b = fs.readFileSync(srcExe);
  const lfanew = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(lfanew) !== 0x00004550) throw new Error(`${srcExe}: PE signature not found`);
  // IMAGE_OPTIONAL_HEADER starts 24 bytes after the PE signature; Subsystem
  // is a WORD at offset 68 in both PE32 and PE32+.
  const subsystemOffset = lfanew + 24 + 68;
  const subsystem = b.readUInt16LE(subsystemOffset);
  if (subsystem !== 2 && subsystem !== 3) {
    throw new Error(`${srcExe}: unexpected PE subsystem ${subsystem} — refusing to patch`);
  }
  b.writeUInt16LE(3, subsystemOffset); // IMAGE_SUBSYSTEM_WINDOWS_CUI
  fs.writeFileSync(destExe, b);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === "win32") {
    const src = path.join(context.appOutDir, "MAGENTRA.exe");
    const dest = path.join(context.appOutDir, "magentra-cli.exe");
    writeConsoleSubsystemCopy(src, dest);
    console.log("afterPack: wrote magentra-cli.exe (console-subsystem copy for the terminal command)");
    return;
  }

  if (context.electronPlatformName === "darwin") {
    const appName = context.packager.appInfo.productFilename; // "MAGENTRA"
    const binDir = path.join(context.appOutDir, `${appName}.app`, "Contents", "Resources", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "magentra"), MAC_LAUNCHER, { mode: 0o755 });
    console.log("afterPack: wrote the mac terminal launcher");
    return;
  }

  if (context.electronPlatformName !== "linux") return;

  const exe = path.join(context.appOutDir, "magentra");
  const real = path.join(context.appOutDir, "magentra-bin");
  fs.renameSync(exe, real);
  fs.writeFileSync(exe, WRAPPER, { mode: 0o755 });
  console.log("afterPack: wrapped linux binary with the sandbox + terminal launcher");
};
