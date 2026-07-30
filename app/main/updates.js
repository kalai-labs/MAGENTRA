"use strict";
/**
 * Update checking and installing.
 *
 * An install belongs to one of two tiers for its whole life, decided by the
 * format it was installed from — see docs/adr/0009-updates-have-two-tiers.md.
 *
 *   self      Windows NSIS, and an AppImage whose own file is writable.
 *             electron-updater downloads the new build and installs it on quit.
 *   assisted  Windows portable, macOS, deb, tar.gz. These cannot replace
 *             themselves, so one click opens the browser on the exact asset for
 *             this install's format.
 *
 * The tiers are peers. `assisted` is where roughly a third of installs live
 * permanently, so it is not an error path.
 *
 * Nothing is downloaded before the user asks. `autoDownload` is off, and the
 * check only ever reports what exists.
 */

const fs = require("node:fs");

const { app, shell } = require("electron");

const REPO = "kalai-labs/MAGENTRA";
const RELEASES_URL = `https://github.com/${REPO}/releases`;

/**
 * GitHub serves JSON for this non-API path when asked, and it redirects to the
 * newest release that is neither a draft nor a prerelease. Both properties
 * matter: `api.github.com` allows 60 unauthenticated requests per hour per IP,
 * which one office behind one NAT would exhaust, and skipping prereleases is
 * what makes retraction work — flipping a bad release to prerelease takes it out
 * of this answer for every client at once.
 */
const LATEST_URL = `${RELEASES_URL}/latest`;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;

/**
 * @typedef {"disabled" | "uptodate" | "available" | "downloading" | "ready"} Status
 *
 * `disabled` hides the affordance: a development run, or a user who turned the
 * check off. There is no error status on purpose — a failed check means we did
 * not see an update, and "up to date" is what the user can act on. It is the
 * honest answer offline, too.
 */

/** @type {{ status: Status, tier: "none" | "self" | "assisted", current: string, version: string | null, percent: number, notesUrl: string }} */
let state = {
  status: "disabled",
  tier: "none",
  current: "",
  version: null,
  percent: 0,
  notesUrl: RELEASES_URL,
};

/** @type {(state: typeof state) => void} */
let publish = () => {};
/** @type {(event: string, data?: object) => void} */
let record = () => {};
/** @type {import("electron-updater").AppUpdater | null} */
let updater = null;
/** @type {NodeJS.Timeout | null} */
let timer = null;

/**
 * The packaging format this install came from. Both the tier and the asset name
 * follow from it, so the question is asked in exactly one place.
 *
 * Windows must be tested for the portable launcher, not just for the platform.
 * A portable build has no installer to re-run: handing it the NSIS setup would
 * install a second copy into Program Files while the user keeps launching the
 * portable executable, and the two would then diverge silently.
 *
 * @returns {"dmg" | "portable" | "nsis" | "AppImage" | "deb" | "tar.gz"}
 */
function installFormat() {
  if (process.platform === "darwin") return "dmg";
  if (process.platform === "win32") {
    return process.env.PORTABLE_EXECUTABLE_DIR ? "portable" : "nsis";
  }
  if (process.env.APPIMAGE) return "AppImage";
  // Only the deb puts the executable under /opt; a tarball is unpacked anywhere.
  return process.execPath.startsWith("/opt/") ? "deb" : "tar.gz";
}

/**
 * Which tier this install belongs to.
 *
 * An AppImage can only rewrite itself while its own file is writable. One placed
 * under /opt is not, so it drops to the assisted tier rather than failing.
 */
function installTier() {
  if (!app.isPackaged) return "none";

  const format = installFormat();
  if (format === "nsis") return "self";
  if (format === "AppImage") {
    try {
      fs.accessSync(String(process.env.APPIMAGE), fs.constants.W_OK);
      return "self";
    } catch {
      return "assisted";
    }
  }
  return "assisted";
}

/**
 * electron-builder renames `${arch}` per target, so the same x64 build is
 * `x86_64` in an AppImage, `amd64` in a deb and `x64` in a tarball. Guessing
 * from process.arch produced a 404 for two of the three. The rule lives in
 * builder-util's getArtifactArchName; this is its x64 row, which is the only row
 * we build (see build.linux.target in app/package.json).
 */
const LINUX_ARCH = { AppImage: "x86_64", deb: "amd64", "tar.gz": "x64" };

/**
 * The release asset that matches this install's format, so an assisted update
 * never asks the user to choose among every artifact of the release.
 *
 * The names mirror `build.*.artifactName` in app/package.json, and
 * tests/updates.test.js checks them against the real files a build produces.
 *
 * @param {string} version
 * @returns {string | null} `null` when this platform and architecture has no
 *   published artifact at all — an Intel Mac, or a Linux box that is not x64.
 *   The caller then opens the releases page, which is honest, where a
 *   confidently wrong file name would be a 404.
 */
function assetName(version) {
  const format = installFormat();

  if (format === "portable") return `MAGENTRA-${version}-win-portable.exe`;
  if (format === "nsis") return `MAGENTRA-${version}-win-setup.exe`;
  // Only an arm64 dmg is published; Intel is deliberately out of scope.
  if (format === "dmg") {
    return process.arch === "arm64" ? `MAGENTRA-${version}-mac-arm64.dmg` : null;
  }
  if (process.arch !== "x64") return null;
  return `MAGENTRA-${version}-linux-${LINUX_ARCH[format]}.${format}`;
}

/**
 * Compare two dotted numeric versions.
 *
 * Lengths may differ: a legacy release is tagged `v0.13.0.1` while this build
 * reports `0.13.0`, and the extra part still orders correctly.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Positive when `a` is newer.
 */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** @param {Partial<typeof state>} next */
function setState(next) {
  state = { ...state, ...next };
  // "What's new" should show the release being offered, not the whole list.
  state.notesUrl = state.version ? `${RELEASES_URL}/tag/v${state.version}` : RELEASES_URL;
  publish(state);
}

/** The state a newly opened window needs to render the affordance at once. */
function updateState() {
  return state;
}

/** The tag of the newest release that is not a draft or a prerelease. */
async function latestTag() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(LATEST_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body.tag_name === "string" ? body.tag_name : null;
  } finally {
    clearTimeout(timeout);
  }
}

/** The electron-updater instance, configured for consent-first downloading. */
function selfUpdater() {
  if (updater) return updater;

  const { autoUpdater } = require("electron-updater");
  // Nothing reaches the network before the user clicks once.
  autoUpdater.autoDownload = false;
  // The default already installs a downloaded update on quit; being explicit
  // keeps that promise visible next to the one the UI makes to the user.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("update-available", (info) => {
    setState({ status: "available", version: info?.version ?? null });
    record("update-available", { version: info?.version });
  });
  autoUpdater.on("update-not-available", () => {
    setState({ status: "uptodate", version: null, percent: 0 });
  });
  autoUpdater.on("download-progress", (progress) => {
    setState({ status: "downloading", percent: Math.round(progress?.percent ?? 0) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setState({ status: "ready", version: info?.version ?? null, percent: 100 });
    record("update-downloaded", { version: info?.version });
  });
  autoUpdater.on("error", (error) => {
    // A missing channel file is the expected shape of a release whose packaging
    // job failed. Resting at "up to date" leaves the user with nothing to act on
    // and nothing alarming, and the next check picks the update up.
    record("update-error", { message: String(error && error.message) });
    setState({ status: "uptodate", version: null, percent: 0 });
  });

  updater = autoUpdater;
  return autoUpdater;
}

/** Ask whether a newer release exists. Never throws. */
async function checkNow() {
  if (state.tier === "none") return;
  if (state.status === "downloading" || state.status === "ready") return;

  try {
    if (state.tier === "self") {
      await selfUpdater().checkForUpdates();
      return;
    }

    const tag = await latestTag();
    if (!tag) {
      setState({ status: "uptodate", version: null });
      return;
    }
    const latest = tag.replace(/^v/, "");
    if (compareVersions(latest, state.current) > 0) {
      setState({ status: "available", version: latest });
      record("update-available", { version: latest });
    } else {
      setState({ status: "uptodate", version: null });
    }
  } catch (error) {
    // Offline, or a proxy in the way. "Up to date" is the honest answer.
    record("update-check-failed", { message: String(error && error.message) });
    setState({ status: "uptodate", version: null });
  }
}

/**
 * What the one click does.
 *
 * On the self tier it starts the download, and the caller's UI follows the
 * progress events. On the assisted tier it opens the browser on this install's
 * own asset, which is as far as an unsigned build can take the user.
 */
async function startUpdate() {
  if (state.status !== "available" || !state.version) return;

  if (state.tier === "assisted") {
    const asset = assetName(state.version);
    // No artifact exists for this platform and architecture, so the release page
    // is the most useful place we can land the user.
    const url = asset
      ? `${RELEASES_URL}/download/v${state.version}/${asset}`
      : `${RELEASES_URL}/tag/v${state.version}`;
    record("update-download-opened", { version: state.version, asset: asset || "release page" });
    await shell.openExternal(url);
    return;
  }

  try {
    setState({ status: "downloading", percent: 0 });
    await selfUpdater().downloadUpdate();
  } catch (error) {
    record("update-download-failed", { message: String(error && error.message) });
    // Back to `available`: the click is worth offering again.
    setState({ status: "available", percent: 0 });
  }
}

/** Quit and install a downloaded update now, instead of on the next quit. */
function installNow() {
  if (state.status !== "ready" || state.tier !== "self") return;
  record("update-install-now", { version: state.version });
  selfUpdater().quitAndInstall();
}

/**
 * Arm the update check.
 *
 * @param {object} options
 * @param {(state: typeof state) => void} options.broadcast Send the state to
 *   every open window. An update is app-global, not tied to one window's tab.
 * @param {(event: string, data?: object) => void} options.log
 * @param {boolean} options.enabled False when the user turned the check off.
 */
function initUpdates({ broadcast, log, enabled }) {
  publish = broadcast;
  record = log;

  const tier = installTier();
  const current = app.getVersion();

  if (tier === "none" || !enabled) {
    setState({ status: "disabled", tier, current });
    return;
  }

  setState({ status: "uptodate", tier, current, version: null, percent: 0 });

  // Neither timer keeps the process alive: quitting must never wait on an update
  // check, and a check is worth nothing to a process that is already leaving.
  const first = setTimeout(() => void checkNow(), FIRST_CHECK_DELAY_MS);
  if (first.unref) first.unref();
  // A workspace can stay open for weeks, so one check per launch is not enough.
  timer = setInterval(() => void checkNow(), CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  initUpdates,
  updateState,
  checkNow,
  startUpdate,
  installNow,
  // Both describe this install rather than doing anything to it, and both are
  // the parts most worth pinning down: a wrong tier hands a portable build an
  // installer, and a wrong asset name is a 404. tests/updates.test.js covers them.
  installTier,
  assetName,
};
