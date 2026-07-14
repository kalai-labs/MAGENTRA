// Shim for @vscode/ripgrep used when bundling the engine into a single CJS file.
//
// The real @vscode/ripgrep package is pure ESM and resolves its platform-specific
// binary at runtime via `createRequire(import.meta.url).resolve(...)`. That breaks
// when esbuild bundles everything into a single CommonJS file (import.meta.url is
// not available, and the platform package would need to live in node_modules next
// to the bundle). The packaged build ships the right binary next to engine.cjs
// (rg.exe on Windows, rg elsewhere — see scripts/bundle-engine.js), so we resolve
// it with a plain path relative to this bundle instead.
const path = require("node:path");
const fs = require("node:fs");

// `__dirname` collapses to the directory containing the final bundled file
// (build-resources/engine at build time, resources/engine when packaged).
const rgPath = path.join(__dirname, process.platform === "win32" ? "rg.exe" : "rg");

// Artifacts packed on a Windows host can lose the POSIX exec bit; self-heal
// before the first spawn. Read-only mounts (AppImage) refuse the chmod — there
// the bit must already be correct from pack time, so the failure is ignorable.
if (process.platform !== "win32") {
  try {
    fs.chmodSync(rgPath, 0o755);
  } catch {
    /* read-only mount or missing file — the spawn error will say which */
  }
}

exports.rgPath = rgPath;
