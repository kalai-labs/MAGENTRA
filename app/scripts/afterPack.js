"use strict";
// electron-builder afterPack hook.
//
// Linux only: wrap the real binary in a shell launcher that decides up-front
// whether Chromium can sandbox itself on the machine that RUNS the artifact.
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

const path = require("node:path");
const fs = require("node:fs");

// The launcher replaces the binary under its original name so both entry
// paths run it: AppImage's AppRun execs <executableName>, and a tar.gz user
// runs ./magentra by hand.
const WRAPPER = `#!/bin/sh
# MAGENTRA launcher: pass --no-sandbox only when Chromium genuinely has no
# sandbox path on this system (see scripts/afterPack.js in the source repo).
DIR="$(dirname "$(readlink -f "$0")")"
BIN="$DIR/magentra-bin"

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

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;

  const exe = path.join(context.appOutDir, "magentra");
  const real = path.join(context.appOutDir, "magentra-bin");
  fs.renameSync(exe, real);
  fs.writeFileSync(exe, WRAPPER, { mode: 0o755 });
  console.log("afterPack: wrapped linux binary with the sandbox launcher");
};
