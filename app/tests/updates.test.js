"use strict";
/**
 * The update mechanism's decisions, which are the parts that cost a user
 * something when they are wrong:
 *
 *   - the tier. Windows portable once got the NSIS installer because the test
 *     was `process.platform === "win32"`, which silently installs a second copy
 *     into Program Files while the user keeps launching the portable exe.
 *   - the asset name. It mirrors build.*.artifactName in package.json, and a
 *     mismatch sends the user to a 404 instead of a download.
 *   - the version comparison. Truncating a 4-part version made two releases
 *     report the same number, which is how self-update stayed dead for a year.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// app/main/updates.js requires electron for `app` and `shell`. Under plain node
// `require("electron")` resolves to the binary's path string, so stand in a
// module with just the two surfaces this test drives.
const openedUrls = [];
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { isPackaged: true, getVersion: () => "0.13.0" },
    shell: {
      openExternal: async (url) => {
        openedUrls.push(url);
      },
    },
  },
};

const updates = require("../main/updates.js");

/** Run `body` with process.platform and process.env.* set to a given install. */
function asInstall({ platform, env = {}, packaged = true }, body) {
  const realPlatform = process.platform;
  const saved = {};
  for (const key of ["PORTABLE_EXECUTABLE_DIR", "APPIMAGE"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const electron = require("electron");
  const realPackaged = electron.app.isPackaged;

  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  electron.app.isPackaged = packaged;
  Object.assign(process.env, env);

  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    electron.app.isPackaged = realPackaged;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// The tier
// ---------------------------------------------------------------------------

assert.equal(
  asInstall({ platform: "win32", packaged: false }, () => updates.installTier()),
  "none",
  "a development run has no update affordance at all",
);

assert.equal(
  asInstall({ platform: "win32" }, () => updates.installTier()),
  "self",
  "an installed Windows build (NSIS) replaces itself",
);

assert.equal(
  asInstall(
    { platform: "win32", env: { PORTABLE_EXECUTABLE_DIR: "D:\\stick" } },
    () => updates.installTier(),
  ),
  "assisted",
  "a Windows PORTABLE build must never be handed the NSIS installer",
);

assert.equal(
  asInstall({ platform: "darwin" }, () => updates.installTier()),
  "assisted",
  "macOS ships unsigned, so Squirrel.Mac can never validate a replacement",
);

assert.equal(
  asInstall({ platform: "linux" }, () => updates.installTier()),
  "assisted",
  "a deb or tar.gz install has no AppImage to rewrite",
);

// A real file, really chmod'd: writability is the whole question for an AppImage,
// and asserting it against a stub would prove nothing about the real check.
const appImage = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "magentra-appimage-")),
  "MAGENTRA.AppImage",
);
fs.writeFileSync(appImage, "not really an appimage");

assert.equal(
  asInstall({ platform: "linux", env: { APPIMAGE: appImage } }, () => updates.installTier()),
  "self",
  "a writable AppImage rewrites itself in place",
);

fs.chmodSync(appImage, 0o444);
const readOnlyTier = asInstall({ platform: "linux", env: { APPIMAGE: appImage } }, () =>
  updates.installTier(),
);
fs.chmodSync(appImage, 0o644);
fs.rmSync(path.dirname(appImage), { recursive: true, force: true });

// Skipped when the test runs as root, which can write a read-only file anyway.
if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  assert.equal(
    readOnlyTier,
    "assisted",
    "an AppImage under /opt cannot rewrite itself, so it falls to the assisted tier",
  );
}

// ---------------------------------------------------------------------------
// The asset name — these must match build.*.artifactName in app/package.json
// ---------------------------------------------------------------------------

const pkg = require("../package.json");
const artifactNames = [
  pkg.build.portable.artifactName,
  pkg.build.nsis.artifactName,
  pkg.build.linux.artifactName,
  pkg.build.mac.artifactName,
];
for (const name of artifactNames) {
  assert.match(
    name,
    /\$\{version\}/,
    `artifactName ${name} must carry \${version}: the asset URL is built from it`,
  );
}

assert.equal(
  asInstall(
    { platform: "win32", env: { PORTABLE_EXECUTABLE_DIR: "D:\\stick" } },
    () => updates.assetName("0.14.0"),
  ),
  "MAGENTRA-0.14.0-win-portable.exe",
);

assert.equal(
  asInstall({ platform: "win32" }, () => updates.assetName("0.14.0")),
  "MAGENTRA-0.14.0-win-setup.exe",
);

// electron-builder renames ${arch} per target: the same x64 build is x86_64 in an
// AppImage, amd64 in a deb and x64 in a tarball (builder-util getArtifactArchName).
// Deriving the name from process.arch gave "linux-x64.deb", which is a 404. These
// are the names `npm run dist:linux` actually wrote.
const realLinuxNames = {
  AppImage: "MAGENTRA-0.14.0-linux-x86_64.AppImage",
  deb: "MAGENTRA-0.14.0-linux-amd64.deb",
  "tar.gz": "MAGENTRA-0.14.0-linux-x64.tar.gz",
};

if (process.arch === "x64") {
  assert.equal(
    asInstall({ platform: "linux", env: { APPIMAGE: "/home/u/MAGENTRA.AppImage" } }, () =>
      updates.assetName("0.14.0"),
    ),
    realLinuxNames.AppImage,
    "a read-only AppImage is offered the AppImage, not a deb",
  );

  // The deb is the only Linux format whose executable sits under /opt.
  const realExecPath = process.execPath;
  Object.defineProperty(process, "execPath", { value: "/opt/MAGENTRA/magentra", configurable: true });
  const debName = asInstall({ platform: "linux" }, () => updates.assetName("0.14.0"));
  Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
  assert.equal(debName, realLinuxNames.deb);

  assert.equal(
    asInstall({ platform: "linux" }, () => updates.assetName("0.14.0")),
    realLinuxNames["tar.gz"],
  );
}

// Only an arm64 dmg and an x64 Linux build are published. Where no artifact
// exists, say so rather than inventing a name that 404s.
const dmgName = asInstall({ platform: "darwin" }, () => updates.assetName("0.14.0"));
if (process.arch === "arm64") {
  assert.equal(dmgName, "MAGENTRA-0.14.0-mac-arm64.dmg");
} else {
  assert.equal(dmgName, null, "an Intel Mac has no published dmg, so there is no asset");
}

// ---------------------------------------------------------------------------
// The check, and what one click does
// ---------------------------------------------------------------------------

const seen = [];
const realFetch = global.fetch;

/** @param {unknown} body The JSON the GitHub latest-release path answers with. */
function answerWith(body) {
  global.fetch = async () => ({ ok: true, json: async () => body });
}

/** Windows portable: assisted, and its asset name carries no architecture, so
 *  these assertions hold on every machine the suite runs on. */
const PORTABLE = { platform: "win32", env: { PORTABLE_EXECUTABLE_DIR: "D:\\stick" } };

async function main() {
  await new Promise((resolve) => {
    asInstall(PORTABLE, () => {
      answerWith({ tag_name: "v0.13.0" });
      updates.initUpdates({
        broadcast: (state) => seen.push({ ...state }),
        log: () => {},
        enabled: true,
      });
      resolve();
    });
  });

  assert.equal(updates.updateState().tier, "assisted");
  assert.equal(updates.updateState().current, "0.13.0");
  assert.equal(updates.updateState().status, "uptodate", "resting state before any check");

  answerWith({ tag_name: "v0.13.0" });
  await updates.checkNow();
  assert.equal(updates.updateState().status, "uptodate", "the same version is not an update");

  answerWith({ tag_name: "v0.14.0" });
  await updates.checkNow();
  assert.equal(updates.updateState().status, "available");
  assert.equal(updates.updateState().version, "0.14.0");

  // A legacy 4-part tag is still newer than this 3-part build, and the lengths
  // differing must not make the comparison give up.
  answerWith({ tag_name: "v0.13.0.1" });
  await updates.checkNow();
  assert.equal(updates.updateState().status, "available");
  assert.equal(updates.updateState().version, "0.13.0.1");

  // One click on the assisted tier opens this install's own asset.
  answerWith({ tag_name: "v0.14.0" });
  await updates.checkNow();
  await asInstall(PORTABLE, () => updates.startUpdate());
  assert.equal(openedUrls.length, 1);
  assert.equal(
    openedUrls[0],
    "https://github.com/kalai-labs/MAGENTRA/releases/download/v0.14.0/MAGENTRA-0.14.0-win-portable.exe",
    "the browser opens on the exact asset, never the 8-asset release page",
  );

  // Where no artifact exists for the platform, land on the release page instead
  // of a name that would 404.
  openedUrls.length = 0;
  await asInstall({ platform: "darwin" }, () =>
    process.arch === "arm64" ? null : updates.startUpdate(),
  );
  if (process.arch !== "arm64") {
    assert.equal(
      openedUrls[0],
      "https://github.com/kalai-labs/MAGENTRA/releases/tag/v0.14.0",
      "an Intel Mac gets the release page, never an invented dmg name",
    );
  }

  // Offline, and a release whose packaging job failed, must both rest at
  // "up to date": the user has nothing to act on either way.
  global.fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND github.com");
  };
  await updates.checkNow();
  assert.equal(updates.updateState().status, "uptodate", "offline rests, it does not alarm");

  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  await updates.checkNow();
  assert.equal(updates.updateState().status, "uptodate");

  // A disabled check renders nothing, whatever the tier.
  await new Promise((resolve) => {
    asInstall({ platform: "win32" }, () => {
      updates.initUpdates({ broadcast: () => {}, log: () => {}, enabled: false });
      resolve();
    });
  });
  assert.equal(updates.updateState().status, "disabled");

  global.fetch = realFetch;
  assert.equal(seen.length > 0, true, "every state change reaches the renderer");

  process.stdout.write(
    "✓ update tiers, per-format asset names, version comparison, and offline resting\n",
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
